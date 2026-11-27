import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { credsAuthenticator } from '@nats-io/transport-node';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { ObserveInstrument } from './observe';

async function main() {
  for (const key of ['A_PUBLIC_KEY', 'B_PRIVATE_KEY', 'SUPABASE_URL', 'DATABASE_URL', 'NATS_B_CREDENTIALS_FILE']) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    instrument: ObserveInstrument,
    transport: Transport.NATS,
    options: {
      servers: [process.env.NATS_URL ?? 'nats://127.0.0.1:4222'],
      authenticator: credsAuthenticator(readFileSync(process.env.NATS_B_CREDENTIALS_FILE!)),
      queue: 'messaging-workers',
      gracefulShutdown: true,
    },
  });
  app.enableShutdownHooks();
  await app.listen();
  new Logger('WorkerBootstrap').log('service=messaging-service stage=ready transport=nats queue=messaging-workers');
}

void main();
