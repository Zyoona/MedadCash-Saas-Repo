# Medad — نظام مداد لإدارة ومحاسبة المكتبة

> المبدأ الحاكم: الأنظمة المحاسبية لا تقبل الخطأ — كل حركة مالية ومخزنية لها أثر قيد مزدوج غير قابل للتعديل، مع Audit Log مستقل.

## البنية (Monorepo)

- `apps/web` — React + TypeScript + PWA (Vite)، RTL عربي، يشمل غلاف PWA.
- `apps/api` — NestJS + Prisma + PostgreSQL (سحابة)؛ SQLite محلي لاحقًا بنفس الـ Schema.
- `packages/shared-types` — العقود المشتركة (DTO/Validation/Zod).

## القيود الصارمة (ملزمة)

1. `journal_entries` و `journal_lines` هي **Append-only**: ممنوع UPDATE/DELETE من أي API. التصحيح بقيد عكسي فقط (`reverses_entry_id`).
2. كل عملية مالية/مخزنية داخل **Transaction ذرية واحدة** (مستند + قيود + مخزون + sync op + audit).
3. التوازن يُفرض على مستويين: كود (Dr=Cr قبل الحفظ) + قاعدة بيانات (CHECK + Trigger).
4. المبالغ `NUMERIC(18,2)` فقط، والحساب بأعداد صحيحة (Cents/Agora) أو Decimal — ممنوع Float.
5. ترتيب حساب الفاتورة ثابت: خصم السطر → خصم الفاتورة موزع نسبيًا → الضريبة بعد الخصومات (السعر غير شامل، الافتراضي 0%).
6. Soft-delete فقط (`deleted_at`)، والهجرات تراكمية مرقمة فقط.

## التشغيل

```powershell
npm install
npm run prisma:migrate -w apps/api
npm run prisma:seed -w apps/api
npm run dev:api   # NestJS
npm run dev:web   # Vite PWA
```

## الاختبارات

```powershell
npm run test:ledger -w apps/api   # اختبارات محرك القيد المزدوج (§9.1)
npm test                          # كل اختبارات API
```
