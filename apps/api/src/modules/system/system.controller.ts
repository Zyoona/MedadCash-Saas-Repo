import { Body, Controller, Get, Post, Res, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as fs from 'node:fs';
import { RequirePerm, CurrentUser, type AuthUser } from '../auth/auth.guard.js';
import { IMPORT_TMP_DIR, SystemService, type DestructiveBody } from './system.service.js';

fs.mkdirSync(IMPORT_TMP_DIR, { recursive: true });

@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get('export-zip')
  @RequirePerm('backup.view')
  async exportZip(@CurrentUser() u: AuthUser, @Res() res: Response) {
    const { filePath, fileName } = await this.system.exportZip(u.tenantId, u.userId);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  @Post('import-zip')
  @RequirePerm('system.wipe')
  @UseInterceptors(FileInterceptor('file', { dest: IMPORT_TMP_DIR, limits: { fileSize: 200 * 1024 * 1024 } }))
  importZip(@CurrentUser() u: AuthUser, @UploadedFile() file: any, @Body() body: Record<string, unknown>) {
    return this.system.importZip(
      u.tenantId,
      { userId: u.userId, role: u.role },
      file ? { path: file.path as string, originalname: file.originalname as string, size: file.size as number } : undefined,
      body as unknown as DestructiveBody,
    );
  }

  @Post('wipe-demo')
  @RequirePerm('system.wipe')
  wipeDemo(@CurrentUser() u: AuthUser, @Body() body: DestructiveBody) {
    return this.system.wipeDemo(u.tenantId, { userId: u.userId, role: u.role }, body);
  }
}
