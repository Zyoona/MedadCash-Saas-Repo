import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PartiesService } from '../parties/parties.service.js';
import { computeInvoice } from '@medad/shared-types';
import { agoraToDec, decToAgora } from '../../common/money.util.js';
import { auditTx, fiscalYearFor, settingValue, syncOpTx, type Db } from '../../common/ctx.js';

const REVENUE = '4000';
const TAX_PAYABLE = '2100';
const AR = '1300';
const COGS = '5000';
const INVENTORY = '1400';
const RETURNS_EXPENSE = '4100';
const LEGACY_BANK = '1100';

// POS / Sales (§Phase4) — BINDING invoice order (§1.2):
//   line discount → pro-rata invoice discount → tax AFTER discounts (default 0%).
// Every sale is ONE atomic tx: invoice doc + ledger (sale + COGS) + stock + sync op + audit.

export interface SaleLineInput {
  productId?: string;
  variantId?: string;
  qty: number;
  unitPriceAgora?: number; // optional: defaults to branch price
  lineDiscountAgora?: number;
  taxRateBps?: number; // optional: defaults to settings tax_rate
}

export interface PaymentInput {
  method: string; // cash | bank | check | credit
  accountCode: string;
  amountAgora: number; // negative = إرجاع باقي بطريقة مختلفة (§4 row 8)
}

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly inventory: InventoryService,
    private readonly parties: PartiesService,
  ) {}

  /** الدفع البنكي يجب أن يستهدف حساب بنك مسجل (1100 مقبول للتوافق مع البيانات القديمة). */
  private async assertBankAccount(tenantId: string, code: string) {
    if (code === LEGACY_BANK) return;
    const bank = await this.prisma.bankAccount.findFirst({
      where: { tenantId, glAccountCode: code, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (!bank) throw new BadRequestException(`كود الحساب البنكي غير مسجل أو معطل: ${code}`);
  }

  async createInvoice(tenantId: string, actor: { userId: string; perms: string[]; device?: string; ip?: string }, input: {
    branchId: string;
    customerId?: string | null;
    shiftId?: string | null;
    refNo?: string;
    invoiceDiscountAgora?: number;
    lines: SaleLineInput[];
    payments: PaymentInput[];
    date?: string;
  }) {
    const branchId = input.branchId;
    if (!input.lines?.length) throw new BadRequestException('لا توجد أسطر');
    if (!input.payments?.length) throw new BadRequestException('لا توجد صفقات دفع');

    const date = input.date ? new Date(input.date) : new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);
    const taxDefault = ((await settingValue<{ rateBps: number }>(this.prisma, tenantId, 'tax_rate', branchId)) ?? { rateBps: 0 }).rateBps;

    // Resolve lines: product/variant + branch price + cost snapshot
    const resolved: { productId: string; variantId: string | null; qty: number; unitPriceAgora: number; lineDiscountAgora: number; taxRateBps: number; costAgora: number; isService: boolean }[] = [];
    for (const l of input.lines) {
      if (!Number.isInteger(l.qty) || l.qty <= 0) throw new BadRequestException('كمية غير صالحة');
      let productId = l.productId ?? null;
      if (!productId && l.variantId) {
        const v = await this.prisma.productVariant.findFirst({ where: { id: l.variantId, tenantId }, select: { productId: true } });
        if (!v) throw new NotFoundException('المتغير غير موجود');
        productId = v.productId;
      }
      if (!productId) throw new BadRequestException(' productId أو variantId مطلوب لكل سطر');
      const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId, deletedAt: null } });
      if (!product) throw new NotFoundException('الصنف غير موجود');
      const isService = String(product.sku ?? '').startsWith('SVC-'); // خدمة (مهام): بلا أثر مخزني
      const pb = await this.prisma.productBranch.findFirst({ where: { tenantId, branchId, productId } });
      const unitPriceAgora = l.unitPriceAgora ?? (pb ? decToAgora(pb.price) : 0);
      if (!Number.isInteger(unitPriceAgora) || unitPriceAgora < 0) throw new BadRequestException('سعر غير صالح');
      resolved.push({
        productId,
        variantId: l.variantId ?? null,
        qty: l.qty,
        unitPriceAgora,
        lineDiscountAgora: l.lineDiscountAgora ?? 0,
        taxRateBps: l.taxRateBps ?? taxDefault,
        costAgora: isService ? 0 : pb ? decToAgora(pb.cost) : 0,
        isService,
      });
    }

    // Binding math from shared-types (unit-tested §9.1)
    const totals = computeInvoice(
      resolved.map((r) => ({ qty: r.qty, unitPriceAgora: r.unitPriceAgora, lineDiscountAgora: r.lineDiscountAgora, taxRateBps: r.taxRateBps })),
      input.invoiceDiscountAgora ?? 0,
    );

    // Payments normalization + credit remainder
    const paidNet = input.payments.reduce((s, p) => s + p.amountAgora, 0);
    const remainder = totals.grandTotalAgora - paidNet; // >0 → آجل (ذمم), <0 → خطأ
    if (remainder < 0) throw new BadRequestException(`المدفوع (${paidNet}) أكبر من الإجمالي (${totals.grandTotalAgora})`);
    for (const p of input.payments) {
      if (!Number.isInteger(p.amountAgora) || p.amountAgora === 0) throw new BadRequestException('مبلغ دفع غير صالح');
      if (p.method === 'bank') await this.assertBankAccount(tenantId, p.accountCode);
    }

    return this.prisma.$transaction(async (db: Db) => {
      // Customer: default cash customer; credit sales need a real customer + limit check (§3)
      const customer = input.customerId
        ? await db.customer.findFirst({ where: { id: input.customerId, tenantId, deletedAt: null } })
        : await this.parties.cashCustomer(db, tenantId, branchId);
      if (!customer) throw new NotFoundException('العميل غير موجود');

      const warnings: string[] = [];
      if (remainder > 0) {
        if (customer.isCashDefault) throw new BadRequestException('البيع الآجل يتطلب عميلاً حقيقياً (ليس الزبون النقدي)');
        const balance = await this.parties.customerBalance(tenantId, customer.id);
        const limit = decToAgora(customer.creditLimit);
        if (limit > 0 && balance + remainder > limit) {
          const canOverride = actor.perms.includes('override_credit_limit');
          if (!canOverride) {
            throw new ForbiddenException(`تجاوز حد الدين: الرصيد ${balance / 100} + الجديد ${remainder / 100} > الحد ${limit / 100}`);
          }
          warnings.push('override_credit_limit: تم تجاوز حد الدين بصلاحية خاصة');
        }
      }

      // Stock out (negative allowed with explicit warning + audit §3); services have no stock effect
      for (const r of resolved) {
        if (r.isService) continue;
        const res = await this.inventory.moveStock(db, { tenantId, branchId, productId: r.productId, variantId: r.variantId, delta: -r.qty });
        if (res.negative) warnings.push(`مخزون سالب: ${r.productId} → ${res.newQty}`);
      }

      // Invoice document
      const invoice = await db.invoice.create({
        data: {
          tenantId, branchId,
          shiftId: input.shiftId ?? null,
          customerId: customer.id,
          refNo: input.refNo ?? null,
          status: 'posted',
          invoiceDiscountAgora: input.invoiceDiscountAgora ?? 0,
          createdAt: date,
          lines: {
            create: resolved.map((r, i) => ({
              productId: r.productId,
              variantId: r.variantId,
              qty: r.qty,
              unitPriceAgora: r.unitPriceAgora,
              lineDiscountAgora: r.lineDiscountAgora,
              invoiceDiscountShareAgora: totals.lines[i].invoiceDiscountShareAgora,
              taxRateBps: r.taxRateBps,
              taxAgora: totals.lines[i].taxAgora,
              netAgora: totals.lines[i].netAgora,
              costAgora: r.costAgora,
            })),
          },
          payments: {
            create: input.payments.map((p) => ({ method: p.method, accountCode: p.accountCode, amount: agoraToDec(p.amountAgora) })),
          },
        },
      });

      // Ledger 1 — sale (§4 rows 1/3 + change row 8): Dr payment accounts (net) + Dr AR remainder / Cr revenue + Cr tax
      const netByAccount = new Map<string, number>();
      for (const p of input.payments) {
        netByAccount.set(p.accountCode, (netByAccount.get(p.accountCode) ?? 0) + p.amountAgora);
      }
      const saleLines = [
        ...[...netByAccount.entries()].flatMap(([code, amt]) =>
          amt > 0
            ? [{ accountCode: code, debitAgora: amt, creditAgora: 0 }]
            : [{ accountCode: code, debitAgora: 0, creditAgora: -amt }],
        ),
        ...(remainder > 0 ? [{ accountCode: AR, debitAgora: remainder, creditAgora: 0, customerId: customer.id }] : []),
        { accountCode: REVENUE, debitAgora: 0, creditAgora: totals.taxableTotalAgora },
        ...(totals.taxTotalAgora > 0 ? [{ accountCode: TAX_PAYABLE, debitAgora: 0, creditAgora: totals.taxTotalAgora }] : []),
      ];
      const saleEntryId = await this.ledger.post({
        tenantId, branchId, fiscalYearId: fy.id, date,
        sourceType: 'sale', sourceId: invoice.id,
        memo: input.refNo ? `فاتورة ${input.refNo}` : 'فاتورة مبيعات',
        lines: saleLines,
      }, db);

      // Ledger 2 — COGS at sale-time cost (§4 row 2)
      const cogsTotal = resolved.reduce((s, r) => s + r.costAgora * r.qty, 0);
      let cogsEntryId: string | null = null;
      if (cogsTotal > 0) {
        cogsEntryId = await this.ledger.post({
          tenantId, branchId, fiscalYearId: fy.id, date,
          sourceType: 'sale_cogs', sourceId: invoice.id,
          memo: `تكلفة مبيعات فاتورة ${invoice.id}`,
          lines: [
            { accountCode: COGS, debitAgora: cogsTotal, creditAgora: 0 },
            { accountCode: INVENTORY, debitAgora: 0, creditAgora: cogsTotal },
          ],
        }, db);
      }

      await auditTx(db, {
        tenantId, actorId: actor.userId, branchId,
        action: 'create', entity: 'invoices', entityId: invoice.id,
        diff: { grandTotalAgora: totals.grandTotalAgora, taxTotalAgora: totals.taxTotalAgora, remainderAgora: remainder, warnings, saleEntryId, cogsEntryId },
        ip: actor.ip ?? null, device: actor.device ?? null,
      });
      await syncOpTx(db, { tenantId, branchId, entity: 'invoice', entityId: invoice.id, op: 'create', payload: { grandTotalAgora: totals.grandTotalAgora, customerId: customer.id } });

      return { invoiceId: invoice.id, totals, remainderAgora: remainder, cogsAgora: cogsTotal, warnings, saleEntryId, cogsEntryId };
    });
  }

  async listInvoices(tenantId: string, q: { branchId?: string; customerId?: string; from?: string; to?: string; refNo?: string; page?: number; pageSize?: number }) {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 50, 200);
    const where = {
      tenantId, deletedAt: null,
      ...(q.branchId ? { branchId: q.branchId } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.refNo ? { refNo: { contains: q.refNo } } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          customer: { select: { id: true, name: true } },
          lines: { select: { netAgora: true, qty: true } },
          payments: { select: { method: true, accountCode: true, amount: true } },
        },
      }),
    ]);
    return {
      total, page, pageSize,
      rows: rows.map((i) => ({
        ...i,
        totalAgora: i.lines.reduce((s, l) => s + l.netAgora, 0),
        payments: i.payments.map((p) => ({ ...p, amountAgora: decToAgora(p.amount) })),
      })),
    };
  }

  async getInvoice(tenantId: string, id: string) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        customer: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        lines: { include: { variant: { select: { id: true, name: true, barcode: true, product: { select: { id: true, name: true } } } } } },
        payments: true,
        shift: { select: { id: true, openedAt: true } },
      },
    });
    if (!inv) throw new NotFoundException('الفاتورة غير موجودة');
    const returned = await this.returnedQtyByInvoice(tenantId, id);
    return {
      ...inv,
      payments: inv.payments.map((p) => ({ ...p, amountAgora: decToAgora(p.amount) })),
      returned: [...returned.entries()].map(([variantId, qty]) => ({ variantId, qty })),
      totalAgora: inv.lines.reduce((s, l) => s + l.netAgora, 0),
    };
  }

  private async returnedQtyByInvoice(tenantId: string, invoiceId: string): Promise<Map<string, number>> {
    const rets = await this.prisma.saleReturn.findMany({ where: { tenantId, sourceInvoiceId: invoiceId }, include: { lines: true } });
    const map = new Map<string, number>();
    for (const r of rets) {
      for (const l of r.lines) map.set(l.variantId, (map.get(l.variantId) ?? 0) + l.qty);
    }
    return map;
  }

  /**
   * Sale return (§4 row 7): Dr revenue + Dr tax + Dr inventory(cost) /
   * Cr refund method + Cr 4100 (restocking fee) + Cr COGS. ONE atomic tx.
   */
  async createReturn(tenantId: string, actor: { userId: string; ip?: string; device?: string }, input: {
    branchId?: string;
    sourceInvoiceId: string;
    lines: { variantId: string; qty: number }[];
    restockingFeeAgora?: number;
    refundMethod: string;
    refundAccountCode: string;
    date?: string;
  }) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id: input.sourceInvoiceId, tenantId, deletedAt: null, status: 'posted' },
      include: { lines: true, customer: true },
    });
    if (!inv) throw new NotFoundException('الفاتورة الأصلية غير موجودة');
    if (!input.lines?.length) throw new BadRequestException('لا توجد أسطر إرجاع');
    const fee = input.restockingFeeAgora ?? 0;
    if (!Number.isInteger(fee) || fee < 0) throw new BadRequestException('خصم إرجاع غير صالح');
    if (input.refundMethod === 'bank') await this.assertBankAccount(tenantId, input.refundAccountCode);

    const already = await this.returnedQtyByInvoice(tenantId, inv.id);
    const date = input.date ? new Date(input.date) : new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);

    // Validate + prorate each returned line from its original invoice line
    const items: { line: typeof inv.lines[number]; qty: number; taxable: number; tax: number; cost: number }[] = [];
    for (const rl of input.lines) {
      if (!Number.isInteger(rl.qty) || rl.qty <= 0) throw new BadRequestException('كمية غير صالحة');
      const orig = inv.lines.find((l) => (l.variantId ?? l.productId ?? '') === rl.variantId || l.variantId === rl.variantId);
      if (!orig) throw new BadRequestException(`السطر غير موجود في الفاتورة: ${rl.variantId}`);
      const returnedBefore = already.get(orig.variantId ?? orig.productId ?? '') ?? 0;
      if (returnedBefore + rl.qty > orig.qty) throw new BadRequestException('الكمية المرجعة تتجاوز المباع');
      const taxable = Math.round((orig.netAgora - orig.taxAgora) * (rl.qty / orig.qty));
      const tax = Math.round(orig.taxAgora * (rl.qty / orig.qty));
      items.push({ line: orig, qty: rl.qty, taxable, tax, cost: orig.costAgora * rl.qty });
    }
    const taxableTotal = items.reduce((s, x) => s + x.taxable, 0);
    const taxTotal = items.reduce((s, x) => s + x.tax, 0);
    const costTotal = items.reduce((s, x) => s + x.cost, 0);
    const refundGross = taxableTotal + taxTotal - fee;
    if (refundGross < 0) throw new BadRequestException('خصم الإرجاع أكبر من قيمة المرتجع');

    return this.prisma.$transaction(async (db: Db) => {
      // stock back in
      for (const it of items) {
        const productId = it.line.variantId
          ? (await db.productVariant.findFirst({ where: { id: it.line.variantId }, select: { productId: true } }))?.productId
          : it.line.productId;
        if (!productId) throw new BadRequestException('تعذر تحديد الصنف للمرتجع');
        await this.inventory.moveStock(db, { tenantId, branchId: inv.branchId, productId, variantId: it.line.variantId ?? null, delta: it.qty });
      }
      const ret = await db.saleReturn.create({
        data: {
          tenantId, branchId: inv.branchId, sourceInvoiceId: inv.id,
          restockingFeeAgora: fee, refundMethod: input.refundMethod, refundAccountCode: input.refundAccountCode,
          createdAt: date,
          lines: { create: items.map((it) => ({ variantId: it.line.variantId ?? it.line.productId ?? '', qty: it.qty })) },
        },
      });
      const entryId = await this.ledger.post({
        tenantId, branchId: inv.branchId, fiscalYearId: fy.id, date,
        sourceType: 'sale_return', sourceId: ret.id,
        memo: `مرتجع من فاتورة ${inv.refNo ?? inv.id}`,
        lines: [
          { accountCode: REVENUE, debitAgora: taxableTotal, creditAgora: 0 },
          ...(taxTotal > 0 ? [{ accountCode: TAX_PAYABLE, debitAgora: taxTotal, creditAgora: 0 }] : []),
          ...(costTotal > 0 ? [{ accountCode: INVENTORY, debitAgora: costTotal, creditAgora: 0 }] : []),
          {
            accountCode: input.refundAccountCode, debitAgora: 0, creditAgora: refundGross,
            ...(input.refundMethod === 'credit' ? { customerId: inv.customerId } : {}),
          },
          ...(fee > 0 ? [{ accountCode: RETURNS_EXPENSE, debitAgora: 0, creditAgora: fee }] : []),
          ...(costTotal > 0 ? [{ accountCode: COGS, debitAgora: 0, creditAgora: costTotal }] : []),
        ],
      }, db);
      await auditTx(db, { tenantId, actorId: actor.userId, branchId: inv.branchId, action: 'create', entity: 'returns', entityId: ret.id, diff: { sourceInvoiceId: inv.id, refundGross, fee, entryId }, ip: actor.ip ?? null, device: actor.device ?? null });
      await syncOpTx(db, { tenantId, branchId: inv.branchId, entity: 'sale_return', entityId: ret.id, op: 'create', payload: { sourceInvoiceId: inv.id, refundGross } });
      return { returnId: ret.id, entryId, refundGrossAgora: refundGross, taxableTotalAgora: taxableTotal, taxTotalAgora: taxTotal, costTotalAgora: costTotal, feeAgora: fee };
    });
  }

  async listReturns(tenantId: string, branchId?: string) {
    const rows = await this.prisma.saleReturn.findMany({
      where: { tenantId, ...(branchId ? { branchId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { lines: true },
    });
    return rows;
  }
}
