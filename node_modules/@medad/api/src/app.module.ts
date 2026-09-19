import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { FiscalModule } from './modules/fiscal/fiscal.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { PartiesModule } from './modules/parties/parties.module.js';
import { PurchasesModule } from './modules/purchases/purchases.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { OpsModule } from './modules/ops/ops.module.js';
import { SyncModule } from './modules/sync/sync.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AuditModule,
    LedgerModule,
    SettingsModule,
    UsersModule,
    AccountsModule,
    FiscalModule,
    CatalogModule,
    InventoryModule,
    PartiesModule,
    PurchasesModule,
    SalesModule,
    OpsModule,
    SyncModule,
    DashboardModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
