-- Medad 0001_init — full V1 schema (PostgreSQL)
-- Binding rules: append-only ledger, balance enforced in DB, NUMERIC(18,2), soft-delete via deleted_at.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Tenancy ──
CREATE TABLE "tenants" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);

CREATE TABLE "branches" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "name" TEXT NOT NULL,
  "address" TEXT,
  "phone" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "branches_tenantId_idx" ON "branches"("tenantId");

CREATE TABLE "users" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "branchId" TEXT REFERENCES "branches"("id"),
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "permissionsOverride" JSONB,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ,
  UNIQUE("tenantId","email")
);
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");

-- ── Catalog ──
CREATE TABLE "categories" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "parentId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "categories_tenantId_idx" ON "categories"("tenantId");

CREATE TABLE "brands" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "brands_tenantId_idx" ON "brands"("tenantId");

CREATE TABLE "units" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "symbol" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "units_tenantId_idx" ON "units"("tenantId");

CREATE TABLE "products" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "categoryId" TEXT REFERENCES "categories"("id"),
  "brandId" TEXT REFERENCES "brands"("id"),
  "baseUnitId" TEXT,
  "name" TEXT NOT NULL,
  "sku" TEXT,
  "isContainer" BOOLEAN NOT NULL DEFAULT false,
  "lowStockDefault" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "products_tenantId_idx" ON "products"("tenantId");

CREATE TABLE "product_variants" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL REFERENCES "products"("id"),
  "name" TEXT NOT NULL,
  "barcode" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ,
  UNIQUE("tenantId","barcode")
);
CREATE INDEX "product_variants_productId_idx" ON "product_variants"("productId");

CREATE TABLE "product_units" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL REFERENCES "products"("id"),
  "unitId" TEXT NOT NULL REFERENCES "units"("id"),
  "factor" INTEGER NOT NULL,
  "barcode" TEXT
);
CREATE INDEX "product_units_productId_idx" ON "product_units"("productId");

CREATE TABLE "cost_components" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL REFERENCES "products"("id"),
  "label" TEXT NOT NULL,
  "amount" NUMERIC(18,2) NOT NULL CHECK ("amount" >= 0)
);
CREATE INDEX "cost_components_productId_idx" ON "cost_components"("productId");

CREATE TABLE "product_branch" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL REFERENCES "products"("id"),
  "branchId" TEXT NOT NULL REFERENCES "branches"("id"),
  "price" NUMERIC(18,2) NOT NULL DEFAULT 0,
  "cost" NUMERIC(18,2) NOT NULL DEFAULT 0,
  "minAlert" INTEGER,
  UNIQUE("branchId","productId")
);

CREATE TABLE "branch_stock" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL REFERENCES "branches"("id"),
  "productId" TEXT NOT NULL,
  "variantId" TEXT REFERENCES "product_variants"("id"),
  "qty" INTEGER NOT NULL DEFAULT 0,
  UNIQUE("branchId","productId","variantId")
);
CREATE INDEX "branch_stock_branchId_idx" ON "branch_stock"("branchId");

-- ── Parties ──
CREATE TABLE "customers" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "branchId" TEXT NOT NULL REFERENCES "branches"("id"),
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "openingBalance" NUMERIC(18,2) NOT NULL DEFAULT 0,
  "openingDate" TIMESTAMPTZ,
  "creditLimit" NUMERIC(18,2) NOT NULL DEFAULT 0,
  "paymentTerms" TEXT,
  "isCashDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "customers_tenant_branch_idx" ON "customers"("tenantId","branchId");

CREATE TABLE "suppliers" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "openingBalance" NUMERIC(18,2) NOT NULL DEFAULT 0,
  "openingDate" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "suppliers_tenantId_idx" ON "suppliers"("tenantId");

-- ── Accounts + fiscal year ──
CREATE TABLE "accounts" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL CHECK ("type" IN ('asset','liability','equity','revenue','expense')),
  "isClosed" BOOLEAN NOT NULL DEFAULT false,
  "parentId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ,
  UNIQUE("tenantId","code")
);
CREATE INDEX "accounts_tenantId_idx" ON "accounts"("tenantId");

CREATE TABLE "fiscal_years" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "name" TEXT NOT NULL,
  "startDate" TIMESTAMPTZ NOT NULL,
  "endDate" TIMESTAMPTZ NOT NULL,
  "isClosed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "fiscal_years_tenantId_idx" ON "fiscal_years"("tenantId");

-- ── APPEND-ONLY ledger ──
CREATE TABLE "journal_entries" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "branchId" TEXT NOT NULL REFERENCES "branches"("id"),
  "fiscalYearId" TEXT NOT NULL REFERENCES "fiscal_years"("id"),
  "date" TIMESTAMPTZ NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "memo" TEXT,
  "reversesEntryId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "journal_entries_tenant_branch_idx" ON "journal_entries"("tenantId","branchId");
CREATE INDEX "journal_entries_source_idx" ON "journal_entries"("sourceType","sourceId");

CREATE TABLE "journal_lines" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "entryId" TEXT NOT NULL REFERENCES "journal_entries"("id"),
  "accountId" TEXT NOT NULL REFERENCES "accounts"("id"),
  "debit" NUMERIC(18,2) NOT NULL CHECK ("debit" >= 0),
  "credit" NUMERIC(18,2) NOT NULL CHECK ("credit" >= 0),
  "customerId" TEXT,
  "supplierId" TEXT,
  "memo" TEXT,
  CONSTRAINT "journal_lines_one_side_ck" CHECK (
    (("debit" > 0)::int + ("credit" > 0)::int) = 1
  )
);
CREATE INDEX "journal_lines_entryId_idx" ON "journal_lines"("entryId");
CREATE INDEX "journal_lines_accountId_idx" ON "journal_lines"("accountId");

-- Balance enforcement (deferred: entry + lines commit atomically)
CREATE OR REPLACE FUNCTION "medad_assert_balanced"() RETURNS trigger
LANGUAGE plpgsql AS $func$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM (
    SELECT "entryId", SUM("debit") AS dr, SUM("credit") AS cr, COUNT(*) AS n
    FROM "journal_lines"
    WHERE "entryId" IN (SELECT DISTINCT "entryId" FROM (SELECT NEW."entryId" AS "entryId" UNION SELECT OLD."entryId" AS "entryId") s WHERE "entryId" IS NOT NULL)
    GROUP BY "entryId"
  ) t WHERE t.dr <> t.cr OR t.n < 2 OR t.dr <= 0;
  IF bad > 0 THEN
    RAISE EXCEPTION 'Unbalanced journal entry (Dr must equal Cr, >= 2 lines)';
  END IF;
  RETURN NULL;
END $func$;

DROP TRIGGER IF EXISTS "journal_lines_balance_trg" ON "journal_lines";
CREATE CONSTRAINT TRIGGER "journal_lines_balance_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "medad_assert_balanced"();

-- Append-only: block UPDATE/DELETE on ledger tables (reversal only)
CREATE OR REPLACE FUNCTION "medad_block_ledger_write"() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  RAISE EXCEPTION 'Ledger is append-only: use reversal entry instead (table %)',TG_TABLE_NAME;
  RETURN NULL;
END $func$;

DROP TRIGGER IF EXISTS "journal_entries_no_update" ON "journal_entries";
CREATE TRIGGER "journal_entries_no_update" BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "medad_block_ledger_write"();
DROP TRIGGER IF EXISTS "journal_lines_no_update" ON "journal_lines";
CREATE TRIGGER "journal_lines_no_update" BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "medad_block_ledger_write"();

-- ── Purchases ──
CREATE TABLE "purchases" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL REFERENCES "branches"("id"),
  "supplierId" TEXT NOT NULL REFERENCES "suppliers"("id"),
  "status" TEXT NOT NULL DEFAULT 'ordered' CHECK ("status" IN ('ordered','pending','received')),
  "refNo" TEXT,
  "discountAgora" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "purchases_tenant_branch_idx" ON "purchases"("tenantId","branchId");

CREATE TABLE "purchase_lines" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "purchaseId" TEXT NOT NULL REFERENCES "purchases"("id"),
  "variantId" TEXT NOT NULL REFERENCES "product_variants"("id"),
  "qty" INTEGER NOT NULL CHECK ("qty" > 0),
  "unitCostAgora" INTEGER NOT NULL CHECK ("unitCostAgora" >= 0),
  "lineDiscountAgora" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "purchase_lines_purchaseId_idx" ON "purchase_lines"("purchaseId");

CREATE TABLE "supplier_payments" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "purchaseId" TEXT NOT NULL REFERENCES "purchases"("id"),
  "accountCode" TEXT NOT NULL,
  "amount" NUMERIC(18,2) NOT NULL CHECK ("amount" >= 0),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Sales ──
CREATE TABLE "shifts" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL REFERENCES "branches"("id"),
  "cashierId" TEXT NOT NULL,
  "openingAmount" NUMERIC(18,2) NOT NULL,
  "closingExpected" NUMERIC(18,2),
  "closingActual" NUMERIC(18,2),
  "closedBy" TEXT,
  "openedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "closedAt" TIMESTAMPTZ
);
CREATE INDEX "shifts_tenant_branch_idx" ON "shifts"("tenantId","branchId");

CREATE TABLE "invoices" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL REFERENCES "branches"("id"),
  "shiftId" TEXT REFERENCES "shifts"("id"),
  "customerId" TEXT NOT NULL REFERENCES "customers"("id"),
  "refNo" TEXT,
  "status" TEXT NOT NULL DEFAULT 'posted' CHECK ("status" IN ('draft','posted','void')),
  "invoiceDiscountAgora" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "invoices_tenant_branch_idx" ON "invoices"("tenantId","branchId");

CREATE TABLE "invoice_lines" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "invoiceId" TEXT NOT NULL REFERENCES "invoices"("id"),
  "productId" TEXT,
  "variantId" TEXT REFERENCES "product_variants"("id"),
  "qty" INTEGER NOT NULL CHECK ("qty" > 0),
  "unitPriceAgora" INTEGER NOT NULL CHECK ("unitPriceAgora" >= 0),
  "lineDiscountAgora" INTEGER NOT NULL DEFAULT 0,
  "invoiceDiscountShareAgora" INTEGER NOT NULL DEFAULT 0,
  "taxRateBps" INTEGER NOT NULL DEFAULT 0,
  "taxAgora" INTEGER NOT NULL DEFAULT 0,
  "netAgora" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "invoice_lines_invoiceId_idx" ON "invoice_lines"("invoiceId");

CREATE TABLE "invoice_payments" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "invoiceId" TEXT NOT NULL REFERENCES "invoices"("id"),
  "method" TEXT NOT NULL,
  "accountCode" TEXT NOT NULL,
  "amount" NUMERIC(18,2) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "returns" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "sourceInvoiceId" TEXT NOT NULL,
  "restockingFeeAgora" INTEGER NOT NULL DEFAULT 0,
  "refundMethod" TEXT NOT NULL,
  "refundAccountCode" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "returns_tenant_branch_idx" ON "returns"("tenantId","branchId");

CREATE TABLE "return_lines" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "returnId" TEXT NOT NULL REFERENCES "returns"("id"),
  "variantId" TEXT NOT NULL,
  "qty" INTEGER NOT NULL CHECK ("qty" > 0)
);

CREATE TABLE "quotations" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "customerId" TEXT,
  "expiryDate" TIMESTAMPTZ NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open','converted','expired','cancelled')),
  "convertedInvoiceId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "quotations_tenant_branch_idx" ON "quotations"("tenantId","branchId");

CREATE TABLE "quotation_lines" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "quotationId" TEXT NOT NULL REFERENCES "quotations"("id"),
  "variantId" TEXT NOT NULL,
  "qty" INTEGER NOT NULL CHECK ("qty" > 0),
  "unitPriceAgora" INTEGER NOT NULL CHECK ("unitPriceAgora" >= 0)
);

-- ── Inventory ops ──
CREATE TABLE "stock_transfers" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "fromBranchId" TEXT NOT NULL REFERENCES "branches"("id"),
  "toBranchId" TEXT NOT NULL REFERENCES "branches"("id"),
  "status" TEXT NOT NULL DEFAULT 'in_transit' CHECK ("status" IN ('in_transit','received')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "stock_transfers_tenantId_idx" ON "stock_transfers"("tenantId");

CREATE TABLE "stock_transfer_lines" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "transferId" TEXT NOT NULL REFERENCES "stock_transfers"("id"),
  "variantId" TEXT NOT NULL,
  "qty" INTEGER NOT NULL CHECK ("qty" > 0)
);

CREATE TABLE "stock_counts" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL REFERENCES "branches"("id"),
  "type" TEXT NOT NULL CHECK ("type" IN ('initial','daily')),
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "stock_count_lines" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "countId" TEXT NOT NULL REFERENCES "stock_counts"("id"),
  "variantId" TEXT NOT NULL,
  "expectedQty" INTEGER NOT NULL,
  "countedQty" INTEGER NOT NULL
);

CREATE TABLE "tasks" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT,
  "customerId" TEXT,
  "serviceProduct" TEXT NOT NULL,
  "deadline" TIMESTAMPTZ,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "tasks_tenantId_idx" ON "tasks"("tenantId");

-- ── Sync / audit / settings ──
CREATE TABLE "sync_operations" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "op" TEXT NOT NULL CHECK ("op" IN ('create','update','delete')),
  "payload" JSONB NOT NULL,
  "lamport" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "appliedAt" TIMESTAMPTZ
);
CREATE INDEX "sync_operations_tenant_branch_device_idx" ON "sync_operations"("tenantId","branchId","deviceId");
CREATE INDEX "sync_operations_entity_idx" ON "sync_operations"("entity","entityId");

CREATE TABLE "sync_conflicts" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "localValue" JSONB NOT NULL,
  "remoteValue" JSONB NOT NULL,
  "localDevice" TEXT NOT NULL,
  "resolved" BOOLEAN NOT NULL DEFAULT false,
  "resolution" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "sync_conflicts_tenant_resolved_idx" ON "sync_conflicts"("tenantId","resolved");

CREATE TABLE "audit_logs" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT,
  "actorId" TEXT REFERENCES "users"("id"),
  "action" TEXT NOT NULL CHECK ("action" IN ('create','update','delete','login','logout','view','search','export','print')),
  "entity" TEXT NOT NULL,
  "entityId" TEXT,
  "diff" JSONB,
  "ip" TEXT,
  "device" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "audit_logs_tenant_actor_idx" ON "audit_logs"("tenantId","actorId");
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs"("entity","entityId");

CREATE TABLE "settings" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "branchId" TEXT REFERENCES "branches"("id"),
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("tenantId","branchId","key")
);
