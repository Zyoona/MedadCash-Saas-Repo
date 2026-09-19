import { Module } from '@nestjs/common';
import { PurchasesService } from './purchases.service.js';
import { PurchasesController } from './purchases.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';

@Module({
  imports: [LedgerModule, InventoryModule],
  controllers: [PurchasesController],
  providers: [PurchasesService],
  exports: [PurchasesService],
})
export class PurchasesModule {}
