import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';
import { PERMS } from '../../common/permissions.js';

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService, private readonly prisma: PrismaService) {}

  @Get('users')
  @RequirePerm('users.manage')
  list(@CurrentUser() user: AuthUser) {
    return this.users.list(user.tenantId);
  }

  @Get('users/perms')
  @RequirePerm('users.manage')
  perms() {
    return PERMS;
  }

  @Post('users')
  @RequirePerm('users.manage')
  create(@CurrentUser() user: AuthUser, @Body() body: { email: string; password: string; name: string; role: string; branchId?: string | null; permissionsOverride?: Record<string, boolean> | null }) {
    return this.users.create(user.tenantId, body, user.userId);
  }

  @Patch('users/:id')
  @RequirePerm('users.manage')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { name?: string; role?: string; branchId?: string | null; isActive?: boolean; permissionsOverride?: Record<string, boolean> | null }) {
    return this.users.update(user.tenantId, id, body, user.userId);
  }

  @Post('users/:id/password')
  @RequirePerm('users.manage')
  resetPassword(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { password: string }) {
    return this.users.resetPassword(user.tenantId, id, body.password, user.userId);
  }

  // ─── Org: tenant + branches ───

  @Get('org/tenant')
  async tenant(@CurrentUser() user: AuthUser) {
    return this.prisma.tenant.findFirst({ where: { id: user.tenantId }, select: { id: true, name: true } });
  }

  @Get('org/branches')
  async branches(@CurrentUser() user: AuthUser) {
    return this.prisma.branch.findMany({ where: { tenantId: user.tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  }

  @Post('org/branches')
  @RequirePerm('users.manage')
  async createBranch(@CurrentUser() user: AuthUser, @Body() body: { name: string; address?: string; phone?: string }) {
    return this.prisma.branch.create({ data: { tenantId: user.tenantId, name: body.name, address: body.address, phone: body.phone } });
  }
}
