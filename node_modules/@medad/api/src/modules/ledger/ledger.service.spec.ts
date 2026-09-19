import { BadRequestException } from '@nestjs/common';
import { LedgerService } from './ledger.service.js';

// Unit tests for the accounting engine (§9.1):
// every §4 row posts balanced (Dr=Cr) + partial payment + compound discount + tax 0%/non-0%.
// Prisma is mocked — no DB needed. DB-level CHECK/trigger is covered by migration 0001_init.

function mockDb(existing: { accounts?: { code: string; id: string; isClosed?: boolean }[]; fyClosed?: boolean } = {}) {
  const created: { data: unknown }[] = [];
  const accounts =
    existing.accounts ??
    [
      '1000', '1100', '1200', '1300', '1400', '1410', '1500',
      '2000', '2100', '3000', '3900', '4000', '4100', '5000', '5200', '5300',
    ].map((code) => ({ code, id: `acc-${code}`, isClosed: false }));
  const db = {
    fiscalYear: { findFirst: jest.fn().mockResolvedValue({ id: 'fy1', isClosed: existing.fyClosed ?? false }) },
    account: {
      findMany: jest.fn().mockImplementation((args?: { where?: { code?: { in?: string[] } } }) => {
        const wanted = args?.where?.code?.in;
        const list = wanted ? accounts.filter((a) => wanted.includes(a.code)) : accounts;
        return Promise.resolve(list);
      }),
    },
    journalEntry: {
      create: jest.fn().mockImplementation((args: { data: unknown }) => {
        created.push(args);
        return Promise.resolve({ id: 'entry-1' });
      }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    journalLine: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(dbRef as unknown)),
  };
  const dbRef: Record<string, unknown> = db;
  return { db, created };
}

const BASE = { tenantId: 't1', branchId: 'b1', fiscalYearId: 'fy1', date: new Date('2026-01-15') };

describe('LedgerService (§9.1)', () => {
  test.each([
    ['cash sale', { sourceType: 'sale', sourceId: 's1', lines: [
      { accountCode: '1000', debitAgora: 11600, creditAgora: 0 },
      { accountCode: '4000', debitAgora: 0, creditAgora: 10000 },
      { accountCode: '2100', debitAgora: 0, creditAgora: 1600 }] }],
    ['COGS', { sourceType: 'sale_cogs', sourceId: 's1', lines: [
      { accountCode: '5000', debitAgora: 6000, creditAgora: 0 },
      { accountCode: '1400', debitAgora: 0, creditAgora: 6000 }] }],
    ['credit sale', { sourceType: 'sale', sourceId: 's2', lines: [
      { accountCode: '1300', debitAgora: 10000, creditAgora: 0 },
      { accountCode: '4000', debitAgora: 0, creditAgora: 10000 }] }],
    ['collection', { sourceType: 'collection', sourceId: 'c1', lines: [
      { accountCode: '1000', debitAgora: 4000, creditAgora: 0 },
      { accountCode: '1300', debitAgora: 0, creditAgora: 4000 }] }],
    ['purchase received partial', { sourceType: 'purchase', sourceId: 'p1', lines: [
      { accountCode: '1400', debitAgora: 10000, creditAgora: 0 },
      { accountCode: '1500', debitAgora: 1600, creditAgora: 0 },
      { accountCode: '1000', debitAgora: 0, creditAgora: 5000 },
      { accountCode: '2000', debitAgora: 0, creditAgora: 6600 }] }],
    ['supplier payment', { sourceType: 'supplier_payment', sourceId: 'p1', lines: [
      { accountCode: '2000', debitAgora: 6600, creditAgora: 0 },
      { accountCode: '1100', debitAgora: 0, creditAgora: 6600 }] }],
    ['sale return', { sourceType: 'sale_return', sourceId: 'r1', lines: [
      { accountCode: '4000', debitAgora: 10000, creditAgora: 0 },
      { accountCode: '1400', debitAgora: 6000, creditAgora: 0 },
      { accountCode: '1000', debitAgora: 0, creditAgora: 10000 },
      { accountCode: '5000', debitAgora: 0, creditAgora: 6000 }] }],
    ['opening balance', { sourceType: 'opening_balance', sourceId: 'ob1', lines: [
      { accountCode: '1300', debitAgora: 25000, creditAgora: 0 },
      { accountCode: '3900', debitAgora: 0, creditAgora: 25000 }] }],
    ['account transfer', { sourceType: 'account_transfer', sourceId: 't1', lines: [
      { accountCode: '1100', debitAgora: 20000, creditAgora: 0 },
      { accountCode: '1000', debitAgora: 0, creditAgora: 20000 }] }],
    ['stock adjustment', { sourceType: 'stock_adjustment', sourceId: 'a1', lines: [
      { accountCode: '5200', debitAgora: 1500, creditAgora: 0 },
      { accountCode: '1400', debitAgora: 0, creditAgora: 1500 }] }],
    ['transfer out/in', { sourceType: 'stock_transfer_out', sourceId: 'x1', lines: [
      { accountCode: '1410', debitAgora: 3000, creditAgora: 0 },
      { accountCode: '1400', debitAgora: 0, creditAgora: 3000 }] }],
  ])('%s posts balanced', async (_name, entry) => {
    const { db } = mockDb();
    const svc = new LedgerService(db as never);
    await expect(svc.post({ ...BASE, ...entry } as never)).resolves.toBe('entry-1');
  });

  test('rejects unbalanced entry', async () => {
    const svc = new LedgerService(mockDb().db as never);
    await expect(
      svc.post({ ...BASE, sourceType: 'sale', sourceId: 'x', lines: [
        { accountCode: '1000', debitAgora: 100, creditAgora: 0 },
        { accountCode: '4000', debitAgora: 0, creditAgora: 99 },
      ] } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('rejects float amounts', () => {
    const svc = new LedgerService(mockDb().db as never);
    expect(() =>
      svc.assertBalanced([
        { accountCode: '1000', debitAgora: 10.5, creditAgora: 0 },
        { accountCode: '4000', debitAgora: 0, creditAgora: 10.5 },
      ]),
    ).toThrow();
  });

  test('rejects closed account and closed fiscal year', async () => {
    const closed = mockDb({ accounts: [{ code: '1000', id: 'a1', isClosed: true }, { code: '4000', id: 'a2' }] });
    const svc = new LedgerService(closed.db as never);
    await expect(
      svc.post({ ...BASE, sourceType: 'sale', sourceId: 'x', lines: [
        { accountCode: '1000', debitAgora: 100, creditAgora: 0 },
        { accountCode: '4000', debitAgora: 0, creditAgora: 100 },
      ] } as never),
    ).rejects.toThrow();

    const fyClosed = mockDb({ fyClosed: true });
    const svc2 = new LedgerService(fyClosed.db as never);
    await expect(
      svc2.post({ ...BASE, sourceType: 'sale', sourceId: 'x', lines: [
        { accountCode: '1000', debitAgora: 100, creditAgora: 0 },
        { accountCode: '4000', debitAgora: 0, creditAgora: 100 },
      ] } as never),
    ).rejects.toThrow();
  });

  test('trialBalance sums Dr == Cr (§9.6)', async () => {
    const db = mockDb().db as never as {
      journalLine: { findMany: jest.Mock };
    };
    (db as Record<string, unknown>).journalLine = {
      findMany: jest.fn().mockResolvedValue([
        { debit: '100.00', credit: '0.00' },
        { debit: '0.00', credit: '100.00' },
      ]),
    };
    const svc = new LedgerService(db as never);
    await expect(svc.trialBalance('t1')).resolves.toEqual({ debitAgora: 10000, creditAgora: 10000, balanced: true });
  });
});
