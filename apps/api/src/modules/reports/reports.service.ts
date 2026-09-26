import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { decToAgora } from '../../common/money.util.js';

// Reports (read-only §Phase6): الربح لأي فترة (من → إلى) — يُحسب من دفتر القيود (مصدر الحقيقة الوحيد)
// بنفس منطق إقفال السنة المالية لكن بنطاق تاريخ حر: إيرادات − تكلفة البضاعة المباعة − باقي المصروفات.

const COGS_CODE = '5000';

export interface ProfitQuery {
  from?: string;
  to?: string;
  branchId?: string;
}

export interface ProfitReport {
  from: string;
  to: string;
  branchId: string | null;
  salesAgora: number;
  cogsAgora: number;
  grossProfitAgora: number;
  grossMarginPct: number | null;
  expenses: { code: string; name: string; amountAgora: number }[];
  expensesTotalAgora: number;
  netProfitAgora: number;
  netMarginPct: number | null;
  invoicesCount: number;
  invoicesTotalAgora: number;
  avgInvoiceAgora: number;
  returnsCount: number;
  byDay: { date: string; revenueAgora: number; costsAgora: number; profitAgora: number }[];
  topItems: { name: string; qty: number; revenueAgora: number; costAgora: number; profitAgora: number }[];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Accepts 'YYYY-MM-DD' (local) or a full ISO string; null when absent/invalid. */
function parseBoundary(s: string | undefined, endOfDay: boolean): Date | null {
  if (!s || !s.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (endOfDay) d.setHours(23, 59, 59, 999);
    return d;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d;
}

function itemName(l: {
  productId: string | null;
  variant?: { name: string; product?: { name: string } } | null;
}): string {
  const pName = l.variant?.product?.name;
  const vName = l.variant?.name;
  if (pName && vName && vName !== 'افتراضي') return `${pName} — ${vName}`;
  return pName ?? vName ?? l.productId ?? 'صنف غير معروف';
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async profit(tenantId: string, q: ProfitQuery) {
    const now = new Date();
    const fromD = parseBoundary(q.from, false) ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const toD = parseBoundary(q.to, true) ?? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    if (fromD > toD) throw new BadRequestException('نطاق التاريخ غير صحيح: «من» بعد «إلى»');
    const branchId = q.branchId?.trim() || undefined;

    const entryWhere = {
      tenantId,
      date: { gte: fromD, lte: toD },
      ...(branchId ? { branchId } : {}),
    };

    const lines = await this.prisma.journalLine.findMany({
      where: {
        entry: entryWhere,
        account: { type: { in: ['revenue', 'expense'] } },
      },
      select: {
        debit: true,
        credit: true,
        account: { select: { code: true, name: true, type: true } },
        entry: { select: { date: true } },
      },
    });

    let salesAgora = 0;
    let cogsAgora = 0;
    let expensesTotalAgora = 0;
    const expenseMap = new Map<string, { code: string; name: string; amountAgora: number }>();
    const dayMap = new Map<string, { revenueAgora: number; costsAgora: number }>();

    for (const l of lines) {
      const dr = decToAgora(l.debit as never);
      const cr = decToAgora(l.credit as never);
      const key = dayKey(new Date(l.entry.date));
      const day = dayMap.get(key) ?? { revenueAgora: 0, costsAgora: 0 };
      if (l.account.type === 'revenue') {
        const net = cr - dr; // دائن − مدين (أثر مرتجعات البيع مدمج تلقائياً)
        salesAgora += net;
        day.revenueAgora += net;
      } else {
        const net = dr - cr;
        if (l.account.code === COGS_CODE) {
          cogsAgora += net;
        } else {
          expensesTotalAgora += net;
          const row = expenseMap.get(l.account.code) ?? { code: l.account.code, name: l.account.name, amountAgora: 0 };
          row.amountAgora += net;
          expenseMap.set(l.account.code, row);
        }
        day.costsAgora += net;
      }
      dayMap.set(key, day);
    }

    const invoiceWhere = {
      tenantId,
      status: 'posted',
      deletedAt: null,
      createdAt: { gte: fromD, lte: toD },
      ...(branchId ? { branchId } : {}),
    };

    const [invoicesCount, returnsCount, soldLines] = await Promise.all([
      this.prisma.invoice.count({ where: invoiceWhere }),
      this.prisma.saleReturn.count({
        where: { tenantId, createdAt: { gte: fromD, lte: toD }, ...(branchId ? { branchId } : {}) },
      }),
      this.prisma.invoiceLine.findMany({
        where: { invoice: invoiceWhere },
        select: {
          qty: true,
          netAgora: true,
          taxAgora: true,
          costAgora: true,
          productId: true,
          variantId: true,
          variant: { select: { name: true, product: { select: { name: true } } } },
        },
      }),
    ]);

    let invoicesTotalAgora = 0;
    const itemMap = new Map<string, { name: string; qty: number; revenueAgora: number; costAgora: number }>();
    for (const l of soldLines) {
      invoicesTotalAgora += l.netAgora;
      const id = l.variantId ?? l.productId ?? '-';
      const item = itemMap.get(id) ?? { name: itemName(l), qty: 0, revenueAgora: 0, costAgora: 0 };
      item.qty += l.qty;
      item.revenueAgora += l.netAgora - l.taxAgora; // إيراد بدون ضريبة ليتطابق مع الدفتر
      item.costAgora += l.costAgora * l.qty;
      itemMap.set(id, item);
    }

    const topItems = [...itemMap.values()]
      .map((t) => ({ ...t, profitAgora: t.revenueAgora - t.costAgora }))
      .sort((a, b) => b.profitAgora - a.profitAgora || b.revenueAgora - a.revenueAgora)
      .slice(0, 12);

    const grossProfitAgora = salesAgora - cogsAgora;
    const netProfitAgora = grossProfitAgora - expensesTotalAgora;
    const pct = (part: number, base: number): number | null => (base > 0 ? Math.round((part / base) * 100) : null);

    const byDay = [...dayMap.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, d]) => ({ date, ...d, profitAgora: d.revenueAgora - d.costsAgora }));

    const expenses = [...expenseMap.values()].sort((a, b) => Math.abs(b.amountAgora) - Math.abs(a.amountAgora));

    return {
      from: fromD.toISOString(),
      to: toD.toISOString(),
      branchId: branchId ?? null,
      salesAgora,
      cogsAgora,
      grossProfitAgora,
      grossMarginPct: pct(grossProfitAgora, salesAgora),
      expenses,
      expensesTotalAgora,
      netProfitAgora,
      netMarginPct: pct(netProfitAgora, salesAgora),
      invoicesCount,
      invoicesTotalAgora,
      avgInvoiceAgora: invoicesCount > 0 ? Math.round(invoicesTotalAgora / invoicesCount) : 0,
      returnsCount,
      byDay,
      topItems,
    };
  }
}
