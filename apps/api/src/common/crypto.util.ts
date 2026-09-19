// AES-256-GCM encryption for secrets at rest (drive_config ...). Key derived from access secret.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { JWT_ACCESS_SECRET } from './env.js';

const KEY = createHash('sha256').update(JWT_ACCESS_SECRET).digest();

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptJson<T>(packed: string): T {
  const [v, iv, tag, data] = packed.split(':');
  if (v !== 'v1') throw new Error('تنسيق المفتاح السري غير مدعوم (الإصدار v1 فقط)');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  return JSON.parse(dec.toString('utf8')) as T;
}
