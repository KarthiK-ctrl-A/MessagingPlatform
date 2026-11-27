import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { assertServiceKeys, requiredEnv } from '@messaging/security';
import { AppModule } from './app.module';
import { ObserveInstrument } from './observe';
import { requestLogging } from './transport/http/request-logging';
import { trustProxySetting } from './transport/http/trust-proxy';

async function main() {
  // Fail at startup, not on the first user request, when signing material is missing.
  assertServiceKeys('A_PRIVATE_KEY', 'B_PUBLIC_KEY');
  const supabaseOrigin = new URL(requiredEnv('SUPABASE_URL')).origin;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { instrument: ObserveInstrument });
  app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));
  app.use(helmet({ contentSecurityPolicy: { directives: {
    connectSrc: ["'self'", supabaseOrigin],
    upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
  } } }));
  app.use(requestLogging);
  app.setGlobalPrefix('v1');
  app.useStaticAssets(join(__dirname, '..', '..', 'web'));
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  new Logger('GatewayBootstrap').log(`service=api-gateway stage=ready host=${host} port=${port}`);
}

main().catch((error: unknown) => {
  new Logger('GatewayBootstrap').error(`service=api-gateway stage=startup_failed error=${error instanceof Error ? error.message : 'unknown'}`);
  process.exit(1);
});
