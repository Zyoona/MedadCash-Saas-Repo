import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { allocateProRata, agoraToDec, decToAgora, mulBps } from '../../common/money.util.js';
import { auditTx, fiscalYearFor, syncOpTx, type Db } from '../../common/ctx.js';

const INVENTORY = '1400';
const INPUT_TAX = '1500';
const AP = '2000';

// Purchases (§Phase3): ordered/pending have NO stock/ledger effect.
// Transition to `received` is ONE atomic tx: stock in + entry + partial payments + AP remainder.

export interface PurchaseLineInput {
  variantId: string;
  qty: number;
  unitCostAgora: number;
  lineDiscountAgora?: number;
}

export interface PurchaseTotals {
  lines: { variantId: string; productId: string; qty: number; grossAgora: number; afterLineDiscountAgora: number; discountShareAgora: number; taxableAgora: number; taxAgora: number; netUnitCostAgora: number }[];
  inventoryTotalAgora: number;
  taxTotalAgora: number;
  grandTotalAgora: number;
}

@Injectable()
export class PurchasesService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly inventory: InventoryService) {}

  async list(tenantId: string, q: { branchId?: string; status?: string; supplierId?: string; q?: string; from?: string; to?: string }) {
    const term = q.q?.trim();
    const rows = await this.prisma.purchase.findMany({
      where: {
        tenantId, deletedAt: null,
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.supplierId ? { supplierId: q.supplierId } : {}),
        ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
        ...(term
          ? {
              OR: [
                { refNo: { contains: term, mode: 'insensitive' as const } },
                { supplier: { is: { name: { contains: term, mode: 'insensitive' as const } } } },
              ],
            }
          : {}),
      },
      // الأحدث أولاً ثم الأقدم
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        supplier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        lines: true,
        payments: { orderBy: { createdAt: 'asc' } },
      },
      take: 200,
    });
    return rows.map((p) => {
      const totals = this.safeTotals(p.lines, p.discountAgora, p.taxRateBps);
      const paidAgora = p.payments.reduce((s, x) => s + decToAgora(x.amount), 0);
      return {
        id: p.id, status: p.status, refNo: p.refNo, createdAt: p.createdAt, notes: p.notes,
        discountAgora: p.discountAgora, taxRateBps: p.taxRateBps, taxAgora: p.taxAgora,
        supplier: p.supplier, branch: p.branch,
        lines: p.lines.map((l) => ({ id: l.id, variantId: l.variantId, qty: l.qty, unitCostAgora: l.unitCostAgora, lineDiscountAgora: l.lineDiscountAgora })),
        payments: p.payments.map((x) => ({ id: x.id, accountCode: x.accountCode, amountAgora: decToAgora(x.amount), createdAt: x.createdAt })),
        totals: totals && {
          grandTotalAgora: totals.grandTotalAgora,
          paidAgora,
          remainderAgora: Math.max(0, totals.grandTotalAgora - paidAgora),
        },
      };
    });
  }

  /** إجماليات عرض القائمة فقط — لا ترمي أخطاء (بيانات تاريخية قد تكون غير متسقة) */
  private safeTotals(lines: { variantId: string; qty: number; unitCostAgora: number; lineDiscountAgora: number }[], discountAgora: number, taxRateBps: number) {
    try {
      return this.computeTotals(lines.map((l) => ({ ...l, productId: '' })), discountAgora, taxRateBps);
    } catch {
      return null;
    }
  }

  async get(tenantId: string, id: string) {
    const p = await this.prisma.purchase.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        supplier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        lines: { include: { variant: { select: { id: true, name: true, barcode: true, product: { select: { id: true, name: true } } } } } },
        payments: true,
      },
    });
    if (!p) throw new NotFoundException('فاتورة الشراء غير موجودة');
    return { ...p, payments: p.payments.map((x) => ({ ...x, amountAgora: decToAgora(x.amount) })) };
  }

  async create(tenantId: string, input: {
    branchId: string; supplierId: string; refNo?: string; notes?: string;
    discountAgora?: number; taxRateBps?: number;
    lines: PurchaseLineInput[];
  }, actorId: string) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: input.supplierId, tenantId, deletedAt: null } });
    if (!supplier) throw new NotFoundException('المورد غير موجود');
    if (!input.lines?.length) throw new BadRequestException('لا توجد أسطر');
    for (const l of input.lines) {
      if (!Number.isInteger(l.qty) || l.qty <= 0) throw new BadRequestException('كمية غير صالحة');
      if (!Number.isInteger(l.unitCostAgora) || l.unitCostAgora < 0) throw new BadRequestException('تكلفة غير صالحة');
      if (l.lineDiscountAgora !== undefined && (!Number.isInteger(l.lineDiscountAgora) || l.lineDiscountAgora < 0)) throw new BadRequestException('خصم سطر غير صالح');
    }
    const discountAgora = input.discountAgora ?? 0;
    if (!Number.isInteger(discountAgora) || discountAgora < 0) throw new BadRequestException('خصم غير صالح');

    return this.prisma.$transaction(async (db: Db) => {
      const p = await db.purchase.create({
        data: {
          tenantId, branchId: input.branchId, supplierId: input.supplierId,
          status: 'ordered', refNo: input.refNo ?? null, notes: input.notes ?? null,
          discountAgora, taxRateBps: input.taxRateBps ?? 0,
          lines: {
            create: input.lines.map((l) => ({
              variantId: l.variantId, qty: l.qty,
              unitCostAgora: l.unitCostAgora,
              lineDiscountAgora: l.lineDiscountAgora ?? 0,
            })),
          },
        },
        include: { lines: true },
      });
      await auditTx(db, { tenantId, actorId, branchId: input.branchId, action: 'create', entity: 'purchases', entityId: p.id, diff: { supplierId: input.supplierId, lines: input.lines.length, status: 'ordered' } });
      await syncOpTx(db, { tenantId, branchId: input.branchId, entity: 'purchase', entityId: p.id, op: 'create', payload: { status: 'ordered', supplierId: input.supplierId } });
      return p;
    });
  }

  async setStatus(tenantId: string, id: string, status: 'pending' | 'received', actorId: string, payments?: { accountCode: string; amountAgora: number }[]) {
    const p = await this.prisma.purchase.findFirst({ where: { id, tenantId, deletedAt: null }, include: { lines: true } });
    if (!p) throw new NotFoundException('فاتورة الشراء غير موجودة');
    if (p.status === 'received') throw new ConflictException('مستلمة مسبقاً');
    const allowed: Record<string, string[]> = { ordered: ['pending', 'received'], pending: ['received'] };
    if (!allowed[p.status]?.includes(status)) throw new BadRequestException(`انتقال حالة غير صالح: ${p.status} → ${status}`);
    if (status === 'pending') {
      return this.prisma.$transaction(async (db: Db) => {
        const updated = await db.purchase.update({ where: { id }, data: { status: 'pending' } });
        await auditTx(db, { tenantId, actorId, branchId: p.branchId, action: 'update', entity: 'purchases', entityId: id, diff: { status: 'pending' } });
        return updated;
      });
    }
    return this.receive(tenantId, p, payments ?? [], actorId);
  }

  /** Compute totals with the BINDING order: line discount → pro-rata purchase discount → tax after discounts. */
  computeTotals(lines: { variantId: string; productId: string; qty: number; unitCostAgora: number; lineDiscountAgora: number }[], discountAgora: number, taxRateBps: number): PurchaseTotals {
    const gross = lines.map((l) => l.qty * l.unitCostAgora);
    const afterLine = lines.map((l, i) => {
      const v = gross[i] - l.lineDiscountAgora;
      if (v < 0) throw new BadRequestException('خصم السطر أكبر من إجماليه');
      return v;
    });
    const subtotal = afterLine.reduce((s, x) => s + x, 0);
    if (discountAgora > subtotal) throw new BadRequestException('خصم الفاتورة أكبر من الإجمالي');
    const shares = allocateProRata(discountAgora, afterLine);
    const computed = lines.map((l, i) => {
      const taxable = afterLine[i] - shares[i];
      const tax = mulBps(taxable, taxRateBps);
      return {
        variantId: l.variantId, productId: l.productId, qty: l.qty,
        grossAgora: gross[i], afterLineDiscountAgora: afterLine[i],
        discountShareAgora: shares[i], taxableAgora: taxable, taxAgora: tax,
        netUnitCostAgora: Math.floor(taxable / l.qty),
      };
    });
    const inventoryTotal = computed.reduce((s, c) => s + c.taxableAgora, 0);
    const taxTotal = computed.reduce((s, c) => s + c.taxAgora, 0);
    return { lines: computed, inventoryTotalAgora: inventoryTotal, taxTotalAgora: taxTotal, grandTotalAgora: inventoryTotal + taxTotal };
  }

  /** RECEIVED: the only state with stock + accounting effect (§3, §9.3). One atomic tx. */
  private async receive(tenantId: string, p: { id: string; branchId: string; supplierId: string; discountAgora: number; taxRateBps: number; taxAgora: number; refNo: string | null; lines: { variantId: string; qty: number; unitCostAgora: number; lineDiscountAgora: number }[] }, payments: { accountCode: string; amountAgora: number }[], actorId: string) {
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: p.lines.map((l) => l.variantId) } },
      select: { id: true, productId: true },
    });
    const variantProduct = new Map(variants.map((v) => [v.id, v.productId]));
    const linesWithProduct = p.lines.map((l) => ({
      ...l,
      productId: variantProduct.get(l.variantId) ?? '',
    }));
    if (linesWithProduct.some((l) => !l.productId)) throw new BadRequestException('متغير غير معروف في الأسطر');

    const totals = this.computeTotals(linesWithProduct, p.discountAgora, p.taxRateBps);
    for (const pay of payments) {
      if (!Number.isInteger(pay.amountAgora) || pay.amountAgora < 0) throw new BadRequestException('دفعة غير صالحة');
    }
    const paid = payments.reduce((s, x) => s + x.amountAgora, 0);
    if (paid > totals.grandTotalAgora) throw new BadRequestException('المدفوع أكبر من الإجمالي');
    const remainder = totals.grandTotalAgora - paid; // الباقي ذمم تلقائياً

    const date = new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);

    return this.prisma.$transaction(async (db: Db) => {
      // 1) stock in per line
      for (const l of totals.lines) {
        await this.inventory.moveStock(db, { tenantId, branchId: p.branchId, productId: l.productId, variantId: l.variantId, delta: l.qty });
        // last-cost valuation per branch
        await db.productBranch.updateMany({
          where: { tenantId, branchId: p.branchId, productId: l.productId },
          data: { cost: agoraToDec(l.netUnitCostAgora) },
        });
      }
      // 2) payments rows
      for (const pay of payments) {
        if (pay.amountAgora > 0) {
          await db.supplierPayment.create({ data: { purchaseId: p.id, accountCode: pay.accountCode, amount: agoraToDec(pay.amountAgora) } });
        }
      }
      // 3) ledger entry: Dr 1400 + Dr 1500 / Cr payments + Cr 2000 remainder (§4 row 5)
      const grouped = new Map<string, number>();
      for (const pay of payments) {
        if (pay.amountAgora > 0) grouped.set(pay.accountCode, (grouped.get(pay.accountCode) ?? 0) + pay.amountAgora);
      }
      const lines = [
        { accountCode: INVENTORY, debitAgora: totals.inventoryTotalAgora, creditAgora: 0 },
        ...(totals.taxTotalAgora > 0 ? [{ accountCode: INPUT_TAX, debitAgora: totals.taxTotalAgora, creditAgora: 0 }] : []),
        ...[...grouped.entries()].map(([code, amt]) => ({ accountCode: code, debitAgora: 0, creditAgora: amt })),
        ...(remainder > 0 ? [{ accountCode: AP, debitAgora: 0, creditAgora: remainder, supplierId: p.supplierId }] : []),
      ];
      const entryId = await this.ledger.post({
        tenantId, branchId: p.branchId, fiscalYearId: fy.id, date,
        sourceType: 'purchase', sourceId: p.id,
        memo: `استلام مشتريات ${p.refNo ?? p.id}`,
        lines,
      }, db);
      // 4) status + tax snapshot
      const updated = await db.purchase.update({ where: { id: p.id }, data: { status: 'received', taxAgora: totals.taxTotalAgora } });
      await auditTx(db, { tenantId, actorId, branchId: p.branchId, action: 'receive', entity: 'purchases', entityId: p.id, diff: { totals, payments, remainderAgora: remainder, entryId } });
      await syncOpTx(db, { tenantId, branchId: p.branchId, entity: 'purchase', entityId: p.id, op: 'update', payload: { status: 'received', grandTotalAgora: totals.grandTotalAgora } });
      return { purchase: updated, totals, entryId, remainderAgora: remainder };
    });
  }
}
