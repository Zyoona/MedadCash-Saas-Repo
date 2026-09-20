// Runtime configuration. Secrets come from apps/api/.env (loaded in main.ts).
export const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'medad-dev-access-secret-change-in-prod';
export const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'medad-dev-refresh-secret-change-in-prod';
export const ACCESS_TTL_SEC = 60 * 60; // 1 hour (short-lived access)
export const REFRESH_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
export const BACKUP_DIR = process.env.BACKUP_DIR ?? 'F:\\مداد\\MedadCash\\_tools\\backups';
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? 'F:\\مداد\\MedadCash\\_tools\\uploads';
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // حد حجم صورة الصنف بعد فك الترميز
