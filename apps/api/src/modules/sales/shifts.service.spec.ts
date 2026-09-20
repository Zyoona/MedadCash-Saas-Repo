import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { fromAgora } from '@medad/shared-types';
import { ShiftsService } from './shifts.service.js';
import { LedgerService } from '../ledger/ledger.service.js';

// الورديات (§Phase4) — مطابقة الصندوق الفعلي:
//  - الافتتاح = عدّ النقد الموجود (بلا قيد محاسبي؛ النقد مسجل أصلاً في 1000).
//  - المتوقع = الافتتاح + صافي حركة 1000 لفرع الوردية خلال نافذتها (من دفتر الأستاذ).
//  - الفرق عند الإقفال يُرحَّل: عجز Dr 5310 / Cr 1000 — فائض Dr 1000 / Cr 5310.
//  - وردية مفتوحة واحدة لكل (مستأجر، فرع، كاشير)، وإقفال وردية الغير requires pos.shift_any.

const dec = fromAgora; // 1234 → "12.34"

interface CashLine { sourceType: string; debitAgora: number; creditAgora: number; date: Date; branchId: string }

const T0 = new Date('2026-09-15T08:30:00.000Z');
const at = (h: number) => new Date(T0.getTime() + h * 3600_000);

/** حركة صندوق الفرع b1 داخل نافذة الوردية + ما يجب استبعاده (خارج النافذة/فرع آخر/مصادر غير نقدية). */
function cashLines(): CashLine[] {
  return [
    { sourceType: 'sale', debitAgora: 12880, creditAgora: 0, date: at(1), branchId: 'b1' },
    { sourceType: 'sale_return', debitAgora: 0, creditAgora: 500, date: at(2), branchId: 'b1' },
    { sourceType: 'collection', debitAgora: 2000, creditAgora: 0, date: at(3), branchId: 'b1' },
    { sourceType: 'supplier_payment', debitAgora: 0, creditAgora: 3000, date: at(4), branchId: 'b1' },
    // مستبعدة: تعرف أولي للرصيد (ضمن العدّ الافتتاحي) + قيد إقفال وردية سابق
    { sourceType: 'opening_balance', debitAgora: 999999, creditAgora: 0, date: at(1), branchId: 'b1' },
    { sourceType: 'shift_close', debitAgora: 0, creditAgora: 999999, date: at(1), branchId: 'b1' },
    // مستبعدة: قبل افتتاح الوردية
    { sourceType: 'sale', debitAgora: 7777, creditAgora: 0, date: at(-1), branchId: 'b1' },
    // مستبعدة: فرع آخر
    { sourceType: 'sale', debitAgora: 8888, creditAgora: 0, date: at(1), branchId: 'b2' },
  ];
}

// الافتتاح 500.00 ₪ + (12880 − 500 + 2000 − 3000) = 50000 + 11380
const OPENING = 50000;
const FLOW = 12880 - 500 + 2000 - 3000;
const EXPECTED = OPENING + FLOW;

function makeShift(over: Record<string, unknown> = {}) {
  return {
    id: 'sh1', tenantId: 't1', branchId: 'b1', cashierId: 'u1',
    openingAmount: dec(OPENING), closingExpected: null, closingActual: null,
    closedBy: null, openedAt: T0, closedAt: null, invoices: [], ...over,
  };
}

function makeDb(opts: { shifts?: any[]; lines?: CashLine[]; box?: { dr: number; cr: number }; with5310?: boolean } = {}) {
  const created: { entries: any[]; shifts: any[]; audit: any[]; accounts: any[] } = { entries: [], shifts: [], audit: [], accounts: [] };
  const accounts: any[] = [
    { id: 'acc-1000', code: '1000', name: 'الصندوق', type: 'asset', isClosed: false, tenantId: 't1' },
    ...(opts.with5310 === false ? [] : [{ id: 'acc-5310', code: '5310', name: 'فروقات الصندوق (عجز/فائض)', type: 'expense', isClosed: false, tenantId: 't1' }]),
  ];
  const shifts: any[] = opts.shifts ? [...opts.shifts] : [makeShift()];
  const lines = opts.lines ?? cashLines();
  const box = opts.box ?? { dr: 61380, cr: 0 };
  let shiftSeq = shifts.length;

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

  const db: any = {
    branch: { findFirst: jest.fn(async ({ where }: any) => (where?.id === 'b1' && where?.tenantId === 't1' ? { id: 'b1' } : null)) },
    fiscalYear: { findFirst: jest.fn(async () => ({ id: 'fy1', isClosed: false })) },
    account: {
      findMany: jest.fn(async ({ where }: any) => accounts.filter((a) => !where?.code?.in || where.code.in.includes(a.code))),
      findFirst: jest.fn(async ({ where }: any) => accounts.find((a) => a.code === where?.code && (!where?.tenantId || a.tenantId === where.tenantId)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `acc-new-${data.code}`, isClosed: false, ...data };
        accounts.push(row); created.accounts.push(row);
        return row;
      }),
    },
    journalEntry: {
      create: jest.fn(async ({ data }: any) => { created.entries.push(data); return { id: `e${created.entries.length}` }; }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    journalLine: {
      findMany: jest.fn(async ({ where }: any) => {
        const from: Date | undefined = where?.entry?.date?.gte;
        const to: Date | undefined = where?.entry?.date?.lte;
        const notIn: string[] = where?.entry?.sourceType?.notIn ?? [];
        const branchId: string | undefined = where?.entry?.branchId;
        return lines
          .filter((l) => !branchId || l.branchId === branchId)
          .filter((l) => !notIn.includes(l.sourceType))
          .filter((l) => !from || l.date >= from)
          .filter((l) => !to || l.date <= to)
          .map((l) => ({ debit: dec(l.debitAgora), credit: dec(l.creditAgora), entry: { sourceType: l.sourceType } }));
      }),
      groupBy: jest.fn(async () => [{ accountId: 'acc-1000', _sum: { debit: dec(box.dr), credit: dec(box.cr) } }]),
    },
    shift: {
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const rows = shifts.filter((s) => matchShift(s, where));
        if (orderBy?.openedAt === 'desc') rows.sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
        if (orderBy?.closedAt === 'desc') rows.sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0));
        return rows[0] ?? null;
      }),
      count: jest.fn(async ({ where }: any) => shifts.filter((s) => matchShift(s, where)).length),
      create: jest.fn(async ({ data }: any) => {
        shiftSeq += 1;
        const row = { id: `sh${shiftSeq}`, closedAt: null, closingExpected: null, closingActual: null, closedBy: null, ...data };
        shifts.push(row); created.shifts.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = shifts.find((s) => s.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    invoice: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn(async ({ data }: any) => { created.audit.push(data); return {}; }) },
    $transaction: jest.fn((fn: any) => fn(db)),
  };
  return { db, created, shifts, accounts };
}

const build = (db: any) => new ShiftsService(db, new LedgerService(db));
const CASHIER = { userId: 'u1', perms: ['pos.sell', 'pos.shift'], branchId: 'b1' };
const CASHIER2 = { userId: 'u2', perms: ['pos.sell', 'pos.shift'], branchId: 'b1' };
const MANAGER = { userId: 'u9', perms: ['pos.shift', 'pos.shift_any'], branchId: 'b1' };

const entryLines = (created: { entries: any[] }, i = 0) => created.entries[i].lines.create as any[];
const sumSide = (ls: any[], side: 'debit' | 'credit') => ls.reduce((s, l) => s + Number(l[side]), 0);

describe('Shifts — opening (الافتتاح = عدّ بلا قيد)', () => {
  test('يفتح وردية بالعدّ الافتتاحي ويرحل audit فقط (لا قيد محاسبي)', async () => {
    const { db, created } = makeDb({ shifts: [] });
    const res: any = await build(db).open('t1', 'b1', OPENING, CASHIER);
    expect(res.openingAmountAgora).toBe(OPENING);
    expect(res.expectedAgora).toBe(OPENING);
    expect(Number(res.openingAmount)).toBe(OPENING / 100);
    expect(res.cashierId).toBe('u1');
    expect(created.entries.length).toBe(0); // النقد مسجل أصلاً في 1000 — الافتتاح ليس حركة
    expect(created.audit[0]).toMatchObject({ action: 'open_shift', entity: 'shifts', entityId: res.id });
    expect(created.audit[0].diff).toMatchObject({ openingAmountAgora: OPENING });
  });

  test('يرفض وردية ثانية مفتوحة لنفس الكاشير', async () => {
    const { db } = makeDb();
    await expect(build(db).open('t1', 'b1', 1000, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
  });

  test('يرفض وردية لكاشير آخر على صندوق الفرع نفسه بلا صلاحية', async () => {
    const { db } = makeDb();
    await expect(build(db).open('t1', 'b1', 1000, CASHIER2)).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('يسمح بها بصلاحية pos.shift_any مع تحذير وتوثيق التجاوز في audit', async () => {
    const { db, created } = makeDb();
    const res: any = await build(db).open('t1', 'b1', 1000, { ...CASHIER2, perms: ['pos.shift', 'pos.shift_any'] });
    expect(created.shifts.length).toBe(1);
    expect(created.shifts[0].cashierId).toBe('u2');
    expect(created.audit[0].diff).toMatchObject({ sharedBoxOverride: 1 });
    expect(res.warnings.join(' ')).toContain('وردية أخرى مفتوحة في نفس الفرع');
  });

  test('يرفض مبلغاً غير صالح وفرعاً غير موجود', async () => {
    const { db } = makeDb({ shifts: [] });
    await expect(build(db).open('t1', 'b1', -5, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(db).open('t1', 'b1', 10.5, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(db).open('t1', 'b9', 100, CASHIER)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Shifts — closing (المطابقة مع الصندوق الفعلي)', () => {
  test('المتوقع = الافتتاح + صافي حركة صندوق الفرع داخل النافذة (بلا قيد عند التطابق)', async () => {
    const { db, created } = makeDb();
    const res: any = await build(db).close('t1', 'sh1', EXPECTED, CASHIER);
    expect(res.expectedAgora).toBe(EXPECTED);
    expect(res.cashFlowAgora).toBe(FLOW);
    expect(res.diffAgora).toBe(0);
    expect(res.entryId).toBeNull();
    expect(created.entries.length).toBe(0);
    expect(Number(res.closingExpected)).toBe(EXPECTED / 100);
    expect(res.closedBy).toBe('u1');
    expect(created.audit[0].diff).toMatchObject({ expectedAgora: EXPECTED, actualAgora: EXPECTED, diffAgora: 0 });
  });

  test('العجز يُرحَّل: Dr 5310 / Cr 1000', async () => {
    const { db, created } = makeDb();
    const res: any = await build(db).close('t1', 'sh1', EXPECTED - 500, CASHIER);
    expect(res.diffAgora).toBe(-500);
    expect(created.entries.length).toBe(1);
    const e = created.entries[0];
    expect(e.sourceType).toBe('shift_close');
    expect(e.sourceId).toBe('sh1');
    const ls = entryLines(created);
    expect(ls).toContainEqual(expect.objectContaining({ accountId: 'acc-5310', debit: '5.00' }));
    expect(ls).toContainEqual(expect.objectContaining({ accountId: 'acc-1000', credit: '5.00' }));
    expect(sumSide(ls, 'debit')).toBe(sumSide(ls, 'credit'));
    expect(created.audit[0].diff).toMatchObject({ diffAgora: -500, entryId: 'e1' });
  });

  test('الفائض يُرحَّل: Dr 1000 / Cr 5310', async () => {
    const { db, created } = makeDb();
    const res: any = await build(db).close('t1', 'sh1', EXPECTED + 1000, CASHIER);
    expect(res.diffAgora).toBe(1000);
    const ls = entryLines(created);
    expect(ls).toContainEqual(expect.objectContaining({ accountId: 'acc-1000', debit: '10.00' }));
    expect(ls).toContainEqual(expect.objectContaining({ accountId: 'acc-5310', credit: '10.00' }));
    expect(sumSide(ls, 'debit')).toBe(sumSide(ls, 'credit'));
  });

  test('ينشئ حساب 5310 تلقائياً عند غيابه ثم يرحل الفرق', async () => {
    const { db, created } = makeDb({ with5310: false });
    const res: any = await build(db).close('t1', 'sh1', EXPECTED - 250, CASHIER);
    expect(created.accounts.map((a: any) => a.code)).toContain('5310');
    expect(res.entryId).toBeTruthy();
    expect(sumSide(entryLines(created), 'debit')).toBe(sumSide(entryLines(created), 'credit'));
  });

  test('يرفض الإقفال المزدوج والمبلغ غير الصالح', async () => {
    const { db } = makeDb({ shifts: [makeShift({ closedAt: at(9), closingExpected: dec(EXPECTED), closingActual: dec(EXPECTED) })] });
    await expect(build(db).close('t1', 'sh1', EXPECTED, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
    const open = makeDb();
    await expect(build(open.db).close('t1', 'sh1', -1, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(build(open.db).close('t1', 'missing', 100, CASHIER)).rejects.toBeInstanceOf(BadRequestException);
  });

  test('إقفال وردية كاشير آخر: ممنوع بلا صلاحية، ومسموح مع pos.shift_any', async () => {
    const { db } = makeDb();
    const other = { userId: 'u2', perms: ['pos.shift'], branchId: 'b1' };
    await expect(build(db).close('t1', 'sh1', EXPECTED, other)).rejects.toBeInstanceOf(ForbiddenException);
    const res: any = await build(db).close('t1', 'sh1', EXPECTED, MANAGER);
    expect(res.closedBy).toBe('u9');
  });

  test('لا يُقفل وردية فرع آخر بلا صلاحية', async () => {
    const { db } = makeDb();
    await expect(build(db).close('t1', 'sh1', EXPECTED, { userId: 'u1', perms: ['pos.shift'], branchId: 'b2' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Shifts — panel (لوحة POS)', () => {
  test('بلا وردية مفتوحة: يقترح افتتاح = العدّ الفعلي لآخر إقفال + رصيد صندوق الفرع', async () => {
    const { db } = makeDb({
      shifts: [makeShift({ id: 'sh0', closedAt: at(-2), closingActual: dec(43210) })],
      box: { dr: 43210, cr: 0 },
    });
    const res: any = await build(db).panel('t1', 'b1', 'u1');
    expect(res.shift).toBeNull();
    expect(res.expectedAgora).toBeNull();
    expect(res.suggestedOpeningAgora).toBe(43210);
    expect(res.boxBalanceAgora).toBe(43210);
    expect(res.otherOpenShifts).toBe(0);
  });

  test('وردية مفتوحة: المتوقع الحي = الافتتاح + حركة الصندوق', async () => {
    const { db } = makeDb();
    const res: any = await build(db).panel('t1', 'b1', 'u1');
    expect(res.shift).toMatchObject({ id: 'sh1', openingAmountAgora: OPENING, cashierId: 'u1' });
    expect(res.expectedAgora).toBe(EXPECTED);
    expect(res.suggestedOpeningAgora).toBeNull();
    expect(res.boxBalanceAgora).toBe(61380);
  });

  test('يعدّ الورديات المفتوحة الأخرى في نفس الفرع', async () => {
    const { db } = makeDb({ shifts: [makeShift(), makeShift({ id: 'sh2', cashierId: 'u2', openedAt: at(0.5) })] });
    const res: any = await build(db).panel('t1', 'b1', 'u1');
    expect(res.otherOpenShifts).toBe(1);
    expect(res.warnings.join(' ')).toContain('وردية أخرى مفتوحة');
  });
});

describe('Shifts — report (تقرير الوردية)', () => {
  test('مطابقة نقدية كاملة + تفصيل الحركة حسب المصدر', async () => {
    const { db } = makeDb({
      shifts: [makeShift({ closedAt: at(9), closingExpected: dec(EXPECTED), closingActual: dec(EXPECTED - 500) })],
    });
    const res: any = await build(db).report('t1', 'sh1');
    expect(res.cash.openingAgora).toBe(OPENING);
    expect(res.cash.movementsAgora).toBe(FLOW);
    expect(res.cash.expectedAgora).toBe(EXPECTED);
    expect(res.cash.actualAgora).toBe(EXPECTED - 500);
    expect(res.cash.diffAgora).toBe(-500);
    expect(res.cash.movementsBySource).toEqual(expect.arrayContaining([
      { sourceType: 'sale', amountAgora: 12880 },
      { sourceType: 'sale_return', amountAgora: -500 },
      { sourceType: 'collection', amountAgora: 2000 },
      { sourceType: 'supplier_payment', amountAgora: -3000 },
    ]));
    expect(res.warnings.length).toBe(0);
  });

  test('يكشف القيود اللاحقة للإقفال التي غيّرت نافذة الوردية', async () => {
    const { db } = makeDb({
      shifts: [makeShift({ closedAt: at(9), closingExpected: dec(1000), closingActual: dec(1000) })],
    });
    const res: any = await build(db).report('t1', 'sh1');
    expect(res.cash.expectedAgora).toBe(1000); // المخزن هو المعتمد
    expect(res.cash.recomputedExpectedAgora).toBe(EXPECTED);
    expect(res.warnings.join(' ')).toContain('المتوقع المخزن');
  });
});
