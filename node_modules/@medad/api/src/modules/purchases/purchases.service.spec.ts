import { PurchasesService } from './purchases.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { InventoryService } from '../inventory/inventory.service.js';

// §9.3: ordered/pending move NOTHING; received moves stock + entries + partial payment AP remainder.

 
function makeDb() {
  const created: { entries: any[]; payments: any[]; stockMoves: any[]; audit: any[]; sync: any[] } = { entries: [], payments: [], stockMoves: [], audit: [], sync: [] };
  const accounts = ['1000', '1100', '1400', '1500', '2000'].map((code) => ({ code, id: `acc-${code}`, isClosed: false }));
  let entrySeq = 0;
  const db: any = {
    fiscalYear: { findFirst: jest.fn().mockResolvedValue({ id: 'fy1', isClosed: false }) },
    account: { findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(accounts.filter((a) => !where?.code?.in || where.code.in.includes(a.code)))) },
    journalEntry: {
      create: jest.fn(async ({ data }: any) => { created.entries.push(data); entrySeq += 1; return { id: `e${entrySeq}` }; }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    journalLine: { findMany: jest.fn().mockResolvedValue([]) },
    purchase: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'pur1', tenantId: 't1', branchId: 'b1', supplierId: 'sup1', status: 'ordered',
        discountAgora: 300, taxRateBps: 1600, refNo: 'R-1',
        lines: [
          { variantId: 'v1', qty: 10, unitCostAgora: 1000, lineDiscountAgora: 500 },
          { variantId: 'v2', qty: 5, unitCostAgora: 2000, lineDiscountAgora: 0 },
        ],
      }),
      update: jest.fn(async ({ data }: any) => data),
    },
    productVariant: { findMany: jest.fn().mockResolvedValue([{ id: 'v1', productId: 'p1' }, { id: 'v2', productId: 'p2' }]) },
    productBranch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue({ cost: '0.00' }) },
    branchStock: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => { created.stockMoves.push(data); return { qty: data.qty }; }),
      update: jest.fn(async ({ data }: any) => { created.stockMoves.push(data); return data; }),
    },
    supplierPayment: { create: jest.fn(async ({ data }: any) => { created.payments.push(data); return data; }) },
    auditLog: { create: jest.fn(async ({ data }: any) => { created.audit.push(data); return {}; }) },
    syncOperation: { create: jest.fn(async ({ data }: any) => { created.sync.push(data); return { id: 'so' }; }), aggregate: jest.fn().mockResolvedValue({ _max: { lamport: 0 } }) },
    $transaction: jest.fn((fn: any) => fn(db)),
  };
  return { db, created };
}

describe('Purchases §9.3', () => {
  test('computeTotals: line discount → pro-rata purchase discount → tax after discounts', () => {
    const svc = new PurchasesService(null as any, null as any, null as any);
    const t = svc.computeTotals(
      [
        { variantId: 'v1', productId: 'p1', qty: 10, unitCostAgora: 1000, lineDiscountAgora: 500 },
        { variantId: 'v2', productId: 'p2', qty: 5, unitCostAgora: 2000, lineDiscountAgora: 0 },
      ],
      300,
      1600,
    );
    expect(t.lines[0].afterLineDiscountAgora).toBe(9500);
    expect(t.lines[0].discountShareAgora).toBe(146);
    expect(t.lines[1].discountShareAgora).toBe(154);
    expect(t.inventoryTotalAgora).toBe(19200);
    expect(t.taxTotalAgora).toBe(1497 + 1575);
    expect(t.grandTotalAgora).toBe(19200 + 3072);
    expect(t.lines[0].netUnitCostAgora).toBe(935);
  });

  test('received: stock in + balanced entry (Dr inventory + input tax / Cr payments + AP remainder) + payment rows', async () => {
    const { db, created } = makeDb();
    const ledger = new LedgerService(db);
    const svc = new PurchasesService(db, ledger, new InventoryService(db));
    const res = await svc.setStatus('t1', 'pur1', 'received', 'u1', [
      { accountCode: '1000', amountAgora: 10000 },
    ]);
    expect(res.remainderAgora).toBe(22272 - 10000);
    // 15 units moved in
    expect(created.stockMoves.length).toBe(2);
    // one balanced entry
    expect(created.entries.length).toBe(1);
    const e = created.entries[0];
    const dr = e.lines.create.reduce((s: number, l: any) => s + Number(l.debit), 0);
    const cr = e.lines.create.reduce((s: number, l: any) => s + Number(l.credit), 0);
    expect(dr).toBe(cr);
    expect(dr).toBe(222.72);
    expect(e.lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-1400', debit: '192.00' }));
    expect(e.lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-1500', debit: '30.72' }));
    expect(e.lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-1000', credit: '100.00' }));
    expect(e.lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-2000', credit: '122.72' }));
    expect(created.payments.length).toBe(1);
    expect(created.audit.length).toBeGreaterThan(0);
    expect(created.sync.length).toBeGreaterThan(0);
  });
});
