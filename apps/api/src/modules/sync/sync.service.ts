import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { auditTx, type Db } from '../../common/ctx.js';

// Sync (§6): Operation Log batches + MANUAL conflict isolation. NO auto-merge, ever.
// Financial entities are never written through sync — conflicts on them are informational
// and must be settled via ledger reversal (append-only rule §1.2).

const WRITE_WHITELIST: Record<string, string> = {
  customer: 'customer',
  supplier: 'supplier',
  product: 'product',
  category: 'category',
  brand: 'brand',
  unit: 'unit',
  task: 'task',
};
const FINANCIAL_ENTITIES = new Set(['invoice', 'purchase', 'sale_return', 'collection', 'supplier_payment', 'journal_entry', 'stock_count', 'stock_transfer']);

export interface PushOp {
  entity: string;
  entityId: string;
  op: 'create' | 'update' | 'delete';
  payload: { value?: Record<string, unknown>; baseUpdatedAt?: string };
  lamport?: number;
}

@Injectable()
export class SyncService {
  constructor(private readonly prisma: PrismaService) {}

  async push(tenantId: string, actorId: string, input: { branchId: string; deviceId: string; operations: PushOp[] }) {
    if (!input.operations?.length) throw new BadRequestException('لا توجد عمليات');
    const applied: string[] = [];
    const conflicts: string[] = [];

    for (const op of input.operations) {
      const agg = await this.prisma.syncOperation.aggregate({
        where: { tenantId, branchId: input.branchId, deviceId: input.deviceId },
        _max: { lamport: true },
      });
      const row = await this.prisma.syncOperation.create({
        data: {
          tenantId, branchId: input.branchId, deviceId: input.deviceId,
          entity: op.entity, entityId: op.entityId, op: op.op,
          payload: op.payload as object, lamport: op.lamport ?? (agg._max.lamport ?? 0) + 1,
        },
      });

      const isFinancial = FINANCIAL_ENTITIES.has(op.entity);
      const model = WRITE_WHITELIST[op.entity];
      if (isFinancial || !model) {
        // Financial/unknown entity: isolate — never write; humans settle via reversal.
        const current = isFinancial ? { note: 'كيان مالي — التسوية بقيد عكسي فقط' } : { note: 'كيان خارج قائمة المزامنة' };
        const c = await this.prisma.syncConflict.create({
          data: {
            tenantId, branchId: input.branchId, entity: op.entity, entityId: op.entityId,
            localValue: op.payload as object, remoteValue: current as object, localDevice: input.deviceId,
          },
        });
        conflicts.push(c.id);
        continue;
      }

      const db = this.prisma as Db;
      const existing = await db[model].findFirst({ where: { id: op.entityId, tenantId } });

      if (op.op === 'update') {
        if (!existing) {
          const c = await this.prisma.syncConflict.create({
            data: { tenantId, branchId: input.branchId, entity: op.entity, entityId: op.entityId, localValue: op.payload as object, remoteValue: { note: 'الكيان غير موجود على الخادم' } as object, localDevice: input.deviceId },
          });
          conflicts.push(c.id);
          continue;
        }
        const base = op.payload.baseUpdatedAt ? new Date(op.payload.baseUpdatedAt).getTime() : null;
        const serverTime = new Date(existing.createdAt).getTime();
        if (base !== null && serverTime > base) {
          // Both sides changed the same entity while apart → isolate (§6)
          const c = await this.prisma.syncConflict.create({
            data: { tenantId, branchId: input.branchId, entity: op.entity, entityId: op.entityId, localValue: (op.payload.value ?? op.payload) as object, remoteValue: existing as object, localDevice: input.deviceId },
          });
          conflicts.push(c.id);
          continue;
        }
        if (op.payload.value) await db[model].update({ where: { id: op.entityId }, data: op.payload.value });
      } else if (op.op === 'create') {
        if (!existing && op.payload.value) {
          await db[model].create({ data: { ...op.payload.value, id: op.entityId, tenantId } });
        }
      } else if (op.op === 'delete') {
        if (existing) await db[model].update({ where: { id: op.entityId }, data: { deletedAt: new Date() } });
      }
      applied.push(row.id);
      await this.prisma.syncOperation.update({ where: { id: row.id }, data: { appliedAt: new Date() } });
    }

    await this.prisma.auditLog.create({
      data: { tenantId, actorId, branchId: input.branchId, action: 'sync_push', entity: 'sync_operations', diff: { deviceId: input.deviceId, applied: applied.length, conflicts: conflicts.length } as object },
    });
    return { applied: applied.length, conflicts, conflictCount: conflicts.length };
  }

  pull(tenantId: string, q: { branchId?: string; since?: string; deviceId?: string }) {
    return this.prisma.syncOperation.findMany({
      where: {
        tenantId,
        ...(q.branchId ? { branchId: q.branchId } : {}),
        ...(q.deviceId ? { deviceId: { not: q.deviceId } } : {}),
        ...(q.since ? { createdAt: { gte: new Date(q.since) } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
  }

  listConflicts(tenantId: string, resolved?: boolean) {
    return this.prisma.syncConflict.findMany({
      where: { tenantId, ...(resolved !== undefined ? { resolved } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Manual resolution (§6): show both values → user picks one → applied as a NEW operation. */
  async resolveConflict(tenantId: string, id: string, input: { choice: 'local' | 'remote' | 'custom'; value?: Record<string, unknown> }, actorId: string) {
    const c = await this.prisma.syncConflict.findFirst({ where: { id, tenantId } });
    if (!c) throw new NotFoundException('التعارض غير موجود');
    if (c.resolved) throw new BadRequestException('محلول مسبقاً');
    const model = WRITE_WHITELIST[c.entity];

    await this.prisma.$transaction(async (db: Db) => {
      if (input.choice !== 'remote' && model) {
        const value = input.choice === 'custom' ? input.value : ((c.localValue as { value?: Record<string, unknown> }).value ?? c.localValue as Record<string, unknown>);
        const existing = await db[model].findFirst({ where: { id: c.entityId, tenantId } });
        if (existing) await db[model].update({ where: { id: c.entityId }, data: value });
        else await db[model].create({ data: { ...value, id: c.entityId, tenantId } });
      }
      await db.syncConflict.update({
        where: { id },
        data: { resolved: true, resolution: { choice: input.choice, by: actorId, at: new Date().toISOString() } as object },
      });
      await auditTx(db, { tenantId, actorId, branchId: c.branchId, action: 'resolve_conflict', entity: 'sync_conflicts', entityId: id, diff: { choice: input.choice, entity: c.entity, entityId: c.entityId } });
    });
    return { ok: true };
  }

  /** Manager board (§6): aggregated visibility per branch. */
  async board(tenantId: string) {
    const branches = await this.prisma.branch.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true } });
    const out = [];
    for (const b of branches) {
      const lastPush = await this.prisma.syncOperation.findFirst({ where: { tenantId, branchId: b.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, deviceId: true } });
      const devices = await this.prisma.syncOperation.groupBy({ by: ['deviceId'], where: { tenantId, branchId: b.id } });
      const conflicts = await this.prisma.syncConflict.count({ where: { tenantId, branchId: b.id, resolved: false } });
      out.push({ branch: b, lastPushAt: lastPush?.createdAt ?? null, lastPushDevice: lastPush?.deviceId ?? null, deviceCount: devices.length, openConflicts: conflicts });
    }
    return out;
  }
}
