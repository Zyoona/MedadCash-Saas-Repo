import { TransfersService } from './transfers.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { InventoryService } from '../inventory/inventory.service.js';

// §9.4: branch transfer — immediate deduction into in-transit, later receipt adds to destination.
// Qty (and value) must never vanish mid-transfer.

 
function makeDb() {
  const created: { entries: any[]; stock: any[] } = { entries: [], stock: [] };
  const accounts = ['1400', '1410'].map((code) => ({ code, id: `acc-${code}`, isClosed: false }));
  let entrySeq = 0;
  let transferSeq = 0;
  const db: any = {
    fiscalYear: { findFirst: jest.fn().mockResolvedValue({ id: 'fy1', isClosed: false }) },
    account: { findMany: jest.fn().mockResolvedValue(accounts) },
    journalEntry: {
      create: jest.fn(async ({ data }: any) => { created.entries.push(data); entrySeq += 1; return { id: `e${entrySeq}` }; }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    journalLine: { findMany: jest.fn().mockResolvedValue([]) },
    productVariant: { findMany: jest.fn().mockResolvedValue([{ id: 'v1', productId: 'p1' }]), findFirst: jest.fn().mockResolvedValue({ id: 'v1', productId: 'p1' }) },
    productBranch: { findFirst: jest.fn().mockResolvedValue({ cost: '6.00' }) },
    branchStock: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => { created.stock.push(data); return { qty: data.qty }; }),
      update: jest.fn(async ({ data }: any) => { created.stock.push(data); return data; }),
    },
    stockTransfer: {
      create: jest.fn(async ({ data }: any) => { transferSeq += 1; return { id: `tr${transferSeq}`, ...data, lines: data.lines.create }; }),
      findFirst: jest.fn().mockResolvedValue({
        id: 'tr1', tenantId: 't1', fromBranchId: 'b1', toBranchId: 'b2', status: 'in_transit',
        lines: [{ variantId: 'v1', qty: 2, costAgora: 600 }],
      }),
      update: jest.fn(async ({ data }: any) => data),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    syncOperation: { create: jest.fn().mockResolvedValue({ id: 'so' }), aggregate: jest.fn().mockResolvedValue({ _max: { lamport: 0 } }) },
    $transaction: jest.fn((fn: any) => fn(db)),
  };
  return { db, created };
}

describe('Transfers §9.4', () => {
  test('create deducts source into in-transit at cost', async () => {
    const { db, created } = makeDb();
    const svc = new TransfersService(db, new LedgerService(db), new InventoryService(db));
    const res = await svc.create('t1', { fromBranchId: 'b1', toBranchId: 'b2', lines: [{ variantId: 'v1', qty: 2 }] }, 'u1');
    expect(res.totalCostAgora).toBe(1200);
    expect(created.entries[0].lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-1410', debit: '12.00' }));
    expect(created.entries[0].lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-1400', credit: '12.00' }));
    const dr = created.entries[0].lines.create.reduce((s: number, l: any) => s + Number(l.debit), 0);
    const cr = created.entries[0].lines.create.reduce((s: number, l: any) => s + Number(l.credit), 0);
    expect(dr).toBe(cr);
  });

  test('receive adds to destination — in-transit nets to zero (nothing lost)', async () => {
    const { db, created } = makeDb();
    const svc = new TransfersService(db, new LedgerService(db), new InventoryService(db));
    await svc.receive('t1', 'tr1', 'u1');
    const inTransit = created.entries[0].lines.create.find((l: any) => l.accountId === 'acc-1410');
    expect(inTransit.credit).toBe('12.00');
    expect(created.entries[0].lines.create).toContainEqual(expect.objectContaining({ accountId: 'acc-1400', debit: '12.00' }));
    // destination stock grew
    expect(created.stock.some((s) => s.qty === 2)).toBe(true);
  });
});
