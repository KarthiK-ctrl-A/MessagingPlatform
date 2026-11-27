import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ObserveInstrument } from './observe';
import helmet from 'helmet';
import { requestLogging } from './transport/http/request-logging';

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { instrument: ObserveInstrument });
  const supabaseOrigin = new URL(process.env.SUPABASE_URL ?? 'https://example.supabase.co').origin;
  app.use(helmet({ contentSecurityPolicy: { directives: {
    connectSrc: ["'self'", supabaseOrigin],
    upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
  } } }));
  app.use(requestLogging);
  app.setGlobalPrefix('v1');
  app.useStaticAssets(join(process.cwd(), 'apps/web'));
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  new Logger('GatewayBootstrap').log(`service=api-gateway stage=ready host=${host} port=${port}`);
}

void main();
