import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { decToAgora } from '../../common/money.util.js';
import { settingValue, type Db } from '../../common/ctx.js';

// Inventory (§3): qty lives ONLY in BranchStock (per branch, per variant).
// moveStock is the single mutation path used by sales/purchases/counts/transfers — always inside their tx.

export interface MoveResult {
  newQty: number;
  negative: boolean;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The single stock mutation path. Negative results are ALLOWED (warning + audit by caller §3). */
  async moveStock(
    db: Db,
    p: { tenantId: string; branchId: string; productId: string; variantId?: string | null; delta: number },
  ): Promise<MoveResult> {
    const variantId = p.variantId ?? null;
    const existing = await db.branchStock.findFirst({
      where: { branchId: p.branchId, productId: p.productId, variantId },
    });
    if (existing) {
      const newQty = existing.qty + p.delta;
      await db.branchStock.update({ where: { id: existing.id }, data: { qty: newQty } });
      return { newQty, negative: newQty < 0 };
    }
    const created = await db.branchStock.create({
      data: { tenantId: p.tenantId, branchId: p.branchId, productId: p.productId, variantId, qty: p.delta },
    });
    return { newQty: created.qty, negative: created.qty < 0 };
  }

  async currentQty(db: Db, branchId: string, productId: string, variantId?: string | null): Promise<number> {
    const row = await db.branchStock.findFirst({
      where: { branchId, productId, variantId: variantId ?? null },
      select: { qty: true },
    });
    return row?.qty ?? 0;
  }

  /** Unit cost (agora) for a product at a branch — used for COGS/adjustments valuation. */
  async unitCostAgora(db: Db, tenantId: string, branchId: string, productId: string): Promise<number> {
    const pb = await db.productBranch.findFirst({ where: { tenantId, branchId, productId }, select: { cost: true } });
    return pb ? decToAgora(pb.cost) : 0;
  }

  /** Full stock view of a branch with alert flags (low / negative). */
  async stockList(tenantId: string, branchId: string, q?: string) {
    const lowDefault = ((await settingValue<{ qty: number }>(this.prisma, tenantId, 'low_stock_default', branchId)) ?? { qty: 0 }).qty;
    const products = await this.prisma.product.findMany({
      where: {
        tenantId, deletedAt: null,
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { name: 'asc' },
      include: {
        variants: { where: { deletedAt: null }, select: { id: true, name: true, barcode: true } },
        branchData: { where: { branchId }, select: { price: true, cost: true, minAlert: true } },
        category: { select: { name: true } },
        brand: { select: { name: true } },
      },
      take: 500,
    });
    const stocks = await this.prisma.branchStock.findMany({ where: { tenantId, branchId } });
    const byProduct = new Map<string, { variantId: string | null; qty: number }[]>();
    for (const s of stocks) {
      const list = byProduct.get(s.productId) ?? [];
      list.push({ variantId: s.variantId, qty: s.qty });
      byProduct.set(s.productId, list);
    }
    return products.map((p) => {
      const bd = p.branchData[0];
      const rows = byProduct.get(p.id) ?? [];
      const totalQty = rows.reduce((s, r) => s + r.qty, 0);
      const threshold = bd?.minAlert ?? p.lowStockDefault ?? lowDefault;
      return {
        id: p.id, name: p.name, sku: p.sku, isContainer: p.isContainer, imageUrl: p.imageUrl,
        category: p.category?.name ?? null, brand: p.brand?.name ?? null,
        variants: p.variants,
        priceAgora: bd ? decToAgora(bd.price) : null,
        costAgora: bd ? decToAgora(bd.cost) : null,
        minAlert: threshold,
        rows, totalQty,
        low: totalQty <= threshold,
        negative: rows.some((r) => r.qty < 0),
      };
    });
  }

  /** النواقص والسالب (§Phase2 alerts). */
  async alerts(tenantId: string, branchId: string) {
    const all = await this.stockList(tenantId, branchId);
    return {
      low: all.filter((p) => p.low && !p.negative),
      negative: all.filter((p) => p.negative),
    };
  }

  /** Daily-count wizard data (§Phase5): الصندوق→البنك→الديون→الجرد. */
  async dailyWizard(tenantId: string, branchId: string) {
    const balances: Record<string, number> = {};
    for (const code of ['1000', '1100', '1200', '1300', '2000', '2100', '1500']) {
      const sums = await this.prisma.journalLine.groupBy({
        by: ['accountId'],
        where: { entry: { tenantId }, account: { code } },
        _sum: { debit: true, credit: true },
      });
      balances[code] = sums.reduce((s, r) => s + decToAgora(r._sum.debit) - decToAgora(r._sum.credit), 0);
    }
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayInvoices = await this.prisma.invoice.findMany({
      where: { tenantId, branchId, status: 'posted', createdAt: { gte: startOfDay } },
      include: { lines: { select: { netAgora: true } } },
    });
    const openShift = await this.prisma.shift.findFirst({
      where: { tenantId, branchId, closedAt: null },
      orderBy: { openedAt: 'desc' },
    });
    const alerts = await this.alerts(tenantId, branchId);
    return {
      balances,
      todaySalesAgora: todayInvoices.reduce((s, i) => s + i.lines.reduce((x, l) => x + l.netAgora, 0), 0),
      todayInvoicesCount: todayInvoices.length,
      openShift: openShift ? { id: openShift.id, openedAt: openShift.openedAt, openingAmountAgora: decToAgora(openShift.openingAmount) } : null,
      alerts: { lowCount: alerts.low.length, negativeCount: alerts.negative.length },
    };
  }
}
