import { Module } from '@nestjs/common';
import { CountsService } from './counts.service.js';
import { TransfersService } from './transfers.service.js';
import { TasksService } from './tasks.service.js';
import { OpsController } from './ops.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';

@Module({
  imports: [LedgerModule, InventoryModule, SalesModule, CatalogModule],
  controllers: [OpsController],
  providers: [CountsService, TransfersService, TasksService],
  exports: [CountsService, TransfersService, TasksService],
})
export class OpsModule {}
