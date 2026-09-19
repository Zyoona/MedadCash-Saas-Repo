import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

// Audit (§7): every sensitive action gets a row. Rows are never updated/deleted
// (archival only, after fiscal close, by manager — not exposed via API).
export interface AuditInput {
  tenantId: string;
  actorId?: string | null;
  branchId?: string | null;
  action: string; // create | update | delete | login | view | search | export | print | ...
  entity: string;
  entityId?: string | null;
  diff?: unknown;
  ip?: string | null;
  device?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Standalone log (outside business tx) — used for login and read-audit events. */
  async log(p: AuditInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        tenantId: p.tenantId,
        actorId: p.actorId ?? null,
        branchId: p.branchId ?? null,
        action: p.action,
        entity: p.entity,
        entityId: p.entityId ?? null,
        diff: (p.diff ?? undefined) as object,
        ip: p.ip ?? null,
        device: p.device ?? null,
      },
    });
  }

  async list(q: {
    tenantId: string;
    actorId?: string;
    action?: string;
    entity?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }) {
    const where = {
      tenantId: q.tenantId,
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.from || q.to
        ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
        : {}),
    };
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 50, 200);
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { actor: { select: { id: true, name: true, email: true } } },
      }),
    ]);
    return { total, page, pageSize, rows };
  }

  /** CSV export (Excel-compatible: UTF-8 BOM + comma separated). */
  async exportCsv(q: { tenantId: string; actorId?: string; action?: string; entity?: string; from?: string; to?: string }): Promise<string> {
    const where = {
      tenantId: q.tenantId,
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.from || q.to
        ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
        : {}),
    };
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 50000,
      include: { actor: { select: { name: true } } },
    });
    const esc = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['التاريخ', 'المستخدم', 'الإجراء', 'الكيان', 'المعرف', 'التفاصيل', 'IP', 'الجهاز'];
    const lines = rows.map((r) =>
      [r.createdAt.toISOString(), r.actor?.name ?? '', r.action, r.entity, r.entityId ?? '', JSON.stringify(r.diff ?? {}), r.ip ?? '', r.device ?? '']
        .map(esc)
        .join(','),
    );
    return `\uFEFF${head.map(esc).join(',')}\n${lines.join('\n')}`;
  }
}
