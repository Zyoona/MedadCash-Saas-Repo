import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BACKUP_DIR, UPLOAD_DIR } from '../../common/env.js';
import { auditTx, settingValue, type Db } from '../../common/ctx.js';
import { DUMP_ORDER, dumpTenant, dumpWhere, restoreDumpTx } from '../sync/backup.service.js';

export const EXPORT_FORMAT = 'medad-export/1';
export const WIPE_PHRASE = 'حذف نهائي';
export const IMPORT_PHRASE = 'استعادة';
export const IMPORT_TMP_DIR = path.join(BACKUP_DIR, 'tmp');
const WIPE_FLAG = 'demo_wipe_done';
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const PRODUCT_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_t)?\.(png|jpg|webp|gif)$/;

const KEEP_MODELS = new Set(['tenant', 'branch', 'user', 'account', 'bankAccount', 'cashDrawer', 'fiscalYear', 'setting', 'backupRun']);
const WIPE_DELETE_ORDER = [...DUMP_ORDER].reverse().filter((m) => !KEEP_MODELS.has(m as string));

export interface DestructiveBody {
  password?: string;
  confirmPhrase?: string;
  acknowledge?: string | boolean;
}

export interface UploadedZip {
  path: string;
  originalname: string;
  size: number;
}

function tsName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

@Injectable()
export class SystemService {
  constructor(private readonly prisma: PrismaService) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.mkdirSync(IMPORT_TMP_DIR, { recursive: true });
  }

  private async assertManager(role: string) {
    if (role !== 'manager') throw new ForbiddenException('هذا الإجراء للمدير فقط');
  }

  private assertDestructive(body: DestructiveBody, phrase: string) {
    const ack = body?.acknowledge === true || body?.acknowledge === 'true';
    if (!ack) throw new BadRequestException('يجب الإقرار بفهم خطورة العملية أولاً');
    if (body?.confirmPhrase !== phrase) throw new BadRequestException(`عبارة التأكيد غير صحيحة — اكتب «${phrase}» حرفياً`);
    if (!body?.password) throw new BadRequestException('كلمة المرور مطلوبة');
  }

  private async verifyPassword(tenantId: string, userId: string, password: string) {
    const u = await this.prisma.user.findFirst({ where: { id: userId, tenantId } });
    if (!u || !u.isActive) throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    const ok = await bcrypt.compare(password, u.passwordHash);
    if (!ok) throw new UnauthorizedException('كلمة المرور غير صحيحة');
  }

  private async assertNoOpenShifts(tenantId: string) {
    const open = await this.prisma.shift.count({ where: { tenantId, closedAt: null } });
    if (open > 0) throw new BadRequestException('أغلق الورديات المفتوحة أولاً');
  }

  private countsOf(dump: Record<string, unknown[]>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const m of DUMP_ORDER) counts[m] = ((dump[m] as unknown[]) ?? []).length;
    return counts;
  }

  async exportZip(tenantId: string, actorId: string) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const run = await this.prisma.backupRun.create({ data: { tenantId, provider: 'local-export', status: 'failed' } });
    const short = tenantId.slice(0, 8);
    const fileName = `medad-export-${short}-${tsName()}.zip`;
    const tmpPath = path.join(BACKUP_DIR, `${fileName}.${crypto.randomUUID()}.tmp.zip`);
    const finalPath = path.join(BACKUP_DIR, fileName);
    try {
      const dump = await dumpTenant(this.prisma as unknown as Db, tenantId);
      const counts = this.countsOf(dump);
      const productsDir = path.join(UPLOAD_DIR, 'products');
      let files: string[] = [];
      try {
        files = fs.readdirSync(productsDir).filter((f) => {
          try { return fs.statSync(path.join(productsDir, f)).isFile(); } catch { return false; }
        });
      } catch { files = []; }
      const manifest = {
        format: EXPORT_FORMAT,
        exportedAt: new Date().toISOString(),
        tenantId,
        appVersion: process.env.npm_package_version ?? null,
        counts,
        filesIncluded: files,
        backupRunId: run.id,
      };
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tmpPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        out.on('close', () => resolve());
        out.on('error', reject);
        archive.on('error', reject);
        archive.pipe(out);
        archive.append(JSON.stringify(manifest), { name: 'manifest.json' });
        archive.append(JSON.stringify(dump), { name: 'database.json' });
        for (const f of files) archive.file(path.join(productsDir, f), { name: `images/${f}` });
        void archive.finalize();
      });
      fs.renameSync(tmpPath, finalPath);
      const bytes = fs.statSync(finalPath).size;
      await this.prisma.backupRun.update({ where: { id: run.id }, data: { status: 'success', filePath: finalPath, sizeBytes: bytes, finishedAt: new Date() } });
      await this.applyExportRetention(tenantId);
      await this.prisma.auditLog.create({ data: { tenantId, actorId, action: 'backup_export', entity: 'backup_runs', entityId: run.id, diff: { filePath: finalPath, bytes, backupRunId: run.id } as object } });
      return { filePath: finalPath, fileName, counts, filesIncluded: files.length };
    } catch (e) {
      await this.prisma.backupRun.update({ where: { id: run.id }, data: { status: 'failed', message: (e as Error).message, finishedAt: new Date() } }).catch(() => undefined);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw e;
    }
  }

  private async applyExportRetention(tenantId: string) {
    const keep = ((await settingValue<{ n: number }>(this.prisma, tenantId, 'backup_keep')) ?? { n: 7 }).n;
    const runs = await this.prisma.backupRun.findMany({
      where: { tenantId, provider: 'local-export', status: 'success' },
      orderBy: { startedAt: 'desc' },
    });
    for (const old of runs.slice(keep)) {
      if (old.filePath && fs.existsSync(old.filePath)) {
        try { fs.unlinkSync(old.filePath); } catch { /* ignore */ }
      }
    }
  }

  async importZip(tenantId: string, actor: { userId: string; role: string }, file: UploadedZip | undefined, body: DestructiveBody) {
    await this.assertManager(actor.role);
    this.assertDestructive(body, IMPORT_PHRASE);
    await this.verifyPassword(tenantId, actor.userId, body.password ?? '');
    if (!file || !file.path) throw new BadRequestException('اختر ملف النسخة (.zip) أولاً');
    try {
      if (!file.originalname?.toLowerCase().endsWith('.zip')) throw new BadRequestException('الملف المرفوع ليس ZIP');
      const stat = fs.statSync(file.path);
      if (stat.size <= 0) throw new BadRequestException('ملف النسخة فارغ');
      if (stat.size > MAX_UPLOAD_BYTES) throw new BadRequestException('حجم النسخة يتجاوز الحد (200MB)');

      const directory = await unzipper.Open.file(file.path);
      const entries = directory.files;
      const byPath = new Map(entries.map((e) => [e.path, e]));
      const manifestEntry = byPath.get('manifest.json');
      const databaseEntry = byPath.get('database.json');
      if (!manifestEntry || manifestEntry.type !== 'File') throw new BadRequestException('النسخة تالفة — manifest.json مفقود');
      if (!databaseEntry || databaseEntry.type !== 'File') throw new BadRequestException('النسخة تالفة — database.json مفقود');
      for (const e of entries) {
        if (e.type === 'Directory') continue;
        const p = e.path;
        if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) throw new BadRequestException('النسخة تحتوي مساراً غير آمن');
        const segs = p.split('/');
        if (segs.includes('..') || segs.includes('')) throw new BadRequestException('النسخة تحتوي مساراً غير آمن');
        if (p !== 'manifest.json' && p !== 'database.json' && !(segs.length === 2 && segs[0] === 'images')) {
          throw new BadRequestException('النسخة تحتوي ملفات غير متوقعة');
        }
      }

      const manifest = JSON.parse((await manifestEntry.buffer()).toString('utf8')) as {
        format?: string; tenantId?: string; exportedAt?: string; counts?: Record<string, number>; filesIncluded?: string[];
      };
      if (manifest.format !== EXPORT_FORMAT) throw new BadRequestException('نسخة غير متوافقة مع هذا الإصدار');
      if (manifest.tenantId !== tenantId) throw new BadRequestException('النسخة تخص مستأجراً آخر');
      const dump = JSON.parse((await databaseEntry.buffer()).toString('utf8')) as Record<string, unknown[]>;
      if (!dump || typeof dump !== 'object' || Array.isArray(dump)) throw new BadRequestException('محتوى النسخة تالف');
      const dumpTenantId = Array.isArray(dump.tenantId) ? dump.tenantId[0] : undefined;
      if (dumpTenantId && dumpTenantId !== tenantId) throw new BadRequestException('النسخة تخص مستأجراً آخر');

      await this.assertNoOpenShifts(tenantId);

      const safetyName = `pre-import-auto-${tenantId.slice(0, 8)}-${tsName()}.json`;
      const safetyPath = path.join(BACKUP_DIR, safetyName);
      const current = await dumpTenant(this.prisma as unknown as Db, tenantId);
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.writeFileSync(safetyPath, JSON.stringify(current), 'utf8');
      const safetyBytes = fs.statSync(safetyPath).size;
      const safetyRun = {
        id: crypto.randomUUID(), tenantId, provider: 'pre-import-auto', status: 'success',
        filePath: safetyPath, sizeBytes: safetyBytes, startedAt: new Date(), finishedAt: new Date(),
      };
      const counts = this.countsOf(dump);

      await this.prisma.$transaction(async (db: Db) => {
        await restoreDumpTx(db, tenantId, dump, { keepSettings: [WIPE_FLAG, 'fake_seed'], keepBackupRuns: [safetyRun] });
        await auditTx(db, {
          tenantId, actorId: actor.userId, action: 'import_zip', entity: 'backup_runs',
          diff: { manifest: { format: manifest.format, exportedAt: manifest.exportedAt, counts, filesIncluded: (manifest.filesIncluded ?? []).length }, safetyBackup: safetyPath, actorId: actor.userId },
        });
      }, { timeout: 120000 });

      await this.restoreImages(tenantId, actor.userId, entries);

      return { ok: true, safetyBackup: safetyPath, importedAt: new Date().toISOString(), counts };
    } finally {
      try { if (file?.path) fs.unlinkSync(file.path); } catch { /* ignore */ }
    }
  }

  private async restoreImages(tenantId: string, actorId: string, entries: unzipper.File[]) {
    const productsDir = path.join(UPLOAD_DIR, 'products');
    try {
      fs.mkdirSync(productsDir, { recursive: true });
      for (const f of fs.readdirSync(productsDir)) {
        try { fs.unlinkSync(path.join(productsDir, f)); } catch { /* ignore */ }
      }
      let extracted = 0;
      const skipped: string[] = [];
      for (const e of entries) {
        if (e.type !== 'File' || !e.path.startsWith('images/')) continue;
        const base = path.basename(e.path);
        if (!PRODUCT_FILE_RE.test(base)) { skipped.push(e.path); continue; }
        await new Promise<void>((resolve, reject) => {
          const ws = fs.createWriteStream(path.join(productsDir, base));
          ws.on('finish', () => resolve());
          ws.on('error', reject);
          e.stream().on('error', reject).pipe(ws);
        });
        extracted += 1;
      }
      if (skipped.length > 0) {
        await this.prisma.auditLog.create({
          data: { tenantId, actorId, action: 'import_zip_images_skipped', entity: 'products', diff: { skipped } as object },
        }).catch(() => undefined);
      }
      void extracted;
    } catch {
      await this.prisma.auditLog.create({
        data: { tenantId, actorId, action: 'import_zip_images_failed', entity: 'products' },
      }).catch(() => undefined);
    }
  }

  async wipeDemo(tenantId: string, actor: { userId: string; role: string }, body: DestructiveBody) {
    await this.assertManager(actor.role);
    this.assertDestructive(body, WIPE_PHRASE);
    const flag = await this.prisma.setting.findFirst({ where: { tenantId, branchId: null, key: WIPE_FLAG } });
    if (flag) throw new ConflictException('استُخدم زر التصفير مسبقاً');
    await this.verifyPassword(tenantId, actor.userId, body.password ?? '');
    await this.assertNoOpenShifts(tenantId);

    const at = new Date();
    await this.prisma.$transaction(async (db: Db) => {
      for (const model of WIPE_DELETE_ORDER) {
        await db[model].deleteMany({ where: dumpWhere(model as string, tenantId) });
      }
      await auditTx(db, { tenantId, actorId: actor.userId, action: 'wipe_demo', entity: 'system', diff: { actorId: actor.userId } });
      const existing = await db.setting.findFirst({ where: { tenantId, branchId: null, key: WIPE_FLAG } });
      const value = { done: true, at: at.toISOString(), actorId: actor.userId };
      if (existing) await db.setting.update({ where: { id: (existing as { id: string }).id }, data: { value: value as never } });
      else await db.setting.create({ data: { tenantId, branchId: null, key: WIPE_FLAG, value: value as never } });
    }, { timeout: 120000 });

    try {
      const productsDir = path.join(UPLOAD_DIR, 'products');
      for (const f of fs.readdirSync(productsDir)) {
        try { fs.unlinkSync(path.join(productsDir, f)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    return { ok: true, deletedTables: [...WIPE_DELETE_ORDER], at: at.toISOString() };
  }
}
