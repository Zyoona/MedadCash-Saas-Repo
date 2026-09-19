import { Module } from '@nestjs/common';
import { SalesService } from './sales.service.js';
import { ShiftsService } from './shifts.service.js';
import { QuotationsService } from './quotations.service.js';
import { SalesController } from './sales.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { PartiesModule } from '../parties/parties.module.js';

@Module({
  imports: [LedgerModule, InventoryModule, PartiesModule],
  controllers: [SalesController],
  providers: [SalesService, ShiftsService, QuotationsService],
  exports: [SalesService, ShiftsService, QuotationsService],
})
export class SalesModule {}
