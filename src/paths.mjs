// Where a user's data lives. SCOUT_DATA points every script at another folder;
// the tests set it to tests/fixture/ so they never touch the real files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC = path.dirname(fileURLToPath(import.meta.url));
export const DATA = process.env.SCOUT_DATA ? path.resolve(process.env.SCOUT_DATA) : SRC;

export const RESUME = path.join(DATA, 'resume.json');
export const CONTACT = path.join(DATA, 'contact.json');
export const DUTY_BANK = path.join(DATA, 'duty-bank.json');
export const STORE = path.join(DATA, 'postings');
export const BASELINES = path.join(DATA, 'baselines');
// jobs.tsv is the application record and has no second copy — a suite that
// snapshots and restores it loses the file on any crash mid-run.
export const JOBS = process.env.SCOUT_JOBS_TSV || path.join(DATA, 'jobs.tsv');

/** A baseline is BASELINES/<name>/selection.json. */
export const baselinePath = name => path.join(BASELINES, name, 'selection.json');

/** Every baseline name, found by listing the folder. */
export function listBaselines() {
  if (!fs.existsSync(BASELINES)) return [];
  return fs.readdirSync(BASELINES)
    .filter(name => fs.existsSync(baselinePath(name)))
    .sort();
}
