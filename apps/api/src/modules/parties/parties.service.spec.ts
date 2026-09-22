import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PartiesService } from './parties.service.js';
import { LedgerService } from '../ledger/ledger.service.js';

// Unit tests for customer collections (تحصيل), statement (كشف حساب) and aging (أعمار الديون).
// Prisma is mocked — no DB needed. Ledger balance rules are covered by ledger.service.spec.ts.

const CUSTOMER = { id: 'c1', name: 'عميل', branchId: 'b1' };

function setupCollect(debtAgora: number, account: { type?: string; isClosed?: boolean } | null = { type: 'asset', isClosed: false }) {
  const post = jest.fn().mockResolvedValue('entry-1');
  const ledger = { post } as unknown as LedgerService;
  const db = {
    fiscalYear: { findFirst: jest.fn().mockResolvedValue({ id: 'fy1', isClosed: false }) },
    customer: { findFirst: jest.fn().mockResolvedValue(CUSTOMER) },
    account: { findFirst: jest.fn().mockResolvedValue(account) },
    journalLine: {
      findMany: jest.fn().mockResolvedValue(
        debtAgora > 0 ? [{ debit: `${(debtAgora / 100).toFixed(2)}`, credit: '0.00', customerId: 'c1', supplierId: null }] : [],
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    syncOperation: {
      aggregate: jest.fn().mockResolvedValue({ _max: { lamport: 3 } }),
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
  };
  const svc = new PartiesService(db as never, ledger);
  return { svc, db, post };
}

const INPUT = { customerId: 'c1', accountCode: '1000', amountAgora: 2000 };

describe('PartiesService — تحصيل من عميل', () => {
  test('تحصيل جزئي: قيد متوازن Dr صندوق / Cr ذمم موسومة بالعميل — بلا تحذير', async () => {
    const { svc, post } = setupCollect(5000);
    const res = await svc.collectFromCustomer('t1', 'b1', INPUT, 'u1');
    expect(res).toEqual({
      entryId: 'entry-1',
      balanceBeforeAgora: 5000,
      balanceAfterAgora: 3000,
      overpaidAgora: 0,
      creditBalanceAgora: 0,
      warning: null,
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        branchId: 'b1',
        sourceType: 'collection',
        sourceId: 'c1',
        lines: [
          { accountCode: '1000', debitAgora: 2000, creditAgora: 0 },
          { accountCode: '1300', debitAgora: 0, creditAgora: 2000, customerId: 'c1' },
        ],
      }),
      expect.anything(),
    );
  });

  test('تحصيل كامل الدين: بلا تحذير وبلا رصيد دائن', async () => {
    const { svc } = setupCollect(5000);
    const res = await svc.collectFromCustomer('t1', 'b1', { ...INPUT, amountAgora: 5000 }, 'u1');
    expect(res.overpaidAgora).toBe(0);
    expect(res.creditBalanceAgora).toBe(0);
    expect(res.balanceAfterAgora).toBe(0);
    expect(res.warning).toBeNull();
  });

  test('دفع زائد عن الدين: يُسجَّل رصيد مستحق للعميل مع تحذير لا يمنع العملية (لا بأس بذلك)', async () => {
    const { svc, post } = setupCollect(5000);
    const res = await svc.collectFromCustomer('t1', 'b1', { ...INPUT, amountAgora: 8000 }, 'u1');
    expect(res.overpaidAgora).toBe(3000);
    expect(res.creditBalanceAgora).toBe(3000);
    expect(res.balanceAfterAgora).toBe(-3000);
    expect(res.warning).toContain('لا بأس بذلك');
    // القيد يبقى متوازناً بالكامل: Dr صندوق 8000 / Cr ذمم 8000
    const lines = post.mock.calls[0][0].lines as { accountCode: string; debitAgora: number; creditAgora: number }[];
    expect(lines.reduce((s, l) => s + l.debitAgora, 0)).toBe(8000);
    expect(lines.reduce((s, l) => s + l.creditAgora, 0)).toBe(8000);
  });

  test('تحصيل بلا دين مسبق: كامل المبلغ يصبح رصيداً مستحقاً له', async () => {
    const { svc } = setupCollect(0);
    const res = await svc.collectFromCustomer('t1', 'b1', INPUT, 'u1');
    expect(res.balanceBeforeAgora).toBe(0);
    expect(res.overpaidAgora).toBe(2000);
    expect(res.creditBalanceAgora).toBe(2000);
    expect(res.warning).toContain('لا بأس بذلك');
  });

  test.each([[0], [-500], [10.5]] as const)('يرفض مبلغاً غير صالح: %s', async (amount) => {
    const { svc } = setupCollect(5000);
    await expect(svc.collectFromCustomer('t1', 'b1', { ...INPUT, amountAgora: amount }, 'u1'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  test('يرفض عميلاً غير موجود', async () => {
    const { svc, db } = setupCollect(5000);
    (db.customer.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(svc.collectFromCustomer('t1', 'b1', INPUT, 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  test('يرفض حساب قبض غير أصولي (إيراد/التزام)', async () => {
    const { svc } = setupCollect(5000, { type: 'revenue', isClosed: false });
    await expect(svc.collectFromCustomer('t1', 'b1', INPUT, 'u1')).rejects.toThrow(BadRequestException);
  });

  test('يرفض حساب قبض مغلقاً', async () => {
    const { svc } = setupCollect(5000, { type: 'asset', isClosed: true });
    await expect(svc.collectFromCustomer('t1', 'b1', INPUT, 'u1')).rejects.toBeInstanceOf(ConflictException);
  });

  test('يرفض حساب قبض غير موجود', async () => {
    const { svc } = setupCollect(5000, null);
    await expect(svc.collectFromCustomer('t1', 'b1', INPUT, 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PartiesService — كشف حساب العميل', () => {
  test('يرتب السطور زمنياً ويحسب الرصيد الجاري (مدين − دائن)', async () => {
    const post = jest.fn();
    const ledger = { post } as unknown as LedgerService;
    const db = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'c1', name: 'عميل' }) },
      journalLine: {
        findMany: jest.fn().mockResolvedValue([
          { debit: '0.00', credit: '40.00', memo: null, entry: { id: 'e2', date: new Date('2026-02-10'), createdAt: new Date('2026-02-10'), sourceType: 'collection', sourceId: 'x', memo: 'تحصيل' } },
          { debit: '100.00', credit: '0.00', memo: null, entry: { id: 'e1', date: new Date('2026-01-15'), createdAt: new Date('2026-01-15'), sourceType: 'sale', sourceId: 's1', memo: 'فاتورة' } },
          { debit: '25.00', credit: '0.00', memo: null, entry: { id: 'e3', date: new Date('2026-02-10'), createdAt: new Date('2026-02-11'), sourceType: 'sale', sourceId: 's2', memo: 'فاتورة' } },
        ]),
      },
    };
    const svc = new PartiesService(db as never, ledger);
    const res = await svc.customerStatement('t1', 'c1');
    expect(res.customer).toEqual({ id: 'c1', name: 'عميل' });
    expect(res.rows.map((r) => r.entryId)).toEqual(['e1', 'e2', 'e3']);
    expect(res.rows.map((r) => r.balanceAgora)).toEqual([10000, 6000, 8500]);
    expect(res.balanceAgora).toBe(8500);
  });

  test('يرفض عميلاً غير موجود', async () => {
    const db = {
      customer: { findFirst: jest.fn().mockResolvedValue(null) },
      journalLine: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = new PartiesService(db as never, { post: jest.fn() } as unknown as LedgerService);
    await expect(svc.customerStatement('t1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PartiesService — أعمار الديون', () => {
  test('يوزع الدين FIFO على الفواتير: الأقدم في الفئة الأقدم، والفائض بلا فواتير على +90', async () => {
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000);
    const ledger = { post: jest.fn() } as unknown as LedgerService;
    const db = {
      customer: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'أ' }, { id: 'c2', name: 'ب' }]) },
      journalLine: { findMany: jest.fn().mockResolvedValue([{ debit: '100.00', credit: '0.00', customerId: 'c1', supplierId: null }]) },
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'i-new', customerId: 'c1', createdAt: daysAgo(10), lines: [{ netAgora: 4000 }] },
          { id: 'i-old', customerId: 'c1', createdAt: daysAgo(100), lines: [{ netAgora: 8000 }] },
        ]),
      },
    };
    const svc = new PartiesService(db as never, ledger);
    const res = await svc.customersAging('t1');
    expect(res.totalDebtAgora).toBe(10000);
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.customerId).toBe('c1');
    expect(row.debtAgora).toBe(10000);
    // الأقدم أولاً: فاتورة 100 يوم (8000) → +90 يوم، والباقي (2000) → 0-30
    expect(row.b90plusAgora).toBe(8000);
    expect(row.b0_30Agora).toBe(2000);
    expect(row.b31_60Agora).toBe(0);
    expect(row.b61_90Agora).toBe(0);
    expect(row.oldestInvoiceDays).toBeGreaterThanOrEqual(90);
  });

  test('دين أكبر من مجموع الفواتير: الفارق (رصيد افتتاحي) يُحمَّل على الفئة الأقدم', async () => {
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000);
    const ledger = { post: jest.fn() } as unknown as LedgerService;
    const db = {
      customer: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'أ' }]) },
      journalLine: { findMany: jest.fn().mockResolvedValue([{ debit: '150.00', credit: '0.00', customerId: 'c1', supplierId: null }]) },
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'i1', customerId: 'c1', createdAt: daysAgo(5), lines: [{ netAgora: 5000 }] },
        ]),
      },
    };
    const svc = new PartiesService(db as never, ledger);
    const res = await svc.customersAging('t1');
    // الدين 15000: فاتورة 5000 → 0-30، والباقي 10000 بلا فواتير → +90
    expect(res.rows[0].b0_30Agora).toBe(5000);
    expect(res.rows[0].b90plusAgora).toBe(10000);
  });

  test('لا صفوف لعملاء بلا دين', async () => {
    const ledger = { post: jest.fn() } as unknown as LedgerService;
    const db = {
      customer: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'أ' }]) },
      journalLine: { findMany: jest.fn().mockResolvedValue([]) },
      invoice: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = new PartiesService(db as never, ledger);
    const res = await svc.customersAging('t1');
    expect(res).toEqual({ rows: [], totalDebtAgora: 0 });
  });
});
