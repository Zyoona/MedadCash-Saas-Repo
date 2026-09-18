import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { SettingsService } from './settings.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePerm('settings.view')
  getAll(@CurrentUser() user: AuthUser, @Query('branchId') branchId?: string) {
    return this.settings.getAll(user.tenantId, branchId ?? user.branchId);
  }

  @Put(':key')
  @RequirePerm('settings.manage')
  set(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
    @Body() body: { value: unknown; branchId?: string | null },
  ) {
    return this.settings.set(user.tenantId, key, body.value, body.branchId ?? null, user.userId);
  }
}
