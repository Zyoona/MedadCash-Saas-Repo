import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as express from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { UPLOAD_DIR } from './common/env.js';

// Load apps/api/.env explicitly: works both when cwd=apps/api (nest start)
// and when invoked from the repo root; root .env is NOT used.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), 'apps', 'api', '.env') });

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.setGlobalPrefix('api');
  app.enableCors();
  // رفع صور الأصناف يأتي كـ JSON (data URL) — حد كبير لمسار الرفع فقط، والافتراضي 100kb لبقية المسارات
  const imageUploadJson = express.json({ limit: '10mb' });
  const defaultJson = express.json({ limit: '100kb' });
  const isImageUpload = (req: express.Request) => req.method === 'POST' && /^\/api\/catalog\/products\/[^/]+\/image\/?$/.test(req.originalUrl);
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => (isImageUpload(req) ? imageUploadJson(req, res, next) : defaultJson(req, res, next)));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  // صور الأصناف المرفوعة — عامة (بدون توكن) لأن <img> لا يرسل Authorization
  try {
    fs.mkdirSync(path.join(UPLOAD_DIR, 'products'), { recursive: true });
    app.useStaticAssets(UPLOAD_DIR, { prefix: '/api/uploads' });
  } catch (e) {
    console.warn(`تعذر تهيئة مجلد رفع الصور (${UPLOAD_DIR}) — رفع وعرض الصور معطل`, e);
  }
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`medad-api listening on :${port}/api`);
}

void bootstrap();
