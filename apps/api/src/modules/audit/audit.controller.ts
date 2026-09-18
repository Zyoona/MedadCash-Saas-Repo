import { Controller, Get, Post, Body, Query, Res, Req } from '@nestjs/common';
import type { Response, Request } from 'express';
import { AuditService } from './audit.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePerm('audit.view')
  list(
    @CurrentUser() user: AuthUser,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('entity') entity?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.audit.list({
      tenantId: user.tenantId, actorId, action, entity, from, to,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 50,
    });
  }

  /** Client-driven read audit: page view / search / print events (§7). */
  @Post('event')
  async event(@CurrentUser() user: AuthUser, @Req() req: Request, @Body() body: { action: string; entity: string; entityId?: string }) {
    await this.audit.log({
      tenantId: user.tenantId,
      actorId: user.userId,
      branchId: user.branchId,
      action: body.action,
      entity: body.entity,
      entityId: body.entityId ?? null,
      ip: req.ip,
      device: req.headers['user-agent'] ?? null,
    });
    return { ok: true };
  }

  @Get('export.csv')
  @RequirePerm('audit.view')
  async exportCsv(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res() res: Response,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('entity') entity?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const csv = await this.audit.exportCsv({ tenantId: user.tenantId, actorId, action, entity, from, to });
    await this.audit.log({ tenantId: user.tenantId, actorId: user.userId, action: 'export', entity: 'audit_logs', ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
    res.send(csv);
  }
}
