import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { SyncService, type PushOp } from './sync.service.js';
import { BackupService } from './backup.service.js';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService, private readonly backup: BackupService) {}

  @Post('push')
  push(@CurrentUser() u: AuthUser, @Body() b: { branchId?: string; deviceId: string; operations: PushOp[] }) {
    return this.sync.push(u.tenantId, u.userId, { branchId: b.branchId ?? u.branchId ?? '', deviceId: b.deviceId, operations: b.operations });
  }

  @Get('pull')
  @RequirePerm('sync.view')
  pull(@CurrentUser() u: AuthUser, @Query('branchId') branchId?: string, @Query('since') since?: string, @Query('deviceId') deviceId?: string) {
    return this.sync.pull(u.tenantId, { branchId, since, deviceId });
  }

  @Get('conflicts')
  @RequirePerm('sync.view')
  conflicts(@CurrentUser() u: AuthUser, @Query('resolved') resolved?: string) {
    return this.sync.listConflicts(u.tenantId, resolved === undefined ? false : resolved === '1');
  }

  @Post('conflicts/:id/resolve')
  @RequirePerm('sync.resolve')
  resolve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { choice: 'local' | 'remote' | 'custom'; value?: Record<string, unknown> }) {
    return this.sync.resolveConflict(u.tenantId, id, b, u.userId);
  }

  @Get('board')
  @RequirePerm('sync.view')
  board(@CurrentUser() u: AuthUser) {
    return this.sync.board(u.tenantId);
  }

  // ─── Backup ───

  @Post('backup/run')
  @RequirePerm('backup.manage')
  runBackup(@CurrentUser() u: AuthUser, @Body() b: { provider?: string }) {
    return this.backup.run(u.tenantId, b.provider ?? 'local', u.userId);
  }

  @Get('backup/runs')
  @RequirePerm('backup.view')
  backupRuns(@CurrentUser() u: AuthUser) {
    return this.backup.runs(u.tenantId);
  }

  @Post('backup/restore')
  @RequirePerm('backup.manage')
  restore(@CurrentUser() u: AuthUser, @Body() b: { filePath: string }) {
    return this.backup.restore(u.tenantId, b.filePath, u.userId);
  }
}
