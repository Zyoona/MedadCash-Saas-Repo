import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service.js';
import { LedgerController } from './ledger.controller.js';

@Module({
  providers: [LedgerService],
  controllers: [LedgerController],
  exports: [LedgerService],
})
export class LedgerModule {}
