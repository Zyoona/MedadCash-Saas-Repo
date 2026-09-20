import * as path from 'path';

// Runtime configuration. Secrets come from apps/api/.env (loaded in main.ts).
export const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'medad-dev-access-secret-change-in-prod';
export const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'medad-dev-refresh-secret-change-in-prod';
export const ACCESS_TTL_SEC = 60 * 60; // 1 hour (short-lived access)
export const REFRESH_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

// جذر المشروع مشتق من موقع الملف (src/common في التطوير أو dist/common بعد البناء)
// بدلاً من مسار قرص ثابت، ليعمل النسخ الاحتياطي والرفع من أي مسار.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(PROJECT_ROOT, '_tools', 'backups');
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(PROJECT_ROOT, '_tools', 'uploads');
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // حد حجم صورة الصنف بعد فك الترميز
