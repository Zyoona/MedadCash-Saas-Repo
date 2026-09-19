import { Module } from '@nestjs/common';
import { PartiesService } from './parties.service.js';
import { PartiesController } from './parties.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';

@Module({
  imports: [LedgerModule],
  controllers: [PartiesController],
  providers: [PartiesService],
  exports: [PartiesService],
})
export class PartiesModule {}
