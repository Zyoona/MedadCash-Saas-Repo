import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @RequirePerm('dashboard.view')
  summary(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string) {
    return this.dashboard.summary(u.tenantId, branchId ?? u.branchId ?? '');
  }
}
