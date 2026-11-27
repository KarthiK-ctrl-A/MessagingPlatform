import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { assertServiceKeys, natsConnectionOptions, requiredEnv } from '@messaging/security';
import { AppModule } from './app.module';
import { ObserveInstrument } from './observe';

async function main() {
  for (const key of ['SUPABASE_URL', 'DATABASE_URL']) requiredEnv(key);
  assertServiceKeys('B_PRIVATE_KEY', 'A_PUBLIC_KEY');
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    instrument: ObserveInstrument,
    transport: Transport.NATS,
    options: {
      ...natsConnectionOptions('NATS_B_CREDENTIALS_FILE'),
      queue: 'messaging-workers',
      gracefulShutdown: true,
    },
  });
  app.enableShutdownHooks();
  await app.listen();
  new Logger('WorkerBootstrap').log('service=messaging-service stage=ready transport=nats queue=messaging-workers');
}

main().catch((error: unknown) => {
  new Logger('WorkerBootstrap').error(`service=messaging-service stage=startup_failed error=${error instanceof Error ? error.message : 'unknown'}`);
  process.exit(1);
});
