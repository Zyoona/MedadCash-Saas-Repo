import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

// Read-only reports — صلاحية reports.view موجودة مسبقاً في RBAC (§7).
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** تقرير الربح لفترة (من → إلى) — بلغة مبسطة للعرض: مبيعات/تكلفة/مصروفات/صافي. */
  @Get('profit')
  @RequirePerm('reports.view')
  profit(
    @CurrentUser() u: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reports.profit(u.tenantId, { from, to, branchId });
  }
}
