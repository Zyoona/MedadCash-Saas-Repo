import { SyncService } from './sync.service.js';

// §9.5: two offline edits to the same entity → manual conflict isolation, NO auto-merge,
// resolution applies as a NEW operation. Financial entities are never auto-written.

function makeDb(opts: { existing?: any } = {}) {
  const created: { conflicts: any[]; updates: any[]; audit: any[] } = { conflicts: [], updates: [], audit: [] };
  let seq = 0;
  const db: any = {
    syncOperation: {
      create: jest.fn(async ({ data }: any) => { seq += 1; return { id: `so${seq}`, ...data }; }),
      update: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _max: { lamport: 0 } }),
    },
    syncConflict: {
      create: jest.fn(async ({ data }: any) => { created.conflicts.push(data); seq += 1; return { id: `sc${seq}`, ...data }; }),
      findFirst: jest.fn().mockResolvedValue({ id: 'sc1', tenantId: 't1', entity: 'customer', entityId: 'c1', branchId: 'b1', localValue: { value: { name: 'محلي' } }, resolved: false }),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    customer: {
      findFirst: jest.fn().mockResolvedValue(opts.existing ?? null),
      update: jest.fn(async ({ data }: any) => { created.updates.push(data); return data; }),
      create: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn(async ({ data }: any) => { created.audit.push(data); return {}; }) },
    $transaction: jest.fn((fn: any) => fn(db)),
  };
  return { db, created };
}

describe('Sync conflicts §9.5', () => {
  test('stale base → conflict isolated, no write, no auto-merge', async () => {
    const { db, created } = makeDb({ existing: { id: 'c1', name: 'سيرفر', createdAt: new Date('2026-02-01') } });
    const svc = new SyncService(db);
    const res = await svc.push('t1', 'u1', {
      branchId: 'b1', deviceId: 'dev1',
      operations: [{ entity: 'customer', entityId: 'c1', op: 'update', payload: { value: { name: 'محلي' }, baseUpdatedAt: new Date('2026-01-01').toISOString() } }],
    });
    expect(res.conflictCount).toBe(1);
    expect(created.conflicts.length).toBe(1);
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  test('fresh base → applied cleanly', async () => {
    const { db, created } = makeDb({ existing: { id: 'c1', name: 'سيرفر', createdAt: new Date('2026-01-01') } });
    const svc = new SyncService(db);
    const res = await svc.push('t1', 'u1', {
      branchId: 'b1', deviceId: 'dev1',
      operations: [{ entity: 'customer', entityId: 'c1', op: 'update', payload: { value: { name: 'محلي' }, baseUpdatedAt: new Date('2026-03-01').toISOString() } }],
    });
    expect(res.applied).toBe(1);
    expect(res.conflictCount).toBe(0);
    expect(created.updates).toContainEqual({ name: 'محلي' });
  });

  test('financial entity op → always isolated (append-only ledger protected)', async () => {
    const { db, created } = makeDb();
    const svc = new SyncService(db);
    const res = await svc.push('t1', 'u1', {
      branchId: 'b1', deviceId: 'dev1',
      operations: [{ entity: 'invoice', entityId: 'i1', op: 'update', payload: { value: { status: 'void' } } }],
    });
    expect(res.conflictCount).toBe(1);
    expect(created.conflicts[0].remoteValue).toEqual({ note: expect.stringContaining('قيد عكسي') });
  });

  test('manual resolution: choice=local applies the local value as a new op', async () => {
    const { db, created } = makeDb({ existing: { id: 'c1', name: 'سيرفر', createdAt: new Date('2026-01-01') } });
    const svc = new SyncService(db);
    await svc.resolveConflict('t1', 'sc1', { choice: 'local' }, 'u1');
    expect(created.updates).toContainEqual({ name: 'محلي' });
    expect(db.syncConflict.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ resolved: true }) }));
    expect(created.audit.length).toBe(1);
  });
});
