import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PurchasesService } from './purchases.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  @RequirePerm('purchases.view')
  list(
    @CurrentUser() u: AuthUser,
    @Query('branchId') branchId?: string,
    @Query('status') status?: string,
    @Query('supplierId') supplierId?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.purchases.list(u.tenantId, { branchId, status, supplierId, q, from, to });
  }

  @Get(':id')
  @RequirePerm('purchases.view')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.purchases.get(u.tenantId, id);
  }

  @Post()
  @RequirePerm('purchases.manage')
  create(@CurrentUser() u: AuthUser, @Body() b: {
    branchId?: string; supplierId: string; refNo?: string; notes?: string;
    discountAgora?: number; taxRateBps?: number;
    lines: { variantId: string; qty: number; unitCostAgora: number; lineDiscountAgora?: number }[];
  }) {
    return this.purchases.create(u.tenantId, { ...b, branchId: b.branchId ?? u.branchId ?? '' }, u.userId);
  }

  @Post(':id/status')
  @RequirePerm('purchases.manage')
  setStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { status: 'pending' | 'received'; payments?: { accountCode: string; amountAgora: number }[] }) {
    return this.purchases.setStatus(u.tenantId, id, b.status, u.userId, b.payments);
  }
}
