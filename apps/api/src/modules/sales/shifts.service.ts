import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { fromAgora } from '@medad/shared-types';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { agoraToDec, decToAgora } from '../../common/money.util.js';
import { auditTx, ensureAccount, fiscalYearFor, type Db } from '../../common/ctx.js';
import { hasPerm } from '../../common/permissions.js';

// الورديات (§Phase4): افتتاح/إقفال مع مطابقة المتوقع مقابل العدّ الفعلي.
//
// النموذج المحاسبي المعتمد (ملزم):
//  - حساب 1000 (الصندوق) هو صندوق الفرع نفسه؛ كل حركة نقدية له قيد مزدوج يحمل branchId.
//  - «مبلغ الافتتاح» = عدّ النقد الموجود في الصندوق لحظة بدء الوردية، وليس نقل ملكية:
//    لا يُرحَّل أي قيد عند الافتتاح لأن النقود مسجلة أصلاً في 1000 (الرصيد الافتتاحي المحاسبي
//    يُرحَّل مرة واحدة فقط عبر /accounts/opening مقابل 3900).
//  - المتوقع = مبلغ الافتتاح + صافي حركة 1000 للفرع خلال نافذة الوردية (من دفتر الأستاذ مباشرة)،
//    فيشمل المبيعات النقدية والمرتجعات والتحصيلات ومدفوعات الموردين والمشتريات والمصروفات والتحويلات.
//  - الفرق (عجز/فائض) عند الإقفال يُرحَّل: عجز Dr 5310 / Cr 1000 — فائض Dr 1000 / Cr 5310،
//    فيصبح رصيد الصندوق الدفتري مطابقاً للعدّ الفعلي.
//  - الوردية وحدة مساءلة الكاشير: تُفتتح مع كل وردية (وليست لمرة واحدة). ولأن الصندوق (1000)
//    واحد لكل فرع، تُسمح وردية مفتوحة واحدة لكل فرع/كاشير، ولا تُفتح وردية ثانية في نفس الفرع
//    إلا بصلاحية pos.shift_any (تجاوز يُوثَّق في audit ويُظهر تحذيراً في المطابقة).
//  - الإقفال لا يُمنع أبداً: الكاشير يُقفل ورديته، وإقفال وردية غيره/فرع آخر يتطلب pos.shift_any.

const CASH = '1000';
const CASH_DIFF = '5310';
const CASH_DIFF_NAME = 'فروقات الصندوق (عجز/فائض)';

/** مصادر لا تُحتسب ضمن حركة الصندوق داخل نافذة الوردية:
 *  opening_balance = تعرف أولي للرصيد (يظهر ضمن العدّ الافتتاحي نفسه وليس حركة نقدية)،
 *  shift_close = قيد العجز/الفائض عند الإقفال (حتى لا يُحتسب مرتين). */
const NON_CASH_FLOW_SOURCES = ['opening_balance', 'shift_close'];

export interface ShiftActor {
  userId: string;
  perms: string[];
  branchId?: string | null;
}

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /** حركة الصندوق (1000) لفرع ضمن نافذة زمنية من دفتر الأستاذ: الصافي + تفصيل حسب نوع المصدر. */
  private async cashFlowDetail(db: Db, tenantId: string, branchId: string, from: Date, to: Date) {
    const lines: { debit: unknown; credit: unknown; entry: { sourceType: string } }[] = await db.journalLine.findMany({
      where: {
        entry: { tenantId, branchId, date: { gte: from, lte: to }, sourceType: { notIn: NON_CASH_FLOW_SOURCES } },
        account: { code: CASH },
      },
      select: { debit: true, credit: true, entry: { select: { sourceType: true } } },
    });
    const bySource = new Map<string, number>();
    let netAgora = 0;
    for (const l of lines) {
      const amountAgora = decToAgora(l.debit as never) - decToAgora(l.credit as never);
      netAgora += amountAgora;
      bySource.set(l.entry.sourceType, (bySource.get(l.entry.sourceType) ?? 0) + amountAgora);
    }
    return {
      netAgora,
      bySource: [...bySource.entries()]
        .map(([sourceType, amountAgora]) => ({ sourceType, amountAgora }))
        .sort((a, b) => b.amountAgora - a.amountAgora),
    };
  }

  /** رصيد الصندوق الدفتري للفرع (كل الفترات) — مشتق من journal_lines فقط. */
  private async boxBalanceAgora(db: Db, tenantId: string, branchId: string): Promise<number> {
    const sums: { _sum: { debit: unknown; credit: unknown } }[] = await db.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: { tenantId, branchId }, account: { code: CASH } },
      _sum: { debit: true, credit: true },
    });
    return sums.reduce((s, r) => s + decToAgora(r._sum.debit as never) - decToAgora(r._sum.credit as never), 0);
  }

  private async countOtherOpenShifts(db: Db, tenantId: string, branchId: string, excludeCashierId: string | null): Promise<number> {
    return db.shift.count({
      where: { tenantId, branchId, closedAt: null, ...(excludeCashierId ? { cashierId: { not: excludeCashierId } } : {}) },
    });
  }

  /**
   * افتتاح وردية جديدة: تسجيل العدّ الافتتاحي فقط — بلا قيد محاسبي (النقد مسجل أصلاً في 1000).
   * الصندوق واحد لكل فرع، لذا تُرفض وردية ثانية مفتوحة في نفس الفرع إلا بصلاحية pos.shift_any
   * (صناديق/أدراج مستقلة تتطلب حسابات GL مستقلة — غير مدعومة بعد).
   */
  async open(tenantId: string, branchId: string, openingAmountAgora: number, actor: ShiftActor) {
    if (!Number.isInteger(openingAmountAgora) || openingAmountAgora < 0) throw new BadRequestException('مبلغ افتتاح غير صالح');
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, tenantId, deletedAt: null }, select: { id: true } });
    if (!branch) throw new NotFoundException('الفرع غير موجود');
    const cashierId = actor.userId;
    const existing = await this.prisma.shift.findFirst({ where: { tenantId, branchId, cashierId, closedAt: null } });
    if (existing) throw new BadRequestException('توجد وردية مفتوحة لنفس الكاشير');
    const sharedBox = await this.countOtherOpenShifts(this.prisma, tenantId, branchId, cashierId);
    const canShareBox = hasPerm(actor.perms, 'pos.shift_any');
    if (sharedBox > 0 && !canShareBox) {
      throw new ForbiddenException('توجد وردية مفتوحة لكاشير آخر في نفس الفرع — صندوق الفرع واحد، أقفل الوردية المفتوحة أولاً');
    }

    const openedAt = new Date();
    const shift = await this.prisma.$transaction(async (db: Db) => {
      const created = await db.shift.create({
        data: { tenantId, branchId, cashierId, openingAmount: agoraToDec(openingAmountAgora), openedAt },
      });
      await auditTx(db, {
        tenantId, actorId: actor.userId, branchId, action: 'open_shift', entity: 'shifts', entityId: created.id,
        diff: { openingAmountAgora, sharedBoxOverride: sharedBox > 0 ? sharedBox : undefined },
      });
      return created;
    });

    const warnings: string[] = [];
    if (sharedBox > 0) warnings.push('وردية أخرى مفتوحة في نفس الفرع — حركة صندوق الفرع تُحتسب مشتركة حتى الإقفال');
    return { ...shift, openingAmountAgora, expectedAgora: openingAmountAgora, warnings };
  }

  /** الوردية المفتوحة الحالية للكاشير. */
  current(tenantId: string, branchId: string, cashierId?: string) {
    return this.prisma.shift.findFirst({
      where: { tenantId, branchId, closedAt: null, ...(cashierId ? { cashierId } : {}) },
      orderBy: { openedAt: 'desc' },
    });
  }

  /**
   * لوحة الوردية لشاشة POS: الوردية المفتوحة + المتوقع الحي (من الدفتر) + اقتراح مبلغ الافتتاح
   * (من العدّ الفعلي لإقفال الكاشير السابق) + رصيد الصندوق الدفتري للفرع.
   */
  async panel(tenantId: string, branchId: string, cashierId: string) {
    const db = this.prisma;
    const [shift, lastClosed, boxBalance, otherOpenShifts] = await Promise.all([
      db.shift.findFirst({ where: { tenantId, branchId, cashierId, closedAt: null }, orderBy: { openedAt: 'desc' } }),
      db.shift.findFirst({
        where: { tenantId, branchId, cashierId, closedAt: { not: null } },
        orderBy: { closedAt: 'desc' },
        select: { id: true, closedAt: true, closingActual: true },
      }),
      this.boxBalanceAgora(db, tenantId, branchId),
      this.countOtherOpenShifts(db, tenantId, branchId, cashierId),
    ]);
    const warnings: string[] = [];
    if (otherOpenShifts > 0) warnings.push('وردية أخرى مفتوحة في نفس الفرع — حركة صندوق الفرع تُحتسب مشتركة حتى إقفالها');
    if (!shift) {
      return {
        shift: null,
        expectedAgora: null,
        suggestedOpeningAgora: lastClosed?.closingActual != null ? decToAgora(lastClosed.closingActual) : 0,
        boxBalanceAgora: boxBalance,
        otherOpenShifts,
        warnings,
      };
    }
    const flow = await this.cashFlowDetail(db, tenantId, branchId, shift.openedAt, new Date());
    const openingAgora = decToAgora(shift.openingAmount);
    return {
      shift: { id: shift.id, openedAt: shift.openedAt, openingAmountAgora: openingAgora, cashierId: shift.cashierId },
      expectedAgora: openingAgora + flow.netAgora,
      suggestedOpeningAgora: null,
      boxBalanceAgora: boxBalance,
      otherOpenShifts,
      warnings,
    };
  }

  /** إقفال وردية: مطابقة العدّ الفعلي مع المتوقع + ترحيل فرق العجز/الفائض (5310) في نفس الذرية. */
  async close(tenantId: string, shiftId: string, closingActualAgora: number, actor: ShiftActor) {
    const shift = await this.prisma.shift.findFirst({ where: { id: shiftId, tenantId } });
    if (!shift) throw new BadRequestException('الوردية غير موجودة');
    if (shift.closedAt) throw new BadRequestException('الوردية مغلقة مسبقاً');
    if (!Number.isInteger(closingActualAgora) || closingActualAgora < 0) throw new BadRequestException('مبلغ فعلي غير صالح');
    if (shift.cashierId !== actor.userId && !hasPerm(actor.perms, 'pos.shift_any')) {
      throw new ForbiddenException('إقفال وردية كاشير آخر يتطلب صلاحية pos.shift_any');
    }
    if (actor.branchId && actor.branchId !== shift.branchId && !hasPerm(actor.perms, 'pos.shift_any')) {
      throw new ForbiddenException('لا يمكن إقفال وردية لفرع آخر');
    }

    const result = await this.prisma.$transaction(async (db: Db) => {
      const closedAt = new Date();
      const flow = await this.cashFlowDetail(db, tenantId, shift.branchId, shift.openedAt, closedAt);
      const openingAgora = decToAgora(shift.openingAmount);
      const expectedAgora = openingAgora + flow.netAgora;
      const diffAgora = closingActualAgora - expectedAgora;
      if (!Number.isInteger(expectedAgora) || !Number.isInteger(diffAgora)) throw new BadRequestException('حساب فرق الصندوق غير صالح');

      let entryId: string | null = null;
      if (diffAgora !== 0) {
        // ترحيل الفرق: عجز Dr 5310 / Cr 1000 — فائض Dr 1000 / Cr 5310
        await ensureAccount(db, tenantId, CASH_DIFF, CASH_DIFF_NAME, 'expense');
        const fy = await fiscalYearFor(db, tenantId, closedAt);
        entryId = await this.ledger.post({
          tenantId, branchId: shift.branchId, fiscalYearId: fy.id, date: closedAt,
          sourceType: 'shift_close', sourceId: shift.id,
          memo: diffAgora < 0
            ? `عجز صندوق عند إقفال الوردية ${fromAgora(-diffAgora)} ₪`
            : `فائض صندوق عند إقفال الوردية ${fromAgora(diffAgora)} ₪`,
          lines: diffAgora < 0
            ? [
                { accountCode: CASH_DIFF, debitAgora: -diffAgora, creditAgora: 0 },
                { accountCode: CASH, debitAgora: 0, creditAgora: -diffAgora },
              ]
            : [
                { accountCode: CASH, debitAgora: diffAgora, creditAgora: 0 },
                { accountCode: CASH_DIFF, debitAgora: 0, creditAgora: diffAgora },
              ],
        }, db);
      }

      const row = await db.shift.update({
        where: { id: shiftId },
        data: { closingExpected: agoraToDec(expectedAgora), closingActual: agoraToDec(closingActualAgora), closedAt, closedBy: actor.userId },
      });
      await auditTx(db, {
        tenantId, actorId: actor.userId, branchId: shift.branchId,
        action: 'close_shift', entity: 'shifts', entityId: shiftId,
        diff: { expectedAgora, actualAgora: closingActualAgora, diffAgora, cashFlowAgora: flow.netAgora, entryId },
      });
      return { row, entryId, expectedAgora, diffAgora, cashFlowAgora: flow.netAgora, closedAt };
    });

    const warnings: string[] = [];
    if ((await this.countOtherOpenShifts(this.prisma, tenantId, shift.branchId, shift.cashierId)) > 0) {
      warnings.push('وردية أخرى ما زالت مفتوحة في نفس الفرع — رصيد الصندوق الدفتري لم يُطابَق كاملاً');
    }
    return {
      ...result.row,
      expectedAgora: result.expectedAgora,
      diffAgora: result.diffAgora,
      cashFlowAgora: result.cashFlowAgora,
      boxBalanceAgora: await this.boxBalanceAgora(this.prisma, tenantId, shift.branchId),
      entryId: result.entryId,
      warnings,
    };
  }

  /** تقرير الوردية: فواتيرها + مطابقة نقدية كاملة من الدفتر (افتتاح/حركة/متوقع/فعلي/فرق). */
  async report(tenantId: string, shiftId: string) {
    const shift = await this.prisma.shift.findFirst({ where: { id: shiftId, tenantId }, include: { invoices: { include: { lines: true, payments: true } } } });
    if (!shift) throw new BadRequestException('الوردية غير موجودة');
    const end = shift.closedAt ?? new Date();
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
    const flow = await this.cashFlowDetail(this.prisma, tenantId, shift.branchId, shift.openedAt, end);
    const boxBalance = await this.boxBalanceAgora(this.prisma, tenantId, shift.branchId);
    const openingAgora = decToAgora(shift.openingAmount);
    const recomputedExpectedAgora = openingAgora + flow.netAgora;
    // الوردية المغلقة: المتوقع المخزن هو المعتمد، ويُكشف أي قيد لاحق غيّر النافذة (للتدقيق)
    const storedExpectedAgora = shift.closingExpected != null ? decToAgora(shift.closingExpected) : null;
    const actualAgora = shift.closingActual != null ? decToAgora(shift.closingActual) : null;
    const expectedAgora = storedExpectedAgora ?? recomputedExpectedAgora;
    const warnings: string[] = [];
    if (storedExpectedAgora !== null && storedExpectedAgora !== recomputedExpectedAgora) {
      warnings.push('المتوقع المخزن ≠ المعاد احتسابه من دفتر الأستاذ: حركات سُجلت بعد الإقفال، أو وردية أُقفلت بالآلية السابقة (قبل ربط الوردية بحركة الصندوق)');
    }
    return {
      shift: {
        id: shift.id,
        openedAt: shift.openedAt,
        closedAt: shift.closedAt,
        cashierId: shift.cashierId,
        openingAmountAgora: openingAgora,
        closingExpectedAgora: storedExpectedAgora,
        closingActualAgora: actualAgora,
      },
      salesTotalAgora: salesTotal,
      invoicesCount,
      byMethod: [...byMethod.entries()].map(([method, amountAgora]) => ({ method, amountAgora })),
      cash: {
        openingAgora,
        movementsAgora: flow.netAgora,
        expectedAgora,
        recomputedExpectedAgora,
        actualAgora,
        diffAgora: actualAgora === null ? null : actualAgora - expectedAgora,
        boxBalanceAgora: boxBalance,
        movementsBySource: flow.bySource,
      },
      warnings,
    };
  }
}
