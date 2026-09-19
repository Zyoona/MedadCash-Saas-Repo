import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SalesService, type PaymentInput } from '../sales/sales.service.js';
import { agoraToDec } from '../../common/money.util.js';
import { auditTx, type Db } from '../../common/ctx.js';

// Tasks (§Phase5): separate service tasks (e.g. binding/printing jobs) that can be
// billed through POS as a SERVICE product (sku prefix SVC-) when ready for delivery.

const STATUSES = ['open', 'in_progress', 'ready', 'delivered', 'cancelled'] as const;

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService, private readonly sales: SalesService) {}

  async list(tenantId: string, q: { status?: string; customerId?: string; branchId?: string }) {
    const rows = await this.prisma.task.findMany({
      where: {
        tenantId, deletedAt: null,
        ...(q.status ? { status: q.status } : {}),
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(q.branchId ? { branchId: q.branchId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const customerIds = [...new Set(rows.map((t) => t.customerId).filter((x): x is string => !!x))];
    const customers = customerIds.length
      ? await this.prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } })
      : [];
    const byId = new Map(customers.map((c) => [c.id, c]));
    return rows.map((t) => ({ ...t, customer: t.customerId ? byId.get(t.customerId) ?? null : null }));
  }

  async create(tenantId: string, input: { branchId?: string | null; customerId?: string | null; serviceProduct: string; deadline?: string | null; notes?: string }, actorId: string) {
    if (!input.serviceProduct?.trim()) throw new BadRequestException('وصف الخدمة مطلوب');
    return this.prisma.$transaction(async (db: Db) => {
      const t = await db.task.create({
        data: {
          tenantId, branchId: input.branchId ?? null, customerId: input.customerId ?? null,
          serviceProduct: input.serviceProduct.trim(),
          deadline: input.deadline ? new Date(input.deadline) : null,
        },
      });
      await auditTx(db, { tenantId, actorId, branchId: input.branchId ?? null, action: 'create', entity: 'tasks', entityId: t.id, diff: input });
      return t;
    });
  }

  async setStatus(tenantId: string, id: string, status: string, actorId: string) {
    if (!STATUSES.includes(status as never)) throw new BadRequestException('حالة غير صالحة');
    const t = await this.prisma.task.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!t) throw new NotFoundException('المهمة غير موجودة');
    if (t.status === 'delivered' || t.status === 'cancelled') throw new ConflictException('مهمة منتهية');
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.task.update({ where: { id }, data: { status } });
      await auditTx(db, { tenantId, actorId, branchId: t.branchId, action: 'update', entity: 'tasks', entityId: id, diff: { status } });
      return updated;
    });
  }

  /** Bill the task through POS as a service product (no stock effect). */
  async bill(tenantId: string, actor: { userId: string; perms: string[]; ip?: string; device?: string }, id: string, input: {
    priceAgora: number; payments: PaymentInput[]; customerId?: string | null; branchId?: string; taxRateBps?: number;
  }) {
    const t = await this.prisma.task.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!t) throw new NotFoundException('المهمة غير موجودة');
    if (t.status !== 'ready') throw new ConflictException('تُفوتر المهمة عندما تكون جاهزة للتسليم فقط');
    if (!Number.isInteger(input.priceAgora) || input.priceAgora < 0) throw new BadRequestException('سعر غير صالح');
    const branchId = input.branchId ?? t.branchId ?? '';

    // Ensure a service product for this task line
    const sku = `SVC-${id.slice(0, 8)}`;
    let product = await this.prisma.product.findFirst({ where: { tenantId, sku } });
    if (!product) {
      product = await this.prisma.product.create({
        data: { tenantId, name: `خدمة: ${t.serviceProduct}`, sku, lowStockDefault: 0 },
      });
      if (branchId) {
        await this.prisma.productBranch.create({ data: { tenantId, productId: product.id, branchId, price: agoraToDec(input.priceAgora), cost: agoraToDec(0) } });
      }
    }

    const result = await this.sales.createInvoice(tenantId, actor, {
      branchId,
      customerId: input.customerId ?? t.customerId,
      refNo: `TASK-${id.slice(0, 8)}`,
      lines: [{ productId: product.id, qty: 1, unitPriceAgora: input.priceAgora, taxRateBps: input.taxRateBps }],
      payments: input.payments,
    });
    await this.prisma.$transaction(async (db: Db) => {
      await db.task.update({ where: { id }, data: { status: 'delivered' } });
      await auditTx(db, { tenantId, actorId: actor.userId, branchId, action: 'bill', entity: 'tasks', entityId: id, diff: { invoiceId: result.invoiceId, priceAgora: input.priceAgora } });
    });
    return { ...result, taskId: id };
  }
}
