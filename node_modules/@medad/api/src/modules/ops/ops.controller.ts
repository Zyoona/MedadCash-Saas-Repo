import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CountsService } from './counts.service.js';
import { TransfersService } from './transfers.service.js';
import { TasksService } from './tasks.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('ops')
export class OpsController {
  constructor(
    private readonly counts: CountsService,
    private readonly transfers: TransfersService,
    private readonly tasks: TasksService,
    private readonly catalog: CatalogService,
  ) {}

  private actor(u: AuthUser, req: Request) {
    return { userId: u.userId, perms: u.perms, ip: req.ip, device: req.headers['user-agent'] ?? undefined };
  }

  // ─── Counts ───

  @Post('counts')
  @RequirePerm('inventory.count')
  createCount(@CurrentUser() u: AuthUser, @Body() b: { branchId?: string; type: 'initial' | 'daily'; notes?: string; lines: { productId: string; variantId?: string | null; countedQty: number }[] }) {
    return this.counts.create(u.tenantId, { ...b, branchId: b.branchId ?? u.branchId ?? '' }, u.userId);
  }

  @Get('counts')
  @RequirePerm('inventory.view')
  listCounts(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string) {
    return this.counts.list(u.tenantId, branchId);
  }

  @Get('counts/:id')
  @RequirePerm('inventory.view')
  getCount(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.counts.get(u.tenantId, id);
  }

  // ─── Transfers ───

  @Post('transfers')
  @RequirePerm('inventory.transfer')
  createTransfer(@CurrentUser() u: AuthUser, @Body() b: { fromBranchId: string; toBranchId: string; lines: { variantId: string; qty: number }[] }) {
    return this.transfers.create(u.tenantId, b, u.userId);
  }

  @Post('transfers/:id/receive')
  @RequirePerm('inventory.transfer')
  receiveTransfer(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.transfers.receive(u.tenantId, id, u.userId);
  }

  @Get('transfers')
  @RequirePerm('inventory.view')
  listTransfers(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.transfers.list(u.tenantId, status);
  }

  // ─── Tasks ───

  @Get('tasks')
  @RequirePerm('tasks.view')
  listTasks(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('customerId') customerId?: string, @Query('branchId') branchId?: string) {
    return this.tasks.list(u.tenantId, { status, customerId, branchId });
  }

  @Post('tasks')
  @RequirePerm('tasks.manage')
  createTask(@CurrentUser() u: AuthUser, @Body() b: { branchId?: string | null; customerId?: string | null; serviceProduct: string; deadline?: string | null }) {
    return this.tasks.create(u.tenantId, { ...b, branchId: b.branchId ?? u.branchId }, u.userId);
  }

  @Post('tasks/:id/status')
  @RequirePerm('tasks.manage')
  setTaskStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { status: string }) {
    return this.tasks.setStatus(u.tenantId, id, b.status, u.userId);
  }

  @Post('tasks/:id/bill')
  @RequirePerm('tasks.manage')
  billTask(@CurrentUser() u: AuthUser, @Req() req: Request, @Param('id') id: string, @Body() b: { priceAgora: number; payments: { method: string; accountCode: string; amountAgora: number }[]; customerId?: string | null; branchId?: string; taxRateBps?: number }) {
    return this.tasks.bill(u.tenantId, this.actor(u, req), id, b);
  }

  // ─── Labels (§Phase5: بحث + حقول + سعر مشطوب + أحجام — البيانات هنا والطباعة بالعميل) ───

  @Get('labels/products')
  @RequirePerm('labels.print')
  labelProducts(@CurrentUser() u: AuthUser, @Query('branchId') branchId: string, @Query('q') q?: string) {
    return this.catalog.searchForSale(u.tenantId, branchId ?? u.branchId ?? '', q ?? '');
  }
}
