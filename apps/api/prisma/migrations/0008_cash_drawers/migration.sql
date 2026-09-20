-- Medad 0008_cash_drawers — درج/عهدة نقدية مستقلة لكل كاشير (§Phase4).
-- Cumulative migration; additive only (no destructive changes).
--
-- النموذج: حساب GL أصلي مستقل (1010+) لكل كاشير يحمل عهدة الصندوق أثناء ورديته.
--   الافتتاح: Dr درج / Cr 1000 (تحويل العهدة من صندوق الفرع).
--   المبيعات/المرتجعات النقدية لفواتير الوردية: تُرحَّل إلى حساب الدرج بدل 1000.
--   الإقفال:  Dr 1000 (المُسلَّم فعلياً) + Dr/Cr 5310 (العجز/الفائض) / Cr درج (رصيد العهدة)
--             ⇒ يعود حساب الدرج إلى الصفر ويطابق 1000 النقد المُسلَّم.
--   المتوقع = رصيد حساب الدرج من journal_lines (append-only) — لا يُخزَّن أي رصيد مشتق.
-- الورديات القديمة (drawerId = NULL) تبقى على مسار المطابقة السابق:
--   الافتتاح + صافي حركة 1000 لفرع الوردية خلال نافذتها.

CREATE TABLE "cash_drawers" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"("id"),
  "cashierId" TEXT NOT NULL REFERENCES "users"("id"),
  "name" TEXT NOT NULL,
  "glAccountCode" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX "cash_drawers_tenantId_cashierId_key" ON "cash_drawers"("tenantId","cashierId");
CREATE UNIQUE INDEX "cash_drawers_tenantId_glAccountCode_key" ON "cash_drawers"("tenantId","glAccountCode");
CREATE INDEX "cash_drawers_tenantId_idx" ON "cash_drawers"("tenantId");

ALTER TABLE "shifts" ADD COLUMN "drawerId" TEXT REFERENCES "cash_drawers"("id");
CREATE INDEX "shifts_tenantId_drawerId_idx" ON "shifts"("tenantId","drawerId");
