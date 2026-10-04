import { config } from 'dotenv';
import { resolve } from 'node:path';

// Base dédiée aux tests (ghmt_test) : jamais la base de développement.
config({ path: resolve(__dirname, '../.env.test'), override: true, quiet: true });
