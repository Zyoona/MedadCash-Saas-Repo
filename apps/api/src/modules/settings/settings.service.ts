import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { decryptJson, encryptJson } from '../../common/crypto.util.js';
import { auditTx, SETTING_DEFAULTS, type Db } from '../../common/ctx.js';

const SECRET_KEYS = new Set(['drive_config']);

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** All settings merged: defaults ← tenant ← branch. */
  async getAll(tenantId: string, branchId?: string | null): Promise<Record<string, unknown>> {
    const rows = await this.prisma.setting.findMany({ where: { tenantId } });
    const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
    for (const r of rows) {
      if (r.branchId === null) out[r.key] = this.decode(r.key, r.value);
    }
    if (branchId) {
      for (const r of rows) {
        if (r.branchId === branchId) out[r.key] = this.decode(r.key, r.value);
      }
    }
    return out;
  }

  private decode(key: string, value: unknown): unknown {
    if (SECRET_KEYS.has(key) && typeof value === 'string' && value.startsWith('v1:')) {
      try {
        return decryptJson(value);
      } catch {
        return { configured: false, error: 'failed to decrypt' };
      }
    }
    return value;
  }

  async set(tenantId: string, key: string, value: unknown, branchId: string | null, actorId: string) {
    if (!(key in SETTING_DEFAULTS) && !key.startsWith('custom.')) {
      throw new BadRequestException(`مفتاح إعداد غير معروف: ${key}`);
    }
    const stored = SECRET_KEYS.has(key) ? encryptJson(value) : value;
    await this.prisma.$transaction(async (db: Db) => {
      await db.setting.upsert({
        where: { tenantId_branchId_key: { tenantId, branchId: branchId as unknown as string, key } },
        update: { value: stored },
        create: { tenantId, branchId, key, value: stored },
      }).catch(async () => {
        // fallback when unique-null semantics differ: find+create/update
        const existing = await db.setting.findFirst({ where: { tenantId, branchId, key } });
        if (existing) await db.setting.update({ where: { id: existing.id }, data: { value: stored } });
        else await db.setting.create({ data: { tenantId, branchId, key, value: stored } });
      });
      await auditTx(db, { tenantId, actorId, branchId, action: 'update', entity: 'settings', entityId: key, diff: { key, value: SECRET_KEYS.has(key) ? '[encrypted]' : value } });
    });
    return this.getAll(tenantId, branchId);
  }
}
