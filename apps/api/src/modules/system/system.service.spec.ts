import { ConflictException } from '@nestjs/common';
import { DUMP_ORDER, dumpWhere, restoreDumpTx } from '../sync/backup.service.js';

jest.mock('bcryptjs', () => ({ compare: jest.fn() }));
jest.mock('archiver', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('unzipper', () => ({ Open: { file: jest.fn() } }));
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs') as Record<string, unknown>;
  return {
    ...actual,
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    readdirSync: jest.fn(() => []),
    renameSync: jest.fn(),
    statSync: jest.fn(() => ({ size: 100 })),
    existsSync: jest.fn(() => true),
    createWriteStream: jest.fn(),
  };
});

import * as bcrypt from 'bcryptjs';
import * as fs from 'node:fs';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import { SystemService, EXPORT_FORMAT } from './system.service.js';

const mockedCompare = bcrypt.compare as unknown as jest.Mock;
const mockedArchiver = archiver as unknown as jest.Mock;
const mockedOpenFile = (unzipper.Open as unknown as { file: jest.Mock }).file;
const mfs = fs as unknown as Record<string, jest.Mock>;

function delegate() {
  return {
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
    deleteMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 0 })),
    create: jest.fn(async ({ data }: any) => ({ id: 'x', ...data })),
    update: jest.fn(async () => ({})),
    count: jest.fn(async () => 0),
  };
}

function makePrisma(overrides: Record<string, any> = {}) {
  const cache: Record<string, any> = {};
  const base: any = { ...overrides } as any;
  const proxy: any = new Proxy(base, {
    get(t, p: string | symbol) {
      if (typeof p !== 'string') return (t as any)[p];
      if (p === '$transaction') return (t as any)[p] ?? ((fn: any) => fn(proxy));
      let def = cache[p];
      if (!def) {
        def = delegate();
        cache[p] = def;
      }
      if (p in t) {
        const over = (t as any)[p];
        if (over && typeof over === 'object' && !Array.isArray(over)) {
          for (const k of Object.keys(over)) def[k] = over[k];
        } else {
          return over;
        }
      }
      return def;
    },
  });
  if (!base.$transaction) base.$transaction = jest.fn((fn: any) => fn(proxy));
  return proxy;
}

function entry(path: string, json: unknown) {
  return {
    path,
    type: 'File',
    buffer: async () => Buffer.from(JSON.stringify(json)),
    stream: () => { throw new Error('no stream in test'); },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCompare.mockResolvedValue(true);
  mfs.mkdirSync.mockImplementation((() => undefined) as never);
  mfs.writeFileSync.mockImplementation((() => undefined) as never);
  mfs.unlinkSync.mockImplementation((() => undefined) as never);
  mfs.readdirSync.mockImplementation((() => []) as never);
  mfs.renameSync.mockImplementation((() => undefined) as never);
  mfs.statSync.mockImplementation((() => ({ size: 100 })) as never);
  mfs.existsSync.mockImplementation((() => true) as never);
});

describe('DUMP_ORDER', () => {
  test('يشمل bankAccount و cashDrawer', () => {
    expect([...DUMP_ORDER]).toContain('bankAccount');
    expect([...DUMP_ORDER]).toContain('cashDrawer');
  });

  test('dumpWhere يفلتر عبر tenantId أو علاقة الأب', () => {
    expect(dumpWhere('product', 't1')).toEqual({ tenantId: 't1' });
    expect(dumpWhere('tenant', 't1')).toEqual({ id: 't1' });
    expect(dumpWhere('journalLine', 't1')).toEqual({ entry: { tenantId: 't1' } });
    expect(dumpWhere('purchaseLine', 't1')).toEqual({ purchase: { tenantId: 't1' } });
  });
});

describe('restoreDumpTx', () => {
  test('حذف tenant-scoped ولا يمس صف tenant', async () => {
    const db = makePrisma();
    const dump: Record<string, unknown[]> = {
      product: [{ id: 'p1', tenantId: 't1', name: 'x' }],
      setting: [],
      backupRun: [],
    };
    await restoreDumpTx(db, 't1', dump);
    expect(db.tenant.deleteMany).not.toHaveBeenCalled();
    expect(db.product.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't1' } });
    expect(db.journalLine.deleteMany).toHaveBeenCalledWith({ where: { entry: { tenantId: 't1' } } });
    expect(db.product.createMany).toHaveBeenCalled();
  });

  test('كل الحذف مفلتر بـ tenantId', async () => {
    const db = makePrisma();
    await restoreDumpTx(db, 't1', { product: [] });
    for (const m of ['product', 'category', 'invoice', 'journalEntry'] as const) {
      const call = (db[m].deleteMany as jest.Mock).mock.calls[0]?.[0];
      expect(JSON.stringify(call)).toContain('t1');
    }
  });
});

describe('SystemService.wipeDemo', () => {
  function wipePrisma(opts: { flag?: any; openShifts?: number } = {}) {
    const txSettingFindFirst = jest.fn(async () => null);
    const txSettingCreate = jest.fn(async ({ data }: any) => data);
    const txSettingUpdate = jest.fn(async () => ({}));
    const txAudit = jest.fn(async () => ({}));
    const deleted: string[] = [];
    const tx: any = new Proxy(
      {
        auditLog: { create: txAudit },
        setting: { findFirst: txSettingFindFirst, create: txSettingCreate, update: txSettingUpdate },
      },
      {
        get(t, p: string | symbol) {
          if (typeof p !== 'string') return (t as any)[p];
          if (p in t) {
            const over = (t as any)[p];
            if (over && typeof over === 'object' && !Array.isArray(over)) {
              return new Proxy(over, {
                get(ot, k: string | symbol) {
                  if (typeof k !== 'string') return (ot as any)[k];
                  if (k in ot) return (ot as any)[k];
                  if (k === 'deleteMany' || k === 'findMany' || k === 'createMany' || k === 'create' || k === 'update' || k === 'findFirst' || k === 'count') {
                    const fn = jest.fn(async () => {
                      if (k === 'deleteMany') deleted.push(p);
                      return k === 'findFirst' ? null : k === 'findMany' ? [] : {};
                    });
                    (ot as any)[k] = fn;
                    return fn;
                  }
                  return undefined;
                },
              });
            }
            return over;
          }
          return {
            deleteMany: jest.fn(async () => { deleted.push(p); return { count: 0 }; }),
            findMany: jest.fn(async () => []),
            createMany: jest.fn(async () => ({})),
            findFirst: jest.fn(async () => null),
            create: jest.fn(async () => ({})),
            update: jest.fn(async () => ({})),
          };
        },
      },
    );
    const prisma = makePrisma({
      user: { findFirst: jest.fn(async () => ({ id: 'u1', tenantId: 't1', isActive: true, passwordHash: 'h' })) },
      setting: { findFirst: jest.fn(async () => opts.flag ?? null) },
      shift: { count: jest.fn(async () => opts.openShifts ?? 0) },
      $transaction: jest.fn((fn: any) => fn(tx)),
    });
    return { prisma, deleted, txAudit, txSettingCreate };
  }

  const body = (over: Record<string, unknown> = {}) => ({
    password: 'secret', confirmPhrase: 'حذف نهائي', acknowledge: true, ...over,
  });

  test('يرفض غير المدير', async () => {
    const { prisma } = wipePrisma();
    const svc = new SystemService(prisma as never);
    await expect(svc.wipeDemo('t1', { userId: 'u1', role: 'cashier' }, body())).rejects.toThrow();
  });

  test('يرفض بكلمة مرور خاطئة', async () => {
    mockedCompare.mockResolvedValue(false);
    const { prisma } = wipePrisma();
    const svc = new SystemService(prisma as never);
    await expect(svc.wipeDemo('t1', { userId: 'u1', role: 'manager' }, body())).rejects.toThrow('كلمة المرور غير صحيحة');
  });

  test('يرفض بعبارة تأكيد خاطئة', async () => {
    const { prisma } = wipePrisma();
    const svc = new SystemService(prisma as never);
    await expect(svc.wipeDemo('t1', { userId: 'u1', role: 'manager' }, body({ confirmPhrase: 'خطأ' }))).rejects.toThrow();
  });

  test('يرفض عند وردية مفتوحة', async () => {
    const { prisma } = wipePrisma({ openShifts: 1 });
    const svc = new SystemService(prisma as never);
    await expect(svc.wipeDemo('t1', { userId: 'u1', role: 'manager' }, body())).rejects.toThrow('أغلق الورديات المفتوحة أولاً');
  });

  test('يرفض المسح الثاني بسبب demo_wipe_done', async () => {
    const { prisma } = wipePrisma({ flag: { key: 'demo_wipe_done', value: { done: true } } });
    const svc = new SystemService(prisma as never);
    await expect(svc.wipeDemo('t1', { userId: 'u1', role: 'manager' }, body())).rejects.toBeInstanceOf(ConflictException);
  });

  test('نجاح المسح: يحذف التجريبي ويُبقي التأسيس + يكتب العلم والتدقيق', async () => {
    const { prisma, deleted, txAudit, txSettingCreate } = wipePrisma();
    const svc = new SystemService(prisma as never);
    const res = await svc.wipeDemo('t1', { userId: 'u1', role: 'manager' }, body());
    expect(res.ok).toBe(true);
    expect(deleted).toContain('product');
    expect(deleted).toContain('invoice');
    expect(deleted).toContain('journalEntry');
    for (const keep of ['tenant', 'branch', 'user', 'account', 'bankAccount', 'cashDrawer', 'fiscalYear', 'setting', 'backupRun']) {
      expect(deleted).not.toContain(keep);
    }
    expect(txAudit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'wipe_demo' }) }));
    const createdArg = txSettingCreate.mock.calls[0]?.[0]?.data;
    expect(createdArg.key).toBe('demo_wipe_done');
    expect(createdArg.tenantId).toBe('t1');
    expect(mockedCompare).toHaveBeenCalledWith('secret', 'h');
  });
});

describe('SystemService.importZip', () => {
  function importPrisma(tenantId = 't1') {
    const prisma = makePrisma({
      user: { findFirst: jest.fn(async () => ({ id: 'u1', tenantId, isActive: true, passwordHash: 'h' })) },
      shift: { count: jest.fn(async () => 0) },
    });
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    prisma.setting.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.key === 'backup_keep') return { value: { n: 7 } };
      return null;
    });
    prisma.backupRun.findMany.mockResolvedValue([]);
    return prisma;
  }

  const goodBody = () => ({ password: 'secret', confirmPhrase: 'استعادة', acknowledge: true });
  const file = () => ({ path: '/tmp/x.zip', originalname: 'medad.zip', size: 100 });

  function mockZip(manifest: unknown, dump: unknown, extra: any[] = []) {
    mfs.statSync.mockReturnValue({ size: 100 } as never);
    mockedOpenFile.mockResolvedValue({
      files: [entry('manifest.json', manifest), entry('database.json', dump), ...extra],
    } as never);
  }

  test('يرفض نسخة بمستأجر مختلف', async () => {
    const prisma = importPrisma('t1');
    mockZip({ format: EXPORT_FORMAT, tenantId: 'other' }, { tenantId: ['t1'] });
    const svc = new SystemService(prisma as never);
    await expect(svc.importZip('t1', { userId: 'u1', role: 'manager' }, file() as never, goodBody())).rejects.toThrow('مستأجر');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('يرفض نسخة غير متوافقة', async () => {
    const prisma = importPrisma('t1');
    mockZip({ format: 'other/9', tenantId: 't1' }, { tenantId: ['t1'] });
    const svc = new SystemService(prisma as never);
    await expect(svc.importZip('t1', { userId: 'u1', role: 'manager' }, file() as never, goodBody())).rejects.toThrow('غير متوافقة');
  });

  test('يرفض مسار zip-slip خبيث', async () => {
    const prisma = importPrisma('t1');
    mockZip(
      { format: EXPORT_FORMAT, tenantId: 't1' },
      { tenantId: ['t1'] },
      [{ path: '../evil.json', type: 'File', buffer: async () => Buffer.from('x'), stream: () => null as never }],
    );
    const svc = new SystemService(prisma as never);
    await expect(svc.importZip('t1', { userId: 'u1', role: 'manager' }, file() as never, goodBody())).rejects.toThrow('غير آمن');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('نجاح الاستيراد: safety + استبدال + audit بدون كلمة مرور', async () => {
    const prisma = importPrisma('t1');
    const dump = { tenantId: ['t1'], product: [{ id: 'p1', tenantId: 't1' }], setting: [], backupRun: [] };
    mockZip({ format: EXPORT_FORMAT, tenantId: 't1', exportedAt: new Date().toISOString() }, dump);
    const svc = new SystemService(prisma as never);
    jest.spyOn(svc as any, 'restoreImages').mockResolvedValue(undefined);
    const res = await svc.importZip('t1', { userId: 'u1', role: 'manager' }, file() as never, goodBody());
    expect(res.ok).toBe(true);
    expect(res.safetyBackup).toContain('pre-import-auto');
    expect(prisma.$transaction).toHaveBeenCalled();
    const auditCalls = (prisma.auditLog.create as jest.Mock).mock.calls;
    const importCall = auditCalls.find((c) => c[0]?.data?.action === 'import_zip');
    expect(importCall).toBeDefined();
    expect(JSON.stringify(importCall?.[0]?.data)).not.toContain('secret');
  });
});

describe('SystemService.exportZip', () => {
  test('ينشئ backupRun local-export و manifest', async () => {
    const prisma = makePrisma();
    prisma.backupRun.create.mockResolvedValue({ id: 'r1' });
    prisma.backupRun.update.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});
    mfs.statSync.mockReturnValue({ size: 10 } as never);
    const fakeArchive = { on: jest.fn(), pipe: jest.fn(), append: jest.fn(), file: jest.fn(), finalize: jest.fn() };
    mockedArchiver.mockReturnValue(fakeArchive);
    const fakeOut: any = { on: jest.fn((ev: string, cb: () => void) => { if (ev === 'close') setImmediate(cb); return fakeOut; }) };
    mfs.createWriteStream.mockReturnValue(fakeOut as never);
    const svc = new SystemService(prisma as never);
    const res = await svc.exportZip('t1', 'u1');
    expect(res.fileName).toContain('medad-export');
    expect(prisma.backupRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ provider: 'local-export' }) }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'backup_export' }) }));
  });
});
