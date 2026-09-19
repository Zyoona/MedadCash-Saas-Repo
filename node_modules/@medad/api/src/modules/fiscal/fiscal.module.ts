import { Module } from '@nestjs/common';
import { FiscalService } from './fiscal.service.js';
import { FiscalController } from './fiscal.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';

@Module({
  imports: [LedgerModule],
  controllers: [FiscalController],
  providers: [FiscalService],
  exports: [FiscalService],
})
export class FiscalModule {}
