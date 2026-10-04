import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from 'dotenv';

/** Applique les migrations et le catalogue de permissions sur la base de test avant la suite. */
export default function setup(): void {
  const cwd = resolve(__dirname, '..');
  const env = { ...process.env, ...config({ path: resolve(cwd, '.env.test'), quiet: true }).parsed };
  execFileSync(resolve(cwd, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], { cwd, env, stdio: 'ignore' });
  execFileSync(process.execPath, ['prisma/seed.mts'], { cwd, env, stdio: 'ignore' });
}
