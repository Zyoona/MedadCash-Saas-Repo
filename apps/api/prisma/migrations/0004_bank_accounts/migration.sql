-- Medad 0004_bank_accounts — الحسابات البنكية المرتبطة بدليل الحسابات.
-- Cumulative migration; additive only (no destructive changes).
-- كل حساب بنكي مرتبط بكود GL (asset): أول بنك يتبنى 1100، واللاحقة 1101+.
-- الرصيد يُشتق من journal_lines (append-only) — لا يُخزن أي رصيد هنا.

CREATE TABLE "bank_accounts" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "glAccountCode" TEXT NOT NULL,
  "bankName" TEXT NOT NULL,
  "accountLabel" TEXT,
  "accountNumber" TEXT,
  "iban" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'ILS',
  "notes" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX "bank_accounts_tenantId_glAccountCode_key" ON "bank_accounts"("tenantId","glAccountCode");
CREATE INDEX "bank_accounts_tenantId_isActive_idx" ON "bank_accounts"("tenantId","isActive");
