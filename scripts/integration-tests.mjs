import { spawnSync } from 'node:child_process';

// Runs the full test suite with the PostgreSQL integration tests enabled.
// TEST_DATABASE_URL must be a superuser URL for a disposable server: the tests
// create and drop their own database and the messaging_b_runtime role.
if (!process.env.TEST_DATABASE_URL) {
  console.error('Set TEST_DATABASE_URL to a disposable PostgreSQL superuser URL, e.g.\n' +
    '  docker run --rm -d -p 54329:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16\n' +
    '  TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/postgres npm run test:integration');
  process.exit(1);
}
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script through npm so npm_execpath is available');
const result = spawnSync(process.execPath, [npmCli, 'test'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
