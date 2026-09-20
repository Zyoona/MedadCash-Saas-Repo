import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SalesService, type PaymentInput, type SaleLineInput } from './sales.service.js';
import { ShiftsService } from './shifts.service.js';
import { QuotationsService } from './quotations.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('sales')
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly shifts: ShiftsService,
    private readonly quotations: QuotationsService,
  ) {}

  private actor(u: AuthUser, req: Request) {
    return { userId: u.userId, perms: u.perms, ip: req.ip, device: req.headers['user-agent'] ?? undefined };
  }

  // ─── POS invoices ───

  @Post('invoices')
  @RequirePerm('pos.sell')
  createInvoice(@CurrentUser() u: AuthUser, @Req() req: Request, @Body() b: {
    branchId?: string; customerId?: string | null; shiftId?: string | null; refNo?: string;
    invoiceDiscountAgora?: number; lines: SaleLineInput[]; payments: PaymentInput[]; date?: string;
  }) {
    return this.sales.createInvoice(u.tenantId, this.actor(u, req), { ...b, branchId: b.branchId ?? u.branchId ?? '' });
  }

  @Get('invoices')
  @RequirePerm('pos.view')
  listInvoices(
    @CurrentUser() u: AuthUser,
    @Query('branchId') branchId?: string,
    @Query('customerId') customerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('refNo') refNo?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.sales.listInvoices(u.tenantId, { branchId, customerId, from, to, refNo, page: page ? Number(page) : 1, pageSize: pageSize ? Number(pageSize) : 50 });
  }

  @Get('invoices/:id')
  @RequirePerm('pos.view')
  getInvoice(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.sales.getInvoice(u.tenantId, id);
  }

  // ─── Returns ───

  @Post('returns')
  @RequirePerm('returns.manage')
  createReturn(@CurrentUser() u: AuthUser, @Req() req: Request, @Body() b: {
    branchId?: string; sourceInvoiceId: string; lines: { variantId: string; qty: number }[];
    restockingFeeAgora?: number; refundMethod: string; refundAccountCode: string; date?: string;
  }) {
    return this.sales.createReturn(u.tenantId, this.actor(u, req), b);
  }

  @Get('returns')
  @RequirePerm('pos.view')
  listReturns(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string) {
    return this.sales.listReturns(u.tenantId, branchId);
  }

  // ─── Shifts ───

  @Post('shifts/open')
  @RequirePerm('pos.shift')
  openShift(@CurrentUser() u: AuthUser, @Body() b: { branchId?: string; openingAmountAgora: number }) {
    return this.shifts.open(u.tenantId, b.branchId ?? u.branchId ?? '', b.openingAmountAgora, { userId: u.userId, perms: u.perms, branchId: u.branchId });
  }

  @Get('shifts/current')
  @RequirePerm('pos.view')
  currentShift(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string) {
    return this.shifts.current(u.tenantId, branchId ?? u.branchId ?? '', u.userId);
  }

  /** لوحة الوردية لشاشة POS: الوردية المفتوحة + المتوقع الحي + اقتراح الافتتاح + رصيد صندوق الفرع. */
  @Get('shifts/panel')
  @RequirePerm('pos.view')
  shiftPanel(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string) {
    return this.shifts.panel(u.tenantId, branchId ?? u.branchId ?? '', u.userId);
  }

  @Post('shifts/:id/close')
  @RequirePerm('pos.shift')
  closeShift(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { closingActualAgora: number }) {
    return this.shifts.close(u.tenantId, id, b.closingActualAgora, { userId: u.userId, perms: u.perms, branchId: u.branchId });
  }

  @Get('shifts/:id/report')
  @RequirePerm('pos.view')
  shiftReport(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.shifts.report(u.tenantId, id);
  }

  // ─── Quotations ───

  @Get('quotations')
  @RequirePerm('quotations.view')
  listQuotations(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string) {
    return this.quotations.list(u.tenantId, branchId);
  }

  @Get('quotations/:id')
  @RequirePerm('quotations.view')
  quotation(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.quotations.get(u.tenantId, id);
  }

  @Post('quotations')
  @RequirePerm('quotations.manage')
  createQuotation(@CurrentUser() u: AuthUser, @Body() b: {
    branchId?: string; customerId?: string | null; expiryDate: string;
    lines: { variantId: string; qty: number; unitPriceAgora: number }[];
  }) {
    return this.quotations.create(u.tenantId, { ...b, branchId: b.branchId ?? u.branchId ?? '' }, u.userId);
  }

  @Post('quotations/:id/renew')
  @RequirePerm('quotations.manage')
  renewQuotation(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { expiryDate: string }) {
    return this.quotations.renew(u.tenantId, id, b.expiryDate, u.userId);
  }

  @Post('quotations/:id/cancel')
  @RequirePerm('quotations.manage')
  cancelQuotation(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.quotations.cancel(u.tenantId, id, u.userId);
  }

  @Post('quotations/:id/convert')
  @RequirePerm('quotations.manage')
  convertQuotation(@CurrentUser() u: AuthUser, @Req() req: Request, @Param('id') id: string, @Body() b: {
    payments: PaymentInput[]; customerId?: string | null; branchId?: string; invoiceDiscountAgora?: number; shiftId?: string | null;
  }) {
    return this.quotations.convert(u.tenantId, this.actor(u, req), id, b);
  }
}
