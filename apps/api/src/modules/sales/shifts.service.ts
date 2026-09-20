import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { fromAgora } from '@medad/shared-types';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { agoraToDec, decToAgora } from '../../common/money.util.js';
import { auditTx, ensureAccount, fiscalYearFor, type Db } from '../../common/ctx.js';
import { hasPerm } from '../../common/permissions.js';

// الورديات (§Phase4): افتتاح/إقفال مع مطابقة النقد الفعلي مقابل المتوقع المشتق من دفتر الأستاذ.
//
// النموذج المحاسبي المعتمد (ملزم):
//  - لكل كاشير **درج عهدة** = حساب GL أصلي مستقل (1010+) يُنشأ تلقائياً عند أول وردية.
//  - الافتتاح = تحويل العهدة من صندوق الفرع إلى الدرج: Dr درج / Cr 1000 (قيد حقيقي)،
//    و«مبلغ الافتتاح» هو عدّ النقد المُحوَّل — يُرحَّل مرة واحدة لكل وردية.
//    (الرصيد الافتتاحي المحاسبي للصندوق نفسه يُرحَّل مرة واحدة عبر /accounts/opening مقابل 3900.)
//  - النقد خلال الوردية يذهب إلى الدرج: دفعات الفواتير النقدية ومرتجعاتها تُرحَّل إلى حساب الدرج
//    بدل 1000 (انظر SalesService) — صفوف الدفعات تحتفظ بكود الطريقة (1000) والقيود تحمل الدرج.
//  - **المتوقع = رصيد حساب الدرج من دفتر الأستاذ** (لا يُخزَّن أي رصيد مشتق).
//  - الإقفال = تسليم النقد لصندوق الفرع: Dr 1000 (المُسلَّم فعلياً) + Dr/Cr 5310 (العجز/الفائض)
//    / Cr درج (رصيد العهدة) ⇒ يعود الدرج صفراً ويطابق 1000 النقد المُسلَّم.
//  - الورديات القديمة (drawerId = NULL) تبقى على مسار المطابقة السابق: المتوقع = الافتتاح +
//    صافي حركة 1000 لفرع الوردية خلال نافذتها، وعندها يُرحَّل الفرق وحده (Dr/Cr 5310 مقابل 1000).
//  - الوردية وحدة مساءلة الكاشير: تُفتتح مع كل وردية (وليست لمرة واحدة). الأدراج مستقلة لكل كاشير
//    فلا تتداخل مطابقتهم، لكن صندوق الفرع (1000) واحد: تُرفض وردية ثانية مفتوحة في نفس الفرع
//    إلا بصلاحية pos.shift_any (تجاوز يُوثَّق في audit ويُظهر تحذيراً).
//  - الإقفال لا يُمنع أبداً: الكاشير يُقفل ورديته، وإقفال وردية غيره/فرع آخر يتطلب pos.shift_any.

const CASH = '1000';
const CASH_DIFF = '5310';
const CASH_DIFF_NAME = 'فروقات الصندوق (عجز/فائض)';
const DRAWER_BASE = 1010;
const DRAWER_MAX = 1099;

/** مصادر لا تُحتسب ضمن حركة صندوق الفرع في مسار المطابقة القديم:
 *  opening_balance = تعرف أولي للرصيد (يظهر ضمن العدّ الافتتاحي نفسه وليس حركة نقدية).
 *  أما قيد إقفال الوردية نفسها فيُستثنى بمعرف المصدر (NOT sourceType+sourceId) حتى تبقى
 *  تسليمات دروج الورديات الأخرى — وهي نقد دخل الصندوق فعلاً — محسوبة ضمن النافذة. */
const NON_CASH_FLOW_SOURCES = ['opening_balance'];

export interface ShiftActor {
  userId: string;
  perms: string[];
  branchId?: string | null;
}

type ShiftWithDrawer = Prisma.ShiftGetPayload<{ include: { drawer: { select: { glAccountCode: true } } } }>;
type LedgerLine = { accountCode: string; debitAgora: number; creditAgora: number };

export interface CashReconciliation {
  expectedAgora: number;
  drawerAccountCode: string | null;
  basis: 'drawer' | 'branch_flow';
  movementsAgora: number;
  movementsBySource: { sourceType: string; amountAgora: number }[];
}

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /** تفصيل حركة حساب/حسابات من دفتر الأستاذ: الصافي + حسب نوع المصدر (المصدر الوحيد للحقيقة). */
  private async ledgerDetail(
    db: Db,
    tenantId: string,
    codes: string[],
    opts: { branchId?: string; from?: Date; to?: Date; toExclusive?: Date; excludeSources?: string[]; notEntry?: { sourceType: string; sourceId: string } } = {},
  ) {
    const empty = { netAgora: 0, bySource: [] as { sourceType: string; amountAgora: number }[] };
    if (!codes.length) return empty;
    const lines: { debit: unknown; credit: unknown; entry: { sourceType: string } }[] = await db.journalLine.findMany({
      where: {
        entry: {
          tenantId,
          ...(opts.branchId ? { branchId: opts.branchId } : {}),
          ...(opts.from || opts.to || opts.toExclusive
            ? { date: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}), ...(opts.toExclusive ? { lt: opts.toExclusive } : {}) } }
            : {}),
          ...(opts.excludeSources?.length ? { sourceType: { notIn: opts.excludeSources } } : {}),
          ...(opts.notEntry ? { NOT: { sourceType: opts.notEntry.sourceType, sourceId: opts.notEntry.sourceId } } : {}),
        },
        account: { code: { in: codes } },
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

  /** رصيد حسابات من دفتر الأستاذ (كل الفترات، أو لفرع محدد). */
  private async balanceAgora(db: Db, tenantId: string, codes: string[], branchId?: string): Promise<number> {
    if (!codes.length) return 0;
    const sums: { _sum: { debit: unknown; credit: unknown } }[] = await db.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: { tenantId, ...(branchId ? { branchId } : {}) }, account: { code: { in: codes } } },
      _sum: { debit: true, credit: true },
    });
    return sums.reduce((s, r) => s + decToAgora(r._sum.debit as never) - decToAgora(r._sum.credit as never), 0);
  }

  /** كود GL حرّ لأدراج العهدة (1010+) — لا يُعاد تدوير الأكواد لأن الدفتر سجل دائم. */
  private async nextDrawerCode(db: Db, tenantId: string): Promise<string> {
    const rows: { code: string }[] = await db.account.findMany({ where: { tenantId }, select: { code: true } });
    const used = new Set(rows.map((r) => r.code));
    for (let n = DRAWER_BASE; n <= DRAWER_MAX; n++) {
      const code = String(n);
      if (!used.has(code)) return code;
    }
    throw new BadRequestException(`لا يوجد كود حساب حرّ لأدراج العهدة (${DRAWER_BASE}-${DRAWER_MAX})`);
  }

  /** درج عهدة الكاشير: يُنشأ تلقائياً عند أول وردية مع حساب GL أصلي (asset). */
  private async ensureDrawer(db: Db, tenantId: string, cashierId: string): Promise<{ id: string; glAccountCode: string }> {
    const existing = await db.cashDrawer.findFirst({ where: { tenantId, cashierId, deletedAt: null } });
    if (existing) return existing;
    const cashier = await db.user.findFirst({ where: { id: cashierId, tenantId }, select: { name: true } });
    const cashierName: string = cashier?.name ?? 'الكاشير';
    const code = await this.nextDrawerCode(db, tenantId);
    await ensureAccount(db, tenantId, code, `عهدة درج — ${cashierName}`, 'asset');
    return db.cashDrawer.create({ data: { tenantId, cashierId, name: `درج ${cashierName}`, glAccountCode: code } });
  }

  private async countOtherOpenShifts(db: Db, tenantId: string, branchId: string, excludeCashierId: string | null): Promise<number> {
    return db.shift.count({
      where: { tenantId, branchId, closedAt: null, ...(excludeCashierId ? { cashierId: { not: excludeCashierId } } : {}) },
    });
  }

  /**
   * المتوقع في يد الكاشير عند لحظة معينة + أساس الاحتساب:
   *  - درج عهدة: رصيد حساب الدرج (يشمل العهدة المحوَّلة والنقد المرحَّل إليه).
   *  - وردية قديمة بلا درج: الافتتاح + صافي حركة صندوق الفرع خلال نافذة الوردية.
   */
  private async reconcile(db: Db, tenantId: string, shift: Pick<ShiftWithDrawer, 'id' | 'branchId' | 'openedAt' | 'openingAmount' | 'drawer'>, at: Date): Promise<CashReconciliation> {
    const drawerAccountCode = shift.drawer?.glAccountCode ?? null;
    if (drawerAccountCode) {
      // رصيد الدرج حتى لحظة الاحتساب (حصرًا) — قيد التسليم نفسه يُرحَّل بلحظة الإقفال فيُستبعد،
      // بينما تبقى تسليمات الورديات السابقة للدرج نفسه محسوبة (الدرج يُعاد استخدامه).
      const detail = await this.ledgerDetail(db, tenantId, [drawerAccountCode], { toExclusive: at });
      return { expectedAgora: detail.netAgora, drawerAccountCode, basis: 'drawer', movementsAgora: detail.netAgora, movementsBySource: detail.bySource };
    }
    const flow = await this.ledgerDetail(db, tenantId, [CASH], {
      branchId: shift.branchId,
      from: shift.openedAt,
      to: at,
      excludeSources: NON_CASH_FLOW_SOURCES,
      notEntry: { sourceType: 'shift_close', sourceId: shift.id },
    });
    return {
      expectedAgora: decToAgora(shift.openingAmount) + flow.netAgora,
      drawerAccountCode: null,
      basis: 'branch_flow',
      movementsAgora: flow.netAgora,
      movementsBySource: flow.bySource,
    };
  }

  private async loadShift(db: Db, tenantId: string, shiftId: string): Promise<ShiftWithDrawer | null> {
    return db.shift.findFirst({ where: { id: shiftId, tenantId }, include: { drawer: { select: { glAccountCode: true } } } });
  }

  /** افتتاح وردية: اعتماد/إنشاء درج العهدة + ترحيل تحويل العهدة Dr درج / Cr 1000. */
  async open(tenantId: string, branchId: string, openingAmountAgora: number, actor: ShiftActor) {
    if (!Number.isInteger(openingAmountAgora) || openingAmountAgora < 0) throw new BadRequestException('مبلغ افتتاح غير صالح');
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, tenantId, deletedAt: null }, select: { id: true } });
    if (!branch) throw new NotFoundException('الفرع غير موجود');
    const cashierId = actor.userId;
    const existing = await this.prisma.shift.findFirst({ where: { tenantId, branchId, cashierId, closedAt: null } });
    if (existing) throw new BadRequestException('توجد وردية مفتوحة لنفس الكاشير');
    const sharedBox = await this.countOtherOpenShifts(this.prisma, tenantId, branchId, cashierId);
    if (sharedBox > 0 && !hasPerm(actor.perms, 'pos.shift_any')) {
      throw new ForbiddenException('توجد وردية مفتوحة لكاشير آخر في نفس الفرع — صندوق الفرع واحد، أقفل الوردية المفتوحة أولاً');
    }

    const openedAt = new Date();
    const result = await this.prisma.$transaction(async (db: Db) => {
      const drawer = await this.ensureDrawer(db, tenantId, cashierId);
      const created = await db.shift.create({
        data: { tenantId, branchId, cashierId, drawerId: drawer.id, openingAmount: agoraToDec(openingAmountAgora), openedAt },
      });
      let entryId: string | null = null;
      if (openingAmountAgora > 0) {
        // تحويل العهدة من صندوق الفرع إلى الدرج — قيد مزدوج حقيقي (لا يُرحَّل عند مبلغ صفر)
        const fy = await fiscalYearFor(db, tenantId, openedAt);
        entryId = await this.ledger.post({
          tenantId, branchId, fiscalYearId: fy.id, date: openedAt,
          sourceType: 'shift_open', sourceId: created.id,
          memo: `تحويل عهدة صندوق إلى الدرج ${drawer.glAccountCode} — افتتاح وردية ${fromAgora(openingAmountAgora)} ₪`,
          lines: [
            { accountCode: drawer.glAccountCode, debitAgora: openingAmountAgora, creditAgora: 0 },
            { accountCode: CASH, debitAgora: 0, creditAgora: openingAmountAgora },
          ],
        }, db);
      }
      await auditTx(db, {
        tenantId, actorId: actor.userId, branchId, action: 'open_shift', entity: 'shifts', entityId: created.id,
        diff: { openingAmountAgora, drawerAccountCode: drawer.glAccountCode, entryId, sharedBoxOverride: sharedBox > 0 ? sharedBox : undefined },
      });
      return { created, drawerAccountCode: drawer.glAccountCode, entryId };
    });

    const warnings: string[] = [];
    if (sharedBox > 0) warnings.push('وردية أخرى مفتوحة في نفس الفرع — صندوق الفرع (1000) مشترك عند التحويل والتسليم');
    return {
      ...result.created,
      drawerAccountCode: result.drawerAccountCode,
      openingAmountAgora,
      expectedAgora: openingAmountAgora,
      entryId: result.entryId,
      warnings,
    };
  }

  /** الوردية المفتوحة الحالية للكاشير (مع درج العهدة). */
  current(tenantId: string, branchId: string, cashierId?: string) {
    return this.prisma.shift.findFirst({
      where: { tenantId, branchId, closedAt: null, ...(cashierId ? { cashierId } : {}) },
      orderBy: { openedAt: 'desc' },
      include: { drawer: { select: { glAccountCode: true } } },
    });
  }

  /**
   * لوحة الوردية لشاشة POS: الوردية المفتوحة + المتوقع الحي + اقتراح مبلغ الافتتاح
   * (من العدّ الفعلي لإقفال الكاشير السابق) + رصيد صندوق الفرع + درج العهدة.
   */
  async panel(tenantId: string, branchId: string, cashierId: string) {
    const db = this.prisma;
    const [shift, lastClosed, boxBalance, otherOpenShifts] = await Promise.all([
      db.shift.findFirst({
        where: { tenantId, branchId, cashierId, closedAt: null },
        orderBy: { openedAt: 'desc' },
        include: { drawer: { select: { glAccountCode: true } } },
      }),
      db.shift.findFirst({
        where: { tenantId, branchId, cashierId, closedAt: { not: null } },
        orderBy: { closedAt: 'desc' },
        select: { id: true, closedAt: true, closingActual: true },
      }),
      this.balanceAgora(db, tenantId, [CASH], branchId),
      this.countOtherOpenShifts(db, tenantId, branchId, cashierId),
    ]);
    const warnings: string[] = [];
    if (otherOpenShifts > 0) warnings.push('وردية أخرى مفتوحة في نفس الفرع — صندوق الفرع (1000) مشترك عند التحويل والتسليم');
    if (!shift) {
      return {
        shift: null,
        expectedAgora: null,
        drawerAccountCode: null,
        basis: null,
        suggestedOpeningAgora: lastClosed?.closingActual != null ? decToAgora(lastClosed.closingActual) : 0,
        boxBalanceAgora: boxBalance,
        otherOpenShifts,
        warnings,
      };
    }
    const rec = await this.reconcile(db, tenantId, shift, new Date());
    return {
      shift: {
        id: shift.id,
        openedAt: shift.openedAt,
        openingAmountAgora: decToAgora(shift.openingAmount),
        cashierId: shift.cashierId,
      },
      expectedAgora: rec.expectedAgora,
      drawerAccountCode: rec.drawerAccountCode,
      basis: rec.basis,
      suggestedOpeningAgora: null,
      boxBalanceAgora: boxBalance,
      otherOpenShifts,
      warnings,
    };
  }

  /**
   * إقفال وردية: مطابقة العدّ الفعلي مع المتوقع ثم ترحيل التسليم والفروق في نفس الذرية.
   *  - درج عهدة: Dr 1000 (المُسلَّم) + Dr/Cr 5310 (الفرق) / Cr درج (العهدة) ⇒ الدرج يعود صفراً.
   *  - وردية قديمة بلا درج: يُرحَّل الفرق وحده (Dr/Cr 5310 مقابل 1000).
   */
  async close(tenantId: string, shiftId: string, closingActualAgora: number, actor: ShiftActor) {
    const shift = await this.loadShift(this.prisma, tenantId, shiftId);
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
      const rec = await this.reconcile(db, tenantId, shift, closedAt);
      const expectedAgora = rec.expectedAgora;
      const diffAgora = closingActualAgora - expectedAgora;
      if (!Number.isInteger(expectedAgora) || !Number.isInteger(diffAgora)) throw new BadRequestException('حساب فرق الصندوق غير صالح');
      const drawerAccountCode = rec.drawerAccountCode;

      // أسطر القيد: تُستبعد الصفرية، ولا يُرحَّل قيد أصلاً إذا لم تتغير الأرصدة
      const lines: LedgerLine[] = [];
      if (drawerAccountCode) {
        if (closingActualAgora > 0) lines.push({ accountCode: CASH, debitAgora: closingActualAgora, creditAgora: 0 });
        if (expectedAgora > 0) lines.push({ accountCode: drawerAccountCode, debitAgora: 0, creditAgora: expectedAgora });
        else if (expectedAgora < 0) lines.push({ accountCode: drawerAccountCode, debitAgora: -expectedAgora, creditAgora: 0 });
        if (diffAgora < 0) lines.push({ accountCode: CASH_DIFF, debitAgora: -diffAgora, creditAgora: 0 });
        else if (diffAgora > 0) lines.push({ accountCode: CASH_DIFF, debitAgora: 0, creditAgora: diffAgora });
      } else if (diffAgora !== 0) {
        lines.push(
          diffAgora < 0
            ? { accountCode: CASH_DIFF, debitAgora: -diffAgora, creditAgora: 0 }
            : { accountCode: CASH, debitAgora: diffAgora, creditAgora: 0 },
          diffAgora < 0
            ? { accountCode: CASH, debitAgora: 0, creditAgora: -diffAgora }
            : { accountCode: CASH_DIFF, debitAgora: 0, creditAgora: diffAgora },
        );
      }

      let entryId: string | null = null;
      if (lines.length >= 2) {
        await ensureAccount(db, tenantId, CASH_DIFF, CASH_DIFF_NAME, 'expense');
        const fy = await fiscalYearFor(db, tenantId, closedAt);
        entryId = await this.ledger.post({
          tenantId, branchId: shift.branchId, fiscalYearId: fy.id, date: closedAt,
          sourceType: 'shift_close', sourceId: shift.id,
          memo: drawerAccountCode
            ? `تسليم عهدة الدرج ${drawerAccountCode} إلى الصندوق${diffAgora === 0 ? '' : diffAgora < 0 ? ` — عجز ${fromAgora(-diffAgora)} ₪` : ` — فائض ${fromAgora(diffAgora)} ₪`}`
            : diffAgora < 0 ? `عجز صندوق عند إقفال الوردية ${fromAgora(-diffAgora)} ₪` : `فائض صندوق عند إقفال الوردية ${fromAgora(diffAgora)} ₪`,
          lines,
        }, db);
      }

      const row = await db.shift.update({
        where: { id: shiftId },
        data: { closingExpected: agoraToDec(expectedAgora), closingActual: agoraToDec(closingActualAgora), closedAt, closedBy: actor.userId },
      });
      await auditTx(db, {
        tenantId, actorId: actor.userId, branchId: shift.branchId,
        action: 'close_shift', entity: 'shifts', entityId: shiftId,
        diff: { expectedAgora, actualAgora: closingActualAgora, diffAgora, basis: rec.basis, drawerAccountCode, movementsAgora: rec.movementsAgora, entryId },
      });
      return { row, entryId, expectedAgora, diffAgora, drawerAccountCode, basis: rec.basis, movementsAgora: rec.movementsAgora };
    });

    const warnings: string[] = [];
    if ((await this.countOtherOpenShifts(this.prisma, tenantId, shift.branchId, shift.cashierId)) > 0) {
      warnings.push('وردية أخرى ما زالت مفتوحة في نفس الفرع — صندوق الفرع (1000) مشترك');
    }
    return {
      ...result.row,
      expectedAgora: result.expectedAgora,
      diffAgora: result.diffAgora,
      movementsAgora: result.movementsAgora,
      drawerAccountCode: result.drawerAccountCode,
      basis: result.basis,
      boxBalanceAgora: await this.balanceAgora(this.prisma, tenantId, [CASH], shift.branchId),
      entryId: result.entryId,
      warnings,
    };
  }

  /** تقرير الوردية: فواتيرها + مطابقة نقدية كاملة من الدفتر (عهدة/حركة/متوقع/فعلي/فرق). */
  async report(tenantId: string, shiftId: string) {
    const shift = await this.prisma.shift.findFirst({
      where: { id: shiftId, tenantId },
      include: { invoices: { include: { lines: true, payments: true } }, drawer: { select: { glAccountCode: true } } },
    });
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
    const rec = await this.reconcile(this.prisma, tenantId, shift, end);
    const boxBalance = await this.balanceAgora(this.prisma, tenantId, [CASH], shift.branchId);
    const openingAgora = decToAgora(shift.openingAmount);
    const storedExpectedAgora = shift.closingExpected != null ? decToAgora(shift.closingExpected) : null;
    const actualAgora = shift.closingActual != null ? decToAgora(shift.closingActual) : null;
    // الوردية المغلقة: المتوقع المخزن هو المعتمد، ويُكشف أي اختلاف عن إعادة الاحتساب من الدفتر
    const expectedAgora = storedExpectedAgora ?? rec.expectedAgora;
    const warnings: string[] = [];
    if (storedExpectedAgora !== null && storedExpectedAgora !== rec.expectedAgora) {
      warnings.push('المتوقع المخزن ≠ المعاد احتسابه من دفتر الأستاذ: حركات سُجلت بعد الإقفال، أو وردية أُقفلت بأساس احتساب سابق');
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
        drawerAccountCode: rec.drawerAccountCode,
      },
      salesTotalAgora: salesTotal,
      invoicesCount,
      byMethod: [...byMethod.entries()].map(([method, amountAgora]) => ({ method, amountAgora })),
      cash: {
        basis: rec.basis,
        drawerAccountCode: rec.drawerAccountCode,
        openingAgora,
        movementsAgora: rec.movementsAgora,
        expectedAgora,
        recomputedExpectedAgora: rec.expectedAgora,
        actualAgora,
        diffAgora: actualAgora === null ? null : actualAgora - expectedAgora,
        boxBalanceAgora: boxBalance,
        movementsBySource: rec.movementsBySource,
      },
      warnings,
    };
  }
}
