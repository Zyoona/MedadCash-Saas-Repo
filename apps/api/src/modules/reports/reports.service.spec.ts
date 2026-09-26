import { BadRequestException } from '@nestjs/common';
import { ReportsService } from './reports.service.js';

// Unit tests for the profit report aggregation (§Phase6):
// P&L from the ledger (revenue / COGS / other expenses) + invoice-level top items.
// Prisma is mocked — no DB needed.

interface FakeLine {
  debit: string;
  credit: string;
  account: { code: string; name: string; type: string };
  entry: { date: Date };
}

const rev = (creditAgora: number, date: string): FakeLine => ({
  debit: '0.00',
  credit: `${Math.floor(creditAgora / 100)}.${String(creditAgora % 100).padStart(2, '0')}`,
  account: { code: '4000', name: 'إيراد المبيعات', type: 'revenue' },
  entry: { date: new Date(date) },
});

const exp = (code: string, name: string, debitAgora: number, date: string): FakeLine => ({
  debit: `${Math.floor(debitAgora / 100)}.${String(debitAgora % 100).padStart(2, '0')}`,
  credit: '0.00',
  account: { code, name, type: 'expense' },
  entry: { date: new Date(date) },
});

const creditExp = (code: string, name: string, creditAgora: number, date: string): FakeLine => ({
  debit: '0.00',
  credit: `${Math.floor(creditAgora / 100)}.${String(creditAgora % 100).padStart(2, '0')}`,
  account: { code, name, type: 'expense' },
  entry: { date: new Date(date) },
});

function makeDb(lines: FakeLine[], opts: { invoicesCount?: number; returnsCount?: number; soldLines?: unknown[] } = {}) {
  return {
    journalLine: { findMany: jest.fn().mockResolvedValue(lines) },
    invoice: { count: jest.fn().mockResolvedValue(opts.invoicesCount ?? 0) },
    saleReturn: { count: jest.fn().mockResolvedValue(opts.returnsCount ?? 0) },
    invoiceLine: { findMany: jest.fn().mockResolvedValue(opts.soldLines ?? []) },
  };
}

const soldLine = (o: { qty: number; netAgora: number; taxAgora?: number; costAgora: number; productId?: string; variantId?: string; product?: string; variant?: string }) => ({
  qty: o.qty,
  netAgora: o.netAgora,
  taxAgora: o.taxAgora ?? 0,
  costAgora: o.costAgora,
  productId: o.productId ?? null,
  variantId: o.variantId ?? null,
  variant: o.product ? { name: o.variant ?? 'افتراضي', product: { name: o.product } } : null,
});

describe('ReportsService.profit', () => {
  test('يصنّف الإيراد والتكلفة والمصروفات ويحسب الصافي', async () => {
    const db = makeDb(
      [
        rev(10000, '2026-03-05T10:00:00'), // مبيعات 100.00
        exp('5000', 'تكلفة البضاعة المباعة', 6000, '2026-03-05T10:00:00'), // تكلفة 60.00
        exp('5300', 'مصروفات عامة', 1200, '2026-03-06T12:00:00'), // مصروفات 12.00
      ],
      { invoicesCount: 4, soldLines: [] },
    );
    const res = await new ReportsService(db as never).profit('t1', { from: '2026-03-01', to: '2026-03-31' });
    expect(res.salesAgora).toBe(10000);
    expect(res.cogsAgora).toBe(6000);
    expect(res.grossProfitAgora).toBe(4000);
    expect(res.expensesTotalAgora).toBe(1200);
    expect(res.netProfitAgora).toBe(2800);
    expect(res.grossMarginPct).toBe(40);
    expect(res.netMarginPct).toBe(28);
    expect(res.invoicesCount).toBe(4);
    expect(res.avgInvoiceAgora).toBe(0); // لا أسطر مبيعات مُمرّرة
  });

  test('المرتجعات (مدين على الإيراد) تُخصم من المبيعات، والفائض في 5310 يظهر سالباً', async () => {
    const db = makeDb([
      rev(10000, '2026-03-05T10:00:00'),
      { ...rev(0, '2026-03-06T10:00:00'), debit: '100.00', credit: '0.00' }, // مرتجع كامل 100.00
      creditExp('5310', 'فروقات الصندوق (عجز/فائض)', 500, '2026-03-07T10:00:00'), // فائض صندوق
    ]);
    const res = await new ReportsService(db as never).profit('t1', { from: '2026-03-01', to: '2026-03-31' });
    expect(res.salesAgora).toBe(0);
    expect(res.expensesTotalAgora).toBe(-500);
    expect(res.netProfitAgora).toBe(500);
  });

  test('التكلفة (5000) تُعرض منفصلة عن باقي المصروفات وتُستبعد من قائمة المصروفات', async () => {
    const db = makeDb([
      rev(50000, '2026-03-05T10:00:00'),
      exp('5000', 'تكلفة البضاعة المباعة', 30000, '2026-03-05T10:00:00'),
      exp('5300', 'مصروفات عامة', 2000, '2026-03-05T11:00:00'),
      exp('5200', 'تسويات الجرد (عجز/فائض)', 300, '2026-03-08T09:00:00'),
    ]);
    const res = await new ReportsService(db as never).profit('t1', {});
    expect(res.cogsAgora).toBe(30000);
    expect(res.expenses.map((e) => e.code)).toEqual(['5300', '5200']);
    expect(res.expenses.map((e) => e.code)).not.toContain('5000');
    expect(res.netProfitAgora).toBe(50000 - 30000 - 2300);
  });

  test('التجميع اليومي: ربح اليوم = إيراد اليوم − تكاليفه، مرتباً تصاعدياً', async () => {
    const db = makeDb([
      exp('5300', 'مصروفات عامة', 100, '2026-03-06T09:00:00'),
      rev(2000, '2026-03-06T10:00:00'),
      rev(3000, '2026-03-05T10:00:00'),
      exp('5000', 'تكلفة البضاعة المباعة', 1500, '2026-03-05T10:00:00'),
    ]);
    const res = await new ReportsService(db as never).profit('t1', { from: '2026-03-01', to: '2026-03-31' });
    expect(res.byDay.map((d) => d.date)).toEqual(['2026-03-05', '2026-03-06']);
    expect(res.byDay[0]).toMatchObject({ revenueAgora: 3000, costsAgora: 1500, profitAgora: 1500 });
    expect(res.byDay[1]).toMatchObject({ revenueAgora: 2000, costsAgora: 100, profitAgora: 1900 });
  });

  test('أكثر الأصناف ربحاً: تجميع حسب الصنف وإخراج الضريبة من الإيراد', async () => {
    const db = makeDb([], {
      invoicesCount: 2,
      soldLines: [
        soldLine({ qty: 2, netAgora: 2320, taxAgora: 320, costAgora: 600, productId: 'p-notebook', product: 'دفتر 100 ورقة' }),
        soldLine({ qty: 1, netAgora: 1160, taxAgora: 160, costAgora: 500, productId: 'p-notebook', product: 'دفتر 100 ورقة' }),
        soldLine({ qty: 5, netAgora: 2500, costAgora: 3000, productId: 'p-pen', product: 'قلم', variant: 'أحمر' }),
      ],
    });
    const res = await new ReportsService(db as never).profit('t1', {});
    expect(res.invoicesTotalAgora).toBe(2320 + 1160 + 2500);
    expect(res.avgInvoiceAgora).toBe(Math.round(5980 / 2));
    expect(res.topItems).toHaveLength(2);
    const pen = res.topItems.find((t) => t.name.includes('قلم'))!;
    expect(pen).toMatchObject({ qty: 5, revenueAgora: 2500, costAgora: 15000, profitAgora: -12500 });
    const notebook = res.topItems.find((t) => t.name.includes('دفتر'))!;
    expect(notebook).toMatchObject({ qty: 3, revenueAgora: 3000, costAgora: 1700, profitAgora: 1300 });
    expect(res.topItems[0].name).toContain('دفتر'); // الأعلى ربحاً أولاً
  });

  test('يرفض نطاقاً معكوساً', async () => {
    const db = makeDb([]);
    const svc = new ReportsService(db as never);
    await expect(svc.profit('t1', { from: '2026-03-31', to: '2026-03-01' })).rejects.toBeInstanceOf(BadRequestException);
  });

  test('الافتراضي: من أول الشهر حتى نهاية اليوم عند غياب التواريخ', async () => {
    const db = makeDb([]);
    await new ReportsService(db as never).profit('t1', {});
    const where = (db.journalLine.findMany as jest.Mock).mock.calls[0][0].where.entry.date;
    const now = new Date();
    expect(new Date(where.gte).getDate()).toBe(1);
    expect(new Date(where.lte).getDate()).toBe(now.getDate());
  });
});
