import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AccountsService } from './accounts.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @RequirePerm('accounts.view')
  list(@CurrentUser() user: AuthUser) {
    return this.accounts.list(user.tenantId);
  }

  @Post()
  @RequirePerm('accounts.manage')
  create(@CurrentUser() user: AuthUser, @Body() body: { code: string; name: string; type: string; parentId?: string | null }) {
    return this.accounts.create(user.tenantId, body, user.userId);
  }

  @Patch(':id')
  @RequirePerm('accounts.manage')
  rename(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { name: string }) {
    return this.accounts.rename(user.tenantId, id, body.name, user.userId);
  }

  @Post(':id/close')
  @RequirePerm('accounts.manage')
  close(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.close(user.tenantId, id, user.userId);
  }

  @Post('opening')
  @RequirePerm('accounts.manage')
  opening(@CurrentUser() user: AuthUser, @Body() body: { accountCode: string; amountAgora: number; date?: string; memo?: string; branchId?: string }) {
    return this.accounts.opening(user.tenantId, body.branchId ?? user.branchId ?? '', body, user.userId);
  }

  @Post('transfer')
  @RequirePerm('accounts.manage')
  transfer(@CurrentUser() user: AuthUser, @Body() body: { fromCode: string; toCode: string; amountAgora: number; date?: string; memo?: string; branchId?: string }) {
    return this.accounts.transfer(user.tenantId, body.branchId ?? user.branchId ?? '', body, user.userId);
  }

  @Get('ledger/:code')
  @RequirePerm('ledger.view')
  accountLedger(@CurrentUser() user: AuthUser, @Param('code') code: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.accounts.accountLedger(user.tenantId, code, from, to);
  }

  // ─── Bank accounts (الحسابات البنكية) ───

  @Get('banks')
  @RequirePerm('accounts.view')
  listBanks(@CurrentUser() user: AuthUser) {
    return this.accounts.listBanks(user.tenantId);
  }

  @Post('banks')
  @RequirePerm('accounts.manage')
  createBank(@CurrentUser() user: AuthUser, @Body() body: {
    bankName: string; accountLabel?: string; accountNumber?: string; iban?: string;
    currency?: string; notes?: string; openingBalanceAgora?: number; branchId?: string;
  }) {
    return this.accounts.createBank(user.tenantId, body.branchId ?? user.branchId ?? '', body, user.userId);
  }

  @Patch('banks/:id')
  @RequirePerm('accounts.manage')
  updateBank(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: {
    bankName?: string; accountLabel?: string | null; accountNumber?: string | null;
    iban?: string | null; notes?: string | null; isActive?: boolean;
  }) {
    return this.accounts.updateBank(user.tenantId, id, body, user.userId);
  }

  @Delete('banks/:id')
  @RequirePerm('accounts.manage')
  deleteBank(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.deleteBank(user.tenantId, id, user.userId);
  }

  // ─── Checks ───

  @Get('checks/list')
  @RequirePerm('accounts.view')
  listChecks(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.accounts.listChecks(user.tenantId, status);
  }

  @Get('checks/alerts')
  @RequirePerm('accounts.view')
  checkAlerts(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    return this.accounts.checkAlerts(user.tenantId, days ? Number(days) : 7);
  }

  @Post('checks')
  @RequirePerm('checks.manage')
  createCheck(@CurrentUser() user: AuthUser, @Body() body: {
    checkNumber: string; direction: 'in' | 'out'; amountAgora: number; dueDate: string;
    partyName?: string; customerId?: string; supplierId?: string; notes?: string; date?: string; branchId?: string;
  }) {
    return this.accounts.createCheck(user.tenantId, body.branchId ?? user.branchId ?? '', body, user.userId);
  }

  @Post('checks/:id/clear')
  @RequirePerm('checks.manage')
  clearCheck(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { accountCode?: string; date?: string; branchId?: string }) {
    return this.accounts.clearCheck(user.tenantId, body.branchId ?? user.branchId ?? '', id, body, user.userId);
  }

  @Post('checks/:id/bounce')
  @RequirePerm('checks.manage')
  bounceCheck(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { date?: string; branchId?: string }) {
    return this.accounts.bounceCheck(user.tenantId, body.branchId ?? user.branchId ?? '', id, body.date, user.userId);
  }
}
