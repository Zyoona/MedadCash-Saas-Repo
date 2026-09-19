import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { auditTx, fiscalYearFor, syncOpTx, type Db } from '../../common/ctx.js';

const INVENTORY = '1400';
const IN_TRANSIT = '1410'; // مخزون قيد النقل (وسيط)

// Branch transfers (§Phase5 + §4 row 12):
//  create → deduct from source IMMEDIATELY into in-transit account (Dr 1410 Cr 1400)
//  receive → add to destination (Dr 1400 Cr 1410). Qty never lost mid-transfer (§9.4).

@Injectable()
export class TransfersService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly inventory: InventoryService) {}

  async create(tenantId: string, input: {
    fromBranchId: string; toBranchId: string;
    lines: { variantId: string; qty: number }[];
  }, actorId: string) {
    if (input.fromBranchId === input.toBranchId) throw new BadRequestException('الفرعان متطابقان');
    if (!input.lines?.length) throw new BadRequestException('لا توجد أسطر');
    const variants = await this.prisma.productVariant.findMany({ where: { id: { in: input.lines.map((l) => l.variantId) } }, select: { id: true, productId: true } });
    const productOf = new Map(variants.map((v) => [v.id, v.productId]));
    const date = new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);

    return this.prisma.$transaction(async (db: Db) => {
      let totalCostAgora = 0;
      const lineRows: { variantId: string; qty: number; costAgora: number }[] = [];
      const warnings: string[] = [];
      for (const l of input.lines) {
        if (!Number.isInteger(l.qty) || l.qty <= 0) throw new BadRequestException('كمية غير صالحة');
        const productId = productOf.get(l.variantId);
        if (!productId) throw new NotFoundException(`متغير غير معروف: ${l.variantId}`);
        const cost = await this.inventory.unitCostAgora(db, tenantId, input.fromBranchId, productId);
        const res = await this.inventory.moveStock(db, { tenantId, branchId: input.fromBranchId, productId, variantId: l.variantId, delta: -l.qty });
        if (res.negative) warnings.push(`مخزون سالب في المصدر: ${l.variantId} → ${res.newQty}`);
        totalCostAgora += cost * l.qty;
        lineRows.push({ variantId: l.variantId, qty: l.qty, costAgora: cost });
      }

      const transfer = await db.stockTransfer.create({
        data: {
          tenantId, fromBranchId: input.fromBranchId, toBranchId: input.toBranchId, status: 'in_transit',
          lines: { create: lineRows },
        },
        include: { lines: true },
      });

      let entryId: string | null = null;
      if (totalCostAgora > 0) {
        entryId = await this.ledger.post({
          tenantId, branchId: input.fromBranchId, fiscalYearId: fy.id, date,
          sourceType: 'stock_transfer_out', sourceId: transfer.id,
          memo: `تحويل صادر إلى فرع ${input.toBranchId}`,
          lines: [
            { accountCode: IN_TRANSIT, debitAgora: totalCostAgora, creditAgora: 0 },
            { accountCode: INVENTORY, debitAgora: 0, creditAgora: totalCostAgora },
          ],
        }, db);
      }
      await auditTx(db, { tenantId, actorId, branchId: input.fromBranchId, action: 'create', entity: 'stock_transfers', entityId: transfer.id, diff: { toBranchId: input.toBranchId, totalCostAgora, entryId, warnings } });
      await syncOpTx(db, { tenantId, branchId: input.fromBranchId, entity: 'stock_transfer', entityId: transfer.id, op: 'create', payload: { status: 'in_transit', totalCostAgora } });
      return { transfer, totalCostAgora, entryId, warnings };
    });
  }

  async receive(tenantId: string, id: string, actorId: string) {
    const t = await this.prisma.stockTransfer.findFirst({ where: { id, tenantId }, include: { lines: true } });
    if (!t) throw new NotFoundException('التحويل غير موجود');
    if (t.status === 'received') throw new ConflictException('مستلم مسبقاً');
    const date = new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);

    return this.prisma.$transaction(async (db: Db) => {
      let totalCostAgora = 0;
      for (const l of t.lines) {
        const variant = await db.productVariant.findFirst({ where: { id: l.variantId }, select: { productId: true } });
        if (!variant) throw new NotFoundException(`متغير غير معروف: ${l.variantId}`);
        await this.inventory.moveStock(db, { tenantId, branchId: t.toBranchId, productId: variant.productId, variantId: l.variantId, delta: l.qty });
        totalCostAgora += l.costAgora * l.qty;
      }
      const updated = await db.stockTransfer.update({ where: { id }, data: { status: 'received' } });
      let entryId: string | null = null;
      if (totalCostAgora > 0) {
        entryId = await this.ledger.post({
          tenantId, branchId: t.toBranchId, fiscalYearId: fy.id, date,
          sourceType: 'stock_transfer_in', sourceId: id,
          memo: `استلام تحويل من فرع ${t.fromBranchId}`,
          lines: [
            { accountCode: INVENTORY, debitAgora: totalCostAgora, creditAgora: 0 },
            { accountCode: IN_TRANSIT, debitAgora: 0, creditAgora: totalCostAgora },
          ],
        }, db);
      }
      await auditTx(db, { tenantId, actorId, branchId: t.toBranchId, action: 'receive', entity: 'stock_transfers', entityId: id, diff: { totalCostAgora, entryId } });
      await syncOpTx(db, { tenantId, branchId: t.toBranchId, entity: 'stock_transfer', entityId: id, op: 'update', payload: { status: 'received' } });
      return { transfer: updated, totalCostAgora, entryId };
    });
  }

  list(tenantId: string, status?: string) {
    return this.prisma.stockTransfer.findMany({
      where: { tenantId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { lines: true, fromBranch: { select: { name: true } }, toBranch: { select: { name: true } } },
    });
  }
}
