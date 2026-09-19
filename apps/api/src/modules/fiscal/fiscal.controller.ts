import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { FiscalService } from './fiscal.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('fiscal-years')
export class FiscalController {
  constructor(private readonly fiscal: FiscalService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.fiscal.list(user.tenantId);
  }

  @Post()
  @RequirePerm('fiscal.manage')
  create(@CurrentUser() user: AuthUser, @Body() body: { name: string; startDate: string; endDate: string }) {
    return this.fiscal.create(user.tenantId, body, user.userId);
  }

  @Post(':id/close')
  @RequirePerm('fiscal.manage')
  close(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { branchId?: string }) {
    return this.fiscal.close(user.tenantId, id, body.branchId ?? user.branchId ?? '', user.userId);
  }
}
