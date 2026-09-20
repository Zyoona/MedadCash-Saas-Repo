import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BACKUP_DIR } from '../../common/env.js';
import { decryptJson } from '../../common/crypto.util.js';
import { auditTx, settingValue, type Db } from '../../common/ctx.js';

// Backup (§6): daily export via an ABSTRACT provider (local now, Drive when configured,
// private server later — same interface). Failure = critical alert, never blocks selling.

export interface BackupProvider {
  readonly name: string;
  backup(tenantId: string): Promise<{ filePath: string; bytes: number }>;
}

const DUMP_ORDER = [
  'tenant', 'branch', 'user', 'account', 'fiscalYear', 'setting',
  'category', 'brand', 'unit', 'customer', 'supplier',
  'product', 'productVariant', 'productUnit', 'costComponent', 'productBranch', 'branchStock',
  'shift', 'purchase', 'purchaseLine', 'supplierPayment',
  'invoice', 'invoiceLine', 'invoicePayment',
  'saleReturn', 'saleReturnLine', 'quotation', 'quotationLine',
  'stockTransfer', 'stockTransferLine', 'stockCount', 'stockCountLine',
  'task', 'check', 'journalEntry', 'journalLine',
  'syncOperation', 'syncConflict', 'auditLog', 'backupRun',
] as const;

// Child tables have no tenantId column — filter through the parent relation.
const PARENT_REL: Record<string, string> = {
  journalLine: 'entry', purchaseLine: 'purchase', supplierPayment: 'purchase',
  invoiceLine: 'invoice', invoicePayment: 'invoice', saleReturnLine: 'ret',
  quotationLine: 'quotation', stockTransferLine: 'transfer', stockCountLine: 'count',
};

function dumpWhere(model: string, tenantId: string): Record<string, unknown> {
  if (model === 'tenant') return { id: tenantId };
  if (PARENT_REL[model]) return { [PARENT_REL[model]]: { tenantId } };
  return { tenantId };
}

@Injectable()
export class LocalBackupProvider implements BackupProvider {
  readonly name = 'local';
  constructor(private readonly prisma: PrismaService) {}

  async backup(tenantId: string): Promise<{ filePath: string; bytes: number }> {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dump: Record<string, unknown[]> = { exportedAt: [new Date().toISOString()], tenantId: [tenantId] };
    for (const model of DUMP_ORDER) {
      const delegate = (this.prisma as unknown as Record<string, { findMany(args: unknown): Promise<unknown[]> }>)[model];
      dump[model] = await delegate.findMany({ where: dumpWhere(model, tenantId) });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(BACKUP_DIR, `medad-${tenantId.slice(0, 8)}-${ts}.json`);
    fs.writeFileSync(filePath, JSON.stringify(dump), 'utf8');
    return { filePath, bytes: fs.statSync(filePath).size };
  }
}

type DriveCfg = {
  configured?: boolean;
  // Generic mode: any PUT endpoint (WebDAV/bridge).
  uploadUrl?: string;
  token?: string;
  // Native Google Drive mode: OAuth refresh token flow (access tokens expire in ~1h).
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  folderId?: string;
};

@Injectable()
export class DriveBackupProvider implements BackupProvider {
  readonly name = 'drive';
  constructor(private readonly prisma: PrismaService, private readonly local: LocalBackupProvider) {}

  private async loadCfg(tenantId: string): Promise<DriveCfg> {
    const cfgRaw = await this.prisma.setting.findFirst({ where: { tenantId, branchId: null, key: 'drive_config' } });
    if (!cfgRaw) return { configured: false };
    return typeof cfgRaw.value === 'string' && cfgRaw.value.startsWith('v1:')
      ? decryptJson<DriveCfg>(cfgRaw.value)
      : (cfgRaw.value as DriveCfg);
  }

  /** Exchange the long-lived refresh token for a short-lived access token (before each upload). */
  private async refreshAccessToken(cfg: DriveCfg): Promise<string> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId ?? '',
        client_secret: cfg.clientSecret ?? '',
        refresh_token: cfg.refreshToken ?? '',
        grant_type: 'refresh_token',
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new BadRequestException(`فشل تجديد رمز الوصول من جوجل — تحقق من Client ID/Secret/Refresh Token (${json.error_description ?? res.status})`);
    }
    return json.access_token;
  }

  async backup(tenantId: string): Promise<{ filePath: string; bytes: number }> {
    const cfg = await this.loadCfg(tenantId);
    const native = !!(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
    const generic = !!(cfg.uploadUrl && cfg.token);
    if (!cfg?.configured || (!native && !generic)) {
      throw new BadRequestException('خدمة النسخ السحابي (Drive) غير مهيأة — أدخل Client ID و Client Secret و Refresh Token من شاشة الإعدادات (أو uploadUrl و token للوضع البديل)');
    }
    // Build the archive locally first, then upload to the configured destination.
    const local = await this.local.backup(tenantId);
    const fileName = path.basename(local.filePath);
    if (native) {
      const token = await this.refreshAccessToken(cfg);
      const meta: Record<string, unknown> = { name: fileName };
      if (cfg.folderId) meta.parents = [cfg.folderId];
      const boundary = 'medad-' + crypto.randomUUID();
      const pre = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        'utf8',
      );
      const post = Buffer.from(`\r\n--${boundary}--`, 'utf8');
      const body = Buffer.concat([pre, fs.readFileSync(local.filePath), post]);
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: new Uint8Array(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new BadRequestException(`فشل رفع النسخة الاحتياطية إلى Drive (رمز الخطأ: ${res.status}) ${errText.slice(0, 200)}`);
      }
    } else {
      const res = await fetch(cfg.uploadUrl!, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: fs.readFileSync(local.filePath),
      });
      if (!res.ok) throw new BadRequestException(`فشل رفع النسخة الاحتياطية (رمز الخطأ: ${res.status})`);
    }
    return local;
  }
}

@Injectable()
export class BackupService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly localProvider: LocalBackupProvider,
    private readonly driveProvider: DriveBackupProvider,
  ) {}

  /** Daily auto-backup scheduler (hourly tick; runs when last success > 24h). */
  onModuleInit() {
    const tick = () => {
      void (async () => {
        try {
          const tenants = await this.prisma.tenant.findMany({ where: { deletedAt: null }, select: { id: true } });
          for (const t of tenants) {
            const auto = await settingValue<{ enabled: boolean }>(this.prisma, t.id, 'backup_auto');
            if (auto?.enabled === false) continue;
            const last = await this.prisma.backupRun.findFirst({ where: { tenantId: t.id, status: 'success' }, orderBy: { startedAt: 'desc' } });
            if (last && Date.now() - last.startedAt.getTime() < 24 * 3600 * 1000) continue;
            await this.run(t.id, 'local', 'system').catch(() => undefined);
          }
        } catch {
          // scheduler must never crash the API
        }
      })();
    };
    setInterval(tick, 60 * 60 * 1000);
    setTimeout(tick, 15 * 1000);
  }

  async run(tenantId: string, providerName: string, actorId: string) {
    const provider: BackupProvider = providerName === 'drive' ? this.driveProvider : this.localProvider;
    const run = await this.prisma.backupRun.create({ data: { tenantId, provider: provider.name, status: 'failed' } });
    try {
      const { filePath, bytes } = await provider.backup(tenantId);
      const done = await this.prisma.backupRun.update({ where: { id: run.id }, data: { status: 'success', filePath, sizeBytes: bytes, finishedAt: new Date() } });
      await this.applyRetention(tenantId);
      await this.prisma.auditLog.create({ data: { tenantId, actorId, action: 'backup', entity: 'backup_runs', entityId: run.id, diff: { provider: provider.name, filePath, bytes } as object } });
      return done;
    } catch (e) {
      const failed = await this.prisma.backupRun.update({ where: { id: run.id }, data: { status: 'failed', message: (e as Error).message, finishedAt: new Date() } });
      await this.prisma.auditLog.create({ data: { tenantId, actorId, action: 'backup_failed', entity: 'backup_runs', entityId: run.id, diff: { provider: provider.name, error: (e as Error).message } as object } });
      return failed;
    }
  }

  /** Keep last N local copies (settings backup_keep, default 7). */
  private async applyRetention(tenantId: string) {
    const keep = ((await settingValue<{ n: number }>(this.prisma, tenantId, 'backup_keep')) ?? { n: 7 }).n;
    const runs = await this.prisma.backupRun.findMany({
      where: { tenantId, provider: 'local', status: 'success' },
      orderBy: { startedAt: 'desc' },
    });
    for (const old of runs.slice(keep)) {
      if (old.filePath && fs.existsSync(old.filePath)) {
        try { fs.unlinkSync(old.filePath); } catch { /* ignore */ }
      }
    }
  }

  runs(tenantId: string) {
    return this.prisma.backupRun.findMany({ where: { tenantId }, orderBy: { startedAt: 'desc' }, take: 50 });
  }

  /** Full DR restore from a local backup file (manager only). Restores ALL tables atomically. */
  async restore(tenantId: string, filePath: string, actorId: string) {
    if (!filePath.startsWith(BACKUP_DIR)) throw new BadRequestException('مسار النسخة خارج مجلد النسخ');
    if (!fs.existsSync(filePath)) throw new BadRequestException('ملف النسخة غير موجود');
    const dump = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown[]>;
    await this.prisma.$transaction(async (db: Db) => {
      for (const model of [...DUMP_ORDER].reverse()) {
        await db[model].deleteMany({});
      }
      for (const model of DUMP_ORDER) {
        const rows = dump[model] ?? [];
        if (rows.length > 0) await db[model].createMany({ data: rows });
      }
      await auditTx(db, { tenantId, actorId, action: 'restore', entity: 'backup_runs', diff: { filePath } });
    }, { timeout: 120000 });
    return { ok: true, file: filePath };
  }
}
