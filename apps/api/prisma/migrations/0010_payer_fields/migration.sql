-- Migration: 0010_payer_fields
-- إضافة حقلي payerName و payerAccount لدعم المراجعة في دفعات الفواتير وقيود التحصيل

-- حقلا المراجعة في دفعات الفاتورة (طريقة غير نقدية)
ALTER TABLE "invoice_payments"
  ADD COLUMN "payerName"    TEXT,
  ADD COLUMN "payerAccount" TEXT;

-- حقلا المراجعة في قيود اليومية (تحصيل الديون وغيرها)
ALTER TABLE "journal_entries"
  ADD COLUMN "payerName"    TEXT,
  ADD COLUMN "payerAccount" TEXT;
