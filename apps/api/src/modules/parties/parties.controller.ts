import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { PartiesService } from './parties.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('parties')
export class PartiesController {
  constructor(private readonly parties: PartiesService) {}

  @Get('customers')
  @RequirePerm('parties.view')
  customers(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string) {
    return this.parties.listCustomers(u.tenantId, branchId ?? u.branchId);
  }

  @Post('customers')
  @RequirePerm('parties.manage')
  createCustomer(@CurrentUser() u: AuthUser, @Body() b: { branchId?: string; name: string; phone?: string; openingBalanceAgora?: number; openingDate?: string; creditLimitAgora?: number; paymentTerms?: string }) {
    return this.parties.createCustomer(u.tenantId, { ...b, branchId: b.branchId ?? u.branchId ?? '' }, u.userId);
  }

  @Put('customers/:id')
  @RequirePerm('parties.manage')
  updateCustomer(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { name?: string; phone?: string | null; creditLimitAgora?: number; paymentTerms?: string | null }) {
    return this.parties.updateCustomer(u.tenantId, id, b, u.userId);
  }

  @Post('customers/:id/collect')
  @RequirePerm('parties.manage')
  collect(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { accountCode: string; amountAgora: number; date?: string; memo?: string; branchId?: string }) {
    return this.parties.collectFromCustomer(u.tenantId, b.branchId ?? u.branchId ?? '', { customerId: id, accountCode: b.accountCode, amountAgora: b.amountAgora, date: b.date, memo: b.memo }, u.userId);
  }

  @Get('suppliers')
  @RequirePerm('parties.view')
  suppliers(@CurrentUser() u: AuthUser) {
    return this.parties.listSuppliers(u.tenantId);
  }

  @Post('suppliers')
  @RequirePerm('parties.manage')
  createSupplier(@CurrentUser() u: AuthUser, @Body() b: { name: string; phone?: string; openingBalanceAgora?: number; openingDate?: string }) {
    return this.parties.createSupplier(u.tenantId, u.branchId, b, u.userId);
  }

  @Put('suppliers/:id')
  @RequirePerm('parties.manage')
  updateSupplier(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { name?: string; phone?: string | null }) {
    return this.parties.updateSupplier(u.tenantId, id, b, u.userId);
  }

  @Post('suppliers/:id/pay')
  @RequirePerm('parties.manage')
  pay(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { accountCode: string; amountAgora: number; date?: string; memo?: string; branchId?: string }) {
    return this.parties.paySupplier(u.tenantId, b.branchId ?? u.branchId ?? '', { supplierId: id, accountCode: b.accountCode, amountAgora: b.amountAgora, date: b.date, memo: b.memo }, u.userId);
  }
}
