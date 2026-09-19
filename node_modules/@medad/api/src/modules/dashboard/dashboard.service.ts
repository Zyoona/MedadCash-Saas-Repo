import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { decToAgora } from '../../common/money.util.js';

// Dashboard aggregation (§Phase6 manager board + today's KPIs).

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly inventory: InventoryService,
  ) {}

  private async accountBalance(tenantId: string, code: string): Promise<number> {
    const sums = await this.prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: { tenantId }, account: { code } },
      _sum: { debit: true, credit: true },
    });
    return sums.reduce((s, r) => s + decToAgora(r._sum.debit) - decToAgora(r._sum.credit), 0);
  }

  async summary(tenantId: string, branchId: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // البنك = 1100 + كل حسابات البنوك المسجلة (كل بنك GL مستقل)
    const bankAccounts = await this.prisma.bankAccount.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const bankCodes = [...new Set(['1100', ...bankAccounts.map((b) => b.glAccountCode)])];
    const bankBalances = await Promise.all(bankCodes.map((c) => this.accountBalance(tenantId, c)));

    const [todayInvoiceLines, todayCount, cash, ar, ap, alerts, openConflicts, lastBackup, openShift, quotesExpiring, dueChecks, tb] = await Promise.all([
      this.prisma.invoiceLine.findMany({
        where: { invoice: { tenantId, branchId, status: 'posted', createdAt: { gte: startOfDay } } },
        select: { netAgora: true },
      }),
      this.prisma.invoice.count({ where: { tenantId, branchId, status: 'posted', createdAt: { gte: startOfDay } } }),
      this.accountBalance(tenantId, '1000'),
      this.accountBalance(tenantId, '1300'),
      this.accountBalance(tenantId, '2000'),
      this.inventory.alerts(tenantId, branchId),
      this.prisma.syncConflict.count({ where: { tenantId, resolved: false } }),
      this.prisma.backupRun.findFirst({ where: { tenantId }, orderBy: { startedAt: 'desc' } }),
      this.prisma.shift.findFirst({ where: { tenantId, branchId, closedAt: null }, orderBy: { openedAt: 'desc' } }),
      this.prisma.quotation.count({ where: { tenantId, status: { in: ['expired'] }, deletedAt: null } }),
      this.prisma.check.count({ where: { tenantId, status: 'pending', dueDate: { lte: new Date(Date.now() + 7 * 24 * 3600 * 1000) } } }),
      this.ledger.trialBalance(tenantId),
    ]);

    return {
      todaySalesAgora: todayInvoiceLines.reduce((s, l) => s + l.netAgora, 0),
      todayInvoicesCount: todayCount,
      cashAgora: cash,
      bankAgora: bankBalances.reduce((s, x) => s + x, 0),
      banks: bankAccounts.map((b) => ({
        id: b.id,
        bankName: b.bankName,
        accountLabel: b.accountLabel,
        glAccountCode: b.glAccountCode,
        isActive: b.isActive,
        balanceAgora: bankBalances[bankCodes.indexOf(b.glAccountCode)],
      })),
      receivablesAgora: ar,
      payablesAgora: -ap,
      lowStockCount: alerts.low.length,
      negativeStockCount: alerts.negative.length,
      openConflicts,
      lastBackup: lastBackup ? { status: lastBackup.status, provider: lastBackup.provider, startedAt: lastBackup.startedAt } : null,
      openShift: openShift ? { id: openShift.id, openedAt: openShift.openedAt, openingAmountAgora: decToAgora(openShift.openingAmount) } : null,
      expiredQuotations: quotesExpiring,
      dueChecks: dueChecks,
      trialBalance: tb,
    };
  }
}
