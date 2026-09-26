#!/usr/bin/env node
// Resolve where iCIMS postings actually are, so scan.mjs can decide about them.
//
//   node src/icims-locate.mjs              # resolve what is unresolved, write the cache
//   node src/icims-locate.mjs --dry        # report what it would fetch, write nothing
//   node src/icims-locate.mjs --limit 200  # cap the run
//
// Reads  the market feed (same source as scan.mjs), src/icims-locations.tsv
// Writes src/icims-locations.tsv            (tracked, append-only)
//
// THIS IS NOT A SCAN AND IT NEVER WRITES jobs.tsv. Decision 027 gives scan.mjs
// sole authorship of the ledger and that still holds: this pass writes a lookup,
// scan.mjs reads it and decides. Splitting it that way is what keeps `first_seen`
// meaningful and keeps scan network-light — otherwise the daily scan would grow a
// long request tail before it could append a single row.
//
// WHY IT EXISTS AT ALL. The feed collects iCIMS by sitemap, so every one of its
// postings carries the literal location "Not specified". classify() correctly
// drops all of them, and 17% of the market is invisible with no error. A
// posting's own page states its location in JSON-LD, so one fetch per posting
// settles it — permanently, which is the whole reason the answers are cached
// rather than recomputed.
//
// The cache is TRACKED, for decision 020's reason one step further on: rebuilding
// it costs thousands of requests to somebody else's servers, so keeping one copy
// is the difference between polite and not. A resolved posting
// is written once and never rewritten.
//
// Rows that resolve to another country are recorded as firmly as Canadian ones.
// That negative answer is the point — it is what stops the next run asking again.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARDS } from './listings.mjs';
import { isDesignTitle } from './reach.mjs';
import { keyOf } from './postings.mjs';
import { getText } from './readers.mjs';
import { iframeUrl, parsePosting, isCanadian, readLocations, robotsAllows, LOCATIONS_TSV, LOCATIONS_COLUMNS } from './icims.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const CACHE = LOCATIONS_TSV;
const COLUMNS = LOCATIONS_COLUMNS;

const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const DRY = process.argv.includes('--dry');
const LIMIT = Number(arg('--limit') || 0) || Infinity;
const PAUSE_MS = Number(arg('--pause') || 250);

const clean = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

// ── gather ─────────────────────────────────────────────────────────────────
const { jobs, error } = await BOARDS.jobdata();
if (error) { console.error(`feed: ${error}`); process.exit(1); }

const cache = readLocations();
const wanted = [];
const seen = new Set();
let design = 0, disallowed = 0;

for (const j of jobs) {
  if (!j.url || !j.title) continue;
  if (!/\.icims\.com$/i.test((() => { try { return new URL(j.url).hostname; } catch { return ''; } })())) continue;
  if (!isDesignTitle(j.title)) continue;
  design++;
  const k = keyOf(j.url);
  if (cache.has(k) || seen.has(k)) continue;
  seen.add(k);
  if (!robotsAllows(j.url)) { disallowed++; continue; }
  wanted.push({ key: k, url: j.url, title: j.title, company: j.company });
}

const todo = wanted.slice(0, LIMIT === Infinity ? wanted.length : LIMIT);

console.log(
  `${jobs.length} feed postings | ${design} icims design titles | ` +
  `${cache.size} already resolved | ${disallowed} skipped by robots.txt | ` +
  `${wanted.length} unresolved | ${todo.length} this run`,
);

if (DRY) {
  for (const w of todo.slice(0, 15)) console.log(`  would fetch  ${w.title.slice(0, 52).padEnd(54)} ${w.url.slice(0, 60)}`);
  if (todo.length > 15) console.log(`  … and ${todo.length - 15} more`);
  console.log('\ndry run, nothing written');
  process.exit(0);
}

if (!todo.length) { console.log('nothing to resolve'); process.exit(0); }

// ── resolve ────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const rows = [];
let canadian = 0, elsewhere = 0, failed = 0;

let gone = 0;

for (const w of todo) {
  const target = iframeUrl(w.url);
  const { data, error: e } = await getText(target);

  // 404 and 410 are the posting itself answering "I am not here". Unlike the
  // Dayforce case (026) this is NOT ambiguous: the URL is fully specified, with
  // no namespace or board id that could be wrong, so there is nothing else the
  // status could be about. Record it, because the alternative is re-asking a
  // dead posting every run for the 30 days it takes to age out of the feed.
  if (e && /^http 4(04|10)$/.test(e)) {
    gone++;
    rows.push([w.key, today, 'gone', '', 'no', clean(w.title)]);
    await new Promise(r => setTimeout(r, PAUSE_MS));
    continue;
  }

  // Anything else writes NOTHING and is retried next run. A timeout or a 5xx is
  // the network talking, and a row written as "no country" would be a permanent
  // wrong answer in a cache that exists so nothing gets asked twice.
  if (e || !data) { failed++; await new Promise(r => setTimeout(r, PAUSE_MS)); continue; }

  const post = parsePosting(data);
  if (!post) { failed++; await new Promise(r => setTimeout(r, PAUSE_MS)); continue; }

  if (isCanadian(post.country)) canadian++; else elsewhere++;
  rows.push([w.key, today, clean(post.country), clean(post.location), post.remote ? 'yes' : 'no', clean(post.title || w.title)]);
  await new Promise(r => setTimeout(r, PAUSE_MS));
}

if (!fs.existsSync(CACHE)) fs.writeFileSync(CACHE, COLUMNS.join('\t') + '\n', 'utf8');
if (rows.length) fs.appendFileSync(CACHE, rows.map(r => r.join('\t')).join('\n') + '\n', 'utf8');

console.log(
  `\nresolved ${rows.length} | ${canadian} canadian | ${elsewhere} elsewhere | ${gone} gone | ${failed} failed, will retry`,
);
console.log(`cache now ${cache.size + rows.length} rows at src/icims-locations.tsv`);
if (canadian) console.log('run `node src/scan.mjs` to let the Canadian ones into the ledger');
