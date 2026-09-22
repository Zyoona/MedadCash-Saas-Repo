import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { agoraToDec, decToAgora } from '../../common/money.util.js';
import { auditTx, fiscalYearFor, syncOpTx, type Db } from '../../common/ctx.js';

const AR = '1300';
const AP = '2000';
const OPENING = '3900';

@Injectable()
export class PartiesService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService) {}

  // ─── Customers (فرعي + افتتاحي + حد دين §3) ───

  async listCustomers(tenantId: string, branchId?: string | null) {
    const rows = await this.prisma.customer.findMany({
      where: { tenantId, deletedAt: null, ...(branchId ? { branchId } : {}) },
      orderBy: { name: 'asc' },
    });
    const balances = await this.balancesByParty(tenantId, AR, 'customerId');
    return rows.map((c) => ({
      ...c,
      openingBalanceAgora: decToAgora(c.openingBalance),
      creditLimitAgora: decToAgora(c.creditLimit),
      balanceAgora: balances.get(c.id) ?? 0,
    }));
  }

  /** Dr-Cr sums of journal lines tagged with customerId/supplierId on AR/AP account. */
  private async balancesByParty(tenantId: string, accountCode: string, partyField: 'customerId' | 'supplierId'): Promise<Map<string, number>> {
    const lines = await this.prisma.journalLine.findMany({
      where: { entry: { tenantId }, account: { code: accountCode }, [partyField]: { not: null } },
      select: { debit: true, credit: true, customerId: true, supplierId: true },
    });
    const map = new Map<string, number>();
    for (const l of lines) {
      const key = (partyField === 'customerId' ? l.customerId : l.supplierId) as string;
      map.set(key, (map.get(key) ?? 0) + decToAgora(l.debit) - decToAgora(l.credit));
    }
    return map;
  }

  async customerBalance(tenantId: string, customerId: string): Promise<number> {
    const m = await this.balancesByParty(tenantId, AR, 'customerId');
    return m.get(customerId) ?? 0;
  }

  async supplierBalance(tenantId: string, supplierId: string): Promise<number> {
    const m = await this.balancesByParty(tenantId, AP, 'supplierId');
    return -(m.get(supplierId) ?? 0); // AP is credit-normal: return positive owed amount
  }

  async createCustomer(tenantId: string, input: {
    branchId: string; name: string; phone?: string;
    openingBalanceAgora?: number; openingDate?: string;
    creditLimitAgora?: number; paymentTerms?: string;
  }, actorId: string) {
    if (!input.name?.trim()) throw new BadRequestException('اسم العميل مطلوب');
    const opening = input.openingBalanceAgora ?? 0;
    if (!Number.isInteger(opening)) throw new BadRequestException('الرصيد الافتتاحي أغورات صحيحة');
    const date = input.openingDate ? new Date(input.openingDate) : new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);

    return this.prisma.$transaction(async (db: Db) => {
      const c = await db.customer.create({
        data: {
          tenantId, branchId: input.branchId, name: input.name.trim(), phone: input.phone ?? null,
          openingBalance: agoraToDec(opening), openingDate: opening !== 0 ? date : null,
          creditLimit: agoraToDec(input.creditLimitAgora ?? 0),
          paymentTerms: input.paymentTerms ?? null,
        },
      });
      if (opening !== 0) {
        // Opening debit balance (مدين): Dr AR / Cr 3900. Negative opening → mirrored.
        const lines = opening > 0
          ? [
              { accountCode: AR, debitAgora: opening, creditAgora: 0, customerId: c.id },
              { accountCode: OPENING, debitAgora: 0, creditAgora: opening },
            ]
          : [
              { accountCode: OPENING, debitAgora: -opening, creditAgora: 0 },
              { accountCode: AR, debitAgora: 0, creditAgora: -opening, customerId: c.id },
            ];
        await this.ledger.post({
          tenantId, branchId: input.branchId, fiscalYearId: fy.id, date,
          sourceType: 'opening_balance', sourceId: c.id,
          memo: `رصيد افتتاحي لعميل: ${c.name}`, lines,
        }, db);
      }
      await auditTx(db, { tenantId, actorId, branchId: input.branchId, action: 'create', entity: 'customers', entityId: c.id, diff: input });
      await syncOpTx(db, { tenantId, branchId: input.branchId, entity: 'customer', entityId: c.id, op: 'create', payload: { name: c.name, phone: c.phone, openingBalanceAgora: opening, creditLimitAgora: input.creditLimitAgora ?? 0 } });
      return c;
    });
  }

  async updateCustomer(tenantId: string, id: string, patch: { name?: string; phone?: string | null; creditLimitAgora?: number; paymentTerms?: string | null }, actorId: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!c) throw new NotFoundException('العميل غير موجود');
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.customer.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
          ...(patch.creditLimitAgora !== undefined ? { creditLimit: agoraToDec(patch.creditLimitAgora) } : {}),
          ...(patch.paymentTerms !== undefined ? { paymentTerms: patch.paymentTerms } : {}),
        },
      });
      await auditTx(db, { tenantId, actorId, branchId: c.branchId, action: 'update', entity: 'customers', entityId: id, diff: patch });
      await syncOpTx(db, { tenantId, branchId: c.branchId, entity: 'customer', entityId: id, op: 'update', payload: { ...patch, baseUpdatedAt: c.createdAt } });
      return updated;
    });
  }

  /**
   * تحصيل من عميل (§4): Dr صندوق/بنك Cr ذمم العميل.
   * حساب القبض يجب أن يكون حساب أصول غير مغلق.
   * الدفع الزائد مسموح عمداً: الفائض يبقى رصيداً دائناً (مستحقاً) للعميل مع تحذير لا يمنع العملية.
   */
  async collectFromCustomer(tenantId: string, branchId: string, input: { customerId: string; accountCode: string; amountAgora: number; date?: string; memo?: string }, actorId: string) {
    if (!Number.isInteger(input.amountAgora) || input.amountAgora <= 0) throw new BadRequestException('مبلغ غير صالح');
    const c = await this.prisma.customer.findFirst({ where: { id: input.customerId, tenantId, deletedAt: null } });
    if (!c) throw new NotFoundException('العميل غير موجود');
    const payAccount = await this.prisma.account.findFirst({
      where: { tenantId, code: input.accountCode, deletedAt: null },
      select: { id: true, type: true, isClosed: true },
    });
    if (!payAccount) throw new NotFoundException(`حساب القبض غير موجود: ${input.accountCode}`);
    if (payAccount.isClosed) throw new ConflictException('حساب القبض مغلق');
    if (payAccount.type !== 'asset') throw new BadRequestException('حساب القبض يجب أن يكون حساب أصول (صندوق أو بنك)');
    const date = input.date ? new Date(input.date) : new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);
    const balanceBeforeAgora = await this.customerBalance(tenantId, c.id);
    return this.prisma.$transaction(async (db: Db) => {
      const entryId = await this.ledger.post({
        tenantId, branchId, fiscalYearId: fy.id, date,
        sourceType: 'collection', sourceId: c.id,
        memo: input.memo ?? `تحصيل من ${c.name}`,
        lines: [
          { accountCode: input.accountCode, debitAgora: input.amountAgora, creditAgora: 0 },
          { accountCode: AR, debitAgora: 0, creditAgora: input.amountAgora, customerId: c.id },
        ],
      }, db);
      const balanceAfterAgora = balanceBeforeAgora - input.amountAgora;
      const overpaidAgora = Math.max(0, input.amountAgora - Math.max(0, balanceBeforeAgora));
      const creditBalanceAgora = Math.max(0, -balanceAfterAgora);
      const warning = overpaidAgora > 0
        ? `دُفعت ${(overpaidAgora / 100).toFixed(2)} ₪ زائداً عن الدين — أصبح للعميل رصيداً مستحقاً له. لا بأس بذلك.`
        : null;
      await auditTx(db, { tenantId, actorId, branchId, action: 'collection', entity: 'customers', entityId: c.id, diff: { ...input, entryId, balanceBeforeAgora, balanceAfterAgora, overpaidAgora, warning } });
      await syncOpTx(db, { tenantId, branchId, entity: 'collection', entityId: entryId, op: 'create', payload: { customerId: c.id, amountAgora: input.amountAgora, accountCode: input.accountCode, overpaidAgora } });
      return { entryId, balanceBeforeAgora, balanceAfterAgora, overpaidAgora, creditBalanceAgora, warning };
    });
  }

  /** كشف حساب العميل: كل سطور الذمم (1300) الموسومة به، مرتبة زمنياً مع رصيد جارٍ. */
  async customerStatement(tenantId: string, customerId: string) {
    const c = await this.prisma.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null }, select: { id: true, name: true } });
    if (!c) throw new NotFoundException('العميل غير موجود');
    const lines = await this.prisma.journalLine.findMany({
      where: { entry: { tenantId }, account: { code: AR }, customerId },
      select: {
        debit: true, credit: true, memo: true,
        entry: { select: { id: true, date: true, createdAt: true, sourceType: true, sourceId: true, memo: true } },
      },
    });
    const sorted = [...lines].sort((a, b) =>
      new Date(a.entry.date).getTime() - new Date(b.entry.date).getTime() ||
      new Date(a.entry.createdAt).getTime() - new Date(b.entry.createdAt).getTime(),
    );
    let run = 0;
    const rows = sorted.map((l) => {
      const debitAgora = decToAgora(l.debit);
      const creditAgora = decToAgora(l.credit);
      run += debitAgora - creditAgora;
      return {
        entryId: l.entry.id,
        date: l.entry.date,
        sourceType: l.entry.sourceType,
        sourceId: l.entry.sourceId,
        memo: l.memo ?? l.entry.memo ?? null,
        debitAgora,
        creditAgora,
        balanceAgora: run,
      };
    });
    return { customer: c, balanceAgora: run, rows };
  }

  /** أعمار الديون: توزيع رصيد كل عميل مدين على فواتيره المرحّلة (الأقدم أولاً — FIFO) في فئات عمر. */
  async customersAging(tenantId: string) {
    const customers = await this.prisma.customer.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    const balances = await this.balancesByParty(tenantId, AR, 'customerId');
    const debtors = customers.map((c) => ({ ...c, debtAgora: balances.get(c.id) ?? 0 })).filter((c) => c.debtAgora > 0);
    if (debtors.length === 0) return { rows: [], totalDebtAgora: 0 };
    const invoices = await this.prisma.invoice.findMany({
      where: { tenantId, deletedAt: null, status: 'posted', customerId: { in: debtors.map((d) => d.id) } },
      select: { id: true, customerId: true, createdAt: true, lines: { select: { netAgora: true } } },
    });
    const byCustomer = new Map<string, { date: number; total: number }[]>();
    for (const inv of invoices) {
      const total = inv.lines.reduce((s, l) => s + Number(l.netAgora), 0);
      if (total <= 0) continue;
      const list = byCustomer.get(inv.customerId) ?? [];
      list.push({ date: inv.createdAt.getTime(), total });
      byCustomer.set(inv.customerId, list);
    }
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const rows = debtors.map((c) => {
      let remaining = c.debtAgora;
      let b0_30 = 0, b31_60 = 0, b61_90 = 0, b90plus = 0;
      let oldestDays: number | null = null;
      for (const inv of (byCustomer.get(c.id) ?? []).sort((a, b) => a.date - b.date)) {
        if (remaining <= 0) break;
        const alloc = Math.min(remaining, inv.total);
        const days = Math.floor((now - inv.date) / DAY);
        if (days < 31) b0_30 += alloc;
        else if (days < 61) b31_60 += alloc;
        else if (days < 91) b61_90 += alloc;
        else b90plus += alloc;
        if (oldestDays === null) oldestDays = days;
        remaining -= alloc;
      }
      // ديون بلا فواتير مرحّلة تغطيها (رصيد افتتاحي أو فواتير لاحقة لأرشفتها) تُحمَّل على الفئة الأقدم.
      if (remaining > 0) b90plus += remaining;
      return {
        customerId: c.id, name: c.name, debtAgora: c.debtAgora,
        b0_30Agora: b0_30, b31_60Agora: b31_60, b61_90Agora: b61_90, b90plusAgora: b90plus,
        oldestInvoiceDays: oldestDays,
      };
    });
    return { rows, totalDebtAgora: rows.reduce((s, r) => s + r.debtAgora, 0) };
  }

  // ─── Suppliers (tenant-level §3) ───

  async listSuppliers(tenantId: string) {
    const rows = await this.prisma.supplier.findMany({ where: { tenantId, deletedAt: null }, orderBy: { name: 'asc' } });
    const balances = await this.balancesByParty(tenantId, AP, 'supplierId');
    return rows.map((s) => ({
      ...s,
      openingBalanceAgora: decToAgora(s.openingBalance),
      balanceAgora: -(balances.get(s.id) ?? 0),
    }));
  }

  async createSupplier(tenantId: string, branchId: string | null, input: { name: string; phone?: string; openingBalanceAgora?: number; openingDate?: string }, actorId: string) {
    if (!input.name?.trim()) throw new BadRequestException('اسم المورد مطلوب');
    const opening = input.openingBalanceAgora ?? 0;
    const date = input.openingDate ? new Date(input.openingDate) : new Date();
    const fy = opening !== 0 ? await fiscalYearFor(this.prisma, tenantId, date) : null;
    return this.prisma.$transaction(async (db: Db) => {
      const s = await db.supplier.create({
        data: {
          tenantId, name: input.name.trim(), phone: input.phone ?? null,
          openingBalance: agoraToDec(opening), openingDate: opening !== 0 ? date : null,
        },
      });
      if (opening !== 0 && fy) {
        // Supplier opening credit (دائن): Dr 3900 / Cr AP.
        const lines = opening > 0
          ? [
              { accountCode: OPENING, debitAgora: opening, creditAgora: 0 },
              { accountCode: AP, debitAgora: 0, creditAgora: opening, supplierId: s.id },
            ]
          : [
              { accountCode: AP, debitAgora: -opening, creditAgora: 0, supplierId: s.id },
              { accountCode: OPENING, debitAgora: 0, creditAgora: -opening },
            ];
        await this.ledger.post({
          tenantId, branchId: branchId ?? '', fiscalYearId: fy.id, date,
          sourceType: 'opening_balance', sourceId: s.id,
          memo: `رصيد افتتاحي لمورد: ${s.name}`, lines,
        }, db);
      }
      await auditTx(db, { tenantId, actorId, branchId, action: 'create', entity: 'suppliers', entityId: s.id, diff: input });
      await syncOpTx(db, { tenantId, branchId: branchId ?? '', entity: 'supplier', entityId: s.id, op: 'create', payload: { name: s.name, phone: s.phone, openingBalanceAgora: opening } });
      return s;
    });
  }

  async updateSupplier(tenantId: string, id: string, patch: { name?: string; phone?: string | null }, actorId: string) {
    const s = await this.prisma.supplier.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!s) throw new NotFoundException('المورد غير موجود');
    return this.prisma.$transaction(async (db: Db) => {
      const updated = await db.supplier.update({
        where: { id },
        data: { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.phone !== undefined ? { phone: patch.phone } : {}) },
      });
      await auditTx(db, { tenantId, actorId, action: 'update', entity: 'suppliers', entityId: id, diff: patch });
      return updated;
    });
  }

  /** دفع لمورد (§4): Dr ذمم المورد Cr صندوق/بنك. */
  async paySupplier(tenantId: string, branchId: string, input: { supplierId: string; accountCode: string; amountAgora: number; date?: string; memo?: string }, actorId: string) {
    if (!Number.isInteger(input.amountAgora) || input.amountAgora <= 0) throw new BadRequestException('مبلغ غير صالح');
    const s = await this.prisma.supplier.findFirst({ where: { id: input.supplierId, tenantId, deletedAt: null } });
    if (!s) throw new NotFoundException('المورد غير موجود');
    const date = input.date ? new Date(input.date) : new Date();
    const fy = await fiscalYearFor(this.prisma, tenantId, date);
    return this.prisma.$transaction(async (db: Db) => {
      const entryId = await this.ledger.post({
        tenantId, branchId, fiscalYearId: fy.id, date,
        sourceType: 'supplier_payment', sourceId: s.id,
        memo: input.memo ?? `دفع للمورد ${s.name}`,
        lines: [
          { accountCode: AP, debitAgora: input.amountAgora, creditAgora: 0, supplierId: s.id },
          { accountCode: input.accountCode, debitAgora: 0, creditAgora: input.amountAgora },
        ],
      }, db);
      await auditTx(db, { tenantId, actorId, branchId, action: 'supplier_payment', entity: 'suppliers', entityId: s.id, diff: { ...input, entryId } });
      await syncOpTx(db, { tenantId, branchId, entity: 'supplier_payment', entityId: entryId, op: 'create', payload: { supplierId: s.id, amountAgora: input.amountAgora, accountCode: input.accountCode } });
      return { entryId };
    });
  }

  /** Default cash customer per branch (زبون نقدي افتراضي §3). */
  async cashCustomer(db: Db, tenantId: string, branchId: string): Promise<{ id: string }> {
    const existing = await db.customer.findFirst({ where: { tenantId, branchId, isCashDefault: true, deletedAt: null }, select: { id: true } });
    if (existing) return existing;
    return db.customer.create({ data: { tenantId, branchId, name: 'زبون نقدي', isCashDefault: true } });
  }

  async ensureCashCustomer(tenantId: string, branchId: string) {
    const dup = await this.prisma.customer.findFirst({ where: { tenantId, branchId, isCashDefault: true } });
    if (dup) throw new ConflictException('يوجد زبون نقدي مسبقاً');
    return this.prisma.customer.create({ data: { tenantId, branchId, name: 'زبون نقدي', isCashDefault: true } });
  }
}
