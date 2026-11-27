import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]{1,39}$/.test(name)) {
  throw new Error('Usage: npm run service:new -- <lowercase-service-name>');
}
const root = process.cwd();
const directory = join(root, 'apps', name);
if (existsSync(directory)) throw new Error(`Service already exists: ${name}`);
const variable = `NATS_${name.toUpperCase().replaceAll('-', '_')}_CREDENTIALS_FILE`;
const write = (path, content) => {
  const target = join(directory, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
};
write('package.json', JSON.stringify({
  name: `@messaging/${name}`, private: true, version: '0.1.0', main: 'dist/main.js',
  scripts: { build: 'node ../../scripts/build-workspace.mjs', test: 'node ../../scripts/run-tests.mjs' },
  dependencies: {
    '@messaging/contracts': '0.1.0', '@messaging/security': '0.1.0',
    '@nestjs/common': '^12.0.1', '@nestjs/core': '^12.0.1',
    '@nestjs/microservices': '^12.0.1',
    'reflect-metadata': '^0.2.2', 'rxjs': '^7.8.1',
  },
}, null, 2) + '\n');
write('tsconfig.json', '{"extends":"../../tsconfig.base.json","compilerOptions":{"rootDir":"src","outDir":"dist"},"include":["src/**/*.ts"]}\n');
write('src/app.module.ts', `import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DenyAllGuard } from './security/deny-all.guard';

@Module({ providers: [{ provide: APP_GUARD, useClass: DenyAllGuard }] })
export class AppModule {}
`);
write('src/security/deny-all.guard.ts', `import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

// Replace with a verified signed-request guard before registering handlers.
@Injectable()
export class DenyAllGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    throw new RpcException({ code: 'UNAUTHENTICATED', message: 'Service not configured' });
  }
}
`);
write('src/main.ts', `import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { natsConnectionOptions } from '@messaging/security';
import { AppModule } from './app.module';

async function main() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.NATS,
    options: { ...natsConnectionOptions('${variable}'), queue: '${name}-workers', gracefulShutdown: true },
  });
  app.enableShutdownHooks();
  await app.listen();
  new Logger('WorkerBootstrap').log('service=${name} stage=ready transport=nats queue=${name}-workers');
}

main().catch((error) => { new Logger('WorkerBootstrap').error(String(error)); process.exit(1); });
`);
for (const path of ['src/application/.gitkeep', 'src/persistence/.gitkeep', 'src/transport/nats/.gitkeep']) write(path, '');
write('README.md', `# ${name}

Generated from the same NestJS NATS service layout as messaging-service. It has no handlers and a global deny-all guard until security is configured.

Before handling requests, define versioned subjects and strict envelopes in \`@messaging/contracts\`; grant only those subjects to a distinct NATS NKey/JWT identity; verify the gateway packet signature, audience, expiry, subject, user JWT, actor, and replay ID; sign replies; add tests. Add application logic and persistence only after the guard is wired. Add a Compose service without a public port and mount only this service's credentials. Then run \`npm install\`, \`npm run build\`, and \`npm test\`.

See \`SERVICE_CONVENTIONS.md\` at the repository root for the folder map and deployment checklist.
`);
console.log(`Created apps/${name} with a deny-all default. Run npm install to update the lockfile.`);
