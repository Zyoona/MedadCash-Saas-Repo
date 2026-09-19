import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { LedgerService } from './ledger.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

// Read + append-only post + reversal. No PUT/PATCH/DELETE exists by design (§1.2).
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Post('entries')
  @RequirePerm('ledger.post')
  post(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      branchId?: string;
      fiscalYearId: string;
      date: string;
      sourceType: string;
      sourceId: string;
      memo?: string;
      lines: { accountCode: string; debitAgora: number; creditAgora: number; customerId?: string; supplierId?: string }[];
    },
  ) {
    return this.ledger.post({
      ...body,
      tenantId: user.tenantId,
      branchId: body.branchId ?? user.branchId ?? '',
      date: new Date(body.date),
    });
  }

  @Get('entries')
  @RequirePerm('ledger.view')
  listEntries(
    @CurrentUser() user: AuthUser,
    @Query('branchId') branchId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sourceType') sourceType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.ledger.listEntries(user.tenantId, {
      branchId, from, to, sourceType,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 50,
    });
  }

  @Get('entries/:id')
  @RequirePerm('ledger.view')
  getEntry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ledger.getEntry(user.tenantId, id);
  }

  /** The ONLY correction path: a NEW mirrored entry (§1.2 — reversal only). */
  @Post('entries/:id/reverse')
  @RequirePerm('ledger.reverse')
  reverse(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { reason: string; branchId?: string; fiscalYearId: string; date?: string },
  ) {
    return this.ledger.reverse({
      tenantId: user.tenantId,
      branchId: body.branchId ?? user.branchId ?? '',
      fiscalYearId: body.fiscalYearId,
      entryId: id,
      reason: body.reason,
      date: body.date ? new Date(body.date) : undefined,
    });
  }

  @Get('trial-balance')
  @RequirePerm('ledger.view')
  trialBalance(@CurrentUser() user: AuthUser, @Query('branchId') branchId?: string, @Query('byAccount') byAccount?: string) {
    return byAccount === '1'
      ? this.ledger.trialBalanceByAccount(user.tenantId, branchId)
      : this.ledger.trialBalance(user.tenantId, branchId);
  }

  /** Legacy unauthenticated path kept for local smoke tests. */
  @Get('trial-balance/:tenantId')
  trialBalanceLegacy(@Param('tenantId') tenantId: string, @Query('branchId') branchId?: string) {
    return this.ledger.trialBalance(tenantId, branchId);
  }
}
