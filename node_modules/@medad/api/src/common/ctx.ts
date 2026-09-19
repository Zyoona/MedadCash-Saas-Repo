// Shared transaction-context helpers. `Db` = PrismaClient OR Prisma.TransactionClient.
// Business services run everything (document + ledger + stock + sync op + audit) inside ONE tx (§1.2).
import { BadRequestException, NotFoundException } from '@nestjs/common';

export type Db = any;

export interface ActorCtx {
  userId: string;
  tenantId: string;
  branchId: string | null;
  ip?: string;
  device?: string;
}

/** Resolve the open fiscal year containing `date` (fallback: latest open year). */
export async function fiscalYearFor(db: Db, tenantId: string, date: Date): Promise<{ id: string; isClosed: boolean }> {
  const fy =
    (await db.fiscalYear.findFirst({
      where: { tenantId, isClosed: false, startDate: { lte: date }, endDate: { gte: date } },
      select: { id: true, isClosed: true },
    })) ??
    (await db.fiscalYear.findFirst({
      where: { tenantId, isClosed: false },
      orderBy: { startDate: 'desc' },
      select: { id: true, isClosed: true },
    }));
  if (!fy) throw new NotFoundException('لا توجد سنة مالية مفتوحة');
  if (fy.isClosed) throw new BadRequestException('السنة المالية مغلقة');
  return fy;
}

export async function ensureAccount(db: Db, tenantId: string, code: string, name: string, type: string): Promise<void> {
  const existing = await db.account.findFirst({ where: { tenantId, code }, select: { id: true } });
  if (!existing) await db.account.create({ data: { tenantId, code, name, type } });
}

/** Read one setting: branch-level overrides tenant-level; falls back to app defaults. */
export const SETTING_DEFAULTS: Record<string, unknown> = {
  tax_rate: { rateBps: 0 },
  fiscal_year_start: { month: 1, day: 1 },
  low_stock_default: { qty: 5 },
  currency: { code: 'ILS', symbol: '₪' },
  drive_config: { configured: false },
  backup_keep: { n: 7 },
  backup_auto: { enabled: true },
  restocking_fee_account: { code: '4100' },
};

export async function settingValue<T>(db: Db, tenantId: string, key: string, branchId?: string | null): Promise<T> {
  if (branchId) {
    const b = await db.setting.findFirst({ where: { tenantId, branchId, key } });
    if (b) return b.value as T;
  }
  const t = await db.setting.findFirst({ where: { tenantId, branchId: null, key } });
  if (t) return t.value as T;
  return SETTING_DEFAULTS[key] as T;
}

/** Audit row inside the current tx (never fails the business op silently — same tx). */
export function auditTx(
  db: Db,
  p: { tenantId: string; actorId?: string | null; branchId?: string | null; action: string; entity: string; entityId?: string | null; diff?: unknown; ip?: string | null; device?: string | null },
): Promise<unknown> {
  return db.auditLog.create({
    data: {
      tenantId: p.tenantId,
      actorId: p.actorId ?? null,
      branchId: p.branchId ?? null,
      action: p.action,
      entity: p.entity,
      entityId: p.entityId ?? null,
      diff: (p.diff ?? undefined) as any,
      ip: p.ip ?? null,
      device: p.device ?? null,
    },
  });
}

/** Operation-log row for sync (§6): every business write is logged for batch upload. */
export async function syncOpTx(
  db: Db,
  p: { tenantId: string; branchId: string; deviceId?: string; entity: string; entityId: string; op: 'create' | 'update' | 'delete'; payload: unknown },
): Promise<unknown> {
  // Lamport counter: monotonic per branch+device (INT4 — never Date.now()).
  const agg = await db.syncOperation.aggregate({
    where: { tenantId: p.tenantId, branchId: p.branchId, deviceId: p.deviceId ?? 'server' },
    _max: { lamport: true },
  });
  const lamport = (agg._max.lamport ?? 0) + 1;
  return db.syncOperation.create({
    data: {
      tenantId: p.tenantId,
      branchId: p.branchId,
      deviceId: p.deviceId ?? 'server',
      entity: p.entity,
      entityId: p.entityId,
      op: p.op,
      payload: p.payload as any,
      lamport,
      appliedAt: new Date(),
    },
  });
}
