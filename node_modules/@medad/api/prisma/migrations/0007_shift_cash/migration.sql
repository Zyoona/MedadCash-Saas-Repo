-- Medad 0007_shift_cash — ربط الورديات بالصندوق الفعلي (§Phase4).
-- Cumulative migration; additive only (no destructive changes).
--
-- 1) حساب «فروقات الصندوق (عجز/فائض)» 5310 لكل مستأجر قائم: يُرحَّل عند إقفال الوردية
--    عجز: Dr 5310 / Cr 1000 — فائض: Dr 1000 / Cr 5310، فيطابق رصيد الصندوق العدّ الفعلي.
-- 2) فهرس يدعم استعلامات الوردية المفتوحة (مستأجر + فرع + كاشير + closedAt).
--
-- ملاحظات ملزمة:
--  - لا يُخزَّن أي رصيد على shifts: المتوقع يُشتق من journal_lines (append-only) لفرع الوردية
--    خلال نافذتها الزمنية، ومبلغ الافتتاح هو عدّ للنقد الموجود أصلاً في 1000 (بلا قيد).
--  - قيد «وردية مفتوحة واحدة لكل (مستأجر، فرع، كاشير)» يبقى على مستوى التطبيق (ShiftsService.open)
--    ولا يُفرض بفهرس فريد: البذر ينشئ ورديات اليوم قبل إقفال ورديات الأيام السابقة لنفس الكاشير.

INSERT INTO "accounts" ("id", "tenantId", "code", "name", "type")
SELECT gen_random_uuid()::text, t."id", '5310', 'فروقات الصندوق (عجز/فائض)', 'expense'
FROM "tenants" t
WHERE NOT EXISTS (
  SELECT 1 FROM "accounts" a WHERE a."tenantId" = t."id" AND a."code" = '5310'
);

CREATE INDEX IF NOT EXISTS "shifts_tenant_branch_cashier_open_idx"
  ON "shifts"("tenantId", "branchId", "cashierId", "closedAt");
