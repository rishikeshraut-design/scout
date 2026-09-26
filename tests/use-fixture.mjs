// Imported first by every code test, before anything from src/: every script,
// and every child process a suite spawns, reads the fake data in tests/fixture/.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');
process.env.SCOUT_DATA = FIXTURE;
delete process.env.SCOUT_JOBS_TSV;
