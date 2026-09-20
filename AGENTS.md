# AGENTS.md — قواعد العمل في مستودع Medad

> هذه القواعد ملزمة لكل تعديل على المستودع (وكيل أو مطوّر).

## 1) قاعدة البيانات المحلية لا تُرفع إلى Git أبداً

قاعدة البيانات تعمل محلياً كـ PostgreSQL مضمّن، وملفاتها خاصة بكل جهاز. **ممنوع** `git add` (أو `git add -f`) لأي من:

- `_tools/pgsql/` — عنقود PostgreSQL الكامل (البيانات + WAL + `postmaster.pid` + السجل). مستثنى بالكامل في `.gitignore`.
- `_tools/backups/` و`_tools/uploads/` — نسخ احتياطية وملفات مرفوعة تحتوي بيانات حقيقية.
- `apps/api/.env` — أسرار الجهاز ومنها `DATABASE_URL`.
- أي ملف `*.db` / `*.sqlite` داخل أي مجلد `prisma/` (`**/prisma/*.db`).

السبب: اختلاف محتوى القاعدة بين الأجهزة يُنتج تعارضات دمج لا معنى لها. البيانات تنتقل بالنسخ الاحتياطي/التصدير، لا عبر Git.

## 2) كل تعديل على البنية = Migration ملزم

أي تغيير في `apps/api/prisma/schema.prisma` (جدول جديد، عمود، enum، فهرس، علاقة، قيد) **يجب** أن يرافقه ملف migration مُثبَّت في Git تحت:

```
apps/api/prisma/migrations/<NNNN>_<name>/migration.sql
```

الطريقة المعتمدة:

```powershell
npm run pg:start                                   # 1) شغّل قاعدة البيانات المحلية
npm run db:migrate:dev -- --name add_<short_name>  # 2) ولّد الهجرة (اسم إنجليزي وصفي)
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/   # 3) ثبّت الاثنين معاً
```

قواعد ملزمة:

- الهجرات **تراكمية ومرقّمة** (`0008_...` بعد `0007_...`) و**إضافية فقط**؛ لا تغيير هدّام بلا هجرة عكسية.
- **ممنوع** تعديل migration مُطبَّق سابقاً — التصحيح بهجرة جديدة.
- **ممنوع** `prisma db push` أو تعديل الجداول يدوياً؛ الطريق الوحيد هو migration.
- عند سحب تغييرات جهاز آخر: `npm run db:migrate` (أي `prisma migrate deploy`) لتطبيق الهجرات الجديدة محلياً.

> الخلاصة: **البيانات لا تُنقل عبر Git، والبنية تُنقل عبر migrations فقط.**

## 3) أوامر سريعة

| الغرض | الأمر |
|---|---|
| تشغيل / إيقاف / حالة القاعدة | `npm run pg:start` / `npm run pg:stop` / `npm run pg:status` |
| إنشاء migration جديد | `npm run db:migrate:dev -- --name <name>` |
| تطبيق الهجرات على جهاز | `npm run db:migrate` |
| تهيئة كاملة (تشغيل + هجرات + بذر) | `npm run db:setup` |
