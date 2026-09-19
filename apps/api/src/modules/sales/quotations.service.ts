import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SalesService, type PaymentInput } from './sales.service.js';
import { auditTx, type Db } from '../../common/ctx.js';

// Quotations (§Phase4): manual expiry + open-by-ref inside POS + convert to invoice
// + expired handling (alert + renew or bill normally).

@Injectable()
export class QuotationsService {
  constructor(private readonly prisma: PrismaService, private readonly sales: SalesService) {}

  async create(tenantId: string, input: {
    branchId: string; customerId?: string | null; expiryDate: string;
    refNo?: string;
    lines: { variantId: string; qty: number; unitPriceAgora: number }[];
  }, actorId: string) {
    if (!input.lines?.length) throw new BadRequestException('لا توجد أسطر');
    const expiry = new Date(input.expiryDate);
    if (isNaN(expiry.getTime())) throw new BadRequestException('تاريخ صلاحية غير صالح');
    return this.prisma.$transaction(async (db: Db) => {
      const q = await db.quotation.create({
        data: {
          tenantId, branchId: input.branchId, customerId: input.customerId ?? null, expiryDate: expiry,
          lines: { create: input.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPriceAgora: l.unitPriceAgora })) },
        },
        include: { lines: true },
      });
      if (input.refNo) await db.quotation.update({ where: { id: q.id }, data: { convertedInvoiceId: null } }); // refNo lives on invoice side; kept minimal
      await auditTx(db, { tenantId, actorId, branchId: input.branchId, action: 'create', entity: 'quotations', entityId: q.id, diff: { expiryDate: input.expiryDate, lines: input.lines.length } });
      return q;
    });
  }

  async list(tenantId: string, branchId?: string) {
    // Auto-expire open quotations past their date (alert on read)
    await this.prisma.quotation.updateMany({
      where: { tenantId, status: 'open', expiryDate: { lt: new Date() } },
      data: { status: 'expired' },
    });
    const rows = await this.prisma.quotation.findMany({
      where: { tenantId, deletedAt: null, ...(branchId ? { branchId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { lines: true },
    });
    const customerIds = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))];
    const customers = customerIds.length
      ? await this.prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } })
      : [];
    const byId = new Map(customers.map((c) => [c.id, c]));
    return rows.map((r) => ({ ...r, customer: r.customerId ? byId.get(r.customerId) ?? null : null }));
  }

  async get(tenantId: string, id: string) {
    const q = await this.prisma.quotation.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { lines: true },
    });
    if (!q) throw new NotFoundException('عرض السعر غير موجود');
    const variantIds = q.lines.map((l) => l.variantId);
    const variants = variantIds.length
      ? await this.prisma.productVariant.findMany({ where: { id: { in: variantIds } }, include: { product: { select: { id: true, name: true } } } })
      : [];
    const variantById = new Map(variants.map((v) => [v.id, v]));
    const customer = q.customerId ? await this.prisma.customer.findFirst({ where: { id: q.customerId } }) : null;
    return { ...q, customer, lines: q.lines.map((l) => ({ ...l, variant: variantById.get(l.variantId) ?? null })) };
  }

  async renew(tenantId: string, id: string, expiryDate: string, actorId: string) {
    const q = await this.prisma.quotation.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!q) throw new NotFoundException('عرض السعر غير موجود');
    if (q.status === 'converted' || q.status === 'cancelled') throw new ConflictException('لا يمكن تجديد عرض محول/ملغى');
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.quotation.update({ where: { id }, data: { status: 'open', expiryDate: new Date(expiryDate) } });
      await auditTx(db, { tenantId, actorId, branchId: q.branchId, action: 'renew', entity: 'quotations', entityId: id, diff: { expiryDate } });
      return updated;
    });
  }

  async cancel(tenantId: string, id: string, actorId: string) {
    const q = await this.prisma.quotation.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!q) throw new NotFoundException('عرض السعر غير موجود');
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.quotation.update({ where: { id }, data: { status: 'cancelled' } });
      await auditTx(db, { tenantId, actorId, branchId: q.branchId, action: 'cancel', entity: 'quotations', entityId: id });
      return updated;
    });
  }

  /** Convert to a real invoice through SalesService (same binding math + ledger). */
  async convert(tenantId: string, actor: { userId: string; perms: string[]; ip?: string; device?: string }, id: string, input: {
    payments: PaymentInput[]; customerId?: string | null; branchId?: string; invoiceDiscountAgora?: number; shiftId?: string | null;
  }) {
    const q = await this.prisma.quotation.findFirst({ where: { id, tenantId, deletedAt: null }, include: { lines: true } });
    if (!q) throw new NotFoundException('عرض السعر غير موجود');
    if (q.status === 'converted') throw new ConflictException('محول مسبقاً');
    if (q.status === 'cancelled') throw new ConflictException('عرض ملغى');

    const result = await this.sales.createInvoice(tenantId, actor, {
      branchId: input.branchId ?? q.branchId,
      customerId: input.customerId ?? q.customerId,
      shiftId: input.shiftId ?? null,
      refNo: `QUO-${q.id.slice(0, 8)}`,
      invoiceDiscountAgora: input.invoiceDiscountAgora ?? 0,
      lines: q.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPriceAgora: l.unitPriceAgora })),
      payments: input.payments,
    });

    await this.prisma.$transaction(async (db: Db) => {
      await db.quotation.update({ where: { id }, data: { status: 'converted', convertedInvoiceId: result.invoiceId } });
      await auditTx(db, { tenantId, actorId: actor.userId, branchId: q.branchId, action: 'convert', entity: 'quotations', entityId: id, diff: { invoiceId: result.invoiceId } });
    });
    return result;
  }
}
