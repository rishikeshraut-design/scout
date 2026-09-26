// Scout scanner. Zero dependencies, zero model calls, zero API keys.
//
//   node src/scan.mjs            # fetch, append new rows, print them
//   node src/scan.mjs --dry-run  # print what's new, write nothing
//
// Reads  src/companies.tsv  (ats \t slug \t name)  and  src/boards.tsv  (provider \t arg \t name)
// Writes src/jobs.tsv       (append-only; a posting arrives as status=new)
//        src/board-health.tsv (append-only; one row per source per run)
//
// Freshness comes from OUR first-seen ledger, never from a board's posted date.
// Reposts reset those dates and aggregator indexes lag by days; a URL we have
// not recorded before is new, and that is the only definition we trust.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyOf } from './postings.mjs';
import { classify, isDesignTitle } from './reach.mjs';
import { ATS, BOARDS } from './listings.mjs';
import { isCanadian, readLocations } from './icims.mjs';
import { JOBS } from './paths.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const P = n => path.join(DIR, n);

const CONCURRENCY = 6;

const DRY = process.argv.includes('--dry-run');

// ── tsv helpers ────────────────────────────────────────────────────────────
function readTsv(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.replace(/\r$/, ''))
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split('\t'));
}
const clean = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
// keyOf lives in postings.mjs — the ledger and the posting store have to
// agree on what "the same posting" is, and two copies of this drift (014).

const HEALTH = P('board-health.tsv');
// `posted` is the 13th column (decision 030). It is what the
// SCAN knew — the market feed's own first_seen, or a board listing's date field
// — and it is empty when the source carried none. The exact value lives in the
// posting store, written by the fetch straight from the ATS; a reader with both
// prefers that one. Rows appended before this column existed have 12 fields and
// read as unknown, which is the honest answer for them.
const COLUMNS = ['first_seen', 'source', 'company', 'title', 'location', 'reach', 'url', 'status', 'applied_date', 'outcome', 'outcome_date', 'notes', 'posted'];

// ── run ────────────────────────────────────────────────────────────────────
const companies = readTsv(P('companies.tsv'));
const boards = readTsv(P('boards.tsv'));

const tasks = [
  ...companies.map(([ats, slug, name]) => ({ kind: 'company', label: `${ats}:${slug}`, run: () => ATS[ats]?.(slug, name || slug) ?? Promise.resolve({ error: `unknown ats ${ats}` }) })),
  ...boards.map(([provider, arg, name]) => ({ kind: 'board', label: `${provider}${arg ? ':' + arg : ''}`, run: () => BOARDS[provider]?.(arg, name) ?? Promise.resolve({ error: `unknown provider ${provider}` }) })),
];

const results = [];
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < tasks.length) {
    const t = tasks[cursor++];
    const r = await t.run();
    results.push({ ...t, ...r });
    process.stderr.write(r.error ? '!' : '.');
  }
}));
process.stderr.write('\n');

// existing ledger
const existing = new Set(readTsv(JOBS).map(r => keyOf(r[6])));
const icimsLoc = readLocations();
const today = new Date().toISOString().slice(0, 10);

const fresh = [];
const seenThisRun = new Set();
let considered = 0;

for (const r of results) {
  for (const j of r.jobs || []) {
    if (!j.url || !j.title) continue;
    considered++;
    if (!isDesignTitle(j.title)) continue;
    const k = keyOf(j.url);

    // iCIMS arrives from the feed with the literal location "Not specified",
    // because the feed collects that platform by sitemap. Left alone it is
    // dropped here, silently, for 17% of the market. icims-locations.tsv is the
    // resolved answer, written by icims-locate.mjs from the posting's own
    // JSON-LD; a row missing from it is simply not resolved yet and waits for
    // the next locate pass rather than being guessed at.
    //
    // The COUNTRY field admits the row, never the location string. A posting in
    // this dataset reads "ONTARIO, CA" meaning California, and classify() would
    // match `ontario` by name and call it Canadian. See src/icims.mjs.
    const resolved = icimsLoc.get(k);
    let location = j.location, remote = j.remote;
    if (resolved) {
      if (!isCanadian(resolved.country)) continue;
      location = resolved.location;
      remote = remote || resolved.remote;
    }

    const reach = classify(location, remote);
    if (!reach) continue;
    if (existing.has(k) || seenThisRun.has(k)) continue;
    seenThisRun.add(k);
    fresh.push([today, r.label, clean(j.company), clean(j.title), clean(location), reach, j.url, 'new', '', '', '', '', j.posted || '']);
  }
}

// ── write ──────────────────────────────────────────────────────────────────
if (!DRY) {
  if (!fs.existsSync(JOBS)) fs.writeFileSync(JOBS, COLUMNS.join('\t') + '\n', 'utf8');
  if (fresh.length) fs.appendFileSync(JOBS, fresh.map(r => r.join('\t')).join('\n') + '\n', 'utf8');
  const health = results.map(r => [today, r.label, r.error ? 'error' : (r.jobs.length ? 'ok' : 'empty'), r.error || r.jobs.length].join('\t'));
  fs.appendFileSync(HEALTH, health.join('\n') + '\n', 'utf8');
}

// ── report ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => r.error);
const empty = results.filter(r => !r.error && !r.jobs.length);
console.log(`\n${tasks.length} sources | ${considered} postings seen | ${fresh.length} new design roles in reach${DRY ? '  (dry run, nothing written)' : ''}\n`);

for (const tier of ['local', 'canada', 'remote']) {
  const rows = fresh.filter(r => r[5] === tier);
  if (!rows.length) continue;
  console.log(`── ${tier} (${rows.length}) ──`);
  for (const r of rows.sort((a, b) => a[2].localeCompare(b[2]))) {
    console.log(`  ${r[2].padEnd(22).slice(0, 22)}  ${r[3].padEnd(46).slice(0, 46)}  ${r[4].slice(0, 30)}`);
    console.log(`  ${' '.repeat(22)}  ${r[6]}`);
  }
  console.log('');
}

if (failed.length) console.log(`unreachable (${failed.length}): ` + failed.map(r => `${r.label}[${r.error}]`).join(', '));
if (empty.length) console.log(`no postings (${empty.length}): ` + empty.map(r => r.label).join(', '));
