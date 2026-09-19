import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { agoraToDec } from '../../common/money.util.js';
import { auditTx, fiscalYearFor, syncOpTx, type Db } from '../../common/ctx.js';

const INVENTORY = '1400';
const ADJUSTMENTS = '5200'; // تسويات الجرد (عجز/فائض)
const OPENING = '3900'; // الجرد الأولي مقابل أرصدة افتتاحية

// Stock counts (§Phase5): initial/daily. Difference (counted − expected) adjusts stock
// with a ledger effect in the SAME tx: daily → 5200, initial → 3900.

@Injectable()
export class CountsService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly inventory: InventoryService) {}

  async create(tenantId: string, input: {
    branchId: string;
    type: 'initial' | 'daily';
    notes?: string;
    lines: { productId: string; variantId?: string | null; countedQty: number }[];
  }, actorId: string) {
    if (!['initial', 'daily'].includes(input.type)) throw new BadRequestException('نوع جرد غير صالح');
    if (!input.lines?.length) throw new BadRequestException('لا توجد أسطر جرد');
    const date = new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);

    return this.prisma.$transaction(async (db: Db) => {
      const rows: { variantId: string; expectedQty: number; countedQty: number }[] = [];
      let netAdjustmentAgora = 0;
      const details: { productId: string; variantId: string | null; delta: number; costAgora: number }[] = [];

      for (const l of input.lines) {
        if (!Number.isInteger(l.countedQty) || l.countedQty < 0) throw new BadRequestException('كمية معدودة غير صالحة');
        const variantId = l.variantId ?? null;
        const expected = await this.inventory.currentQty(db, input.branchId, l.productId, variantId);
        const delta = l.countedQty - expected;
        rows.push({ variantId: variantId ?? l.productId, expectedQty: expected, countedQty: l.countedQty });
        if (delta !== 0) {
          const cost = await this.inventory.unitCostAgora(db, tenantId, input.branchId, l.productId);
          await this.inventory.moveStock(db, { tenantId, branchId: input.branchId, productId: l.productId, variantId, delta });
          netAdjustmentAgora += delta * cost;
          details.push({ productId: l.productId, variantId, delta, costAgora: cost });
        }
      }

      const count = await db.stockCount.create({
        data: {
          tenantId, branchId: input.branchId, type: input.type, notes: input.notes ?? null,
          lines: { create: rows },
        },
        include: { lines: true },
      });

      let entryId: string | null = null;
      if (netAdjustmentAgora !== 0) {
        const contra = input.type === 'initial' ? OPENING : ADJUSTMENTS;
        const abs = Math.abs(netAdjustmentAgora);
        // فائض: Dr 1400 Cr contra | عجز: Dr contra Cr 1400 (§4 row 11)
        const lines = netAdjustmentAgora > 0
          ? [
              { accountCode: INVENTORY, debitAgora: abs, creditAgora: 0 },
              { accountCode: contra, debitAgora: 0, creditAgora: abs },
            ]
          : [
              { accountCode: contra, debitAgora: abs, creditAgora: 0 },
              { accountCode: INVENTORY, debitAgora: 0, creditAgora: abs },
            ];
        entryId = await this.ledger.post({
          tenantId, branchId: input.branchId, fiscalYearId: fy.id, date,
          sourceType: 'stock_adjustment', sourceId: count.id,
          memo: `${input.type === 'initial' ? 'جرد أولي' : 'جرد يومي'} — فرق ${netAdjustmentAgora / 100} ₪`,
          lines,
        }, db);
      }

      await auditTx(db, { tenantId, actorId, branchId: input.branchId, action: 'create', entity: 'stock_counts', entityId: count.id, diff: { type: input.type, netAdjustmentAgora, details, entryId } });
      await syncOpTx(db, { tenantId, branchId: input.branchId, entity: 'stock_count', entityId: count.id, op: 'create', payload: { type: input.type, netAdjustmentAgora } });
      return { count, netAdjustmentAgora, entryId };
    });
  }

  list(tenantId: string, branchId?: string) {
    return this.prisma.stockCount.findMany({
      where: { tenantId, ...(branchId ? { branchId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { lines: true, branch: { select: { name: true } } },
    });
  }

  get(tenantId: string, id: string) {
    return this.prisma.stockCount.findFirst({ where: { id, tenantId }, include: { lines: true, branch: true } });
  }
}

void agoraToDec;
