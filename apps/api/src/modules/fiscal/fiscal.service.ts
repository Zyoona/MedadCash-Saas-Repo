import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { decToAgora } from '../../common/money.util.js';
import { auditTx, ensureAccount, type Db } from '../../common/ctx.js';

const RETAINED_EARNINGS = '3500';

@Injectable()
export class FiscalService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService) {}

  list(tenantId: string) {
    return this.prisma.fiscalYear.findMany({ where: { tenantId }, orderBy: { startDate: 'desc' } });
  }

  async create(tenantId: string, input: { name: string; startDate: string; endDate: string }, actorId: string) {
    const start = new Date(input.startDate);
    const end = new Date(input.endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) throw new BadRequestException('تواريخ غير صالحة');
    const overlap = await this.prisma.fiscalYear.findFirst({
      where: { tenantId, startDate: { lte: end }, endDate: { gte: start } },
    });
    if (overlap) throw new ConflictException(`تتداخل مع السنة ${overlap.name}`);
    const fy = await this.prisma.$transaction(async (db: Db) => {
      const created = await db.fiscalYear.create({ data: { tenantId, name: input.name, startDate: start, endDate: end } });
      await auditTx(db, { tenantId, actorId, action: 'create', entity: 'fiscal_years', entityId: created.id, diff: input });
      return created;
    });
    return fy;
  }

  /**
   * Close a fiscal year with closing entries (§4): move all revenue/expense balances
   * of the year into retained earnings (3500), then mark the year closed.
   * The ledger rejects any posting into a closed year afterwards.
   */
  async close(tenantId: string, fyId: string, branchId: string, actorId: string) {
    const fy = await this.prisma.fiscalYear.findFirst({ where: { id: fyId, tenantId } });
    if (!fy) throw new NotFoundException('السنة غير موجودة');
    if (fy.isClosed) throw new ConflictException('السنة مغلقة مسبقاً');

    return this.prisma.$transaction(async (db: Db) => {
      await ensureAccount(db, tenantId, RETAINED_EARNINGS, 'أرباح/خسائر السنة (محتجزة)', 'equity');
      const accounts: { id: string; code: string; type: string }[] = await db.account.findMany({ where: { tenantId } });
      const lines: { accountId: string; debit: unknown; credit: unknown }[] = await db.journalLine.findMany({
        where: { entry: { tenantId, fiscalYearId: fyId } },
        select: { accountId: true, debit: true, credit: true },
      });
      const sums = new Map<string, { dr: number; cr: number }>();
      for (const l of lines) {
        const s = sums.get(l.accountId) ?? { dr: 0, cr: 0 };
        s.dr += decToAgora(l.debit as never);
        s.cr += decToAgora(l.credit as never);
        sums.set(l.accountId, s);
      }

      const closeLines: { accountCode: string; debitAgora: number; creditAgora: number; memo: string }[] = [];
      let profit = 0;
      for (const a of accounts) {
        const s = sums.get(a.id);
        if (!s) continue;
        if (a.type === 'revenue') {
          const net = s.cr - s.dr; // normally positive
          if (net === 0) continue;
          profit += net;
          closeLines.push(net > 0
            ? { accountCode: a.code, debitAgora: net, creditAgora: 0, memo: 'إقفال إيرادات' }
            : { accountCode: a.code, debitAgora: 0, creditAgora: -net, memo: 'إقفال إيرادات' });
        } else if (a.type === 'expense') {
          const net = s.dr - s.cr; // normally positive
          if (net === 0) continue;
          profit -= net;
          closeLines.push(net > 0
            ? { accountCode: a.code, debitAgora: 0, creditAgora: net, memo: 'إقفال مصروفات' }
            : { accountCode: a.code, debitAgora: -net, creditAgora: 0, memo: 'إقفال مصروفات' });
        }
      }
      if (closeLines.length > 0) {
        closeLines.push(profit >= 0
          ? { accountCode: RETAINED_EARNINGS, debitAgora: 0, creditAgora: profit, memo: 'صافي الربح' }
          : { accountCode: RETAINED_EARNINGS, debitAgora: -profit, creditAgora: 0, memo: 'صافي الخسارة' });
        await this.ledger.post({
          tenantId, branchId, fiscalYearId: fyId, date: fy.endDate,
          sourceType: 'fiscal_close', sourceId: fyId,
          memo: `قيود إقفال السنة ${fy.name}`,
          lines: closeLines,
        }, db);
      }
      const closed = await db.fiscalYear.update({ where: { id: fyId }, data: { isClosed: true } });
      await auditTx(db, { tenantId, actorId, branchId, action: 'close', entity: 'fiscal_years', entityId: fyId, diff: { profitAgora: profit } });
      return { ...closed, profitAgora: profit };
    });
  }
}
