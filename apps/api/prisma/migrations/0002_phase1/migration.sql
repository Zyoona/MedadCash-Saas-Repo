-- Medad 0002_phase1 — checks, backup runs, purchase tax fields, sale/transfer cost tracking.
-- Cumulative migration; additive only (no destructive changes).

-- ── Purchase tax (ضريبة مدفوعة على المشتريات) ──
ALTER TABLE "purchases" ADD COLUMN "taxRateBps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "purchases" ADD COLUMN "taxAgora" INTEGER NOT NULL DEFAULT 0;

-- ── Sale-time unit cost snapshot (needed for returns/COGS accuracy) ──
ALTER TABLE "invoice_lines" ADD COLUMN "costAgora" INTEGER NOT NULL DEFAULT 0;

-- ── In-transit valuation (عدم ضياع القيمة أثناء النقل بين الفروع) ──
ALTER TABLE "stock_transfer_lines" ADD COLUMN "costAgora" INTEGER NOT NULL DEFAULT 0;

-- ── Checks (شيكات: برسم التحصيل 1200 / مدفوعة 2200) ──
CREATE TABLE "checks" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "branchId" TEXT,
  "checkNumber" TEXT NOT NULL,
  "direction" TEXT NOT NULL, -- in | out
  "accountCode" TEXT NOT NULL DEFAULT '1200',
  "partyName" TEXT,
  "customerId" TEXT,
  "supplierId" TEXT,
  "amount" NUMERIC(18,2) NOT NULL,
  "dueDate" TIMESTAMPTZ NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', -- pending | cleared | bounced
  "clearedAt" TIMESTAMPTZ,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE INDEX "checks_tenantId_status_idx" ON "checks"("tenantId","status");
CREATE INDEX "checks_dueDate_idx" ON "checks"("dueDate");

-- ── Backup runs (سجل عمليات النسخ الاحتياطي) ──
CREATE TABLE "backup_runs" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "provider" TEXT NOT NULL, -- local | drive
  "status" TEXT NOT NULL, -- success | failed
  "filePath" TEXT,
  "sizeBytes" INTEGER,
  "message" TEXT,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finishedAt" TIMESTAMPTZ
);
CREATE INDEX "backup_runs_tenantId_startedAt_idx" ON "backup_runs"("tenantId","startedAt");
