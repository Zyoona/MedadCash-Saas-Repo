import { ForbiddenException } from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PartiesService } from '../parties/parties.service.js';
import { SalesService } from './sales.service.js';
import { computeInvoice } from '@medad/shared-types';

// §9.1 (computeInvoice) + §9.2 (full POS invoice): compound discount + tax + two payments
// + change-in-different-method (negative row) + credit-limit block + negative-stock warning.
// Prisma fully mocked; balance of every produced entry verified in-code.

 
function makeDb(opts: { stockQty?: number; customer?: any; stockFind?: any; shift?: any } = {}) {
  const created: { entries: any[]; invoices: any[]; audit: any[]; sync: any[] } = { entries: [], invoices: [], audit: [], sync: [] };
  const accounts = ['1000', '1100', '1200', '1300', '1400', '1410', '1500', '2000', '2100', '3000', '3900', '4000', '4100', '5000', '5200', '5300']
    .map((code) => ({ code, id: `acc-${code}`, isClosed: false }));
  let entrySeq = 0;
  const db: any = {
    fiscalYear: { findFirst: jest.fn().mockResolvedValue({ id: 'fy1', isClosed: false }) },
    account: { findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(accounts.filter((a) => !where?.code?.in || where.code.in.includes(a.code)))) },
    journalEntry: {
      create: jest.fn(async ({ data }: any) => { created.entries.push(data); entrySeq += 1; return { id: `e${entrySeq}` }; }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    journalLine: { findMany: jest.fn().mockResolvedValue([]) },
    setting: { findFirst: jest.fn().mockResolvedValue(null) },
    productVariant: { findFirst: jest.fn().mockResolvedValue({ id: 'v1', productId: 'p1' }) },
    product: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', name: 'كتاب', sku: null, deletedAt: null }) },
    productBranch: { findFirst: jest.fn().mockResolvedValue({ price: '50.00', cost: '6.00' }) },
    branchStock: {
      findFirst: jest.fn().mockImplementation(() => Promise.resolve(opts.stockFind ?? (opts.stockQty !== undefined ? { id: 's1', qty: opts.stockQty } : null))),
      create: jest.fn(async ({ data }: any) => ({ qty: data.qty })),
      update: jest.fn(async ({ data }: any) => ({ qty: data.qty })),
    },
    customer: { findFirst: jest.fn().mockResolvedValue(opts.customer ?? { id: 'c1', name: 'زبون نقدي', isCashDefault: true, creditLimit: '0.00' }) },
    invoice: { create: jest.fn(async ({ data }: any) => { created.invoices.push(data); return { id: 'inv1' }; }) },
    shift: { findFirst: jest.fn(async () => ('shift' in opts ? opts.shift : { id: 'sh1', branchId: 'b1', cashierId: 'u1', closedAt: null })) },
    auditLog: { create: jest.fn(async ({ data }: any) => { created.audit.push(data); return {}; }) },
    syncOperation: { create: jest.fn(async ({ data }: any) => { created.sync.push(data); return { id: 'so1' }; }), aggregate: jest.fn().mockResolvedValue({ _max: { lamport: 0 } }) },
    $transaction: jest.fn((fn: any) => fn(db)),
  };
  return { db, created };
}

function buildSales(db: any) {
  const ledger = new LedgerService(db);
  const inventory = new InventoryService(db);
  const parties = new PartiesService(db, ledger as any);
  return new SalesService(db, ledger, inventory, parties);
}

const ACTOR = { userId: 'u1', perms: ['pos.sell'] };

describe('Invoice math §9.1 (computeInvoice)', () => {
  test('tax 0% and non-0% + pro-rata invoice discount + exact totals', () => {
    const t = computeInvoice(
      [
        { qty: 2, unitPriceAgora: 5000, lineDiscountAgora: 1000, taxRateBps: 1600 },
        { qty: 1, unitPriceAgora: 3000, lineDiscountAgora: 0, taxRateBps: 0 },
      ],
      500,
    );
    expect(t.lines[0].invoiceDiscountShareAgora).toBe(375);
    expect(t.lines[1].invoiceDiscountShareAgora).toBe(125);
    expect(t.lines[0].taxAgora).toBe(1380); // 8625 × 16%
    expect(t.lines[1].taxAgora).toBe(0);
    expect(t.taxableTotalAgora).toBe(11500);
    expect(t.taxTotalAgora).toBe(1380);
    expect(t.grandTotalAgora).toBe(12880);
  });

  test('rejects line discount above gross and float money', () => {
    expect(() => computeInvoice([{ qty: 1, unitPriceAgora: 100, lineDiscountAgora: 200 }], 0)).toThrow();
    expect(() => computeInvoice([{ qty: 1, unitPriceAgora: 10.5 }], 0)).toThrow();
    expect(() => computeInvoice([{ qty: 1, unitPriceAgora: 100 }], 1.5)).toThrow();
  });
});

describe('POS invoice §9.2 (SalesService)', () => {
  const LINES = [
    { variantId: 'v1', qty: 2, unitPriceAgora: 5000, lineDiscountAgora: 1000, taxRateBps: 1600 },
    { productId: 'p2', qty: 1, unitPriceAgora: 3000, lineDiscountAgora: 0, taxRateBps: 0 },
  ];

  test('compound sale: discount + tax + two payments + change row → balanced entries + COGS + audit + sync', async () => {
    const { db, created } = makeDb();
    const svc = buildSales(db);
    const res = await svc.createInvoice('t1', ACTOR, {
      branchId: 'b1',
      invoiceDiscountAgora: 500,
      lines: LINES,
      payments: [
        { method: 'cash', accountCode: '1000', amountAgora: 13000 },
        { method: 'bank', accountCode: '1100', amountAgora: -120 }, // الباقي بطريقة مختلفة (سالب §4)
      ],
    });
    expect(res.totals.grandTotalAgora).toBe(12880);
    expect(res.remainderAgora).toBe(0);
    // two entries: sale + COGS; each balanced
    expect(created.entries.length).toBe(2);
    for (const e of created.entries) {
      const dr = e.lines.create.reduce((s: number, l: any) => s + Number(l.debit), 0);
      const cr = e.lines.create.reduce((s: number, l: any) => s + Number(l.credit), 0);
      expect(dr).toBe(cr);
    }
    const sale = created.entries[0];
    expect(sale.sourceType).toBe('sale');
    expect(sale.lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-4000', credit: '115.00' }));
    expect(sale.lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-2100', credit: '13.80' }));
    expect(sale.lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-1000', debit: '130.00' }));
    expect(sale.lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-1100', credit: '1.20' }));
    // COGS: 2×600 + 1×600 = 1800
    const cogs = created.entries[1];
    expect(cogs.sourceType).toBe('sale_cogs');
    expect(cogs.lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-5000', debit: '18.00' }));
    expect(created.audit.length).toBeGreaterThan(0);
    expect(created.sync.length).toBeGreaterThan(0);
  });

  test('credit sale beyond credit limit is blocked without override permission', async () => {
    const { db } = makeDb({ customer: { id: 'c2', name: 'عميل آجل', isCashDefault: false, creditLimit: '50.00' } });
    const svc = buildSales(db);
    await expect(
      svc.createInvoice('t1', ACTOR, {
        branchId: 'b1',
        lines: LINES,
        payments: [{ method: 'credit', accountCode: '1300', amountAgora: 1000 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('credit sale allowed with override_credit_limit + audit warning', async () => {
    const { db, created } = makeDb({ customer: { id: 'c2', name: 'عميل آجل', isCashDefault: false, creditLimit: '50.00' } });
    const svc = buildSales(db);
    const res = await svc.createInvoice('t1', { userId: 'u1', perms: ['pos.sell', 'override_credit_limit'] }, {
      branchId: 'b1',
      lines: LINES,
      payments: [{ method: 'credit', accountCode: '1300', amountAgora: 1000 }],
    });
    expect(res.remainderAgora).toBe(12440);
    expect(res.warnings.join(' ')).toContain('override_credit_limit');
    const sale = created.entries[0];
    expect(sale.lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-1300', debit: '124.40' }));
  });

  test('negative stock allowed with explicit warning (§3)', async () => {
    const { db, created } = makeDb({ stockQty: 1 });
    const svc = buildSales(db);
    const res = await svc.createInvoice('t1', ACTOR, {
      branchId: 'b1',
      lines: [{ variantId: 'v1', qty: 3, unitPriceAgora: 1000 }],
      payments: [{ method: 'cash', accountCode: '1000', amountAgora: 3000 }],
    });
    expect(res.warnings.some((w) => w.includes('مخزون سالب'))).toBe(true);
    const sale = created.entries[0];
    const dr = sale.lines.create.reduce((s: number, l: any) => s + Number(l.debit), 0);
    const cr = sale.lines.create.reduce((s: number, l: any) => s + Number(l.credit), 0);
    expect(dr).toBe(cr);
  });

  test('overpayment rejected', async () => {
    const { db } = makeDb();
    const svc = buildSales(db);
    await expect(
      svc.createInvoice('t1', ACTOR, {
        branchId: 'b1',
        lines: [{ variantId: 'v1', qty: 1, unitPriceAgora: 1000 }],
        payments: [{ method: 'cash', accountCode: '1000', amountAgora: 5000 }],
      }),
    ).rejects.toThrow('أكبر من الإجمالي');
  });
});

// ربط الفاتورة بالوردية (§Phase4): الوردية يجب أن تكون موجودة، مفتوحة، لنفس الفرع، ووردية الكاشير
// نفسه — وإلا فسدت مطابقة الصندوق (المتوقع يُشتق من حركة صندوق فرع الوردية خلال نافذتها).
describe('Invoice ↔ shift binding (ربط الفاتورة بالوردية)', () => {
  const L = [{ variantId: 'v1', qty: 1, unitPriceAgora: 1000 }];
  const P = [{ method: 'cash', accountCode: '1000', amountAgora: 1000 }];
  const sell = (db: any, over: Record<string, unknown> = {}, perms: string[] = ['pos.sell']) =>
    buildSales(db).createInvoice('t1', { userId: 'u1', perms }, { branchId: 'b1', lines: L, payments: P, ...over });

  test('بلا shiftId تُقبل (الوردية اختيارية)', async () => {
    const { db, created } = makeDb();
    await sell(db);
    expect(created.invoices[0].shiftId).toBeNull();
  });

  test('وردية مفتوحة لنفس الكاشير/الفرع → تُسند الفاتورة إليها', async () => {
    const { db, created } = makeDb();
    await sell(db, { shiftId: 'sh1' });
    expect(created.invoices[0].shiftId).toBe('sh1');
  });

  test('وردية غير موجودة → رفض', async () => {
    const { db } = makeDb({ shift: null });
    await expect(sell(db, { shiftId: 'sh404' })).rejects.toThrow('الوردية غير موجودة');
  });

  test('وردية مغلقة → رفض', async () => {
    const { db } = makeDb({ shift: { id: 'sh1', branchId: 'b1', cashierId: 'u1', closedAt: new Date() } });
    await expect(sell(db, { shiftId: 'sh1' })).rejects.toThrow('وردية مغلقة');
  });

  test('وردية فرع آخر → رفض', async () => {
    const { db } = makeDb({ shift: { id: 'sh1', branchId: 'b2', cashierId: 'u1', closedAt: null } });
    await expect(sell(db, { shiftId: 'sh1' })).rejects.toThrow('فرعاً غير فرع الفاتورة');
  });

  test('وردية كاشير آخر → ممنوع بلا صلاحية، ومقبول مع pos.shift_any', async () => {
    const other = { id: 'sh1', branchId: 'b1', cashierId: 'u2', closedAt: null };
    const { db } = makeDb({ shift: other });
    await expect(sell(db, { shiftId: 'sh1' })).rejects.toBeInstanceOf(ForbiddenException);
    const { db: db2, created } = makeDb({ shift: other });
    await sell(db2, { shiftId: 'sh1' }, ['pos.sell', 'pos.shift_any']);
    expect(created.invoices[0].shiftId).toBe('sh1');
  });
});
