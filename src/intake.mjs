// The whole intake run, in one command (spec 001, decision 014).
//
//   node src/intake.mjs            # scan, then fetch the new posting bodies
//   node src/intake.mjs --dry      # dry-run the scan and the fetch, write nothing
//
// This CHAINS the two commands; it does not merge them. Decision 014 keeps
// fetching out of scan.mjs on purpose — the scan is the one thing here that
// runs unattended, and coupling the ledger write to a second network pass that
// can half-fail is how you end up with neither. Run sequentially, each step
// commits its own work before the next starts, so a fetch failure still leaves
// the scan's new rows safely in jobs.tsv.
//
// Order matters for a reason that is not obvious: postings close fast, so the
// gap between finding a posting and capturing its text is the window in which
// the text is lost. This
// command exists to make that gap as small as one process.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');

const steps = [
  { name: 'scan',  script: 'scan.mjs',           args: DRY ? ['--dry-run'] : [] },
  { name: 'fetch', script: 'fetch-postings.mjs', args: DRY ? ['--dry'] : [] },
  // Mining is not a step here: the duty bank is an occasional research tool, not
  // a pipeline stage. It regenerates on demand:
  //
  //   node src/mine-duties.mjs
  //
  // Intake keeps the two steps that DO earn their place — postings are
  // perishable, and this command exists to shrink the window in which the text
  // is lost.
];

for (const step of steps) {
  if (DRY && step.skipOnDry) {
    console.log(`\n── ${step.name} ── skipped (dry run writes nothing for it to read)`);
    continue;
  }

  console.log(`\n── ${step.name} ──`);
  const r = spawnSync(process.execPath, [path.join(SRC, step.script), ...step.args], { stdio: 'inherit' });

  if (r.error) {
    console.error(`\n${step.name} could not start: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    // Stop rather than continue. Mining a half-filled store would write a bank
    // that looks complete and is not, and a bank is the kind of artifact nobody
    // re-checks once it exists.
    console.error(`\n${step.name} exited ${r.status} — stopping. Earlier steps kept their work.`);
    process.exit(r.status ?? 1);
  }
}

console.log(DRY ? '\nintake dry run complete, nothing written' : '\nintake complete');
