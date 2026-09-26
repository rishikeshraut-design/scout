// One-off: fill the ledger's `posted` column for rows appended before it existed
// (decision 030).
//
//   node src/backfill-dates.mjs --dry     # report, write nothing
//   node src/backfill-dates.mjs           # rewrite jobs.tsv in place
//
// The market feed carries `first_seen` per posting, within about a day of the
// ATS's own `startDate`. Rows found through the feed can therefore be dated
// without a single extra request — which matters most for the rows Scout can
// never fetch.
//
// This REWRITES jobs.tsv, the one file with no second copy, and it is the only
// script here that does. Three guards, all before anything is written: the row
// count must be unchanged, the set of URLs must be identical, and a backup is
// written alongside. Git holds the committed copy as the real safety net.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { JOBS, STORE } from './paths.mjs';
import { USER_AGENT as UA } from './config.mjs';

const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const BASE = 'https://raw.githubusercontent.com/Feashliaa/job-board-data/main/data';
const POSTED = 12;

const day = v => {
  if (!v) return '';
  const d = new Date(String(v));
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
};

const lines = fs.readFileSync(JOBS, 'utf8').split('\n');
const header = lines[0].split('\t');
const rows = lines.slice(1).filter(Boolean).map(l => l.split('\t'));
if (header.length <= POSTED) header.push('posted');

// The store is the better source wherever it exists: that value came straight
// from the ATS, while the feed's is a proxy good to about a day.
const fromStore = new Map();
if (fs.existsSync(STORE)) {
  for (const f of fs.readdirSync(STORE)) {
    const j = JSON.parse(fs.readFileSync(path.join(STORE, f), 'utf8'));
    if (j.url && j.posted) fromStore.set(j.url, j.posted);
  }
}

const want = new Set(rows.filter(r => r[6] && !r[POSTED]).map(r => r[6]));
console.log(`${rows.length} ledger rows | ${rows.length - want.size} already dated | ${want.size} to fill`);
console.log(`  ${[...want].filter(u => fromStore.has(u)).length} answerable from the posting store`);

const fromFeed = new Map();
if (want.size) {
  process.stderr.write('  reading the market feed ');
  for (let n = 0; ; n++) {
    const r = await fetch(`${BASE}/chunks/jobs_chunk_${n}.json.gz`, { headers: { 'user-agent': UA } });
    if (r.status === 404) break;                 // the end of the list; the count is not published
    if (!r.ok) { console.error(`\nchunk ${n}: http ${r.status} - refusing a partial backfill`); process.exit(1); }
    const arr = JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
    for (const j of Array.isArray(arr) ? arr : []) {
      if (j && j.url && want.has(j.url) && j.first_seen) fromFeed.set(j.url, day(j.first_seen));
    }
    process.stderr.write('.');
  }
  process.stderr.write('\n');
}

let filled = 0;
for (const r of rows) {
  while (r.length <= POSTED) r.push('');
  if (r[POSTED] || !r[6]) continue;
  const v = fromStore.get(r[6]) || fromFeed.get(r[6]) || '';
  if (v) { r[POSTED] = v; filled++; }
}

console.log(`\nfilled ${filled} | still unknown ${rows.filter(r => !r[POSTED]).length}`);
if (DRY) { console.log('\ndry run, nothing written'); process.exit(0); }

// Guards. This file is the application record and it is being rewritten.
const before = fs.readFileSync(JOBS, 'utf8').split('\n').slice(1).filter(Boolean).map(l => l.split('\t'));
if (before.length !== rows.length) { console.error('row count changed - refusing to write'); process.exit(1); }
if (before.map(r => r[6]).join(' ') !== rows.map(r => r[6]).join(' ')) {
  console.error('the set of URLs changed - refusing to write'); process.exit(1);
}

fs.copyFileSync(JOBS, JOBS + '.bak');
fs.writeFileSync(JOBS, [header.join('\t'), ...rows.map(r => r.join('\t'))].join('\n') + '\n', 'utf8');
console.log('wrote jobs.tsv (backup at jobs.tsv.bak)');
