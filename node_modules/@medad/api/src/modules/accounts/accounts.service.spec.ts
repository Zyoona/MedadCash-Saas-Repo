import { BadRequestException, ConflictException } from '@nestjs/common';
import { AccountsService } from './accounts.service.js';
import { LedgerService } from '../ledger/ledger.service.js';

// §Phase1 الحسابات البنكية: كل بنك مرتبط بكود GL فريد (أول بنك يتبنى 1100 ثم أول كود حر)
// + الرصيد يُشتق من دفتر القيود فقط + الحذف ممنوع مع رصيد + كود GL ثابت بعد الإنشاء.

interface MockAccount { id: string; code: string; name: string; type: string; isClosed: boolean; tenantId: string; _dr?: number; _cr?: number }

function makeDb() {
  const created: { entries: any[]; accounts: any[]; audit: any[]; sync: any[] } = { entries: [], accounts: [], audit: [], sync: [] };
  const accounts: MockAccount[] = [
    { id: 'acc-1000', code: '1000', name: 'الصندوق', type: 'asset', isClosed: false, tenantId: 't1' },
    { id: 'acc-1100', code: '1100', name: 'البنك', type: 'asset', isClosed: false, tenantId: 't1' },
    { id: 'acc-3900', code: '3900', name: 'أرصدة افتتاحية', type: 'equity', isClosed: false, tenantId: 't1' },
  ];
  const banks: any[] = [];
  let bankSeq = 0;
  let entrySeq = 0;
  const db: any = {
    fiscalYear: { findFirst: jest.fn().mockResolvedValue({ id: 'fy1', isClosed: false }) },
    account: {
      findMany: jest.fn(async ({ where }: any) =>
        accounts.filter((a) => !where?.code?.in || where.code.in.includes(a.code))),
      findFirst: jest.fn(async ({ where }: any) =>
        accounts.find((a) =>
          (!where?.tenantId || a.tenantId === where.tenantId)
          && (!where?.code || a.code === where.code)
          && (!where?.id || a.id === where.id)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `acc-new-${created.accounts.length + 1}`, isClosed: false, ...data };
        accounts.push(row); created.accounts.push(row);
        return row;
      }),
    },
    bankAccount: {
      findMany: jest.fn(async () => banks.filter((b) => b.deletedAt === null)),
      findFirst: jest.fn(async ({ where }: any) =>
        banks.find((b) => b.id === where?.id
          && (!where?.tenantId || b.tenantId === where.tenantId)
          && (where?.deletedAt === null ? b.deletedAt === null : true)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        bankSeq += 1;
        const row = { id: `bank-${bankSeq}`, createdAt: new Date(), ...data, deletedAt: null };
        banks.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(banks.find((b) => b.id === where.id), data)),
    },
    journalEntry: {
      create: jest.fn(async ({ data }: any) => { created.entries.push(data); entrySeq += 1; return { id: `e${entrySeq}` }; }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    journalLine: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn(async ({ where }: any) => {
        const acc = accounts.find((a) => a.id === where?.accountId);
        return acc ? [{ accountId: acc.id, _sum: { debit: acc._dr ?? 0, credit: acc._cr ?? 0 } }] : [];
      }),
    },
    auditLog: { create: jest.fn(async ({ data }: any) => { created.audit.push(data); return {}; }) },
    syncOperation: {
      create: jest.fn(async ({ data }: any) => { created.sync.push(data); return { id: 'so' }; }),
      aggregate: jest.fn().mockResolvedValue({ _max: { lamport: 0 } }),
    },
    $transaction: jest.fn((fn: any) => fn(db)),
  };
  return { db, created, accounts, banks };
}

describe('Bank accounts (الحسابات البنكية)', () => {
  test('أول بنك يتبنى 1100 الموجود + قيد افتتاحي متوازن Dr 1100 / Cr 3900', async () => {
    const { db, created, banks } = makeDb();
    const svc = new AccountsService(db, new LedgerService(db));
    const res = await svc.createBank('t1', 'b1', {
      bankName: 'بنك فلسطين', accountLabel: 'جاري', openingBalanceAgora: 1500000,
    }, 'u1');
    expect(res.glAccountCode).toBe('1100');
    // لم يُنشئ حساباً جديداً — تبنّى الموجود
    expect(created.accounts.length).toBe(0);
    expect(created.entries.length).toBe(1);
    const lines = created.entries[0].lines.create;
    expect(lines).toContainEqual(expect.objectContaining({ accountId: 'acc-1100', debit: '15000.00' }));
    expect(lines).toContainEqual(expect.objectContaining({ accountId: 'acc-3900', credit: '15000.00' }));
    const dr = lines.reduce((s: number, l: any) => s + Number(l.debit), 0);
    const cr = lines.reduce((s: number, l: any) => s + Number(l.credit), 0);
    expect(dr).toBe(cr);
    expect(banks[0].isActive).toBe(true);
    expect(created.audit.length).toBeGreaterThan(0);
  });

  test('البنك الثاني يأخذ أول كود حر (1101) ويُنشئ حساب GL جديداً', async () => {
    const { db, accounts } = makeDb();
    const svc = new AccountsService(db, new LedgerService(db));
    await svc.createBank('t1', 'b1', { bankName: 'بنك فلسطين' }, 'u1');
    const second = await svc.createBank('t1', 'b1', { bankName: 'بنك القدس', accountLabel: 'تشغيل' }, 'u1');
    expect(second.glAccountCode).toBe('1101');
    expect(accounts.filter((a) => a.code === '1101').length).toBe(1);
    expect(accounts.find((a) => a.code === '1101')?.type).toBe('asset');
  });

  test('يتخطى كوداً محجوزاً في دليل الحسابات (1102 يدوي → البنك الثالث 1103)', async () => {
    const { db, accounts } = makeDb();
    accounts.push({ id: 'acc-1102', code: '1102', name: 'حساب يدوي', type: 'asset', isClosed: false, tenantId: 't1' });
    const svc = new AccountsService(db, new LedgerService(db));
    await svc.createBank('t1', 'b1', { bankName: 'بنك أ' }, 'u1');
    await svc.createBank('t1', 'b1', { bankName: 'بنك ب' }, 'u1');
    const third = await svc.createBank('t1', 'b1', { bankName: 'بنك ج' }, 'u1');
    expect(third.glAccountCode).toBe('1103');
  });

  test('رفض تبنّي كود محجوز بحساب مغلق أو غير أصول', async () => {
    const { db } = makeDb();
    const svc = new AccountsService(db, new LedgerService(db));
    // 1100 مقفل مسبقاً → لا يمكن تبنيه
    (db.account.findMany as jest.Mock).mockResolvedValue([]);
    (db.bankAccount.findMany as jest.Mock).mockResolvedValue([{ glAccountCode: '1099' }]);
    (db.account.findFirst as jest.Mock).mockResolvedValue({ id: 'x', code: '1100', type: 'asset', isClosed: true });
    await expect(svc.createBank('t1', 'b1', { bankName: 'بنك' }, 'u1')).rejects.toThrow(ConflictException);
  });

  test('لا حذف لبنك له رصيد — والحذف ناعم عند صفري', async () => {
    const { db, accounts } = makeDb();
    const svc = new AccountsService(db, new LedgerService(db));
    const b = await svc.createBank('t1', 'b1', { bankName: 'بنك أ', openingBalanceAgora: 1000 }, 'u1');
    (accounts.find((a) => a.code === '1100') as MockAccount)._dr = 1000;
    await expect(svc.deleteBank('t1', b.id, 'u1')).rejects.toThrow(ConflictException);
    (accounts.find((a) => a.code === '1100') as MockAccount)._dr = 0;
    const del = await svc.deleteBank('t1', b.id, 'u1');
    expect(del.deletedAt).not.toBeNull();
  });

  test('تعديل البنك لا يغيّر كود GL أبداً', async () => {
    const { db, banks } = makeDb();
    const svc = new AccountsService(db, new LedgerService(db));
    const b = await svc.createBank('t1', 'b1', { bankName: 'بنك أ' }, 'u1');
    await svc.updateBank('t1', b.id, {
      bankName: 'بنك أ المحدد', iban: 'PS00', glAccountCode: '9999',
    } as any, 'u1');
    expect(banks[0].glAccountCode).toBe('1100');
    expect(banks[0].bankName).toBe('بنك أ المحدد');
    expect(banks[0].iban).toBe('PS00');
  });

  test('رفض اسم بنك فارغ ورفض رصيد افتتاحي غير صالح', async () => {
    const { db } = makeDb();
    const svc = new AccountsService(db, new LedgerService(db));
    await expect(svc.createBank('t1', 'b1', { bankName: '  ' }, 'u1')).rejects.toThrow(BadRequestException);
    await expect(svc.createBank('t1', 'b1', { bankName: 'بنك', openingBalanceAgora: -5 }, 'u1')).rejects.toThrow(BadRequestException);
  });
});
