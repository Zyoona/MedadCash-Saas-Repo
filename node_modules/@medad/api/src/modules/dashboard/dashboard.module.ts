import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';
import { DashboardController } from './dashboard.controller.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';

@Module({
  imports: [LedgerModule, InventoryModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
