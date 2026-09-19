import { Module } from '@nestjs/common';
import { SyncService } from './sync.service.js';
import { SyncController } from './sync.controller.js';
import { BackupService, LocalBackupProvider, DriveBackupProvider } from './backup.service.js';

@Module({
  controllers: [SyncController],
  providers: [SyncService, LocalBackupProvider, DriveBackupProvider, BackupService],
  exports: [SyncService, BackupService],
})
export class SyncModule {}
