import { PrismaClient, Prisma } from '@prisma/client';
import { computeInvoice, fromAgora } from '@medad/shared-types';
import { allocateProRata, agoraToDec, mulBps } from '../src/common/money.util';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = new PrismaClient();

// ─── Money helper (integer agora → Decimal(18,2)) — مشترك مع الكود الفعلي ───
const dec = agoraToDec;

// ─── Account codes ───
const CASH = '1000';
const BANK = '1100';
const RCHECK = '1200';
const AR = '1300';
const INVA = '1400';
const TRANSIT = '1410';
const ITAX = '1500';
const AP = '2000';
const TAXP = '2100';
const PCHECK = '2200';
const OPEN = '3900';
const REV = '4000';
const RETEXP = '4100';
const COGS = '5000';
const ADJ = '5200';
const CASH_DIFF = '5310';

// ─── Deterministic RNG (mulberry32) ───
let _s = 20250102;
function rnd(): number {
  _s |= 0; _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function ri(min: number, max: number): number { return min + Math.floor(rnd() * (max - min + 1)); }
function pick<T>(arr: T[]): T { return arr[Math.floor(rnd() * arr.length)]; }

// ─── Dates ───
const CY = new Date().getFullYear();
const PY = CY - 1;
function d(y: number, m: number, day: number, h = 10, min = 0): Date { return new Date(y, m - 1, day, h, min, 0); }
function today(h: number, min = 0): Date { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, min, 0); }

// ─── Chart of accounts ───
const CHART = [
  { code: '1000', name: 'الصندوق', type: 'asset' },
  { code: '1100', name: 'البنك — الحساب الجاري', type: 'asset' },
  { code: '1101', name: 'البنك — حساب التشغيل', type: 'asset' },
  { code: '1200', name: 'شيكات برسم التحصيل', type: 'asset' },
  { code: '1300', name: 'ذمم العملاء', type: 'asset' },
  { code: '1400', name: 'المخزون', type: 'asset' },
  { code: '1410', name: 'مخزون قيد النقل (وسيط)', type: 'asset' },
  { code: '1500', name: 'ضريبة مدفوعة (مستردة)', type: 'asset' },
  { code: '2000', name: 'ذمم الموردين', type: 'liability' },
  { code: '2100', name: 'ضريبة مستحقة', type: 'liability' },
  { code: '2200', name: 'شيكات مدفوعة', type: 'liability' },
  { code: '3000', name: 'رأس المال', type: 'equity' },
  { code: '3900', name: 'أرصدة افتتاحية (مقابل)', type: 'equity' },
  { code: '4000', name: 'إيراد المبيعات', type: 'revenue' },
  { code: '4100', name: 'خصم مسموح / مصروف مرتجعات', type: 'expense' },
  { code: '5000', name: 'تكلفة البضاعة المباعة', type: 'expense' },
  { code: '5200', name: 'تسويات الجرد (عجز/فائض)', type: 'expense' },
  { code: '5300', name: 'مصروفات عامة', type: 'expense' },
  { code: '5310', name: 'فروقات الصندوق (عجز/فائض)', type: 'expense' },
] as const;

// ─── Catalog definitions (مكتبة قرطاسية + مطبعة + هدايا وتجهيز هدايا) ───
const CATS = ['أدوات كتابة', 'دفاتر وورق', 'مواد مكتبية', 'قسم المطبعة', 'هدايا وتغليف', 'خدمات المطبعية'];
const BRANDS = ['مداد', 'دولار Dollar', 'لارك Lark', 'داكس Dux', 'فابر كاستل', 'Paper One', 'كانجارو Kangaro', 'بيور Pure', 'HP', 'Canon'];
const UNITS = [
  { name: 'قطعة', symbol: 'قطعة' },
  { name: 'علبة', symbol: 'علبة' },
  { name: 'رزمة', symbol: 'رزمة' },
  { name: 'لفافة', symbol: 'لفافة' },
  { name: 'متر', symbol: 'م' },
  { name: 'دزينة', symbol: 'دز' },
];

interface ProdDef {
  name: string; sku: string; cat: string; brand: string; unit: string;
  cost: number; price: number; variants?: string[]; svc?: boolean; low?: number;
}
const PRODUCTS: ProdDef[] = [
  // أدوات كتابة
  { name: 'قلم حبر جاف', sku: 'PEN-BALL', cat: 'أدوات كتابة', brand: 'دولار Dollar', unit: 'قطعة', cost: 120, price: 200, variants: ['أزرق', 'أسود', 'أحمر'], low: 10 },
  { name: 'قلم رصاص HB', sku: 'PEN-HB', cat: 'أدوات كتابة', brand: 'لارك Lark', unit: 'قطعة', cost: 80, price: 150, low: 10 },
  { name: 'ممحاة بيضاء', sku: 'ST-ERASER', cat: 'أدوات كتابة', brand: 'مداد', unit: 'قطعة', cost: 60, price: 125, low: 8 },
  { name: 'مقلمة قماش بسحاب', sku: 'BAG-PENCIL', cat: 'أدوات كتابة', brand: 'لارك Lark', unit: 'قطعة', cost: 800, price: 1400, variants: ['رمادي', 'أزرق'] },
  { name: 'علبة ألوان خشبية 24 لون', sku: 'COL-W24', cat: 'أدوات كتابة', brand: 'فابر كاستل', unit: 'علبة', cost: 2800, price: 4200, low: 3 },
  { name: 'ماركر سبورة أسود', sku: 'MKR-BRD', cat: 'أدوات كتابة', brand: 'دولار Dollar', unit: 'قطعة', cost: 350, price: 550 },
  { name: 'ماركر دائم أسود', sku: 'MKR-PERM', cat: 'أدوات كتابة', brand: 'دولار Dollar', unit: 'قطعة', cost: 350, price: 600 },
  { name: 'أقلام جيل ملونة علبة 10', sku: 'PEN-GEL10', cat: 'أدوات كتابة', brand: 'لارك Lark', unit: 'علبة', cost: 900, price: 1500 },
  // دفاتر وورق
  { name: 'دفتر 100 ورقة مربعات', sku: 'NTR-100', cat: 'دفاتر وورق', brand: 'مداد', unit: 'قطعة', cost: 700, price: 1100, variants: ['غلاف صلب', 'غلاف مرن'], low: 10 },
  { name: 'دفتر ملاحظات صغير 60 ورقة', sku: 'NTR-60', cat: 'دفاتر وورق', brand: 'مداد', unit: 'قطعة', cost: 300, price: 500, low: 10 },
  { name: 'ورق طباعة A4 80غم', sku: 'PPR-A4', cat: 'دفاتر وورق', brand: 'Paper One', unit: 'رزمة', cost: 820, price: 1300, low: 6 },
  { name: 'ورق ألوان A4', sku: 'PPR-COLOR', cat: 'دفاتر وورق', brand: 'Paper One', unit: 'رزمة', cost: 780, price: 1300 },
  { name: 'مغلفات 22×11 علبة 50', sku: 'ENV-50', cat: 'دفاتر وورق', brand: 'مداد', unit: 'علبة', cost: 600, price: 950 },
  { name: 'مفكرة جلدية A5', sku: 'AGD-LTH5', cat: 'دفاتر وورق', brand: 'مداد', unit: 'قطعة', cost: 1500, price: 2500, variants: ['بني', 'أسود'] },
  // مواد مكتبية
  { name: 'دباسة مكتب متوسطة', sku: 'OFC-STAP', cat: 'مواد مكتبية', brand: 'كانجارو Kangaro', unit: 'قطعة', cost: 1200, price: 1800 },
  { name: 'دبابيس 24/6 علبة', sku: 'OFC-PINS', cat: 'مواد مكتبية', brand: 'كانجارو Kangaro', unit: 'علبة', cost: 300, price: 500, low: 8 },
  { name: 'صمغ سائل 100مل', sku: 'OFC-GLUE', cat: 'مواد مكتبية', brand: 'بيور Pure', unit: 'قطعة', cost: 400, price: 650 },
  { name: 'مقص 21سم', sku: 'OFC-SCIS', cat: 'مواد مكتبية', brand: 'داكس Dux', unit: 'قطعة', cost: 600, price: 1000 },
  { name: 'حامل أوراق معدني', sku: 'OFC-HOLD', cat: 'مواد مكتبية', brand: 'مداد', unit: 'قطعة', cost: 1500, price: 2500 },
  { name: 'حقيبة مدرسية', sku: 'BAG-SCH', cat: 'مواد مكتبية', brand: 'لارك Lark', unit: 'قطعة', cost: 5500, price: 8500, variants: ['أزرق', 'وردي'] },
  // قسم المطبعة
  { name: 'حبر ليزر HP 85A أسود', sku: 'INK-HP85', cat: 'قسم المطبعة', brand: 'HP', unit: 'قطعة', cost: 8500, price: 12000 },
  { name: 'حبر نفاث Canon PG-540', sku: 'INK-CN540', cat: 'قسم المطبعة', brand: 'Canon', unit: 'قطعة', cost: 5500, price: 8500 },
  { name: 'لفافة تسريس 61سم×50م', sku: 'ROL-61', cat: 'قسم المطبعة', brand: 'مداد', unit: 'لفافة', cost: 3000, price: 4800, low: 4 },
  { name: 'حلزون تجليد 12مل علبة 100', sku: 'BND-SP12', cat: 'قسم المطبعة', brand: 'مداد', unit: 'علبة', cost: 1000, price: 1600 },
  { name: 'أغلفة تدوير حراري A4 رزمة 100', sku: 'LAM-A4', cat: 'قسم المطبعة', brand: 'مداد', unit: 'رزمة', cost: 1800, price: 2800 },
  { name: 'كرت أبيض 250غم A4 رزمة', sku: 'CRD-250', cat: 'قسم المطبعة', brand: 'Paper One', unit: 'رزمة', cost: 2000, price: 3200 },
  // هدايا وتغليف
  { name: 'ورق تغليف هدايا لفة', sku: 'GFT-WRAP', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'لفافة', cost: 600, price: 1000, low: 6 },
  { name: 'كيس هدايا ورقي كبير', sku: 'GFT-BAG', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'قطعة', cost: 350, price: 600, variants: ['ذهبي', 'أحمر'], low: 8 },
  { name: 'شريط ساتان 10م', sku: 'GFT-RB10', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'قطعة', cost: 250, price: 450 },
  { name: 'فيونكات جاهزة علبة', sku: 'GFT-BOW', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'علبة', cost: 500, price: 800 },
  { name: 'بالونات احتفال علبة 50', sku: 'GFT-BLON', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'علبة', cost: 1200, price: 2000 },
  { name: 'كوب سيراميك مطبوع', sku: 'GFT-MUG', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'قطعة', cost: 1000, price: 1800 },
  { name: 'إطار صور خشبي 20×25', sku: 'GFT-FRAME', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'قطعة', cost: 1800, price: 3000 },
  { name: 'سلة هدايا خشبية متوسطة', sku: 'GFT-BASK', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'قطعة', cost: 2500, price: 4000 },
  { name: 'علبة شوكولاتة فاخرة 250غ', sku: 'GFT-CHOC', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'قطعة', cost: 2200, price: 3500 },
  { name: 'دمية قطيفة دب 35سم', sku: 'GFT-TEDY', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'قطعة', cost: 3000, price: 4800 },
  { name: 'كرة زجاجية ديكور', sku: 'GFT-ORB', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'قطعة', cost: 800, price: 1400 },
  { name: 'شمعة عطرية هدايا', sku: 'GFT-CAND', cat: 'هدايا وتغليف', brand: 'مداد', unit: 'قطعة', cost: 900, price: 1600 },
  // خدمات المطبعة والهدايا (بلا أثر مخزني)
  { name: 'طباعة أبيض وأسود A4 (صفحة)', sku: 'SVC-PR-BW', cat: 'خدمات المطبعية', brand: 'مداد', unit: 'قطعة', cost: 0, price: 25, svc: true },
  { name: 'طباعة ملونة A4 (صفحة)', sku: 'SVC-PR-CL', cat: 'خدمات المطبعية', brand: 'مداد', unit: 'قطعة', cost: 0, price: 150, svc: true },
  { name: 'تصوير A4 (نسخة)', sku: 'SVC-COPY', cat: 'خدمات المطبعية', brand: 'مداد', unit: 'قطعة', cost: 0, price: 20, svc: true },
  { name: 'تجليد لولبي (قطعة)', sku: 'SVC-BIND', cat: 'خدمات المطبعية', brand: 'مداد', unit: 'قطعة', cost: 0, price: 300, svc: true },
  { name: 'تدوير حراري A4 (ورقة)', sku: 'SVC-LAM', cat: 'خدمات المطبعية', brand: 'مداد', unit: 'قطعة', cost: 0, price: 200, svc: true },
  { name: 'تغليف هدية (خدمة)', sku: 'SVC-GIFT', cat: 'خدمات المطبعية', brand: 'مداد', unit: 'قطعة', cost: 0, price: 500, svc: true },
  { name: 'طباعة 100 كرت شخصية', sku: 'SVC-CARD', cat: 'خدمات المطبعية', brand: 'مداد', unit: 'علبة', cost: 0, price: 12000, svc: true },
  { name: 'طباعة بنر (للمتر)', sku: 'SVC-BANR', cat: 'خدمات المطبعية', brand: 'مداد', unit: 'متر', cost: 0, price: 3000, svc: true },
];

// ─── Suppliers / Customers ───
const SUPPLIERS = [
  { name: 'مؤسسة النور لتوزيع القرطاسية', phone: '0599211001', opening: 400000 },
  { name: 'شركة رحال للتوريدات المكتبية', phone: '0598332002', opening: 250000 },
  { name: 'مطبعة المعرفة للمواد التعليمية', phone: '042410003', opening: 0 },
  { name: 'مستوردات الجمال للهدايا', phone: '0599444004', opening: 0 },
];

interface CustDef { name: string; phone: string; branch: 'main' | 'b2'; opening: number; limit: number; terms: string; company?: boolean }
const CUSTOMERS: CustDef[] = [
  { name: 'مكتب المعلم للكتب المدرسية', phone: '0599551001', branch: 'main', opening: 250000, limit: 1000000, terms: 'شيك شهري', company: true },
  { name: 'مدرسة النجاح الأساسية', phone: '0599552002', branch: 'main', opening: 180000, limit: 800000, terms: '30 يوماً', company: true },
  { name: 'شركة نور الدعوية للطباعة والإعلان', phone: '0599553003', branch: 'main', opening: 350000, limit: 1500000, terms: 'نقدي عند التسليم', company: true },
  { name: 'بلدية الظاهرية - دائرة الثقافة', phone: '042911004', branch: 'main', opening: 500000, limit: 2000000, terms: 'شيك', company: true },
  { name: 'ثانوية الرواد', phone: '0599553005', branch: 'b2', opening: 120000, limit: 600000, terms: '30 يوماً', company: true },
  { name: 'مؤسسة قمر لتجهيز الهدايا', phone: '0599554006', branch: 'b2', opening: 80000, limit: 500000, terms: 'أسبوع' },
  { name: 'أبو محمد - زبون دائم', phone: '0599555007', branch: 'main', opening: 0, limit: 300000, terms: 'نقدي' },
  { name: 'أم يزن - زبونة دائمة', phone: '0599556008', branch: 'b2', opening: 0, limit: 200000, terms: 'نقدي' },
];

// ─── Fake state ───
const qty = new Map<string, number>();           // `${branchId}|${variantId}` → qty
const costMap = new Map<string, number>();       // `${branchId}|${productId}` → agora
const priceMap = new Map<string, number>();      // `${branchId}|${productId}` → agora
const arBal = new Map<string, number>();         // customerId → agora
const apBal = new Map<string, number>();         // supplierId → agora
const accountsByCode = new Map<string, { id: string }>();
const lamportByBranch = new Map<string, number>();
const kqty = (branchId: string, variantId: string) => `${branchId}|${variantId}`;
const kcost = (branchId: string, productId: string) => `${branchId}|${productId}`;

type Fy = { id: string; start: Date; end: Date };
type PostLine = { accountCode: string; debitAgora?: number; creditAgora?: number; customerId?: string | null; supplierId?: string | null; memo?: string };

async function post(db: Prisma.TransactionClient, tenantId: string, branchId: string, fys: Fy[], date: Date, sourceType: string, sourceId: string, memo: string, lines: PostLine[]): Promise<string> {
  // نفس قواعد LedgerService.assertBalanced: أعداد صحيحة، طرف واحد فقط، لا أسطر صفرية، توازن كامل
  const clean = lines.map((l) => ({ ...l, debitAgora: l.debitAgora ?? 0, creditAgora: l.creditAgora ?? 0 }));
  let dr = 0, cr = 0;
  for (const l of clean) {
    if (!Number.isInteger(l.debitAgora) || l.debitAgora < 0 || !Number.isInteger(l.creditAgora) || l.creditAgora < 0) {
      throw new Error(`invalid line amount in ${sourceType}/${memo}: ${JSON.stringify(l)}`);
    }
    if (l.debitAgora > 0 === l.creditAgora > 0) throw new Error(`must be one-sided in ${sourceType}/${memo}`);
    dr += l.debitAgora; cr += l.creditAgora;
  }
  if (clean.length < 2 || dr !== cr || dr === 0) throw new Error(`unbalanced ${sourceType}/${memo}: Dr=${dr} Cr=${cr}`);
  const fy = fys.find((f) => f.start <= date && f.end >= date);
  if (!fy) throw new Error(`no open fiscal year for ${date.toISOString()} in ${sourceType}/${memo}`);
  const entry = await db.journalEntry.create({
    data: {
      tenantId, branchId, fiscalYearId: fy.id, date, sourceType, sourceId, memo,
      lines: {
        create: clean.map((l) => ({
          accountId: accountsByCode.get(l.accountCode)!.id,
          debit: dec(l.debitAgora), credit: dec(l.creditAgora),
          customerId: l.customerId ?? null, supplierId: l.supplierId ?? null, memo: l.memo ?? null,
        })),
      },
    },
    select: { id: true },
  });
  return entry.id;
}

async function moveStock(db: Prisma.TransactionClient, tenantId: string, branchId: string, productId: string, variantId: string | null, delta: number): Promise<void> {
  const existing = await db.branchStock.findFirst({ where: { branchId, productId, variantId } });
  if (existing) await db.branchStock.update({ where: { id: existing.id }, data: { qty: existing.qty + delta } });
  else await db.branchStock.create({ data: { tenantId, branchId, productId, variantId, qty: delta } });
  if (variantId) qty.set(kqty(branchId, variantId), (qty.get(kqty(branchId, variantId)) ?? 0) + delta);
}

function audit(db: Prisma.TransactionClient, tenantId: string, p: { actorId?: string | null; branchId?: string | null; action: string; entity: string; entityId?: string | null; diff?: unknown; date?: Date; device?: string | null }) {
  return db.auditLog.create({
    data: {
      tenantId, actorId: p.actorId ?? null, branchId: p.branchId ?? null,
      action: p.action, entity: p.entity, entityId: p.entityId ?? null,
      diff: (p.diff ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: '127.0.0.1', device: p.device ?? null,
      ...(p.date ? { createdAt: p.date } : {}),
    },
  });
}

function syncOp(db: Prisma.TransactionClient, tenantId: string, branchId: string, p: { entity: string; entityId: string; op: 'create' | 'update' | 'delete'; payload: unknown; date?: Date }) {
  const n = (lamportByBranch.get(branchId) ?? 0) + 1;
  lamportByBranch.set(branchId, n);
  return db.syncOperation.create({
    data: {
      tenantId, branchId, deviceId: 'server', entity: p.entity, entityId: p.entityId, op: p.op,
      payload: p.payload as Prisma.InputJsonValue, lamport: n, appliedAt: p.date ?? new Date(),
      ...(p.date ? { createdAt: p.date } : {}),
    },
  });
}

async function main() {
  // حماية بيئة الإنتاج: لا تشغّل التعبئة إلا بموافقة صريحة
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== '1') {
    throw new Error('[seed] تعطيل التعبئة في بيئة الإنتاج (set ALLOW_SEED=1 to override)');
  }
  // ════════════════ BASE (idempotent) ════════════════
  const tenantId = '00000000-0000-4000-8000-000000000001';
  await prisma.tenant.upsert({
    where: { id: tenantId },
    update: {}, // لا نغيّر اسم مستأجر قائم (حماية من التشغيل على قاعدة غير تطويرية)
    create: { id: tenantId, name: 'مكتبة مداد', createdAt: d(PY, 1, 1, 8) },
  });

  let main = await prisma.branch.findFirst({ where: { tenantId, name: 'الفرع الرئيسي' } });
  if (!main) main = await prisma.branch.create({ data: { tenantId, name: 'الفرع الرئيسي', address: 'الشارع الرئيسي - الظاهرية', phone: '042680001', createdAt: d(PY, 1, 1, 8) } });
  let b2 = await prisma.branch.findFirst({ where: { tenantId, name: 'فرع الشارع التجاري' } });
  if (!b2) b2 = await prisma.branch.create({ data: { tenantId, name: 'فرع الشارع التجاري', address: 'الشارع التجاري - وسط البلد', phone: '042680002', createdAt: d(PY, 6, 1, 8) } });

  for (const a of CHART) {
    await prisma.account.upsert({
      where: { tenantId_code: { tenantId, code: a.code } },
      update: { name: a.name, type: a.type },
      create: { tenantId, code: a.code, name: a.name, type: a.type, createdAt: d(PY, 1, 1, 8) },
    });
  }
  for (const acc of await prisma.account.findMany({ where: { tenantId }, select: { code: true, id: true } })) {
    accountsByCode.set(acc.code, acc);
  }

  // ── Bank accounts (الحسابات البنكية) — أول بنك يتبنى 1100 والثاني 1101 (idempotent) ──
  const banksSeed = [
    { glAccountCode: BANK, bankName: 'بنك فلسطين', accountLabel: 'الحساب الجاري الرئيسي', accountNumber: '9900-1234567-1', iban: 'PS92PALS000000000000000000001' },
    { glAccountCode: '1101', bankName: 'بنك القدس', accountLabel: 'حساب التشغيل', accountNumber: '5500-7788992-2', iban: 'PS20JONB000000000000000000002' },
  ];
  for (const b of banksSeed) {
    const exists = await prisma.bankAccount.findFirst({ where: { tenantId, glAccountCode: b.glAccountCode, deletedAt: null } });
    if (!exists) await prisma.bankAccount.create({ data: { tenantId, ...b, currency: 'ILS', isActive: true } });
  }

  await prisma.fiscalYear.upsert({
    where: { id: (await prisma.fiscalYear.findFirst({ where: { tenantId, name: String(PY) } }))?.id ?? 'will-create' },
    update: {},
    create: { tenantId, name: String(PY), startDate: d(PY, 1, 1), endDate: d(PY, 12, 31, 23, 59), createdAt: d(PY, 1, 1, 8) },
  }).catch(async () => {
    if (!(await prisma.fiscalYear.findFirst({ where: { tenantId, name: String(PY) } }))) {
      await prisma.fiscalYear.create({ data: { tenantId, name: String(PY), startDate: d(PY, 1, 1), endDate: d(PY, 12, 31, 23, 59), createdAt: d(PY, 1, 1, 8) } });
    }
  });
  if (!(await prisma.fiscalYear.findFirst({ where: { tenantId, name: String(CY) } }))) {
    await prisma.fiscalYear.create({ data: { tenantId, name: String(CY), startDate: d(CY, 1, 1), endDate: d(CY, 12, 31, 23, 59), createdAt: d(PY, 12, 20, 8) } });
  }
  const fys: Fy[] = (await prisma.fiscalYear.findMany({ where: { tenantId, isClosed: false }, orderBy: { startDate: 'asc' } }))
    .map((f) => ({ id: f.id, start: f.startDate, end: f.endDate }));

  const staffHash = await bcrypt.hash('Medad@123', 12);
  const usersSpec = [
    { email: 'admin@medad.local', name: 'مدير النظام', role: 'manager', branchId: null as string | null, override: null as Prisma.InputJsonValue | undefined },
    { email: 'saba@medad.local', name: 'سما أبو ريان — محاسبة', role: 'accountant', branchId: main.id, override: undefined },
    { email: 'rana@medad.local', name: 'رنا أحمد — كاشير الفرع الرئيسي', role: 'cashier', branchId: main.id, override: { override_credit_limit: true } as Prisma.InputJsonValue },
    { email: 'omar@medad.local', name: 'عمر خليل — كاشير الفرع التجاري', role: 'cashier', branchId: b2.id, override: undefined },
    { email: 'waleed@medad.local', name: 'وليد فؤاد — أمين مخزن', role: 'inventory', branchId: main.id, override: { 'pos.sell': false } as Prisma.InputJsonValue },
  ];
  const users: Record<string, string> = {};
  for (const u of usersSpec) {
    const passwordHash = staffHash;
    const existing = await prisma.user.findUnique({ where: { tenantId_email: { tenantId, email: u.email } } });
    if (existing) {
      // لا نلمس كلمة مرور مستخدم قائم — أبداً
      users[u.email] = existing.id;
      continue;
    }
    const created = await prisma.user.create({
      data: {
        tenantId, branchId: u.branchId, email: u.email, passwordHash, name: u.name, role: u.role,
        permissionsOverride: u.override, createdAt: d(PY, 1, 1, 9),
      },
    });
    users[u.email] = created.id;
  }
  const adminId = users['admin@medad.local'];
  const sabaId = users['saba@medad.local'];
  const waleedId = users['waleed@medad.local'];
  const ranaId = users['rana@medad.local'];
  const omarId = users['omar@medad.local'];

  // ── أدراج العهدة النقدية (§Phase4): حساب GL أصلي مستقل لكل كاشير (1010+) — idempotent ──
  const DRAWER_BASE = 1010;
  const drawerOf = new Map<string, { id: string; code: string }>(); // cashierId → درج العهدة
  for (const cashierId of [ranaId, omarId]) {
    const existing = await prisma.cashDrawer.findFirst({ where: { tenantId, cashierId, deletedAt: null } });
    if (existing) {
      if (!accountsByCode.has(existing.glAccountCode)) {
        const acc = await prisma.account.findFirst({ where: { tenantId, code: existing.glAccountCode }, select: { id: true } });
        if (acc) accountsByCode.set(existing.glAccountCode, acc);
      }
      drawerOf.set(cashierId, { id: existing.id, code: existing.glAccountCode });
      continue;
    }
    let code = DRAWER_BASE;
    while (accountsByCode.has(String(code))) code += 1;
    const cashier = await prisma.user.findUnique({ where: { id: cashierId }, select: { name: true } });
    const acc = await prisma.account.create({
      data: { tenantId, code: String(code), name: `عهدة درج — ${cashier?.name ?? 'الكاشير'}`, type: 'asset', createdAt: d(PY, 1, 1, 8) },
    });
    accountsByCode.set(acc.code, { id: acc.id });
    const drawer = await prisma.cashDrawer.create({
      data: { tenantId, cashierId, name: `درج ${cashier?.name ?? 'الكاشير'}`, glAccountCode: acc.code, createdAt: d(PY, 1, 1, 9) },
    });
    drawerOf.set(cashierId, { id: drawer.id, code: drawer.glAccountCode });
  }

  const defaults: [string, unknown][] = [
    ['tax_rate', { rateBps: 0 }],
    ['fiscal_year_start', { month: 1, day: 1 }],
    ['low_stock_default', { qty: 5 }],
    ['currency', { code: 'ILS', symbol: '₪' }],
    ['drive_config', { configured: false }],
    ['restocking_fee_account', { code: '4100' }],
    ['backup_keep', { n: 7 }],
    ['backup_auto', { enabled: true }],
  ];
  for (const [k, value] of defaults) {
    const s = await prisma.setting.findFirst({ where: { tenantId, branchId: null, key: k } });
    if (!s) await prisma.setting.create({ data: { tenantId, branchId: null, key: k, value: value as Prisma.InputJsonValue } });
  }
  console.log('[seed] base data ready (tenant=مكتبة مداد, branches=2, users=5)');

  // ════════════════ FAKE DATASET (once) ════════════════
  let skipped = false;
  await prisma.$transaction(async (db) => {
    // الحارس داخل المعاملة لتفادي سباق تشغيلين متوازيين (والقيد الفريد للباركود يضيف حماية إضافية)
    const marker = await db.setting.findFirst({ where: { tenantId, branchId: null, key: 'fake_seed' } });
    if (marker) {
      console.log('[seed] fake dataset already seeded — skipping (delete setting fake_seed to re-seed)');
      skipped = true;
      return;
    }

    // ── Categories / brands / units ──
    const catIds = new Map<string, string>();
    for (const c of CATS) catIds.set(c, (await db.category.create({ data: { tenantId, name: c, createdAt: d(PY, 1, 2, 9) } })).id);
    const brandIds = new Map<string, string>();
    for (const b of BRANDS) brandIds.set(b, (await db.brand.create({ data: { tenantId, name: b, createdAt: d(PY, 1, 2, 9) } })).id);
    const unitIds = new Map<string, string>();
    for (const u of UNITS) unitIds.set(u.name, (await db.unit.create({ data: { tenantId, name: u.name, symbol: u.symbol, createdAt: d(PY, 1, 2, 9) } })).id);

    // ── Products + variants + per-branch price/cost ──
    const prod = new Map<string, { id: string; svc: boolean; variants: { id: string; name: string }[] }>();
    let bcSeq = 1;
    const barcode = () => `2${String(PY).slice(2)}01${String(bcSeq++).padStart(8, '0')}`;
    for (const p of PRODUCTS) {
      const created = await db.product.create({
        data: {
          tenantId, name: p.name, sku: p.sku,
          categoryId: catIds.get(p.cat)!, brandId: brandIds.get(p.brand)!,
          baseUnitId: unitIds.get(p.unit)!, lowStockDefault: p.low ?? 5,
          isContainer: false, createdAt: d(PY, 1, 5, 10),
        },
      });
      const variants: { id: string; name: string }[] = [];
      for (const v of (p.variants ?? ['افتراضي'])) {
        const vr = await db.productVariant.create({ data: { tenantId, productId: created.id, name: v, barcode: barcode(), createdAt: d(PY, 1, 5, 10) } });
        variants.push({ id: vr.id, name: v });
      }
      for (const br of [main, b2]) {
        const priceAgora = br.id === main.id ? p.price : Math.round((p.price * 1.05) / 50) * 50;
        await db.productBranch.create({
          data: { tenantId, productId: created.id, branchId: br.id, price: dec(priceAgora), cost: dec(p.cost), minAlert: p.low ?? null },
        });
        costMap.set(kcost(br.id, created.id), p.cost);
        priceMap.set(kcost(br.id, created.id), priceAgora);
      }
      prod.set(p.sku, { id: created.id, svc: !!p.svc, variants });
      await audit(db, tenantId, { actorId: adminId, action: 'create', entity: 'products', entityId: created.id, diff: { name: p.name, sku: p.sku }, date: d(PY, 1, 5, 10) });
    }

    // unit conversions + cost components (نماذج)
    {
      const paper = prod.get('PPR-A4')!;
      const cartonUnit = await db.unit.create({ data: { tenantId, name: 'كرتونة', symbol: 'كرت', createdAt: d(PY, 1, 2, 9) } });
      await db.productUnit.create({ data: { tenantId, productId: paper.id, unitId: unitIds.get('رزمة')!, factor: 1 } });
      await db.productUnit.create({ data: { tenantId, productId: paper.id, unitId: cartonUnit.id, factor: 5, barcode: barcode() } });
      const mug = prod.get('GFT-MUG')!;
      await db.costComponent.create({ data: { tenantId, productId: mug.id, label: 'كوب فارغ', amount: dec(600) } });
      await db.costComponent.create({ data: { tenantId, productId: mug.id, label: 'طباعة سيراميك', amount: dec(400) } });
      const frame = prod.get('GFT-FRAME')!;
      await db.costComponent.create({ data: { tenantId, productId: frame.id, label: 'إطار خشب', amount: dec(1200) } });
      await db.costComponent.create({ data: { tenantId, productId: frame.id, label: 'زجاج وتركيب', amount: dec(600) } });
    }

    // ── Parties ──
    const cashMain = await db.customer.create({ data: { tenantId, branchId: main.id, name: 'زبون نقدي', isCashDefault: true, createdAt: d(PY, 1, 1, 9) } });
    const cashB2 = await db.customer.create({ data: { tenantId, branchId: b2.id, name: 'زبون نقدي', isCashDefault: true, createdAt: d(PY, 6, 1, 9) } });

    const supIds: Record<string, string> = {};
    for (const s of SUPPLIERS) {
      const row = await db.supplier.create({
        data: { tenantId, name: s.name, phone: s.phone, openingBalance: dec(s.opening), openingDate: s.opening > 0 ? d(PY, 1, 2, 9) : null, createdAt: d(PY, 1, 2, 9) },
      });
      supIds[s.name] = row.id;
      if (s.opening > 0) {
        await post(db, tenantId, main.id, fys, d(PY, 1, 2, 9), 'opening_balance', row.id, `رصيد افتتاحي لمورد: ${s.name}`, [
          { accountCode: OPEN, debitAgora: s.opening },
          { accountCode: AP, creditAgora: s.opening, supplierId: row.id },
        ]);
        apBal.set(row.id, s.opening);
      } else apBal.set(row.id, 0);
    }

    const cust = new Map<string, { id: string; branchId: string; limit: number; company: boolean }>();
    for (const c of CUSTOMERS) {
      const branch = c.branch === 'main' ? main : b2;
      const row = await db.customer.create({
        data: {
          tenantId, branchId: branch.id, name: c.name, phone: c.phone,
          openingBalance: dec(c.opening), openingDate: c.opening > 0 ? d(PY, 1, 2, 9) : null,
          creditLimit: dec(c.limit), paymentTerms: c.terms, createdAt: d(PY, 1, 3, 10),
        },
      });
      cust.set(c.name, { id: row.id, branchId: branch.id, limit: c.limit, company: !!c.company });
      if (c.opening > 0) {
        await post(db, tenantId, branch.id, fys, d(PY, 1, 2, 9), 'opening_balance', row.id, `رصيد افتتاحي لعميل: ${c.name}`, [
          { accountCode: AR, debitAgora: c.opening, customerId: row.id },
          { accountCode: OPEN, creditAgora: c.opening },
        ]);
      }
      arBal.set(row.id, c.opening);
    }
    arBal.set(cashMain.id, 0);
    arBal.set(cashB2.id, 0);

    // ── Opening cash/bank ──
    const OPEN_CASH = 6000000;  // 60,000 ₪
    const OPEN_BANK = 15000000; // 150,000 ₪
    const OPEN_BANK2 = 5000000; // 50,000 ₪
    await post(db, tenantId, main.id, fys, d(PY, 1, 2, 9), 'opening_balance', accountsByCode.get(CASH)!.id, 'رصيد افتتاحي: الصندوق', [
      { accountCode: CASH, debitAgora: OPEN_CASH },
      { accountCode: OPEN, creditAgora: OPEN_CASH },
    ]);
    await post(db, tenantId, main.id, fys, d(PY, 1, 2, 9), 'opening_balance', accountsByCode.get(BANK)!.id, 'رصيد افتتاحي: البنك — الحساب الجاري', [
      { accountCode: BANK, debitAgora: OPEN_BANK },
      { accountCode: OPEN, creditAgora: OPEN_BANK },
    ]);
    await post(db, tenantId, main.id, fys, d(PY, 1, 2, 9), 'opening_balance', accountsByCode.get('1101')!.id, 'رصيد افتتاحي: البنك — حساب التشغيل', [
      { accountCode: '1101', debitAgora: OPEN_BANK2 },
      { accountCode: OPEN, creditAgora: OPEN_BANK2 },
    ]);

    // ── Purchases ──
    let pSeq = 1;
    interface BuyLine { sku: string; qty: number; cost: number }
    async function createPurchase(o: {
      y: number; m: number; day: number; supplier: string; branchId: string;
      lines: BuyLine[]; taxBps: number; discount: number;
      status: 'ordered' | 'pending' | 'received';
      payRatio?: number; payAccount?: string; receiveDay?: number;
    }) {
      const refNo = `P-${o.y}-${String(pSeq++).padStart(4, '0')}`;
      const date = d(o.y, o.m, o.day, 11);
      const supplierId = supIds[o.supplier];
      const purchase = await db.purchase.create({
        data: {
          tenantId, branchId: o.branchId, supplierId,
          status: o.status, refNo, discountAgora: o.discount, taxRateBps: o.taxBps,
          notes: null, createdAt: date,
          lines: {
            create: o.lines.map((l) => ({
              variantId: prod.get(l.sku)!.variants[0].id, qty: l.qty, unitCostAgora: l.cost, lineDiscountAgora: 0,
            })),
          },
        },
        select: { id: true },
      });
      await audit(db, tenantId, { actorId: waleedId, branchId: o.branchId, action: 'create', entity: 'purchases', entityId: purchase.id, diff: { refNo, supplierId, lines: o.lines.length, status: o.status }, date });
      await syncOp(db, tenantId, o.branchId, { entity: 'purchase', entityId: purchase.id, op: 'create', payload: { refNo, status: o.status, supplierId }, date });
      if (o.status !== 'received') return;

      // computeTotals — نفس ترتيب computeTotals في purchases.service (خصم أسطر ← توزيع تناسبي ← ضريبة)
      const afterLine = o.lines.map((l) => l.qty * l.cost);
      const shares = allocateProRata(o.discount, afterLine);
      const taxable = afterLine.map((v, i) => v - shares[i]);
      const tax = taxable.map((t) => mulBps(t, o.taxBps));
      const inventoryTotal = taxable.reduce((s, x) => s + x, 0);
      const taxTotal = tax.reduce((s, x) => s + x, 0);
      const grand = inventoryTotal + taxTotal;

      const payRatio = o.payRatio ?? 1;
      const payAccount = o.payAccount ?? CASH;
      const paid = payRatio >= 1 ? grand : Math.floor((grand * payRatio) / 1000) * 1000;
      const remainder = grand - paid;
      const payments = paid > 0 ? [{ accountCode: payAccount, amountAgora: paid }] : [];
      const recvDate = d(o.y, o.m, o.receiveDay ?? o.day + 1, 12);

      for (let i = 0; i < o.lines.length; i++) {
        const l = o.lines[i];
        const p = prod.get(l.sku)!;
        await moveStock(db, tenantId, o.branchId, p.id, p.variants[0].id, l.qty);
        const netUnit = Math.floor(taxable[i] / l.qty);
        costMap.set(kcost(o.branchId, p.id), netUnit);
        await db.productBranch.updateMany({ where: { tenantId, branchId: o.branchId, productId: p.id }, data: { cost: dec(netUnit) } });
      }
      for (const pay of payments) {
        await db.supplierPayment.create({ data: { purchaseId: purchase.id, accountCode: pay.accountCode, amount: dec(pay.amountAgora), createdAt: recvDate } });
      }
      const grouped = new Map<string, number>();
      for (const pay of payments) grouped.set(pay.accountCode, (grouped.get(pay.accountCode) ?? 0) + pay.amountAgora);
      await post(db, tenantId, o.branchId, fys, recvDate, 'purchase', purchase.id, `استلام مشتريات ${refNo}`, [
        { accountCode: INVA, debitAgora: inventoryTotal },
        ...(taxTotal > 0 ? [{ accountCode: ITAX, debitAgora: taxTotal }] : []),
        ...[...grouped.entries()].map(([code, amt]) => ({ accountCode: code, creditAgora: amt })),
        ...(remainder > 0 ? [{ accountCode: AP, creditAgora: remainder, supplierId }] : []),
      ]);
      await db.purchase.update({ where: { id: purchase.id }, data: { status: 'received', taxAgora: taxTotal } });
      apBal.set(supplierId, (apBal.get(supplierId) ?? 0) + remainder);
      await audit(db, tenantId, { actorId: waleedId, branchId: o.branchId, action: 'receive', entity: 'purchases', entityId: purchase.id, diff: { refNo, inventoryTotal, taxTotal, remainder }, date: recvDate });
      await syncOp(db, tenantId, o.branchId, { entity: 'purchase', entityId: purchase.id, op: 'update', payload: { refNo, status: 'received', grandTotalAgora: grand }, date: recvDate });
    }

    await createPurchase({ y: PY, m: 1, day: 20, receiveDay: 21, supplier: 'مؤسسة النور لتوزيع القرطاسية', branchId: main.id, taxBps: 1600, discount: 0, status: 'received', payRatio: 1, payAccount: CASH, lines: [
      { sku: 'PEN-BALL', qty: 240, cost: 120 }, { sku: 'PEN-HB', qty: 150, cost: 80 },
      { sku: 'MKR-BRD', qty: 80, cost: 350 }, { sku: 'NTR-100', qty: 120, cost: 700 },
      { sku: 'PPR-A4', qty: 50, cost: 820 }, { sku: 'ENV-50', qty: 40, cost: 600 },
    ] });
    await createPurchase({ y: PY, m: 2, day: 5, receiveDay: 6, supplier: 'شركة رحال للتوريدات المكتبية', branchId: main.id, taxBps: 0, discount: 1500, status: 'received', payRatio: 0.6, payAccount: CASH, lines: [
      { sku: 'OFC-STAP', qty: 20, cost: 1200 }, { sku: 'OFC-PINS', qty: 60, cost: 300 },
      { sku: 'OFC-GLUE', qty: 50, cost: 400 }, { sku: 'OFC-SCIS', qty: 30, cost: 600 },
      { sku: 'BAG-PENCIL', qty: 25, cost: 800 }, { sku: 'COL-W24', qty: 15, cost: 2800 },
    ] });
    // ── الجرد الأولي (2025-02-10) — بعد أول توريدَين وقبل أي مبيعات ──
    {
      const date = d(PY, 2, 10, 9);
      const lines: { variantId: string; expectedQty: number; countedQty: number }[] = [];
      let netAdjustment = 0;
      const variantsByProduct = new Map<string, { productId: string; variantId: string }[]>();
      for (const [, p] of prod) {
        for (const v of p.variants) variantsByProduct.set(v.id, [{ productId: p.id, variantId: v.id }]);
      }
      for (const [k, have] of [...qty.entries()]) {
        if (!k.startsWith(`${main.id}|`) || have <= 0) continue;
        const variantId = k.split('|')[1];
        const variance = rnd() < 0.75 ? 0 : (rnd() < 0.65 ? ri(1, 2) : -1);
        const counted = Math.max(0, have + variance);
        lines.push({ variantId, expectedQty: have, countedQty: counted });
        if (counted !== have) {
          const productId = variantsByProduct.get(variantId)![0].productId;
          await moveStock(db, tenantId, main.id, productId, variantId, counted - have);
          netAdjustment += (counted - have) * (costMap.get(kcost(main.id, productId)) ?? 0);
        }
      }
      const count = await db.stockCount.create({
        data: { tenantId, branchId: main.id, type: 'initial', notes: 'جرد أولي لبدء التشغيل', createdAt: date, lines: { create: lines } },
        select: { id: true },
      });
      if (netAdjustment !== 0) {
        const abs = Math.abs(netAdjustment);
        await post(db, tenantId, main.id, fys, date, 'stock_adjustment', count.id, `جرد أولي — فرق ${(netAdjustment / 100).toFixed(2)} ₪`, netAdjustment > 0
          ? [{ accountCode: INVA, debitAgora: abs }, { accountCode: OPEN, creditAgora: abs }]
          : [{ accountCode: OPEN, debitAgora: abs }, { accountCode: INVA, creditAgora: abs }]);
      }
      await audit(db, tenantId, { actorId: waleedId, branchId: main.id, action: 'create', entity: 'stock_counts', entityId: count.id, diff: { type: 'initial', lines: lines.length, netAdjustment }, date });
      await syncOp(db, tenantId, main.id, { entity: 'stock_count', entityId: count.id, op: 'create', payload: { type: 'initial', netAdjustment }, date });
    }

    await createPurchase({ y: PY, m: 3, day: 10, receiveDay: 11, supplier: 'مطبعة المعرفة للمواد التعليمية', branchId: main.id, taxBps: 1600, discount: 0, status: 'received', payRatio: 1, payAccount: BANK, lines: [
      { sku: 'INK-HP85', qty: 10, cost: 8500 }, { sku: 'INK-CN540', qty: 8, cost: 5500 },
      { sku: 'ROL-61', qty: 30, cost: 3000 }, { sku: 'BND-SP12', qty: 20, cost: 1000 },
      { sku: 'LAM-A4', qty: 15, cost: 1800 }, { sku: 'CRD-250', qty: 25, cost: 2000 },
    ] });
    await createPurchase({ y: PY, m: 5, day: 8, receiveDay: 9, supplier: 'مستوردات الجمال للهدايا', branchId: b2.id, taxBps: 0, discount: 0, status: 'received', payRatio: 0.4, payAccount: CASH, lines: [
      { sku: 'GFT-WRAP', qty: 60, cost: 600 }, { sku: 'GFT-BAG', qty: 80, cost: 350 },
      { sku: 'GFT-RB10', qty: 70, cost: 250 }, { sku: 'GFT-BOW', qty: 40, cost: 500 },
      { sku: 'GFT-BLON', qty: 30, cost: 1200 }, { sku: 'GFT-MUG', qty: 25, cost: 1000 },
      { sku: 'GFT-FRAME', qty: 15, cost: 1800 }, { sku: 'GFT-CAND', qty: 20, cost: 900 },
    ] });
    await createPurchase({ y: PY, m: 9, day: 14, receiveDay: 15, supplier: 'مؤسسة النور لتوزيع القرطاسية', branchId: main.id, taxBps: 0, discount: 0, status: 'received', payRatio: 0.55, payAccount: CASH, lines: [
      { sku: 'PEN-BALL', qty: 300, cost: 115 }, { sku: 'PEN-HB', qty: 200, cost: 75 },
      { sku: 'ST-ERASER', qty: 150, cost: 55 }, { sku: 'NTR-60', qty: 200, cost: 280 },
      { sku: 'COL-W24', qty: 40, cost: 2700 }, { sku: 'BAG-SCH', qty: 15, cost: 5500 },
      { sku: 'NTR-100', qty: 150, cost: 680 }, { sku: 'PPR-COLOR', qty: 30, cost: 780 },
    ] });
    await createPurchase({ y: PY, m: 11, day: 20, receiveDay: 21, supplier: 'شركة رحال للتوريدات المكتبية', branchId: main.id, taxBps: 0, discount: 0, status: 'received', payRatio: 1, payAccount: CASH, lines: [
      { sku: 'AGD-LTH5', qty: 30, cost: 1500 }, { sku: 'GFT-BASK', qty: 12, cost: 2500 },
      { sku: 'GFT-TEDY', qty: 20, cost: 3000 }, { sku: 'GFT-MUG', qty: 20, cost: 1000 },
      { sku: 'GFT-CHOC', qty: 25, cost: 2200 },
    ] });
    await createPurchase({ y: CY, m: 1, day: 18, receiveDay: 19, supplier: 'مستوردات الجمال للهدايا', branchId: b2.id, taxBps: 0, discount: 0, status: 'received', payRatio: 1, payAccount: BANK, lines: [
      { sku: 'GFT-WRAP', qty: 50, cost: 550 }, { sku: 'GFT-BAG', qty: 60, cost: 320 },
      { sku: 'GFT-RB10', qty: 50, cost: 240 }, { sku: 'GFT-ORB', qty: 25, cost: 800 },
    ] });
    await createPurchase({ y: CY, m: 3, day: 5, receiveDay: 6, supplier: 'مطبعة المعرفة للمواد التعليمية', branchId: b2.id, taxBps: 1600, discount: 0, status: 'received', payRatio: 0.5, payAccount: BANK, lines: [
      { sku: 'ROL-61', qty: 15, cost: 2900 }, { sku: 'BND-SP12', qty: 12, cost: 950 },
      { sku: 'CRD-250', qty: 15, cost: 1950 }, { sku: 'LAM-A4', qty: 10, cost: 1750 },
    ] });
    await createPurchase({ y: CY, m: 6, day: 20, receiveDay: 21, supplier: 'مؤسسة النور لتوزيع القرطاسية', branchId: main.id, taxBps: 0, discount: 0, status: 'received', payRatio: 1, payAccount: CASH, lines: [
      { sku: 'PEN-BALL', qty: 200, cost: 118 }, { sku: 'MKR-PERM', qty: 60, cost: 340 },
      { sku: 'PPR-A4', qty: 40, cost: 820 }, { sku: 'ENV-50', qty: 25, cost: 580 },
      { sku: 'PEN-GEL10', qty: 40, cost: 900 },
    ] });
    await createPurchase({ y: CY, m: 8, day: 28, receiveDay: 29, supplier: 'شركة رحال للتوريدات المكتبية', branchId: main.id, taxBps: 0, discount: 1000, status: 'received', payRatio: 0.6, payAccount: CASH, lines: [
      { sku: 'NTR-100', qty: 100, cost: 690 }, { sku: 'COL-W24', qty: 25, cost: 2650 },
      { sku: 'NTR-60', qty: 120, cost: 270 }, { sku: 'OFC-HOLD', qty: 10, cost: 1500 },
    ] });
    await createPurchase({ y: CY, m: 9, day: 16, supplier: 'مؤسسة النور لتوزيع القرطاسية', branchId: main.id, taxBps: 0, discount: 0, status: 'pending', lines: [
      { sku: 'PEN-BALL', qty: 150, cost: 118 }, { sku: 'PPR-A4', qty: 30, cost: 820 },
    ] });
    await createPurchase({ y: CY, m: new Date().getMonth() + 1, day: new Date().getDate(), supplier: 'شركة رحال للتوريدات المكتبية', branchId: main.id, taxBps: 0, discount: 0, status: 'ordered', lines: [
      { sku: 'GFT-CHOC', qty: 20, cost: 2200 }, { sku: 'GFT-TEDY', qty: 10, cost: 3000 },
      { sku: 'GFT-WRAP', qty: 40, cost: 600 },
    ] });

    // ── Shifts (3 مغلقة + 2 مفتوحة اليوم) + تحويل عهدة الصندوق إلى درج الكاشير عند كل افتتاح ──
    const shiftDefs: { key: string; branchId: string; cashierId: string; opening: number; openedAt: Date }[] = [
      { key: 'sh1', branchId: main.id, cashierId: ranaId, opening: 50000, openedAt: d(CY, 9, 15, 8, 30) },
      { key: 'sh2', branchId: main.id, cashierId: ranaId, opening: 30000, openedAt: d(CY, 9, 16, 8, 30) },
      { key: 'sh3', branchId: b2.id, cashierId: omarId, opening: 20000, openedAt: d(CY, 9, 16, 9, 0) },
      { key: 'sh4', branchId: main.id, cashierId: ranaId, opening: 50000, openedAt: today(8, 30) },
      { key: 'sh5', branchId: b2.id, cashierId: omarId, opening: 20000, openedAt: today(9, 0) },
    ];
    const shifts: Record<string, string> = {};
    const drawerByShift = new Map<string, string>(); // shiftId → كود حساب درج العهدة
    for (const sd of shiftDefs) {
      const drawer = drawerOf.get(sd.cashierId)!;
      const row = await db.shift.create({
        data: { tenantId, branchId: sd.branchId, cashierId: sd.cashierId, drawerId: drawer.id, openingAmount: dec(sd.opening), openedAt: sd.openedAt },
      });
      shifts[sd.key] = row.id;
      drawerByShift.set(row.id, drawer.code);
      // تحويل العهدة Dr درج / Cr 1000 — كما في ShiftsService.open
      await post(db, tenantId, sd.branchId, fys, sd.openedAt, 'shift_open', row.id,
        `تحويل عهدة صندوق إلى الدرج ${drawer.code} — افتتاح وردية ${fromAgora(sd.opening)} ₪`,
        [{ accountCode: drawer.code, debitAgora: sd.opening }, { accountCode: CASH, creditAgora: sd.opening }]);
      await audit(db, tenantId, { actorId: sd.cashierId, branchId: sd.branchId, action: 'open_shift', entity: 'shifts', entityId: row.id, diff: { openingAmountAgora: sd.opening, drawerAccountCode: drawer.code }, date: sd.openedAt });
    }
    const shiftCash = new Map<string, number>(); // shiftId → نقد الفواتير (يُرحَّل إلى حساب الدرج)

    // ── Sales ──
    const svcIds = new Set([...prod.values()].filter((p) => p.svc).map((p) => p.id));
    let invSeqByYear = new Map<number, number>();
    const invRef = (date: Date) => {
      const y = date.getFullYear();
      const n = (invSeqByYear.get(y) ?? 0) + 1;
      invSeqByYear.set(y, n);
      return `S-${y}-${String(n).padStart(4, '0')}`;
    };

    interface SaleLineIn { productId: string; variantId: string | null; qty: number; unitPriceAgora: number; lineDiscountAgora: number; taxRateBps: number }
    const invoices: { id: string; refNo: string; date: Date; branchId: string; customerId: string; recs: { variantId: string | null; productId: string; qty: number; unitPriceAgora: number; taxAgora: number; netAgora: number; costAgora: number; qtyOrig: number }[] }[] = [];

    async function sell(o: {
      date: Date; branchId: string; shiftId: string | null; customerId: string; company: boolean;
      skus?: string[]; maxLines?: number;
    }) {
      const branchId = o.branchId;
      const refNo = invRef(o.date);
      const usedProducts = new Set<string>();
      const lines: SaleLineIn[] = [];
      const nLines = ri(1, o.maxLines ?? 3);
      for (let li = 0; li < nLines; li++) {
        // بناء قائمة مرشحة: أصناف مخزنية متوفرة في الفرع + خدمات دائماً
        const candidates: { sku: string; variantId: string | null; available: number }[] = [];
        for (const [sku, p] of prod) {
          if (usedProducts.has(sku)) continue;
          if (o.skus && !o.skus.includes(sku)) continue;
          if (p.svc) candidates.push({ sku, variantId: null, available: 999 });
          else for (const v of p.variants) {
            const have = qty.get(kqty(branchId, v.id)) ?? 0;
            if (have > 0) candidates.push({ sku, variantId: v.id, available: have });
          }
        }
        if (!candidates.length) break;
        const chosen = pick(candidates);
        const p = prod.get(chosen.sku)!;
        usedProducts.add(chosen.sku);
        const priceAgora = priceMap.get(kcost(branchId, p.id))!;
        let qtySell = p.svc
          ? (chosen.sku === 'SVC-PR-BW' || chosen.sku === 'SVC-COPY' || chosen.sku === 'SVC-PR-CL' ? ri(5, 50) : ri(1, 3))
          : Math.min(chosen.available, chosen.sku === 'PPR-A4' ? ri(1, 3) : ri(1, 5));
        if (qtySell <= 0) continue;
        const gross = qtySell * priceAgora;
        const lineDiscount = rnd() < 0.15 && gross > 60 ? Math.min(gross - 50, ri(20, 300)) : 0;
        lines.push({
          productId: p.id, variantId: chosen.variantId, qty: qtySell, unitPriceAgora: priceAgora,
          lineDiscountAgora: lineDiscount, taxRateBps: o.company ? 1600 : 0,
        });
      }
      if (!lines.length) return null;

      const preTotal = computeInvoice(lines, 0).grandTotalAgora;
      const invoiceDiscount = rnd() < 0.1 && preTotal > 600 ? Math.min(preTotal - 100, ri(100, 800)) : 0;
      const totals = computeInvoice(lines, invoiceDiscount);

      // payments: cash / bank / mixed / credit
      const payments: { method: string; accountCode: string; amountAgora: number }[] = [];
      const roll = rnd();
      const cRec = o.customerId === cashMain.id || o.customerId === cashB2.id;
      const creditPart = roll < 0.18 && !cRec
        ? Math.min(totals.grandTotalAgora, Math.floor((totals.grandTotalAgora * ri(3, 8)) / 10 / 100) * 100)
        : 0;
      const limit = [...cust.values()].find((c) => c.id === o.customerId)?.limit ?? 0;
      if (creditPart > 0 && arBal.get(o.customerId)! + creditPart > limit) {
        // تجاوز حد الدين → بيع نقدي بدلاً من الآجل
        payments.push({ method: 'cash', accountCode: CASH, amountAgora: totals.grandTotalAgora });
        if (o.shiftId) shiftCash.set(o.shiftId, (shiftCash.get(o.shiftId) ?? 0) + totals.grandTotalAgora);
      } else if (creditPart > 0) {
        const cashPart = totals.grandTotalAgora - creditPart;
        if (cashPart > 0) {
          payments.push({ method: 'cash', accountCode: CASH, amountAgora: cashPart });
          if (o.shiftId) shiftCash.set(o.shiftId, (shiftCash.get(o.shiftId) ?? 0) + cashPart);
        }
        payments.push({ method: 'credit', accountCode: AR, amountAgora: creditPart });
        arBal.set(o.customerId, (arBal.get(o.customerId) ?? 0) + creditPart);
      } else if (roll < 0.73) {
        payments.push({ method: 'cash', accountCode: CASH, amountAgora: totals.grandTotalAgora });
        if (o.shiftId) shiftCash.set(o.shiftId, (shiftCash.get(o.shiftId) ?? 0) + totals.grandTotalAgora);
      } else if (roll < 0.91) {
        payments.push({ method: 'bank', accountCode: BANK, amountAgora: totals.grandTotalAgora });
      } else {
        const half = Math.floor(totals.grandTotalAgora / 2 / 100) * 100;
        if (half > 0) payments.push({ method: 'cash', accountCode: CASH, amountAgora: half });
        payments.push({ method: 'bank', accountCode: BANK, amountAgora: totals.grandTotalAgora - half });
        if (o.shiftId && half > 0) shiftCash.set(o.shiftId, (shiftCash.get(o.shiftId) ?? 0) + half);
      }

      const res = await createSaleDb(db, {
        tenantId, branchId, date: o.date, shiftId: o.shiftId, refNo, customerId: o.customerId, userId: branchId === main.id ? ranaId : omarId, fys,
      }, lines, payments, invoiceDiscount);
      invoices.push({ id: res.id, refNo, date: o.date, branchId, customerId: o.customerId, recs: res.recs });
      return res;
    }

    async function createSaleDb(
      db: Prisma.TransactionClient,
      ctx: { tenantId: string; branchId: string; date: Date; shiftId: string | null; refNo: string; customerId: string; userId: string; fys: Fy[] },
      lines: SaleLineIn[], payments: { method: string; accountCode: string; amountAgora: number }[], invoiceDiscountAgora: number,
    ) {
      const totals = computeInvoice(lines, invoiceDiscountAgora);
      const recs = lines.map((l, i) => ({
        productId: l.productId, variantId: l.variantId, qty: l.qty, unitPriceAgora: l.unitPriceAgora,
        lineDiscountAgora: l.lineDiscountAgora, taxRateBps: l.taxRateBps,
        taxAgora: totals.lines[i].taxAgora, netAgora: totals.lines[i].netAgora,
        costAgora: svcIds.has(l.productId) ? 0 : (costMap.get(kcost(ctx.branchId, l.productId)) ?? 0),
        share: totals.lines[i].invoiceDiscountShareAgora, qtyOrig: l.qty,
      }));
      for (const r of recs) {
        if (svcIds.has(r.productId)) continue;
        await moveStock(db, ctx.tenantId, ctx.branchId, r.productId, r.variantId, -r.qty);
      }
      const invoice = await db.invoice.create({
        data: {
          tenantId: ctx.tenantId, branchId: ctx.branchId, shiftId: ctx.shiftId, customerId: ctx.customerId,
          refNo: ctx.refNo, status: 'posted', invoiceDiscountAgora, createdAt: ctx.date,
          lines: {
            create: recs.map((r) => ({
              productId: r.productId, variantId: r.variantId, qty: r.qty,
              unitPriceAgora: r.unitPriceAgora, lineDiscountAgora: r.lineDiscountAgora,
              invoiceDiscountShareAgora: r.share, taxRateBps: r.taxRateBps,
              taxAgora: r.taxAgora, netAgora: r.netAgora, costAgora: r.costAgora,
            })),
          },
          payments: {
            create: payments.map((p) => ({ method: p.method, accountCode: p.accountCode, amount: dec(p.amountAgora), createdAt: ctx.date })),
          },
        },
        select: { id: true },
      });
      // نقد الوردية يُرحَّل إلى حساب درج العهدة — صفوف الدفعات تحتفظ بكود الطريقة (1000)
      const drawerCode = ctx.shiftId ? drawerByShift.get(ctx.shiftId) : undefined;
      const byAcc = new Map<string, number>();
      for (const p of payments) {
        const code = p.accountCode === CASH && drawerCode ? drawerCode : p.accountCode;
        byAcc.set(code, (byAcc.get(code) ?? 0) + p.amountAgora);
      }
      await post(db, ctx.tenantId, ctx.branchId, ctx.fys, ctx.date, 'sale', invoice.id, `فاتورة ${ctx.refNo}`, [
        ...[...byAcc.entries()].map(([code, amt]) => ({ accountCode: code, debitAgora: amt, customerId: code === AR ? ctx.customerId : null })),
        { accountCode: REV, creditAgora: totals.taxableTotalAgora },
        ...(totals.taxTotalAgora > 0 ? [{ accountCode: TAXP, creditAgora: totals.taxTotalAgora }] : []),
      ]);
      const cogsTotal = recs.reduce((s, r) => s + r.costAgora * r.qty, 0);
      if (cogsTotal > 0) {
        await post(db, ctx.tenantId, ctx.branchId, ctx.fys, ctx.date, 'sale_cogs', invoice.id, `تكلفة مبيعات فاتورة ${ctx.refNo}`, [
          { accountCode: COGS, debitAgora: cogsTotal },
          { accountCode: INVA, creditAgora: cogsTotal },
        ]);
      }
      await audit(db, ctx.tenantId, { actorId: ctx.userId, branchId: ctx.branchId, action: 'create', entity: 'invoices', entityId: invoice.id, diff: { refNo: ctx.refNo, grandTotalAgora: totals.grandTotalAgora, methods: payments.map((p) => p.method) }, date: ctx.date, device: 'POS' });
      await syncOp(db, ctx.tenantId, ctx.branchId, { entity: 'invoice', entityId: invoice.id, op: 'create', payload: { refNo: ctx.refNo, grandTotalAgora: totals.grandTotalAgora, customerId: ctx.customerId }, date: ctx.date });
      return { id: invoice.id, refNo: ctx.refNo, grandTotal: totals.grandTotalAgora, recs };
    }

    // فواتير الأيام الأخيرة المرتبطة بالورديات
    const mkB2Cust = [...cust.values()].find((c) => c.branchId === b2.id)!;
    const cashCustOf = (branchId: string) => (branchId === main.id ? cashMain.id : cashB2.id);
    async function cashSell(date: Date, branchId: string, shiftId: string | null, skus?: string[], maxLines?: number) {
      return sell({ date, branchId, shiftId, customerId: cashCustOf(branchId), company: false, skus, maxLines });
    }
    async function creditSell(date: Date, branchId: string, shiftId: string | null, customerName: string, skus?: string[]) {
      const c = cust.get(customerName)!;
      return sell({ date, branchId, shiftId, customerId: c.id, company: true, skus });
    }

    // SH1: يوم 15/9
    await cashSell(d(CY, 9, 15, 9, 40), main.id, shifts.sh1, ['SVC-PR-BW', 'PPR-A4', 'PEN-BALL']);
    await cashSell(d(CY, 9, 15, 11, 20), main.id, shifts.sh1, ['GFT-CHOC', 'GFT-WRAP', 'SVC-GIFT']);
    await cashSell(d(CY, 9, 15, 17, 5), main.id, shifts.sh1, ['NTR-100', 'PEN-GEL10']);
    // SH2: يوم 16/9
    await cashSell(d(CY, 9, 16, 10, 10), main.id, shifts.sh2, ['SVC-COPY', 'ENV-50']);
    await creditSell(d(CY, 9, 16, 12, 30), main.id, shifts.sh2, 'مدرسة النجاح الأساسية', ['PPR-A4', 'SVC-PR-BW']);
    await cashSell(d(CY, 9, 16, 18, 45), main.id, shifts.sh2, ['MKR-BRD', 'OFC-PINS']);
    // SH3: يوم 16/9 فرع تجاري
    await cashSell(d(CY, 9, 16, 11, 15), b2.id, shifts.sh3, ['GFT-BAG', 'GFT-RB10', 'SVC-GIFT']);
    await cashSell(d(CY, 9, 16, 16, 30), b2.id, shifts.sh3, ['GFT-MUG']);
    // (فواتير اليوم تُنشأ بعد الجرد اليومي — انظر الأسفل)

    // مولد الفواتير التاريخية: من شبار 2025 حتى نهاية الشهر الماضي (الأيام الأخيرة مغطاة بالورديات)
    for (let y = PY, m = 2; !(y === CY && m > new Date().getMonth()); m++) {
      if (m > 12) { y++; m = 1; }
      const isSep = m === 9;
      const nInv = (isSep ? 4 : 2) + ri(0, 1);
      for (let i = 0; i < nInv; i++) {
        const day = y === CY ? ri(1, 13) : (y === PY && m === 2 ? ri(12, 27) : ri(2, 27));
        const date = d(y, m, day, ri(9, 19), ri(0, 55));
        if (date >= today(0, 0)) continue;
        // الفرع: التجاري لا يبيع قبل حزيران 2025 (قبل أول توريد له)
        const branchId = date >= d(PY, 6, 1) && rnd() < 0.3 ? b2.id : main.id;
        const cashRoll = rnd();
        if (cashRoll < 0.62) {
          await cashSell(date, branchId, null);
        } else if (cashRoll < 0.92) {
          const candidates = [...cust.entries()].filter(([, c]) => c.branchId === branchId);
          const [, c] = pick(candidates);
          await sell({ date, branchId, shiftId: null, customerId: c.id, company: c.company });
        } else {
          await cashSell(date, branchId, null, ['SVC-PR-BW', 'SVC-COPY', 'SVC-BIND', 'SVC-GIFT']);
        }
      }
    }

    // ── مرتجعات مبيعات (2) ──
    async function makeReturn(o: { sourceIdx: number; fee: number; date: Date; refundAccount: string }) {
      const src = invoices[o.sourceIdx];
      if (!src) return;
      const physLines = src.recs.filter((r) => !svcIds.has(r.productId));
      if (!physLines.length) return;
      const pickLines = physLines.slice(0, Math.min(2, physLines.length)).map((r) => ({ r, q: Math.min(r.qtyOrig, ri(1, 2)) }));
      let taxableTotal = 0, taxTotal = 0, costTotal = 0;
      for (const { r, q } of pickLines) {
        const taxable = Math.round((r.netAgora - r.taxAgora) * (q / r.qtyOrig));
        taxableTotal += taxable;
        taxTotal += Math.round(r.taxAgora * (q / r.qtyOrig));
        costTotal += r.costAgora * q;
      }
      const refundGross = taxableTotal + taxTotal - o.fee;
      if (refundGross <= 0) return; // لا مرتجع برصيد استرداد سالب
      const ret = await db.saleReturn.create({
        data: {
          tenantId, branchId: src.branchId, sourceInvoiceId: src.id,
          restockingFeeAgora: o.fee, refundMethod: 'cash', refundAccountCode: o.refundAccount,
          createdAt: o.date,
          lines: { create: pickLines.map(({ r, q }) => ({ variantId: r.variantId ?? r.productId, qty: q })) },
        },
        select: { id: true },
      });
      for (const { r, q } of pickLines) {
        const productId = r.variantId ? (await db.productVariant.findFirst({ where: { id: r.variantId }, select: { productId: true } }))!.productId : r.productId;
        await moveStock(db, tenantId, src.branchId, productId, r.variantId, q);
      }
      await post(db, tenantId, src.branchId, fys, o.date, 'sale_return', ret.id, `مرتجع من فاتورة ${src.refNo}`, [
        { accountCode: REV, debitAgora: taxableTotal },
        ...(taxTotal > 0 ? [{ accountCode: TAXP, debitAgora: taxTotal }] : []),
        ...(costTotal > 0 ? [{ accountCode: INVA, debitAgora: costTotal }] : []),
        { accountCode: o.refundAccount, creditAgora: refundGross },
        ...(o.fee > 0 ? [{ accountCode: RETEXP, creditAgora: o.fee }] : []),
        ...(costTotal > 0 ? [{ accountCode: COGS, creditAgora: costTotal }] : []),
      ]);
      await audit(db, tenantId, { actorId: ranaId, branchId: src.branchId, action: 'create', entity: 'returns', entityId: ret.id, diff: { sourceInvoiceId: src.id, refundGross, fee: o.fee }, date: o.date });
      await syncOp(db, tenantId, src.branchId, { entity: 'sale_return', entityId: ret.id, op: 'create', payload: { sourceInvoiceId: src.id, refundGross }, date: o.date });
    }
    {
      // مرتجع 2025: أول فاتورة مخزنية في آذار-حزيران 2025
      const idx1 = invoices.findIndex((iv) => iv.date >= d(PY, 3, 1) && iv.date <= d(PY, 7, 1) && iv.recs.some((r) => !svcIds.has(r.productId)));
      if (idx1 >= 0) await makeReturn({ sourceIdx: idx1, fee: 0, date: d(PY, 7, 12, 14), refundAccount: CASH });
      // مرتجع 2026 بخصم إرجاع 5 ₪
      const idx2 = invoices.findLastIndex((iv) => iv.date >= d(CY, 6, 1) && iv.date < d(CY, 9, 15) && iv.recs.some((r) => !svcIds.has(r.productId)));
      if (idx2 >= 0 && idx2 !== idx1) await makeReturn({ sourceIdx: idx2, fee: 500, date: d(CY, 9, 10, 15), refundAccount: CASH });
    }

    // ── تحصيلات من العملاء (4) ──
    async function collect(o: { y: number; m: number; day: number; customer: string; accountCode: string; amount: number }) {
      const c = cust.get(o.customer)!;
      const amount = Math.min(o.amount, Math.max(0, arBal.get(c.id) ?? 0));
      if (amount <= 0) return;
      const date = d(o.y, o.m, o.day, 13);
      await post(db, tenantId, c.branchId, fys, date, 'collection', c.id, `تحصيل من ${o.customer}`, [
        { accountCode: o.accountCode, debitAgora: amount },
        { accountCode: AR, creditAgora: amount, customerId: c.id },
      ]);
      arBal.set(c.id, (arBal.get(c.id) ?? 0) - amount);
      await audit(db, tenantId, { actorId: sabaId, branchId: c.branchId, action: 'collection', entity: 'customers', entityId: c.id, diff: { amount }, date });
      await syncOp(db, tenantId, c.branchId, { entity: 'collection', entityId: c.id, op: 'create', payload: { customerId: c.id, amount }, date });
    }
    await collect({ y: PY, m: 5, day: 15, customer: 'مكتب المعلم للكتب المدرسية', accountCode: CASH, amount: 150000 });
    await collect({ y: PY, m: 12, day: 20, customer: 'مدرسة النجاح الأساسية', accountCode: BANK, amount: 200000 });
    await collect({ y: CY, m: 3, day: 15, customer: 'شركة نور الدعوية للطباعة والإعلان', accountCode: BANK, amount: 300000 });
    await collect({ y: CY, m: 8, day: 10, customer: 'بلدية الظاهرية - دائرة الثقافة', accountCode: CASH, amount: 250000 });

    // ── دفعات للموردين (4) ──
    async function paySupplier(o: { y: number; m: number; day: number; supplier: string; accountCode: string; amount: number }) {
      const sId = supIds[o.supplier];
      const amount = Math.min(o.amount, Math.max(0, apBal.get(sId) ?? 0));
      if (amount <= 0) return;
      const date = d(o.y, o.m, o.day, 13);
      await post(db, tenantId, main.id, fys, date, 'supplier_payment', sId, `دفع للمورد ${o.supplier}`, [
        { accountCode: AP, debitAgora: amount, supplierId: sId },
        { accountCode: o.accountCode, creditAgora: amount },
      ]);
      apBal.set(sId, (apBal.get(sId) ?? 0) - amount);
      await audit(db, tenantId, { actorId: sabaId, branchId: main.id, action: 'supplier_payment', entity: 'suppliers', entityId: sId, diff: { amount }, date });
      await syncOp(db, tenantId, main.id, { entity: 'supplier_payment', entityId: sId, op: 'create', payload: { supplierId: sId, amount }, date });
    }
    await paySupplier({ y: PY, m: 2, day: 20, supplier: 'شركة رحال للتوريدات المكتبية', accountCode: CASH, amount: 150000 });
    await paySupplier({ y: PY, m: 5, day: 25, supplier: 'مستوردات الجمال للهدايا', accountCode: BANK, amount: 120000 });
    await paySupplier({ y: CY, m: 2, day: 10, supplier: 'مؤسسة النور لتوزيع القرطاسية', accountCode: BANK, amount: 200000 });
    await paySupplier({ y: CY, m: 7, day: 1, supplier: 'مطبعة المعرفة للمواد التعليمية', accountCode: CASH, amount: 150000 });

    // ── شيكات (وارد: مصروف/معلق/مرتجع + صادر معلق) ──
    const school = cust.get('مدرسة النجاح الأساسية')!;
    const teacher = cust.get('مكتب المعلم للكتب المدرسية')!;
    const adv = cust.get('شركة نور الدعوية للطباعة والإعلان')!;
    const knowledge = supIds['مطبعة المعرفة للمواد التعليمية'];
    async function addCheck(o: {
      number: string; direction: 'in' | 'out'; amount: number; createdAt: Date; dueDate: Date;
      customerId?: string; supplierId?: string; partyName?: string;
      clearAt?: Date | null; bounceAt?: Date | null;
    }) {
      const accountCode = o.direction === 'in' ? RCHECK : PCHECK;
      const custById = new Map([...cust.values()].map((c) => [c.id, c]));
      const branchId = o.customerId ? (custById.get(o.customerId)?.branchId ?? main.id) : main.id;
      const check = await db.check.create({
        data: {
          tenantId, branchId, checkNumber: o.number, direction: o.direction, accountCode,
          partyName: o.partyName ?? null, customerId: o.customerId ?? null, supplierId: o.supplierId ?? null,
          amount: dec(o.amount), dueDate: o.dueDate, status: 'pending', createdAt: o.createdAt,
        },
        select: { id: true },
      });
      await post(db, tenantId, branchId, fys, o.createdAt, 'check', check.id, `شيك ${o.direction === 'in' ? 'وارد' : 'صادر'} رقم ${o.number}`, o.direction === 'in'
        ? [{ accountCode: RCHECK, debitAgora: o.amount, customerId: o.customerId }, { accountCode: AR, creditAgora: o.amount, customerId: o.customerId }]
        : [{ accountCode: AP, debitAgora: o.amount, supplierId: o.supplierId }, { accountCode: PCHECK, creditAgora: o.amount, supplierId: o.supplierId }]);
      if (o.direction === 'in') arBal.set(o.customerId!, (arBal.get(o.customerId!) ?? 0) - o.amount);
      else apBal.set(o.supplierId!, (apBal.get(o.supplierId!) ?? 0) - o.amount);
      await audit(db, tenantId, { actorId: sabaId, branchId, action: 'create', entity: 'checks', entityId: check.id, diff: { number: o.number, amount: o.amount }, date: o.createdAt });

      if (o.clearAt) {
        await post(db, tenantId, branchId, fys, o.clearAt, 'check_cleared', check.id, `صرف شيك ${o.number}`, o.direction === 'in'
          ? [{ accountCode: CASH, debitAgora: o.amount }, { accountCode: RCHECK, creditAgora: o.amount }]
          : [{ accountCode: PCHECK, debitAgora: o.amount }, { accountCode: CASH, creditAgora: o.amount }]);
        await db.check.update({ where: { id: check.id }, data: { status: 'cleared', clearedAt: o.clearAt } });
        await audit(db, tenantId, { actorId: sabaId, branchId, action: 'clear', entity: 'checks', entityId: check.id, diff: { number: o.number }, date: o.clearAt });
      }
      if (o.bounceAt) {
        await post(db, tenantId, branchId, fys, o.bounceAt, 'check_bounced', check.id, `ارتجاع شيك ${o.number}`, o.direction === 'in'
          ? [{ accountCode: AR, debitAgora: o.amount, customerId: o.customerId }, { accountCode: RCHECK, creditAgora: o.amount }]
          : [{ accountCode: PCHECK, debitAgora: o.amount }, { accountCode: AP, creditAgora: o.amount, supplierId: o.supplierId }]);
        await db.check.update({ where: { id: check.id }, data: { status: 'bounced' } });
        if (o.direction === 'in') arBal.set(o.customerId!, (arBal.get(o.customerId!) ?? 0) + o.amount);
        else apBal.set(o.supplierId!, (apBal.get(o.supplierId!) ?? 0) + o.amount);
        await audit(db, tenantId, { actorId: sabaId, branchId, action: 'bounce', entity: 'checks', entityId: check.id, diff: { number: o.number }, date: o.bounceAt });
      }
      return check;
    }
    await addCheck({ number: 'CH-1001', direction: 'in', amount: 250000, createdAt: d(PY, 5, 10, 12), dueDate: d(PY, 5, 10), customerId: school.id, partyName: 'مدرسة النجاح الأساسية', clearAt: d(PY, 5, 10, 14) });
    await addCheck({ number: 'CH-1002', direction: 'in', amount: 320000, createdAt: d(CY, 9, 10, 12), dueDate: d(CY, 9, 20), customerId: teacher.id, partyName: 'مكتب المعلم للكتب المدرسية' });
    await addCheck({ number: 'CH-1003', direction: 'in', amount: 150000, createdAt: d(CY, 1, 25, 12), dueDate: d(CY, 2, 1), customerId: adv.id, partyName: 'شركة نور الدعوية للطباعة والإعلان', bounceAt: d(CY, 2, 3, 11) });
    await addCheck({ number: 'CH-2001', direction: 'out', amount: 280000, createdAt: d(CY, 9, 15, 12), dueDate: d(CY, 9, 25), supplierId: knowledge, partyName: 'مطبعة المعرفة للمواد التعليمية' });

    // ── تحويلات بين الفروع (1 مستلم + 1 قيد النقل) ──
    async function transfer(o: { skus: [string, number][]; date: Date; receiveAt?: Date }) {
      let totalCost = 0;
      const lineRows: { variantId: string; qty: number; costAgora: number }[] = [];
      for (const [sku, q] of o.skus) {
        const p = prod.get(sku)!;
        const v = p.variants[0];
        const have = qty.get(kqty(main.id, v.id)) ?? 0;
        if (have < q) continue; // لا تحوّل أصناف غير متوفرة في الفرع المصدر
        const cost = costMap.get(kcost(main.id, p.id)) ?? 0;
        await moveStock(db, tenantId, main.id, p.id, v.id, -q);
        totalCost += cost * q;
        lineRows.push({ variantId: v.id, qty: q, costAgora: cost });
      }
      if (!lineRows.length) return;
      const t = await db.stockTransfer.create({
        data: { tenantId, fromBranchId: main.id, toBranchId: b2.id, status: 'in_transit', createdAt: o.date, lines: { create: lineRows } },
        select: { id: true },
      });
      await post(db, tenantId, main.id, fys, o.date, 'stock_transfer_out', t.id, 'تحويل صادر إلى فرع الشارع التجاري', [
        { accountCode: TRANSIT, debitAgora: totalCost },
        { accountCode: INVA, creditAgora: totalCost },
      ]);
      await audit(db, tenantId, { actorId: waleedId, branchId: main.id, action: 'create', entity: 'stock_transfers', entityId: t.id, diff: { totalCost }, date: o.date });
      await syncOp(db, tenantId, main.id, { entity: 'stock_transfer', entityId: t.id, op: 'create', payload: { status: 'in_transit', totalCost }, date: o.date });
      if (!o.receiveAt) return;
      for (const l of lineRows) {
        const productId = (await db.productVariant.findFirst({ where: { id: l.variantId }, select: { productId: true } }))!.productId;
        await moveStock(db, tenantId, b2.id, productId, l.variantId, l.qty);
      }
      await db.stockTransfer.update({ where: { id: t.id }, data: { status: 'received' } });
      await post(db, tenantId, b2.id, fys, o.receiveAt, 'stock_transfer_in', t.id, 'استلام تحويل من الفرع الرئيسي', [
        { accountCode: INVA, debitAgora: totalCost },
        { accountCode: TRANSIT, creditAgora: totalCost },
      ]);
      await audit(db, tenantId, { actorId: waleedId, branchId: b2.id, action: 'receive', entity: 'stock_transfers', entityId: t.id, diff: { totalCost }, date: o.receiveAt });
      await syncOp(db, tenantId, b2.id, { entity: 'stock_transfer', entityId: t.id, op: 'update', payload: { status: 'received' }, date: o.receiveAt });
    }
    await transfer({ skus: [['PEN-BALL', 20], ['PPR-A4', 10], ['NTR-100', 15]], date: d(CY, 4, 12, 10), receiveAt: d(CY, 4, 14, 11) });
    await transfer({ skus: [['GFT-MUG', 5], ['GFT-CHOC', 5]], date: d(CY, 9, 16, 13) });

    // ── عروض أسعار (مفتوح / محول / منتهي / ملغى) ──
    {
      const nor = cust.get('شركة نور الدعوية للطباعة والإعلان')!;
      const paper = prod.get('PPR-A4')!, spiral = prod.get('BND-SP12')!, roll = prod.get('ROL-61')!;
      const pPaper = priceMap.get(kcost(main.id, paper.id))!, pSpiral = priceMap.get(kcost(main.id, spiral.id))!, pRoll = priceMap.get(kcost(main.id, roll.id))!;
      const qOpen = await db.quotation.create({
        data: {
          tenantId, branchId: main.id, customerId: nor.id, expiryDate: d(CY, 10, 15), status: 'open', createdAt: d(CY, 9, 14, 10),
          lines: { create: [{ variantId: roll.variants[0].id, qty: 8, unitPriceAgora: pRoll }, { variantId: paper.variants[0].id, qty: 20, unitPriceAgora: pPaper }] },
        },
        select: { id: true },
      });
      await audit(db, tenantId, { actorId: sabaId, branchId: main.id, action: 'create', entity: 'quotations', entityId: qOpen.id, diff: { status: 'open' }, date: d(CY, 9, 14, 10) });
      // عرض محول → فاتورة أذار 2026
      const convDate = d(CY, 3, 22, 11);
      const conv = await sell({ date: convDate, branchId: main.id, shiftId: null, customerId: nor.id, company: true, skus: ['PPR-A4', 'BND-SP12'] });
      if (conv) {
        const qConv = await db.quotation.create({
          data: {
            tenantId, branchId: main.id, customerId: nor.id, expiryDate: d(CY, 4, 5), status: 'converted',
            convertedInvoiceId: conv.id, createdAt: d(CY, 3, 15, 10),
            lines: { create: [{ variantId: paper.variants[0].id, qty: 10, unitPriceAgora: pPaper }, { variantId: spiral.variants[0].id, qty: 5, unitPriceAgora: pSpiral }] },
          },
          select: { id: true },
        });
        await db.invoice.update({ where: { id: conv.id }, data: { refNo: `S-${CY}-${String(invSeqByYear.get(CY) ?? 0).padStart(4, '0')}Q` } });
        await audit(db, tenantId, { actorId: sabaId, branchId: main.id, action: 'convert', entity: 'quotations', entityId: qConv.id, diff: { invoiceId: conv.id }, date: convDate });
      }
      const qExp = await db.quotation.create({
        data: {
          tenantId, branchId: main.id, customerId: teacher.id, expiryDate: d(CY, 8, 5), status: 'expired', createdAt: d(CY, 7, 20, 10),
          lines: { create: [{ variantId: paper.variants[0].id, qty: 15, unitPriceAgora: pPaper }] },
        },
        select: { id: true },
      });
      await audit(db, tenantId, { actorId: sabaId, branchId: main.id, action: 'create', entity: 'quotations', entityId: qExp.id, diff: { status: 'expired' }, date: d(CY, 7, 20, 10) });
      const qCan = await db.quotation.create({
        data: {
          tenantId, branchId: b2.id, customerId: mkB2Cust.id, expiryDate: d(CY, 9, 1), status: 'cancelled', createdAt: d(CY, 8, 20, 10),
          lines: { create: [{ variantId: prod.get('GFT-BASK')!.variants[0].id, qty: 4, unitPriceAgora: priceMap.get(kcost(b2.id, prod.get('GFT-BASK')!.id)!) }] },
        },
        select: { id: true },
      });
      await audit(db, tenantId, { actorId: omarId, branchId: b2.id, action: 'cancel', entity: 'quotations', entityId: qCan.id, diff: {}, date: d(CY, 8, 25, 10) });
    }

    // ── جرد يومي بعجز بسيط (2026-09-16 مساءً — بعد كل الحركات المؤرخة قبله) ──
    {
      const date = d(CY, 9, 16, 18);
      const skus = ['PEN-BALL', 'NTR-60', 'OFC-PINS', 'PPR-A4'];
      const lines: { variantId: string; expectedQty: number; countedQty: number }[] = [];
      let netAdjustment = 0;
      for (const sku of skus) {
        const p = prod.get(sku)!;
        const v = p.variants[0];
        const expected = qty.get(kqty(main.id, v.id)) ?? 0;
        if (expected < 3) continue;
        const counted = expected - ri(1, 2);
        await moveStock(db, tenantId, main.id, p.id, v.id, counted - expected);
        netAdjustment += (counted - expected) * (costMap.get(kcost(main.id, p.id)) ?? 0);
        lines.push({ variantId: v.id, expectedQty: expected, countedQty: counted });
      }
      const count = await db.stockCount.create({
        data: { tenantId, branchId: main.id, type: 'daily', notes: 'جرد يومي عشوائي — عجز طفيف', createdAt: date, lines: { create: lines } },
        select: { id: true },
      });
      if (netAdjustment !== 0) {
        const abs = Math.abs(netAdjustment);
        await post(db, tenantId, main.id, fys, date, 'stock_adjustment', count.id, `جرد يومي — فرق ${(netAdjustment / 100).toFixed(2)} ₪`, [
          { accountCode: ADJ, debitAgora: abs },
          { accountCode: INVA, creditAgora: abs },
        ]);
      }
      await audit(db, tenantId, { actorId: waleedId, branchId: main.id, action: 'create', entity: 'stock_counts', entityId: count.id, diff: { type: 'daily', lines: lines.length, netAdjustment }, date });
      await syncOp(db, tenantId, main.id, { entity: 'stock_count', entityId: count.id, op: 'create', payload: { type: 'daily', netAdjustment }, date });
    }

    // ── فواتير اليوم (بعد الجرد) ──
    // SH4: اليوم
    await cashSell(today(9, 25), main.id, shifts.sh4, ['SVC-PR-CL', 'PPR-A4', 'PEN-BALL']);
    await creditSell(today(11, 40), main.id, shifts.sh4, 'شركة نور الدعوية للطباعة والإعلان', ['SVC-BANR', 'PPR-A4']);
    // SH5: اليوم فرع تجاري
    await cashSell(today(12, 15), b2.id, shifts.sh5, ['SVC-GIFT', 'GFT-WRAP', 'GFT-BAG', 'GFT-CHOC']);

    // ── مهام المطبعية/الهدايا ──
    const taskDefs = [
      { serviceProduct: 'تجليد لولبي 40 كتاب — كلية العلوم التربوية', deadline: d(CY, 9, 25), status: 'in_progress', customer: 'مكتب المعلم للكتب المدرسية' },
      { serviceProduct: 'طباعة 500 كرت شخصية — د. سامر', deadline: d(CY, 9, 22), status: 'ready', customer: 'شركة نور الدعوية للطباعة والإعلان' },
      { serviceProduct: 'تغليف هدية كبيرة + سلة فاخرة', deadline: d(CY, 9, 18), status: 'open', customer: 'مؤسسة قمر لتجهيز الهدايا' },
      { serviceProduct: 'تصميم وطباعة بنر 3×1م — مهرجان المدرسة', deadline: d(CY, 8, 28), status: 'delivered', customer: 'مدرسة النجاح الأساسية' },
      { serviceProduct: 'طباعة 200 دعوة زواج', deadline: d(PY, 12, 20), status: 'delivered', customer: 'أبو محمد - زبون دائم' },
      { serviceProduct: 'تجليد 5 رسائل جامعية (غلاف حراري)', deadline: d(CY, 9, 30), status: 'in_progress', customer: 'ثانوية الرواد' },
      { serviceProduct: 'طباعة شهادات تقدير 60 نسخة ملونة', deadline: d(CY, 7, 10), status: 'delivered', customer: 'بلدية الظاهرية - دائرة الثقافة' },
    ];
    for (const t of taskDefs) {
      const c = cust.get(t.customer);
      const row = await db.task.create({
        data: {
          tenantId, branchId: c?.branchId ?? main.id, customerId: c?.id ?? null,
          serviceProduct: t.serviceProduct, deadline: t.deadline, status: t.status,
          createdAt: d(CY, 8, ri(1, 28), 11),
        },
      });
      await audit(db, tenantId, { actorId: omarId, branchId: c?.branchId ?? main.id, action: 'create', entity: 'tasks', entityId: row.id, diff: { serviceProduct: t.serviceProduct, status: t.status }, date: row.createdAt });
    }

    // ── إغلاق الورديات المغلقة (المتوقع = افتتاحي + نقد المبيعات) — لا نغلق ورديات اليوم المفتوحة ──
    for (const [shiftId, cash] of [...shiftCash.entries()]) {
      if (shiftId === shifts.sh4 || shiftId === shifts.sh5) continue;
      const s = await db.shift.findFirst({ where: { id: shiftId } });
      if (!s || s.closedAt) continue;
      const opening = Number(s.openingAmount) * 100;
      const expected = Math.round(opening) + cash;
      const actual = shiftId === shifts.sh2 ? expected - 500 : expected; // عجز 5 ₪ موثق
      const closedAt = s.branchId === main.id ? d(CY, 9, shiftId === shifts.sh1 ? 15 : 16, 21, 30) : d(CY, 9, 16, 21, 0);
      await db.shift.update({
        where: { id: shiftId },
        data: { closingExpected: dec(expected), closingActual: dec(actual), closedAt, closedBy: adminId },
      });
      // تسليم العهدة عند الإقفال (كما في ShiftsService.close):
      // Dr 1000 (المُسلَّم فعلياً) + Dr/Cr 5310 (العجز/الفائض) / Cr درج (رصيد العهدة) ⇒ الدرج يعود صفراً
      const diff = actual - expected;
      const drawerCode = drawerByShift.get(shiftId);
      let diffEntryId: string | null = null;
      const closeLines: { accountCode: string; debitAgora?: number; creditAgora?: number }[] = [];
      if (actual > 0) closeLines.push({ accountCode: CASH, debitAgora: actual });
      if (drawerCode && expected > 0) closeLines.push({ accountCode: drawerCode, creditAgora: expected });
      if (diff < 0) closeLines.push({ accountCode: CASH_DIFF, debitAgora: -diff });
      else if (diff > 0) closeLines.push({ accountCode: CASH_DIFF, creditAgora: diff });
      if (closeLines.length >= 2) {
        diffEntryId = await post(db, tenantId, s.branchId, fys, closedAt, 'shift_close', shiftId,
          drawerCode
            ? `تسليم عهدة الدرج ${drawerCode} إلى الصندوق${diff === 0 ? '' : diff < 0 ? ` — عجز ${fromAgora(-diff)} ₪` : ` — فائض ${fromAgora(diff)} ₪`}`
            : diff < 0 ? `عجز صندوق عند إقفال الوردية ${fromAgora(-diff)} ₪` : `فائض صندوق عند إقفال الوردية ${fromAgora(diff)} ₪`,
          closeLines);
      }
      await audit(db, tenantId, { actorId: adminId, branchId: s.branchId, action: 'close_shift', entity: 'shifts', entityId: shiftId, diff: { expectedAgora: expected, actualAgora: actual, diffAgora: diff, drawerAccountCode: drawerCode ?? null, entryId: diffEntryId } });
    }

    // ── سجل دخول المستخدمين ──
    for (const [email, uid] of Object.entries(users)) {
      for (const dt of [d(PY, 3, 1, 8, 5), d(CY, 1, 5, 8, 10), today(8, 5)]) {
        await audit(db, tenantId, { actorId: uid, branchId: email === 'omar@medad.local' ? b2.id : main.id, action: 'login', entity: 'auth', entityId: uid, diff: null, date: dt, device: email === 'omar@medad.local' ? 'Till-02' : 'Till-01' });
      }
    }

    // ── وسم إنجاز التعبئة + ملخص التحقق ──
    await db.setting.create({ data: { tenantId, branchId: null, key: 'fake_seed', value: { version: 1, seededAt: new Date().toISOString(), invoices: invoices.length } as Prisma.InputJsonValue } });

    const sums = await db.journalLine.aggregate({ _sum: { debit: true, credit: true } });
    const drSum = Number(sums._sum.debit ?? 0);
    const crSum = Number(sums._sum.credit ?? 0);
    let negStocks = 0;
    for (const [, q] of qty) if (q < 0) negStocks++;
    const counts = {
      products: await db.product.count({ where: { tenantId } }),
      variants: await db.productVariant.count({ where: { tenantId } }),
      invoices: await db.invoice.count({ where: { tenantId } }),
      purchases: await db.purchase.count({ where: { tenantId } }),
      customers: await db.customer.count({ where: { tenantId } }),
      suppliers: await db.supplier.count({ where: { tenantId } }),
      journalEntries: await db.journalEntry.count({ where: { tenantId } }),
      checks: await db.check.count({ where: { tenantId } }),
      quotations: await db.quotation.count({ where: { tenantId } }),
      tasks: await db.task.count({ where: { tenantId } }),
      shifts: await db.shift.count({ where: { tenantId } }),
      transfers: await db.stockTransfer.count({ where: { tenantId } }),
      counts: await db.stockCount.count({ where: { tenantId } }),
    };
    console.log('[seed] ledger Dr=' + drSum + ' Cr=' + crSum + (drSum === crSum ? ' ✓ balanced' : ' ✗ UNBALANCED'));
    console.log('[seed] negative stocks: ' + negStocks);
    console.log('[seed] counts: ' + JSON.stringify(counts));
    console.log('[seed] dev users seeded: ' + Object.keys(users).length + ' (كلمات مرور التطوير في وثائق الفريق — لا تُطبع هنا)');
  }, { timeout: 15 * 60 * 1000, maxWait: 30000 });

  if (skipped) return;
  console.log('[seed] fake dataset for مكتبة مداد created successfully');
}

main()
  .then(() => void prisma.$disconnect())
  .catch((e) => { console.error(e); process.exit(1); });
