import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

// Load apps/api/.env explicitly: works both when cwd=apps/api (nest start)
// and when invoked from the repo root; root .env is NOT used.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), 'apps', 'api', '.env') });

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`medad-api listening on :${port}/api`);
}

void bootstrap();
