import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { agoraToDec, decToAgora } from '../../common/money.util.js';
import { auditTx, type Db } from '../../common/ctx.js';

// Shifts (§Phase4): opening/closing with expected-vs-actual matching.
// Cash expectation = opening + cash sales − cash refunds during the shift.

const CASH = '1000';

@Injectable()
export class ShiftsService {
  constructor(private readonly prisma: PrismaService) {}

  async open(tenantId: string, branchId: string, cashierId: string, openingAmountAgora: number, actorId: string) {
    if (!Number.isInteger(openingAmountAgora) || openingAmountAgora < 0) throw new BadRequestException('مبلغ افتتاح غير صالح');
    const existing = await this.prisma.shift.findFirst({ where: { tenantId, branchId, cashierId, closedAt: null } });
    if (existing) throw new BadRequestException('توجد وردية مفتوحة لنفس الكاشير');
    return this.prisma.$transaction(async (db: Db) => {
      const shift = await db.shift.create({
        data: { tenantId, branchId, cashierId, openingAmount: agoraToDec(openingAmountAgora) },
      });
      await auditTx(db, { tenantId, actorId, branchId, action: 'open_shift', entity: 'shifts', entityId: shift.id, diff: { openingAmountAgora } });
      return shift;
    });
  }

  current(tenantId: string, branchId: string, cashierId?: string) {
    return this.prisma.shift.findFirst({
      where: { tenantId, branchId, closedAt: null, ...(cashierId ? { cashierId } : {}) },
      orderBy: { openedAt: 'desc' },
    });
  }

  /** Expected cash = opening + Σ cash invoice payments − Σ cash refunds (within shift window). */
  private async expectedCash(tenantId: string, shift: { id: string; openedAt: Date; openingAmount: unknown }) {
    const opening = decToAgora(shift.openingAmount as never);
    const payments = await this.prisma.invoicePayment.findMany({
      where: { invoice: { tenantId, shiftId: shift.id, status: 'posted' }, accountCode: CASH },
      select: { amount: true },
    });
    const salesCash = payments.reduce((s, p) => s + decToAgora(p.amount), 0); // negatives (change) reduce
    const refunds = await this.prisma.saleReturn.findMany({
      where: { tenantId, refundAccountCode: CASH, createdAt: { gte: shift.openedAt } },
      include: { lines: { include: { ret: { select: { id: true } } } } },
    });
    // refund cash amount is stored via ledger; recompute from return totals is complex — use ledger lines of sourceType sale_return
    const returnsCash = await this.prisma.journalLine.findMany({
      where: {
        entry: { tenantId, sourceType: 'sale_return', date: { gte: shift.openedAt } },
        account: { code: CASH },
      },
      select: { credit: true, debit: true },
    });
    const refundsCash = returnsCash.reduce((s, l) => s + decToAgora(l.credit) - decToAgora(l.debit), 0);
    void refunds;
    return opening + salesCash - refundsCash;
  }

  async close(tenantId: string, shiftId: string, closingActualAgora: number, closedBy: string, actorId: string) {
    const shift = await this.prisma.shift.findFirst({ where: { id: shiftId, tenantId } });
    if (!shift) throw new BadRequestException('الوردية غير موجودة');
    if (shift.closedAt) throw new BadRequestException('الوردية مغلقة مسبقاً');
    if (!Number.isInteger(closingActualAgora) || closingActualAgora < 0) throw new BadRequestException('مبلغ فعلي غير صالح');
    const expected = await this.expectedCash(tenantId, shift);
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.shift.update({
        where: { id: shiftId },
        data: { closingExpected: agoraToDec(expected), closingActual: agoraToDec(closingActualAgora), closedAt: new Date(), closedBy },
      });
      await auditTx(db, { tenantId, actorId, branchId: shift.branchId, action: 'close_shift', entity: 'shifts', entityId: shiftId, diff: { expectedAgora: expected, actualAgora: closingActualAgora, diffAgora: closingActualAgora - expected } });
      return { ...updated, expectedAgora: expected, diffAgora: closingActualAgora - expected };
    });
  }

  async report(tenantId: string, shiftId: string) {
    const shift = await this.prisma.shift.findFirst({ where: { id: shiftId, tenantId }, include: { invoices: { include: { lines: true, payments: true } } } });
    if (!shift) throw new BadRequestException('الوردية غير موجودة');
    const byMethod = new Map<string, number>();
    let salesTotal = 0;
    let invoicesCount = 0;
    for (const inv of shift.invoices) {
      if (inv.status !== 'posted') continue;
      invoicesCount++;
      salesTotal += inv.lines.reduce((s, l) => s + l.netAgora, 0);
      for (const p of inv.payments) {
        byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + decToAgora(p.amount));
      }
    }
    return {
      shift: { id: shift.id, openedAt: shift.openedAt, closedAt: shift.closedAt, openingAmountAgora: decToAgora(shift.openingAmount), closingExpectedAgora: shift.closingExpected ? decToAgora(shift.closingExpected) : null, closingActualAgora: shift.closingActual ? decToAgora(shift.closingActual) : null },
      salesTotalAgora: salesTotal,
      invoicesCount,
      byMethod: [...byMethod.entries()].map(([method, amountAgora]) => ({ method, amountAgora })),
    };
  }
}
