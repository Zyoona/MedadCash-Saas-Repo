import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { fromAgora, toAgora } from '@medad/shared-types';
import { ShiftsService } from './shifts.service.js';
import { LedgerService } from '../ledger/ledger.service.js';

// الورديات (§Phase4) — درج عهدة مستقل لكل كاشير + مطابقة الصندوق الفعلي:
//  - الافتتاح: تحويل العهدة Dr درج / Cr 1000 (قيد حقيقي)، ويُخصَّص حساب الدرج تلقائياً من 1010.
//  - المتوقع = رصيد حساب الدرج من دفتر الأستاذ (المصدر الوحيد للحقيقة — لا رصيد مخزَّن).
//  - الإقفال: Dr 1000 (المُسلَّم) + Dr/Cr 5310 (العجز/الفائض) / Cr درج (العهدة) ⇒ الدرج يعود صفراً.
//  - الورديات القديمة (بلا درج): المتوقع = الافتتاح + صافي حركة 1000 لفرع الوردية داخل نافذتها.
//  - وردية مفتوحة واحدة لكل كاشير، وصندوق فرع واحد ⇒ لا وردية ثانية في الفرع بلا pos.shift_any.

const dec = fromAgora; // 1234 → "12.34"
const CASH = '1000';
const CASH_DIFF = '5310';
const DRAWER = '1010';

const T0 = new Date('2026-09-15T08:30:00.000Z');
const at = (h: number) => new Date(T0.getTime() + h * 3600_000);

interface L { accountCode: string; sourceType: string; debitAgora: number; creditAgora: number; date: Date; branchId: string }
const line = (accountCode: string, sourceType: string, debitAgora: number, creditAgora: number, h: number, branchId = 'b1'): L =>
  ({ accountCode, sourceType, debitAgora, creditAgora, date: at(h), branchId });

/** قيود درج العهدة: عهدة 500₪ + مبيعات 128.80₪ − مرتجع 5₪ ⇒ رصيد الدرج 623.80₪ */
const DRAWER_LINES: L[] = [
  line(DRAWER, 'shift_open', 50000, 0, 0),
  line(DRAWER, 'sale', 12880, 0, 1),
  line(DRAWER, 'sale_return', 0, 500, 2),
  line(CASH, 'expense', 0, 9999, 1), // ضجيج على الصندوق — لا يدخل في أساس الدرج
];
const DRAWER_BALANCE = 50000 + 12880 - 500;

/** قيود مسار المطابقة القديم: حركة صندوق الفرع داخل نافذة الوردية + ما يجب استبعاده */
const LEGACY_LINES: L[] = [
  line(CASH, 'sale', 12880, 0, 1),
  line(CASH, 'sale_return', 0, 500, 2),
  line(CASH, 'collection', 2000, 0, 3),
  line(CASH, 'supplier_payment', 0, 3000, 4),
  line(CASH, 'opening_balance', 999999, 0, 1), // مستبعد: تعرف أولي للرصيد
  line(CASH, 'shift_close', 0, 999999, 1), // مستبعد: قيد إقفال
  line(CASH, 'sale', 7777, 0, -1), // مستبعد: قبل افتتاح الوردية
  line(CASH, 'sale', 8888, 0, 1, 'b2'), // مستبعد: فرع آخر
];
const OPENING = 50000;
const LEGACY_FLOW = 12880 - 500 + 2000 - 3000;
const LEGACY_EXPECTED = OPENING + LEGACY_FLOW;

function makeShift(over: Record<string, unknown> = {}) {
  return {
    id: 'sh1', tenantId: 't1', branchId: 'b1', cashierId: 'u1', drawerId: 'dr1',
    openingAmount: dec(OPENING), closingExpected: null, closingActual: null,
    closedBy: null, openedAt: T0, closedAt: null, invoices: [], ...over,
  };
}

function makeDb(opts: {
  shifts?: any[];
  lines?: L[];
  drawers?: { id: string; cashierId: string; glAccountCode: string }[];
  extraAccounts?: string[];
  with5310?: boolean;
} = {}) {
  const created: { entries: any[]; shifts: any[]; audit: any[]; accounts: any[]; drawers: any[] } = { entries: [], shifts: [], audit: [], accounts: [], drawers: [] };
  const legacy = opts.drawers?.length === 0;
  const accounts: any[] = [
    { id: `acc-${CASH}`, code: CASH, name: 'الصندوق', type: 'asset', isClosed: false, tenantId: 't1' },
    ...(opts.with5310 === false ? [] : [{ id: `acc-${CASH_DIFF}`, code: CASH_DIFF, name: 'فروقات الصندوق (عجز/فائض)', type: 'expense', isClosed: false, tenantId: 't1' }]),
    ...(opts.extraAccounts ?? []).map((code) => ({ id: `acc-${code}`, code, name: `حساب ${code}`, type: 'asset', isClosed: false, tenantId: 't1' })),
    ...(legacy ? [] : [{ id: `acc-${DRAWER}`, code: DRAWER, name: 'عهدة درج — رنا', type: 'asset', isClosed: false, tenantId: 't1' }]),
  ];
  const drawers: any[] = opts.drawers ?? (legacy ? [] : [{ id: 'dr1', tenantId: 't1', cashierId: 'u1', glAccountCode: DRAWER, deletedAt: null }]);
  const shifts: any[] = opts.shifts ? [...opts.shifts] : [makeShift(legacy ? { drawerId: null } : {})];
  const lines: L[] = [...(opts.lines ?? (legacy ? LEGACY_LINES : DRAWER_LINES))];
  let shiftSeq = shifts.length;
  let drawerSeq = drawers.length;

  const matchShift = (s: any, where: any): boolean => {
    if (!where) return true;
    if (where.id && s.id !== where.id) return false;
    if (where.tenantId && s.tenantId !== where.tenantId) return false;
    if (where.branchId && s.branchId !== where.branchId) return false;
    if (typeof where.cashierId === 'string' && s.cashierId !== where.cashierId) return false;
    if (where.cashierId?.not && s.cashierId === where.cashierId.not) return false;
    if (where.closedAt === null && s.closedAt != null) return false;
    if (where.closedAt?.not === null && s.closedAt == null) return false;
    return true;
  };
  const withDrawer = (s: any, include: any) =>
    include?.drawer ? { ...s, drawer: drawers.find((d) => d.id === s.drawerId) ? { glAccountCode: drawers.find((d) => d.id === s.drawerId).glAccountCode } : null } : s;
  const matchLines = (where: any) => {
    const codes: string[] | undefined = where?.account?.code?.in;
    const branchId: string | undefined = where?.entry?.branchId;
    const from: Date | undefined = where?.entry?.date?.gte;
    const to: Date | undefined = where?.entry?.date?.lte;
    const lt: Date | undefined = where?.entry?.date?.lt;
    const notIn: string[] = where?.entry?.sourceType?.notIn ?? [];
    return lines
      .filter((l) => !codes || codes.includes(l.accountCode))
      .filter((l) => !branchId || l.branchId === branchId)
      .filter((l) => !notIn.includes(l.sourceType))
      .filter((l) => !from || l.date >= from)
      .filter((l) => !to || l.date <= to)
      .filter((l) => !lt || l.date < lt);
  };

  const db: any = {
    branch: { findFirst: jest.fn(async ({ where }: any) => (where?.id === 'b1' && where?.tenantId === 't1' ? { id: 'b1' } : null)) },
    user: { findFirst: jest.fn(async () => ({ name: 'رنا أحمد' })) },
    fiscalYear: { findFirst: jest.fn(async () => ({ id: 'fy1', isClosed: false })) },
    account: {
      findMany: jest.fn(async ({ where }: any) => accounts.filter((a) => !where?.code?.in || where.code.in.includes(a.code))),
      findFirst: jest.fn(async ({ where }: any) => accounts.find((a) => a.code === where?.code && (!where?.tenantId || a.tenantId === where.tenantId)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `acc-${data.code}`, isClosed: false, tenantId: 't1', ...data };
        accounts.push(row); created.accounts.push(row);
        return row;
      }),
    },
    cashDrawer: {
      findFirst: jest.fn(async ({ where }: any) =>
        drawers.find((d) => (!where?.tenantId || d.tenantId === where.tenantId) && (!where?.cashierId || d.cashierId === where.cashierId) && d.deletedAt == null) ?? null),
      create: jest.fn(async ({ data }: any) => {
        drawerSeq += 1;
        const row = { id: `dr${drawerSeq}`, deletedAt: null, ...data };
        drawers.push(row); created.drawers.push(row);
        return row;
      }),
    },
    journalEntry: {
      create: jest.fn(async ({ data }: any) => {
        created.entries.push(data);
        // تسجيل القيد في دفتر الموك ليظهر أثره في الأرصدة اللاحقة (كما في الحقيقة)
        for (const l of data.lines.create) {
          lines.push({
            accountCode: String(l.accountId).replace('acc-', ''),
            sourceType: data.sourceType,
            debitAgora: toAgora(String(l.debit)),
            creditAgora: toAgora(String(l.credit)),
            date: data.date,
            branchId: data.branchId,
          });
        }
        return { id: `e${created.entries.length}` };
      }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    journalLine: {
      findMany: jest.fn(async ({ where }: any) =>
        matchLines(where).map((l) => ({ debit: dec(l.debitAgora), credit: dec(l.creditAgora), entry: { sourceType: l.sourceType } }))),
      groupBy: jest.fn(async ({ where }: any) => {
        const byCode = new Map<string, { dr: number; cr: number }>();
        for (const l of matchLines(where)) {
          const cur = byCode.get(l.accountCode) ?? { dr: 0, cr: 0 };
          cur.dr += l.debitAgora; cur.cr += l.creditAgora;
          byCode.set(l.accountCode, cur);
        }
        return [...byCode.entries()].map(([code, v]) => ({ accountId: `acc-${code}`, _sum: { debit: dec(v.dr), credit: dec(v.cr) } }));
      }),
    },
    shift: {
      findFirst: jest.fn(async ({ where, orderBy, include }: any) => {
        const rows = shifts.filter((s) => matchShift(s, where));
        if (orderBy?.openedAt === 'desc') rows.sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
        if (orderBy?.closedAt === 'desc') rows.sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
        return rows[0] ? withDrawer(rows[0], include) : null;
      }),
      count: jest.fn(async ({ where }: any) => shifts.filter((s) => matchShift(s, where)).length),
      create: jest.fn(async ({ data }: any) => {
        shiftSeq += 1;
        const row = { id: `sh${shiftSeq}`, closedAt: null, closingExpected: null, closingActual: null, closedBy: null, invoices: [], ...data };
        shifts.push(row); created.shifts.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = shifts.find((s) => s.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    auditLog: { create: jest.fn(async ({ data }: any) => { created.audit.push(data); return {}; }) },
    $transaction: jest.fn((fn: any) => fn(db)),
  };
  return { db, created, shifts, accounts, drawers, lines };
}

const build = (db: any) => new ShiftsService(db, new LedgerService(db));
const CASHIER = { userId: 'u1', perms: ['pos.sell', 'pos.shift'], branchId: 'b1' };
const CASHIER2 = { userId: 'u2', perms: ['pos.sell', 'pos.shift'], branchId: 'b1' };
const MANAGER = { userId: 'u9', perms: ['pos.shift', 'pos.shift_any'], branchId: 'b1' };

const linesOf = (created: { entries: any[] }, i = 0) => created.entries[i].lines.create as any[];
const sumSide = (ls: any[], side: 'debit' | 'credit') => ls.reduce((s, l) => s + Number(l[side]), 0);
const balanceOf = (lines: L[], code: string) =>
  lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.debitAgora - l.creditAgora, 0);

describe('Shifts — opening: درج العهدة وتحويل النقد', () => {
  test('ينشئ درج العهدة (1010) ويرحّل تحويل العهدة Dr درج / Cr 1000', async () => {
    const { db, created } = makeDb({ shifts: [], drawers: [], lines: [] });
    const res: any = await build(db).open('t1', 'b1', OPENING, CASHIER);
    expect(res.drawerAccountCode).toBe(DRAWER);
    expect(res.expectedAgora).toBe(OPENING);
    expect(created.drawers.length).toBe(1);
    expect(created.accounts.map((a: any) => a.code)).toContain(DRAWER);
    expect(created.entries.length).toBe(1);
    const e = created.entries[0];
    expect(e.sourceType).toBe('shift_open');
    expect(e.sourceId).toBe(res.id);
    expect(linesOf(created)).toContainEqual(expect.objectContaining({ accountId: `acc-${DRAWER}`, debit: '500.00' }));
    expect(linesOf(created)).toContainEqual(expect.objectContaining({ accountId: `acc-${CASH}`, credit: '500.00' }));
    expect(sumSide(linesOf(created), 'debit')).toBe(sumSide(linesOf(created), 'credit'));
    expect(created.audit[0]).toMatchObject({ action: 'open_shift', entity: 'shifts', entityId: res.id });
    expect(created.audit[0].diff).toMatchObject({ openingAmountAgora: OPENING, drawerAccountCode: DRAWER, entryId: 'e1' });
  });

  test('يعتمد درجاً قائماً بلا إنشاء حساب جديد، ويختار أول كود حرّ بعده', async () => {
    const existing = makeDb({ shifts: [], drawers: [{ id: 'dr9', tenantId: 't1', cashierId: 'u1', glAccountCode: '1011' }], lines: [], extraAccounts: [DRAWER, '1011'] });
    const reuse: any = await build(existing.db).open('t1', 'b1', 1000, CASHIER);
    expect(reuse.drawerAccountCode).toBe('1011');
    expect(existing.created.accounts.length).toBe(0); // الحساب موجود أصلاً

    const fresh = makeDb({ shifts: [], drawers: [], lines: [], extraAccounts: [DRAWER] });
    const res: any = await build(fresh.db).open('t1', 'b1', 1000, CASHIER);
    expect(res.drawerAccountCode).toBe('1011'); // 1010 مشغول ⇒ التالي
    expect(fresh.created.accounts.map((a: any) => a.code)).toEqual(['1011']);
  });

  test('مبلغ افتتاح صفر: درج بلا قيد تحويل', async () => {
    const { db, created } = makeDb({ shifts: [], drawers: [], lines: [] });
    const res: any = await build(db).open('t1', 'b1', 0, CASHIER);
    expect(res.drawerAccountCode).toBe(DRAWER);
    expect(res.entryId).toBeNull();
    expect(created.entries.length).toBe(0);
  });

  test('يرفض وردية ثانية لنفس الكاشير، ومبلغاً غير صالح، وفرعاً غير موجود', async () => {
    const { db } = makeDb();
    await expect(build(db).open('t1', 'b1', 1000, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
    const fresh = makeDb({ shifts: [], drawers: [], lines: [] });
    await expect(build(fresh.db).open('t1', 'b1', -5, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(fresh.db).open('t1', 'b1', 10.5, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(fresh.db).open('t1', 'b9', 100, CASHIER)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('صندوق الفرع واحد: لا وردية لكاشير آخر بلا صلاحية، وتُسمح مع pos.shift_any + تحذير', async () => {
    const blocked = makeDb();
    await expect(build(blocked.db).open('t1', 'b1', 1000, CASHIER2)).rejects.toBeInstanceOf(ForbiddenException);

    const allowed = makeDb();
    const res: any = await build(allowed.db).open('t1', 'b1', 1000, { ...CASHIER2, perms: ['pos.shift', 'pos.shift_any'] });
    expect(allowed.created.shifts.length).toBe(1);
    expect(allowed.created.audit[0].diff).toMatchObject({ sharedBoxOverride: 1 });
    expect(res.warnings.join(' ')).toContain('وردية أخرى مفتوحة في نفس الفرع');
  });
});

describe('Shifts — closing: مطابقة الدرج وترحيل التسليم والفروق', () => {
  test('المتوقع = رصيد الدرج، والتسليم بلا فرق: Dr 1000 / Cr درج ⇒ الدرج يعود صفراً', async () => {
    const { db, created, lines } = makeDb();
    const res: any = await build(db).close('t1', 'sh1', DRAWER_BALANCE, CASHIER);
    expect(res.basis).toBe('drawer');
    expect(res.drawerAccountCode).toBe(DRAWER);
    expect(res.expectedAgora).toBe(DRAWER_BALANCE);
    expect(res.diffAgora).toBe(0);
    const ls = linesOf(created);
    expect(ls).toContainEqual(expect.objectContaining({ accountId: `acc-${CASH}`, debit: '623.80' }));
    expect(ls).toContainEqual(expect.objectContaining({ accountId: `acc-${DRAWER}`, credit: '623.80' }));
    expect(ls.some((l) => l.accountId === `acc-${CASH_DIFF}`)).toBe(false);
    expect(sumSide(ls, 'debit')).toBe(sumSide(ls, 'credit'));
    expect(balanceOf(lines, DRAWER)).toBe(0); // العهدة صُفّرت
    expect(Number(res.closingExpected)).toBe(DRAWER_BALANCE / 100);
    expect(res.closedBy).toBe('u1');
    expect(created.audit[0].diff).toMatchObject({ basis: 'drawer', drawerAccountCode: DRAWER, diffAgora: 0, entryId: 'e1' });
  });

  test('العجز: Dr 1000 (المُسلَّم) + Dr 5310 / Cr درج (العهدة)', async () => {
    const { db, created, lines } = makeDb();
    const res: any = await build(db).close('t1', 'sh1', DRAWER_BALANCE - 500, CASHIER);
    expect(res.diffAgora).toBe(-500);
    const ls = linesOf(created);
    expect(ls).toContainEqual(expect.objectContaining({ accountId: `acc-${CASH}`, debit: '618.80' }));
    expect(ls).toContainEqual(expect.objectContaining({ accountId: `acc-${CASH_DIFF}`, debit: '5.00' }));
    expect(ls).toContainEqual(expect.objectContaining({ accountId: `acc-${DRAWER}`, credit: '623.80' }));
    expect(sumSide(ls, 'debit')).toBe(sumSide(ls, 'credit'));
    expect(balanceOf(lines, DRAWER)).toBe(0);
    expect(created.entries[0].memo).toContain('عجز');
  });

  test('الفائض: Dr 1000 (المُسلَّم) / Cr درج + Cr 5310', async () => {
    const { db, created, lines } = makeDb();
    const res: any = await build(db).close('t1', 'sh1', DRAWER_BALANCE + 1000, CASHIER);
    expect(res.diffAgora).toBe(1000);
    const ls = linesOf(created);
    expect(ls).toContainEqual(expect.objectContaining({ accountId: `acc-${CASH}`, debit: '633.80' }));
    expect(ls).toContainEqual(expect.objectContaining({ accountId: `acc-${DRAWER}`, credit: '623.80' }));
    expect(ls).toContainEqual(expect.objectContaining({ accountId: `acc-${CASH_DIFF}`, credit: '10.00' }));
    expect(sumSide(ls, 'debit')).toBe(sumSide(ls, 'credit'));
    expect(balanceOf(lines, DRAWER)).toBe(0);
    expect(created.entries[0].memo).toContain('فائض');
  });

  test('تسليم كامل بلا عهدة ولا مبيعات: لا قيد (لا شيء يتغير)', async () => {
    const { db, created } = makeDb({ lines: [], shifts: [makeShift({ openingAmount: dec(0) })] });
    const res: any = await build(db).close('t1', 'sh1', 0, CASHIER);
    expect(res.expectedAgora).toBe(0);
    expect(res.entryId).toBeNull();
    expect(created.entries.length).toBe(0);
  });

  test('درج معاد الاستخدام: تسليم وردية سابقة محسوب ضمن الرصيد (لا عجز وهمي)', async () => {
    const { db, created } = makeDb({
      lines: [
        line(DRAWER, 'shift_open', 20000, 0, -10), // عهدة وردية سابقة
        line(DRAWER, 'shift_close', 0, 20000, -9), // تسليمها إلى الصندوق
        ...DRAWER_LINES,
      ],
    });
    const res: any = await build(db).close('t1', 'sh1', DRAWER_BALANCE, CASHIER);
    expect(res.expectedAgora).toBe(DRAWER_BALANCE); // 20000 − 20000 + 62380
    expect(res.diffAgora).toBe(0);
    expect(created.entries.length).toBe(1);
  });

  test('ينشئ حساب 5310 تلقائياً عند غيابه ثم يرحل الفرق', async () => {
    const { db, created } = makeDb({ with5310: false });
    const res: any = await build(db).close('t1', 'sh1', DRAWER_BALANCE - 250, CASHIER);
    expect(created.accounts.map((a: any) => a.code)).toContain(CASH_DIFF);
    expect(res.entryId).toBeTruthy();
    expect(sumSide(linesOf(created), 'debit')).toBe(sumSide(linesOf(created), 'credit'));
  });

  test('يرفض الإقفال المزدوج والمبلغ غير الصالح والوردية غير الموجودة', async () => {
    const closed = makeDb({ shifts: [makeShift({ closedAt: at(9), closingExpected: dec(DRAWER_BALANCE), closingActual: dec(DRAWER_BALANCE) })] });
    await expect(build(closed.db).close('t1', 'sh1', DRAWER_BALANCE, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
    const open = makeDb();
    await expect(build(open.db).close('t1', 'sh1', -1, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(open.db).close('t1', 'missing', 100, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
  });

  test('إقفال وردية كاشير/فرع آخر: ممنوع بلا صلاحية ومسموح مع pos.shift_any', async () => {
    const { db } = makeDb();
    await expect(build(db).close('t1', 'sh1', DRAWER_BALANCE, CASHIER2)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(build(db).close('t1', 'sh1', DRAWER_BALANCE, { userId: 'u1', perms: ['pos.shift'], branchId: 'b2' })).rejects.toBeInstanceOf(ForbiddenException);
    const res: any = await build(db).close('t1', 'sh1', DRAWER_BALANCE, MANAGER);
    expect(res.closedBy).toBe('u9');
  });
});

describe('Shifts — مسار التوافق (وردية قديمة بلا درج)', () => {
  const legacyDb = (over: Record<string, unknown> = {}) =>
    makeDb({ drawers: [], shifts: [makeShift({ drawerId: null, ...over })] });

  test('المتوقع = الافتتاح + صافي حركة صندوق الفرع داخل النافذة (مع استثناء المصادر غير النقدية)', async () => {
    const { db, created } = legacyDb();
    const res: any = await build(db).close('t1', 'sh1', LEGACY_EXPECTED, CASHIER);
    expect(res.basis).toBe('branch_flow');
    expect(res.drawerAccountCode).toBeNull();
    expect(res.expectedAgora).toBe(LEGACY_EXPECTED);
    expect(res.movementsAgora).toBe(LEGACY_FLOW);
    expect(res.diffAgora).toBe(0);
    expect(created.entries.length).toBe(0); // النقد لم يغادر 1000 ⇒ لا تسليم
  });

  test('العجز/الفائض يُرحَّل 5310 مقابل 1000 فقط', async () => {
    const short = legacyDb();
    await build(short.db).close('t1', 'sh1', LEGACY_EXPECTED - 500, CASHIER);
    expect(linesOf(short.created)).toContainEqual(expect.objectContaining({ accountId: `acc-${CASH_DIFF}`, debit: '5.00' }));
    expect(linesOf(short.created)).toContainEqual(expect.objectContaining({ accountId: `acc-${CASH}`, credit: '5.00' }));
    expect(linesOf(short.created).length).toBe(2);

    const over = legacyDb();
    await build(over.db).close('t1', 'sh1', LEGACY_EXPECTED + 1000, CASHIER);
    expect(linesOf(over.created)).toContainEqual(expect.objectContaining({ accountId: `acc-${CASH}`, debit: '10.00' }));
    expect(linesOf(over.created)).toContainEqual(expect.objectContaining({ accountId: `acc-${CASH_DIFF}`, credit: '10.00' }));
  });
});

describe('Shifts — panel (لوحة POS)', () => {
  test('بلا وردية: يقترح افتتاح = العدّ الفعلي لآخر إقفال + رصيد صندوق الفرع', async () => {
    const { db } = makeDb({
      shifts: [makeShift({ id: 'sh0', closedAt: at(-2), closingActual: dec(43210) })],
      lines: [line(CASH, 'sale', 43210, 0, -3)],
    });
    const res: any = await build(db).panel('t1', 'b1', 'u1');
    expect(res.shift).toBeNull();
    expect(res.expectedAgora).toBeNull();
    expect(res.suggestedOpeningAgora).toBe(43210);
    expect(res.boxBalanceAgora).toBe(43210);
    expect(res.otherOpenShifts).toBe(0);
  });

  test('وردية مفتوحة: المتوقع الحي = رصيد الدرج + كود الدرج وأساس الاحتساب', async () => {
    const { db } = makeDb();
    const res: any = await build(db).panel('t1', 'b1', 'u1');
    expect(res.shift).toMatchObject({ id: 'sh1', openingAmountAgora: OPENING, cashierId: 'u1' });
    expect(res.expectedAgora).toBe(DRAWER_BALANCE);
    expect(res.drawerAccountCode).toBe(DRAWER);
    expect(res.basis).toBe('drawer');
    expect(res.suggestedOpeningAgora).toBeNull();
    expect(res.boxBalanceAgora).toBe(-9999); // حركة الصندوق في بيانات الاختبار
  });

  test('يعدّ الورديات المفتوحة الأخرى في نفس الفرع ويحذّر منها', async () => {
    const { db } = makeDb({
      shifts: [makeShift(), makeShift({ id: 'sh2', cashierId: 'u2', drawerId: 'dr2', openedAt: at(0.5) })],
      drawers: [{ id: 'dr1', tenantId: 't1', cashierId: 'u1', glAccountCode: DRAWER }, { id: 'dr2', tenantId: 't1', cashierId: 'u2', glAccountCode: '1011' }],
    });
    const res: any = await build(db).panel('t1', 'b1', 'u1');
    expect(res.otherOpenShifts).toBe(1);
    expect(res.warnings.join(' ')).toContain('وردية أخرى مفتوحة');
  });
});

describe('Shifts — report (تقرير الوردية)', () => {
  test('وردية مغلقة بدرج: مطابقة كاملة + تفصيل الحركة حسب المصدر', async () => {
    const { db } = makeDb({
      shifts: [makeShift({ closedAt: at(9), closingExpected: dec(DRAWER_BALANCE), closingActual: dec(DRAWER_BALANCE - 500) })],
    });
    const res: any = await build(db).report('t1', 'sh1');
    expect(res.shift.drawerAccountCode).toBe(DRAWER);
    expect(res.cash.basis).toBe('drawer');
    expect(res.cash.openingAgora).toBe(OPENING);
    expect(res.cash.expectedAgora).toBe(DRAWER_BALANCE);
    expect(res.cash.actualAgora).toBe(DRAWER_BALANCE - 500);
    expect(res.cash.diffAgora).toBe(-500);
    expect(res.cash.movementsBySource).toEqual(expect.arrayContaining([
      { sourceType: 'shift_open', amountAgora: 50000 },
      { sourceType: 'sale', amountAgora: 12880 },
      { sourceType: 'sale_return', amountAgora: -500 },
    ]));
    expect(res.warnings.length).toBe(0);
  });

  test('وردية مغلقة: المتوقع المعاد احتسابه يطابق المخزن (قيد التسليم مستبعد زمنياً)', async () => {
    const { db } = makeDb({
      shifts: [makeShift({ closedAt: at(9), closingExpected: dec(DRAWER_BALANCE), closingActual: dec(DRAWER_BALANCE) })],
      lines: [
        ...DRAWER_LINES,
        line(DRAWER, 'shift_close', 0, DRAWER_BALANCE, 9), // قيد التسليم بلحظة الإقفال
        line(CASH, 'shift_close', DRAWER_BALANCE, 0, 9),
      ],
    });
    const res: any = await build(db).report('t1', 'sh1');
    expect(res.cash.recomputedExpectedAgora).toBe(DRAWER_BALANCE);
    expect(res.cash.expectedAgora).toBe(DRAWER_BALANCE);
    expect(res.cash.diffAgora).toBe(0);
    expect(res.warnings.length).toBe(0);
  });

  test('يكشف اختلاف المتوقع المخزن عن المعاد احتسابه من الدفتر', async () => {
    const { db } = makeDb({ shifts: [makeShift({ closedAt: at(9), closingExpected: dec(1000), closingActual: dec(1000) })] });
    const res: any = await build(db).report('t1', 'sh1');
    expect(res.cash.expectedAgora).toBe(1000); // المخزن هو المعتمد
    expect(res.cash.recomputedExpectedAgora).toBe(DRAWER_BALANCE);
    expect(res.warnings.join(' ')).toContain('المتوقع المخزن');
  });
});
