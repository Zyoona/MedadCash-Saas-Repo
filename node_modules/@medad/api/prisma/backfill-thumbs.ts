import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import sharp = require('sharp');
import { UPLOAD_DIR } from '../src/common/env';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = new PrismaClient();

const THUMB_SIZE = 128;
const UPLOADS_PREFIX = '/api/uploads/products/';

/** ترحيل لمرة واحدة: توليد مصغّرة WebP لكل صورة صنف مرفوعة قبل إضافة المصغّرات. */
async function main() {
  const products = await prisma.product.findMany({
    where: { imageUrl: { not: null }, thumbUrl: null },
    select: { id: true, name: true, imageUrl: true },
  });
  if (!products.length) {
    console.log('[thumbs] لا أصناف بحاجة لتوليد مصغّرة');
    return;
  }
  const dir = path.join(UPLOAD_DIR, 'products');
  let ok = 0, failed = 0;
  for (const p of products) {
    try {
      if (!p.imageUrl?.startsWith(UPLOADS_PREFIX)) continue;
      const src = path.join(dir, path.basename(p.imageUrl));
      if (!fs.existsSync(src)) {
        console.warn(`[thumbs] الملف مفقود: ${p.imageUrl} — (${p.name})`);
        continue;
      }
      const thumbName = `${p.id.slice(0, 8)}_${Date.now()}_t.webp`;
      const thumbPath = path.join(dir, thumbName);
      await sharp(src)
        .rotate()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', withoutEnlargement: true })
        .webp({ quality: 72 })
        .toFile(thumbPath);
      await prisma.product.update({
        where: { id: p.id },
        data: { thumbUrl: `/api/uploads/products/${thumbName}` },
      });
      ok++;
    } catch (e) {
      failed++;
      console.error(`[thumbs] فشل: (${p.name}) —`, (e as Error).message);
    }
  }
  console.log(`[thumbs] تم: ${ok}، أخفق: ${failed}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => void prisma.$disconnect());
