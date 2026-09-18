import { Controller, Get, Query } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('stock')
  @RequirePerm('inventory.view')
  stock(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string, @Query('q') q?: string) {
    return this.inventory.stockList(u.tenantId, branchId ?? u.branchId ?? '', q);
  }

  @Get('alerts')
  @RequirePerm('inventory.view')
  alerts(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string) {
    return this.inventory.alerts(u.tenantId, branchId ?? u.branchId ?? '');
  }

  @Get('daily-wizard')
  @RequirePerm('inventory.view')
  dailyWizard(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string) {
    return this.inventory.dailyWizard(u.tenantId, branchId ?? u.branchId ?? '');
  }
}
