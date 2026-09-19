import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

// Minimal structural types for the Prisma transaction surface used by the ledger.
// Keeps typecheck green without requiring `prisma generate` artifacts;
// runtime uses the real PrismaClient via PrismaService.
interface TxAccount {
  code: string;
  id: string;
  isClosed: boolean;
}
interface TxDb {
  fiscalYear: { findFirst(args: unknown): Promise<{ id: string; isClosed: boolean } | null> };
  account: { findMany(args: unknown): Promise<TxAccount[]> };
  journalEntry: {
    create(args: unknown): Promise<{ id: string }>;
    findFirst(args: unknown): Promise<null | {
      id: string;
      sourceType: string;
      sourceId: string;
      lines: { account: { code: string }; debit: unknown; credit: unknown; customerId: string | null; supplierId: string | null }[];
    }>;
  };
  journalLine: { findMany(args: unknown): Promise<{ debit: unknown; credit: unknown }[]> };
}

// ─── LedgerService: the ONLY writer of journal_entries/journal_lines ───
// Rules (binding, §1.2 + §4 of plan):
//  - Append-only: no UPDATE/DELETE path exists in this service.
//  - Balance enforced in code (Dr == Cr, integer agora) AND in DB (CHECK + trigger in 0001_init).
//  - Amounts are integer agora in code, persisted as NUMERIC(18,2).
//  - Closed accounts (isClosed) and closed fiscal years reject new postings.
//  - Reversal creates a NEW mirrored entry linked via reversesEntryId; never edits the original.

export interface PostLine {
  accountCode: string;
  debitAgora: number;
  creditAgora: number;
  customerId?: string;
  supplierId?: string;
  memo?: string;
}

export interface PostEntry {
  tenantId: string;
  branchId: string;
  fiscalYearId: string;
  date: Date;
  sourceType: string;
  sourceId: string;
  memo?: string;
  reversesEntryId?: string;
  lines: PostLine[];
}

function toDecimalString(agora: number): string {
  const neg = agora < 0;
  const abs = Math.abs(agora);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Validate balance in code before touching the DB. Throws BadRequest on violation. */
  assertBalanced(lines: PostLine[]): { debit: number; credit: number } {
    if (lines.length < 2) throw new BadRequestException('يجب أن يحتوي القيد على سطرين على الأقل');
    let dr = 0;
    let cr = 0;
    for (const l of lines) {
      if (!Number.isInteger(l.debitAgora) || !Number.isInteger(l.creditAgora)) {
        throw new BadRequestException('المبالغ يجب أن تكون بأغورات صحيحة (بدون كسور)');
      }
      if (l.debitAgora < 0 || l.creditAgora < 0) {
        throw new BadRequestException('المبالغ يجب أن تكون صفراً أو أكثر');
      }
      if (l.debitAgora > 0 && l.creditAgora > 0) {
        throw new BadRequestException('لا يمكن أن يكون السطر مديناً ودائناً في الوقت نفسه');
      }
      if (l.debitAgora === 0 && l.creditAgora === 0) {
        throw new BadRequestException('لا يمكن أن يكون مبلغ السطر صفراً');
      }
      dr += l.debitAgora;
      cr += l.creditAgora;
    }
    if (dr !== cr) throw new BadRequestException(`القيد غير متوازن: إجمالي المدين ${toDecimalString(dr)} ≠ إجمالي الدائن ${toDecimalString(cr)}`);
    if (dr === 0) throw new BadRequestException('إجمالي القيد لا يمكن أن يكون صفراً');
    return { debit: dr, credit: cr };
  }

  /** Post one balanced entry atomically. Returns the created entry id. */
  async post(
    input: PostEntry,
    tx?: { $transaction?: (fn: (db: TxDb) => Promise<string>) => Promise<string> } & Partial<TxDb>,
  ): Promise<string> {
    this.assertBalanced(input.lines);

    const run = async (db: TxDb): Promise<string> => {
      const fy = await db.fiscalYear.findFirst({
        where: { id: input.fiscalYearId, tenantId: input.tenantId },
      });
      if (!fy) throw new NotFoundException('السنة المالية غير موجودة');
      if (fy.isClosed) throw new ConflictException('السنة المالية مغلقة');

      const codes = [...new Set(input.lines.map((l) => l.accountCode))];
      const accounts = await db.account.findMany({
        where: { tenantId: input.tenantId, code: { in: codes } },
      });
      if (accounts.length !== codes.length) {
        const found = new Set(accounts.map((a) => a.code));
        throw new NotFoundException(`الحسابات التالية غير موجودة: ${codes.filter((c) => !found.has(c)).join('، ')}`);
      }
      const byCode = new Map(accounts.map((a) => [a.code, a]));
      const closed = accounts.filter((a) => a.isClosed);
      if (closed.length > 0) {
        throw new ConflictException(`الحسابات التالية مغلقة: ${closed.map((a) => a.code).join('، ')}`);
      }

      const entry = await db.journalEntry.create({
        data: {
          tenantId: input.tenantId,
          branchId: input.branchId,
          fiscalYearId: input.fiscalYearId,
          date: input.date,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          memo: input.memo,
          reversesEntryId: input.reversesEntryId ?? null,
          lines: {
            create: input.lines.map((l) => ({
              accountId: byCode.get(l.accountCode)!.id,
              debit: toDecimalString(l.debitAgora),
              credit: toDecimalString(l.creditAgora),
              customerId: l.customerId ?? null,
              supplierId: l.supplierId ?? null,
              memo: l.memo ?? null,
            })),
          },
        },
        select: { id: true },
      });
      return entry.id;
    };

    if (tx && !tx.$transaction) return run(tx as unknown as TxDb);
    const prisma = this.prisma as unknown as {
      $transaction(fn: (db: TxDb) => Promise<string>): Promise<string>;
    };
    return prisma.$transaction((db) => run(db));
  }

  /** Reverse an entry with a NEW mirrored entry. Never edits the original. */
  async reverse(params: {
    tenantId: string;
    branchId: string;
    fiscalYearId: string;
    entryId: string;
    reason: string;
    date?: Date;
  }): Promise<string> {
    const db = this.prisma as unknown as TxDb & {
      journalEntry: TxDb['journalEntry'] & {
        findFirst(args: unknown): Promise<{
          id: string;
          sourceType: string;
          sourceId: string;
          lines: {
            account: { code: string };
            debit: unknown;
            credit: unknown;
            customerId: string | null;
            supplierId: string | null;
          }[];
        } | null>;
      };
    };
    const original = await db.journalEntry.findFirst({
      where: { id: params.entryId, tenantId: params.tenantId },
      include: { lines: { include: { account: true } } },
    });
    if (!original) throw new NotFoundException('القيد الأصلي غير موجود');
    const already = await db.journalEntry.findFirst({
      where: { tenantId: params.tenantId, reversesEntryId: params.entryId },
      select: { id: true },
    });
    if (already) throw new ConflictException('تم عكس هذا القيد مسبقاً');

    return this.post({
      tenantId: params.tenantId,
      branchId: params.branchId,
      fiscalYearId: params.fiscalYearId,
      date: params.date ?? new Date(),
      sourceType: 'reversal',
      sourceId: params.entryId,
      memo: `عكس قيد ${original.sourceType}/${original.sourceId}: ${params.reason}`,
      reversesEntryId: params.entryId,
      lines: original.lines.map((l) => ({
        accountCode: l.account.code,
        // mirror: original debit becomes credit and vice versa
        debitAgora: Math.round(Number(l.credit) * 100),
        creditAgora: Math.round(Number(l.debit) * 100),
        customerId: l.customerId ?? undefined,
        supplierId: l.supplierId ?? undefined,
        memo: 'reversal',
      })),
    });
  }

  /** Read-only trial balance: total Dr == total Cr per tenant (acceptance §9.6). */
  async trialBalance(tenantId: string, branchId?: string) {
    const prisma = this.prisma as unknown as TxDb;
    const lines = await prisma.journalLine.findMany({
      where: { entry: { tenantId, ...(branchId ? { branchId } : {}) } },
      select: { debit: true, credit: true },
    });
    let dr = 0;
    let cr = 0;
    for (const l of lines) {
      dr += Math.round(Number(l.debit) * 100);
      cr += Math.round(Number(l.credit) * 100);
    }
    return { debitAgora: dr, creditAgora: cr, balanced: dr === cr };
  }

  /** Trial balance per account (code, name, type, Dr/Cr totals, balance). */
  async trialBalanceByAccount(tenantId: string, branchId?: string) {
    const prisma = this.prisma as unknown as {
      account: { findMany(args: unknown): Promise<{ id: string; code: string; name: string; type: string; isClosed: boolean }[]> };
      journalLine: { groupBy(args: unknown): Promise<{ accountId: string; _sum: { debit: unknown; credit: unknown } }[]> };
    };
    const [accounts, sums] = await Promise.all([
      prisma.account.findMany({ where: { tenantId, deletedAt: null }, orderBy: { code: 'asc' } }),
      prisma.journalLine.groupBy({
        by: ['accountId'],
        where: { entry: { tenantId, ...(branchId ? { branchId } : {}) } },
        _sum: { debit: true, credit: true },
      }),
    ]);
    const byId = new Map(sums.map((s) => [s.accountId, s._sum]));
    let totalDr = 0;
    let totalCr = 0;
    const rows = accounts.map((a) => {
      const s = byId.get(a.id);
      const dr = Math.round(Number(s?.debit ?? 0) * 100);
      const cr = Math.round(Number(s?.credit ?? 0) * 100);
      totalDr += dr;
      totalCr += cr;
      return { ...a, debitAgora: dr, creditAgora: cr, balanceAgora: dr - cr };
    });
    return { rows, totalDrAgora: totalDr, totalCrAgora: totalCr, balanced: totalDr === totalCr };
  }

  /** Paged entries list with lines (read-only view for the Ledger page). */
  async listEntries(tenantId: string, q: { branchId?: string; from?: string; to?: string; sourceType?: string; page?: number; pageSize?: number }) {
    const prisma = this.prisma as unknown as {
      journalEntry: {
        count(args: unknown): Promise<number>;
        findMany(args: unknown): Promise<unknown[]>;
      };
    };
    const where = {
      tenantId,
      ...(q.branchId ? { branchId: q.branchId } : {}),
      ...(q.sourceType ? { sourceType: q.sourceType } : {}),
      ...(q.from || q.to ? { date: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    };
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 50, 200);
    const [total, rows] = await Promise.all([
      prisma.journalEntry.count({ where }),
      prisma.journalEntry.findMany({
        where,
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          lines: { include: { account: { select: { code: true, name: true, type: true } } } },
          branch: { select: { id: true, name: true } },
        },
      }),
    ]);
    return { total, page, pageSize, rows };
  }

  async getEntry(tenantId: string, id: string) {
    const prisma = this.prisma as unknown as {
      journalEntry: { findFirst(args: unknown): Promise<unknown>; };
    };
    const entry = await prisma.journalEntry.findFirst({
      where: { id, tenantId },
      include: {
        lines: { include: { account: { select: { code: true, name: true, type: true } } } },
        branch: { select: { id: true, name: true } },
        fiscalYear: { select: { id: true, name: true } },
      },
    });
    if (!entry) throw new NotFoundException('القيد غير موجود');
    return entry;
  }
}
