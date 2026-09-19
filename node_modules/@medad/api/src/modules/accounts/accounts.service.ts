import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { agoraToDec, decToAgora } from '../../common/money.util.js';
import { auditTx, ensureAccount, fiscalYearFor, syncOpTx, type Db } from '../../common/ctx.js';

const CASH = '1000';
const BANK_BASE = '1100';
const RECEIVABLE_CHECKS = '1200';
const PAYABLE_CHECKS = '2200';
const AR = '1300';
const AP = '2000';
const OPENING = '3900';

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService) {}

  /** Chart of accounts + live balances (Dr-Cr per account, integer agora). */
  async list(tenantId: string) {
    const [accounts, sums] = await Promise.all([
      this.prisma.account.findMany({ where: { tenantId, deletedAt: null }, orderBy: { code: 'asc' } }),
      this.prisma.journalLine.groupBy({
        by: ['accountId'],
        where: { entry: { tenantId } },
        _sum: { debit: true, credit: true },
      }),
    ]);
    const byId = new Map(sums.map((s) => [s.accountId, s._sum]));
    return accounts.map((a) => {
      const s = byId.get(a.id);
      const dr = decToAgora(s?.debit ?? 0);
      const cr = decToAgora(s?.credit ?? 0);
      return { ...a, debitAgora: dr, creditAgora: cr, balanceAgora: dr - cr };
    });
  }

  async create(tenantId: string, input: { code: string; name: string; type: string; parentId?: string | null }, actorId: string) {
    const dup = await this.prisma.account.findFirst({ where: { tenantId, code: input.code } });
    if (dup) throw new ConflictException(`الكود ${input.code} مستخدم`);
    if (!['asset', 'liability', 'equity', 'revenue', 'expense'].includes(input.type)) {
      throw new BadRequestException('نوع حساب غير صالح');
    }
    const acc = await this.prisma.$transaction(async (db: Db) => {
      const created = await db.account.create({
        data: { tenantId, code: input.code, name: input.name, type: input.type, parentId: input.parentId ?? null },
      });
      await auditTx(db, { tenantId, actorId, action: 'create', entity: 'accounts', entityId: created.id, diff: input });
      return created;
    });
    return acc;
  }

  async rename(tenantId: string, id: string, name: string, actorId: string) {
    const acc = await this.prisma.account.findFirst({ where: { id, tenantId } });
    if (!acc) throw new NotFoundException('الحساب غير موجود');
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.account.update({ where: { id }, data: { name } });
      await auditTx(db, { tenantId, actorId, action: 'update', entity: 'accounts', entityId: id, diff: { name } });
      return updated;
    });
  }

  /** Closing an account blocks ALL future postings (enforced by LedgerService). */
  async close(tenantId: string, id: string, actorId: string) {
    const acc = await this.prisma.account.findFirst({ where: { id, tenantId } });
    if (!acc) throw new NotFoundException('الحساب غير موجود');
    if (acc.isClosed) throw new ConflictException('الحساب مغلق مسبقاً');
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.account.update({ where: { id }, data: { isClosed: true } });
      await auditTx(db, { tenantId, actorId, action: 'close_account', entity: 'accounts', entityId: id });
      return updated;
    });
  }

  /** Opening deposit: asset/expense → Dr account Cr 3900; else reversed (§4 row 9). */
  async opening(tenantId: string, branchId: string, input: { accountCode: string; amountAgora: number; date?: string; memo?: string }, actorId: string) {
    if (!Number.isInteger(input.amountAgora) || input.amountAgora <= 0) throw new BadRequestException('المبلغ يجب أن يكون موجباً (أغورات صحيحة)');
    const acc = await this.prisma.account.findFirst({ where: { tenantId, code: input.accountCode } });
    if (!acc) throw new NotFoundException('الحساب غير موجود');
    const date = input.date ? new Date(input.date) : new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);
    const debitSide = acc.type === 'asset' || acc.type === 'expense';
    return this.prisma.$transaction(async (db: Db) => {
      const entryId = await this.ledger.post({
        tenantId, branchId, fiscalYearId: fy.id, date,
        sourceType: 'opening_balance', sourceId: acc.id,
        memo: input.memo ?? `رصيد افتتاحي: ${acc.name}`,
        lines: debitSide
          ? [
              { accountCode: acc.code, debitAgora: input.amountAgora, creditAgora: 0 },
              { accountCode: OPENING, debitAgora: 0, creditAgora: input.amountAgora },
            ]
          : [
              { accountCode: OPENING, debitAgora: input.amountAgora, creditAgora: 0 },
              { accountCode: acc.code, debitAgora: 0, creditAgora: input.amountAgora },
            ],
      }, db);
      await auditTx(db, { tenantId, actorId, branchId, action: 'opening_balance', entity: 'accounts', entityId: acc.id, diff: { amountAgora: input.amountAgora, entryId } });
      return { entryId };
    });
  }

  /** Transfer between two accounts (§4 row 10): Dr destination / Cr source. */
  async transfer(tenantId: string, branchId: string, input: { fromCode: string; toCode: string; amountAgora: number; date?: string; memo?: string }, actorId: string) {
    if (!Number.isInteger(input.amountAgora) || input.amountAgora <= 0) throw new BadRequestException('المبلغ يجب أن يكون موجباً');
    if (input.fromCode === input.toCode) throw new BadRequestException('الحسابان متطابقان');
    const date = input.date ? new Date(input.date) : new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);
    return this.prisma.$transaction(async (db: Db) => {
      const entryId = await this.ledger.post({
        tenantId, branchId, fiscalYearId: fy.id, date,
        sourceType: 'account_transfer', sourceId: `${input.fromCode}>${input.toCode}`,
        memo: input.memo ?? `تحويل من ${input.fromCode} إلى ${input.toCode}`,
        lines: [
          { accountCode: input.toCode, debitAgora: input.amountAgora, creditAgora: 0 },
          { accountCode: input.fromCode, debitAgora: 0, creditAgora: input.amountAgora },
        ],
      }, db);
      await auditTx(db, { tenantId, actorId, branchId, action: 'account_transfer', entity: 'accounts', entityId: input.fromCode, diff: { ...input, entryId } });
      return { entryId };
    });
  }

  // ─── Bank accounts (الحسابات البنكية §Phase1) ───
  // كل حساب بنكي = كيان تشغيلي (اسم البنك/رقم/IBAN) مرتبط بحساب GL من دليل الحسابات.
  // الرصيد يُشتق من دفتر القيود Append-only — مصدر واحد للحقيقة ولا رقم مزدوج أبداً.

  async listBanks(tenantId: string) {
    const banks = await this.prisma.bankAccount.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });
    const codes = [...new Set(banks.map((b) => b.glAccountCode))];
    const [accounts, sums] = await Promise.all([
      codes.length ? this.prisma.account.findMany({ where: { tenantId, code: { in: codes } }, select: { id: true, code: true, name: true, isClosed: true } }) : [],
      codes.length ? this.prisma.journalLine.groupBy({
        by: ['accountId'],
        where: { entry: { tenantId }, account: { code: { in: codes } } },
        _sum: { debit: true, credit: true },
      }) : [],
    ]);
    const accByCode = new Map(accounts.map((a) => [a.code, a]));
    const sumByAcc = new Map(sums.map((s) => [s.accountId, s._sum]));
    return banks.map((b) => {
      const acc = accByCode.get(b.glAccountCode);
      const s = acc ? sumByAcc.get(acc.id) : undefined;
      const dr = decToAgora(s?.debit ?? 0);
      const cr = decToAgora(s?.credit ?? 0);
      return {
        ...b,
        glAccountName: acc?.name ?? null,
        glClosed: acc?.isClosed ?? false,
        debitAgora: dr,
        creditAgora: cr,
        balanceAgora: dr - cr,
      };
    });
  }

  /** أول بنك يتبنى 1100، واللاحقة أول كود حر من 1101..1199 (لا تصادم مع دليل الحسابات). */
  private async nextBankCode(db: Db, tenantId: string): Promise<string> {
    const [banks, accounts] = (await Promise.all([
      db.bankAccount.findMany({ where: { tenantId, deletedAt: null }, select: { glAccountCode: true } }),
      db.account.findMany({ where: { tenantId }, select: { code: true } }),
    ])) as { glAccountCode: string }[][] | { code: string }[][];
    if (!(banks as { glAccountCode: string }[]).some((b) => b.glAccountCode === BANK_BASE)) return BANK_BASE;
    const taken = new Set<string>([
      ...(banks as { glAccountCode: string }[]).map((b) => b.glAccountCode),
      ...(accounts as { code: string }[]).map((a) => a.code),
    ]);
    for (let n = 1; n <= 99; n++) {
      const code = `11${String(n).padStart(2, '0')}`;
      if (!taken.has(code)) return code;
    }
    throw new ConflictException('لا توجد أكواد متاحة لبنك جديد (1100..1199 ممتلئة)');
  }

  async createBank(tenantId: string, branchId: string, input: {
    bankName: string; accountLabel?: string; accountNumber?: string; iban?: string;
    currency?: string; notes?: string; openingBalanceAgora?: number;
  }, actorId: string) {
    const bankName = input.bankName?.trim();
    if (!bankName) throw new BadRequestException('اسم البنك مطلوب');
    const opening = input.openingBalanceAgora ?? 0;
    if (!Number.isInteger(opening) || opening < 0) throw new BadRequestException('الرصيد الافتتاحي غير صالح (أغورات)');
    const glName = input.accountLabel?.trim() ? `${bankName} — ${input.accountLabel.trim()}` : bankName;

    return this.prisma.$transaction(async (db: Db) => {
      const glAccountCode = await this.nextBankCode(db, tenantId);
      // 1100/1101 قد تكون موجودة مسبقاً في دليل الحسابات — نتبناها إن كانت أصولاً مفتوحة
      const existing = await db.account.findFirst({ where: { tenantId, code: glAccountCode } });
      if (existing && (existing.type !== 'asset' || existing.isClosed)) {
        throw new ConflictException(`الكود ${glAccountCode} محجوز بحساب غير صالح`);
      }
      if (!existing) await db.account.create({ data: { tenantId, code: glAccountCode, name: glName, type: 'asset' } });
      const bank = await db.bankAccount.create({
        data: {
          tenantId, glAccountCode, bankName,
          accountLabel: input.accountLabel?.trim() || null,
          accountNumber: input.accountNumber?.trim() || null,
          iban: input.iban?.trim() || null,
          currency: input.currency?.trim() || 'ILS',
          notes: input.notes?.trim() || null,
          isActive: true,
        },
      });
      let entryId: string | null = null;
      if (opening > 0) {
        const fy = await fiscalYearFor(db, tenantId, new Date());
        entryId = await this.ledger.post({
          tenantId, branchId, fiscalYearId: fy.id, date: new Date(),
          sourceType: 'opening_balance', sourceId: bank.id,
          memo: `رصيد افتتاحي: ${glName}`,
          lines: [
            { accountCode: glAccountCode, debitAgora: opening, creditAgora: 0 },
            { accountCode: OPENING, debitAgora: 0, creditAgora: opening },
          ],
        }, db);
      }
      await auditTx(db, { tenantId, actorId, branchId, action: 'create', entity: 'bank_accounts', entityId: bank.id, diff: { ...input, glAccountCode, openingEntryId: entryId } });
      await syncOpTx(db, { tenantId, branchId, entity: 'bank_account', entityId: bank.id, op: 'create', payload: { bankName, glAccountCode } });
      return { ...bank, glAccountName: glName, entryId };
    });
  }

  /** تعديل البيانات التشغيلية فقط — كود GL ثابت بعد الإنشاء (حماية سلامة القيود). */
  async updateBank(tenantId: string, id: string, patch: {
    bankName?: string; accountLabel?: string | null; accountNumber?: string | null;
    iban?: string | null; notes?: string | null; isActive?: boolean;
  }, actorId: string) {
    const bank = await this.prisma.bankAccount.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!bank) throw new NotFoundException('الحساب البنكي غير موجود');
    if (patch.bankName !== undefined && !patch.bankName.trim()) throw new BadRequestException('اسم البنك مطلوب');
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.bankAccount.update({
        where: { id },
        data: {
          ...(patch.bankName !== undefined ? { bankName: patch.bankName.trim() } : {}),
          ...(patch.accountLabel !== undefined ? { accountLabel: patch.accountLabel?.trim() || null } : {}),
          ...(patch.accountNumber !== undefined ? { accountNumber: patch.accountNumber?.trim() || null } : {}),
          ...(patch.iban !== undefined ? { iban: patch.iban?.trim() || null } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
          ...(patch.isActive !== undefined ? { isActive: !!patch.isActive } : {}),
        },
      });
      await auditTx(db, { tenantId, actorId, branchId: null, action: 'update', entity: 'bank_accounts', entityId: id, diff: patch });
      return updated;
    });
  }

  /** حذف ناعم — ممنوع إذا كان للبنك رصيد: حوّل الرصيد أولاً (تحويل بين الحسابات). */
  async deleteBank(tenantId: string, id: string, actorId: string) {
    const bank = await this.prisma.bankAccount.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!bank) throw new NotFoundException('الحساب البنكي غير موجود');
    const acc = await this.prisma.account.findFirst({ where: { tenantId, code: bank.glAccountCode }, select: { id: true } });
    if (acc) {
      const sums = await this.prisma.journalLine.groupBy({
        by: ['accountId'],
        where: { entry: { tenantId }, accountId: acc.id },
        _sum: { debit: true, credit: true },
      });
      const bal = sums.reduce((s, r) => s + decToAgora(r._sum.debit) - decToAgora(r._sum.credit), 0);
      if (bal !== 0) throw new ConflictException(`لا يمكن حذف حساب بنكي له رصيد (${bal / 100}) — حوّل الرصيد أولاً`);
    }
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.bankAccount.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
      await auditTx(db, { tenantId, actorId, branchId: null, action: 'delete', entity: 'bank_accounts', entityId: id });
      return updated;
    });
  }

  private async auditStandalone(tenantId: string, actorId: string, branchId: string | null, action: string, entity: string, entityId: string, diff: unknown) {
    await this.prisma.auditLog.create({
      data: { tenantId, actorId, branchId, action, entity, entityId, diff: diff as object },
    });
  }

  // ─── Checks (§Phase1: شيكات + تنبيه استحقاق) ───

  async listChecks(tenantId: string, status?: string) {
    return this.prisma.check.findMany({
      where: { tenantId, deletedAt: null, ...(status ? { status } : {}) },
      orderBy: { dueDate: 'asc' },
    });
  }

  /** Due alerts: pending checks due within `days` (default 7) or overdue. */
  async checkAlerts(tenantId: string, days = 7) {
    const horizon = new Date(Date.now() + days * 24 * 3600 * 1000);
    return this.prisma.check.findMany({
      where: { tenantId, status: 'pending', dueDate: { lte: horizon } },
      orderBy: { dueDate: 'asc' },
    });
  }

  /**
   * Receive/issue a check WITH its ledger effect (§4):
   *  - in  (من عميل): Dr 1200 / Cr 1300 (يخفض ذمة العميل)
   *  - out (لمورد):   Dr 2000 / Cr 2200 (يخفض ذمة المورد مقابل شيك مدفوع)
   */
  async createCheck(tenantId: string, branchId: string, input: {
    checkNumber: string; direction: 'in' | 'out'; amountAgora: number; dueDate: string;
    partyName?: string; customerId?: string; supplierId?: string; notes?: string; date?: string;
  }, actorId: string) {
    if (!Number.isInteger(input.amountAgora) || input.amountAgora <= 0) throw new BadRequestException('مبلغ غير صالح');
    if (input.direction === 'in' && !input.customerId) throw new BadRequestException('شيك التحصيل يتطلب عميلاً');
    if (input.direction === 'out' && !input.supplierId) throw new BadRequestException('الشيك المدفوع يتطلب مورداً');
    const date = input.date ? new Date(input.date) : new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);
    await ensureAccount(this.prisma, tenantId, PAYABLE_CHECKS, 'شيكات مدفوعة', 'liability');

    return this.prisma.$transaction(async (db: Db) => {
      const check = await db.check.create({
        data: {
          tenantId, branchId,
          checkNumber: input.checkNumber,
          direction: input.direction,
          accountCode: input.direction === 'in' ? RECEIVABLE_CHECKS : PAYABLE_CHECKS,
          partyName: input.partyName ?? null,
          customerId: input.customerId ?? null,
          supplierId: input.supplierId ?? null,
          amount: agoraToDec(input.amountAgora),
          dueDate: new Date(input.dueDate),
          notes: input.notes ?? null,
        },
      });
      const lines = input.direction === 'in'
        ? [
            { accountCode: RECEIVABLE_CHECKS, debitAgora: input.amountAgora, creditAgora: 0, customerId: input.customerId },
            { accountCode: AR, debitAgora: 0, creditAgora: input.amountAgora, customerId: input.customerId },
          ]
        : [
            { accountCode: AP, debitAgora: input.amountAgora, creditAgora: 0, supplierId: input.supplierId },
            { accountCode: PAYABLE_CHECKS, debitAgora: 0, creditAgora: input.amountAgora, supplierId: input.supplierId },
          ];
      const entryId = await this.ledger.post(
        { tenantId, branchId, fiscalYearId: fy.id, date, sourceType: 'check', sourceId: check.id, memo: `شيك ${input.direction === 'in' ? 'وارد' : 'صادر'} رقم ${input.checkNumber}`, lines },
        db,
      );
      await auditTx(db, { tenantId, actorId, branchId, action: 'create', entity: 'checks', entityId: check.id, diff: { ...input, entryId } });
      return { ...check, entryId };
    });
  }

  /** Clear a pending check: in → Dr cash/bank Cr 1200; out → Dr 2200 Cr cash/bank. */
  async clearCheck(tenantId: string, branchId: string, id: string, input: { accountCode?: string; date?: string }, actorId: string) {
    const check = await this.prisma.check.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!check) throw new NotFoundException('الشيك غير موجود');
    if (check.status !== 'pending') throw new ConflictException('الشيك مصروف/مرتجع مسبقاً');
    const cashAccount = input.accountCode ?? CASH;
    const amount = decToAgora(check.amount);
    const date = input.date ? new Date(input.date) : new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);

    return this.prisma.$transaction(async (db: Db) => {
      const lines = check.direction === 'in'
        ? [
            { accountCode: cashAccount, debitAgora: amount, creditAgora: 0 },
            { accountCode: RECEIVABLE_CHECKS, debitAgora: 0, creditAgora: amount },
          ]
        : [
            { accountCode: PAYABLE_CHECKS, debitAgora: amount, creditAgora: 0 },
            { accountCode: cashAccount, debitAgora: 0, creditAgora: amount },
          ];
      const entryId = await this.ledger.post(
        { tenantId, branchId, fiscalYearId: fy.id, date, sourceType: 'check_cleared', sourceId: id, memo: `صرف شيك ${check.checkNumber}`, lines },
        db,
      );
      const updated = await db.check.update({ where: { id }, data: { status: 'cleared', clearedAt: date } });
      await auditTx(db, { tenantId, actorId, branchId, action: 'clear', entity: 'checks', entityId: id, diff: { entryId } });
      return { ...updated, entryId };
    });
  }

  /** Bounce: reverse the receivable/payable effect (in → Dr 1300 Cr 1200; out → Dr 2200 Cr 2000). */
  async bounceCheck(tenantId: string, branchId: string, id: string, date0: string | undefined, actorId: string) {
    const check = await this.prisma.check.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!check) throw new NotFoundException('الشيك غير موجود');
    if (check.status !== 'pending') throw new ConflictException('لا يمكن إرجاع شيك غير معلق');
    const amount = decToAgora(check.amount);
    const date = date0 ? new Date(date0) : new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);

    return this.prisma.$transaction(async (db: Db) => {
      const lines = check.direction === 'in'
        ? [
            { accountCode: AR, debitAgora: amount, creditAgora: 0, customerId: check.customerId ?? undefined },
            { accountCode: RECEIVABLE_CHECKS, debitAgora: 0, creditAgora: amount },
          ]
        : [
            { accountCode: PAYABLE_CHECKS, debitAgora: amount, creditAgora: 0 },
            { accountCode: AP, debitAgora: 0, creditAgora: amount, supplierId: check.supplierId ?? undefined },
          ];
      const entryId = await this.ledger.post(
        { tenantId, branchId, fiscalYearId: fy.id, date, sourceType: 'check_bounced', sourceId: id, memo: `ارتجاع شيك ${check.checkNumber}`, lines },
        db,
      );
      const updated = await db.check.update({ where: { id }, data: { status: 'bounced' } });
      await auditTx(db, { tenantId, actorId, branchId, action: 'bounce', entity: 'checks', entityId: id, diff: { entryId } });
      return { ...updated, entryId };
    });
  }

  /** Ledger of one account (read-only journal lines with entry metadata). */
  async accountLedger(tenantId: string, accountCode: string, from?: string, to?: string) {
    const acc = await this.prisma.account.findFirst({ where: { tenantId, code: accountCode } });
    if (!acc) throw new NotFoundException('الحساب غير موجود');
    const lines = await this.prisma.journalLine.findMany({
      where: {
        accountId: acc.id,
        entry: {
          tenantId,
          ...(from || to ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
        },
      },
      include: { entry: { select: { id: true, date: true, sourceType: true, sourceId: true, memo: true, branchId: true } } },
      orderBy: { entry: { date: 'asc' } },
      take: 2000,
    });
    let running = 0;
    const rows = lines.map((l) => {
      const dr = decToAgora(l.debit);
      const cr = decToAgora(l.credit);
      running += dr - cr;
      return { id: l.id, entry: l.entry, debitAgora: dr, creditAgora: cr, memo: l.memo, runningAgora: running };
    });
    return { account: acc, rows, closingAgora: running };
  }
}
