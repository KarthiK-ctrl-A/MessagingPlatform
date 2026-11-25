import { generateKeyPairSync } from 'node:crypto';

for (const service of ['A', 'B']) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  process.stdout.write(`${service}_PRIVATE_KEY=${privateDer.toString('base64')}\n`);
  process.stdout.write(`${service}_PUBLIC_KEY=${publicDer.toString('base64')}\n`);
}
