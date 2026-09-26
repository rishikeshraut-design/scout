// Fill the posting store from the ledger (spec 001, decision 014).
//
//   node src/fetch-postings.mjs             # fetch bodies missing from the store
//   node src/fetch-postings.mjs --dry       # report what it would fetch, write nothing
//   node src/fetch-postings.mjs --limit 25  # attempt at most 25 postings this run
//
// Reads  src/jobs.tsv       (the ledger; never written to here)
// Writes src/postings/*.json (tracked bodies, one per posting)
//
// Separate from scan.mjs on purpose: the daily scan's contract is "append new
// rows, fast", and it is the one thing here that runs unattended. A second
// network pass that can half-fail does not belong inside it.
//
// Boards are fetched once each and indexed by posting key, so twenty roles at
// one company cost one request, not twenty.
//
// Which reader handles a row is decided by its URL, not by its ledger `source`.
// The source names where the row was *found*, which is a different question:
// `BOARDS.jobdata` (decision 028) finds postings by the thousand and labels them
// all `jobdata:N`, while their URLs point at Greenhouse, Lever, Ashby and Workday
// boards this file already reads. `source` remains the fallback for rows whose
// URL no reader recognises.

import fs from 'node:fs';
import path from 'node:path';
import { keyOf, hasPosting, readPosting, writePosting, htmlToBlocks } from './postings.mjs';
import { READERS, providerFromUrl } from './readers.mjs';
import { JOBS } from './paths.mjs';

const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');

// Re-ask the board about postings ALREADY stored, to pick up fields captured
// later than they were (decision 030 added posted/closes/employment_type/
// department). Strictly additive and destructive of nothing:
//
//   - Tombstones are never touched. A tombstone may be the only record that a
//     posting existed, and the board will never answer for it again.
//   - A posting whose body was pasted with --text has no board to re-ask, so it
//     is skipped rather than lost.
//   - A miss during a refresh NEVER tombstones. The posting is already captured;
//     the board no longer listing it is expected on old rows, and replacing a
//     stored body with a tombstone would destroy the only copy.
//   - A failed fetch keeps the existing record untouched.
const REFRESH = process.argv.includes('--refresh');

// A posting budget, not a board budget: Workday asks per posting, so counting
// boards would badly under-price it. Whole boards are kept or skipped, never
// split, so the budget bounds the run without changing what a board fetch means.
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  if (i < 0) return Infinity;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--limit needs a positive integer, got: ${process.argv[i + 1]}`);
    process.exit(1);
  }
  return n;
})();

// ── run ────────────────────────────────────────────────────────────────────

if (!fs.existsSync(JOBS)) { console.error('no jobs.tsv — run src/scan.mjs first'); process.exit(1); }

const rows = fs.readFileSync(JOBS, 'utf8').split('\n').slice(1).filter(Boolean).map(l => l.split('\t'));
const wanted = [];
for (const r of rows) {
  const [, source, company, title, , , url] = r;
  if (!url) continue;
  const key = keyOf(url);
  if (hasPosting(key) && !REFRESH) continue;           // never re-fetch (spec R3)
  if (hasPosting(key)) {
    const prev = readPosting(key);
    if (prev.unavailable) continue;                    // a tombstone is final
    if (!prev.format) continue;                        // pasted with --text; no board to ask
  }

  // URL first, ledger source second. providerFromUrl returns the same
  // { provider, slug } pair the readers take as their argument — add-posting.mjs
  // already calls them that way.
  const byUrl = providerFromUrl(url);
  const board = byUrl && READERS[byUrl.provider]
    ? byUrl
    : { provider: (source || '').split(':')[0], slug: (source || '').split(':')[1] };

  wanted.push({
    key, url, source, company, title,
    provider: board.provider,
    arg: board.slug,
    board: `${board.provider}:${board.slug ?? ''}`,
  });
}

const unsupported = wanted.filter(w => !READERS[w.provider]);
const supported = wanted.filter(w => READERS[w.provider]);

// Group before the budget applies, so a board is never half-attempted.
const byBoard = new Map();
for (const w of supported) {
  if (!byBoard.has(w.board)) byBoard.set(w.board, []);
  byBoard.get(w.board).push(w);
}

const groups = [];
let budget = LIMIT, deferred = 0;
for (const [board, group] of byBoard) {
  if (group.length <= budget) { groups.push([board, group]); budget -= group.length; }
  else deferred += group.length;
}
const todo = groups.flatMap(([, g]) => g);

console.log(
  `${rows.length} ledger rows | ${rows.length - wanted.length} already stored | ` +
  `${todo.length} to fetch across ${groups.length} boards | ` +
  `${deferred} deferred by --limit | ${unsupported.length} unsupported`
);

if (DRY) {
  for (const [board, group] of groups) console.log(`  would fetch  ${board.padEnd(34)} ${group.length} posting(s)`);
  const byProvider = new Map();
  for (const w of unsupported) byProvider.set(w.provider, (byProvider.get(w.provider) || 0) + 1);
  for (const [p, n] of [...byProvider].sort((a, b) => b[1] - a[1])) {
    console.log(`  unsupported  ${String(p).padEnd(34)} ${n} posting(s)`);
  }
  console.log('\ndry run, nothing written');
  process.exit(0);
}

let stored = 0, missed = 0;
const failures = [];

for (const [board, group] of groups) {
  const { provider, arg } = group[0];
  const { map, error, soft } = await READERS[provider](arg, group);
  if (error) { failures.push(`${board}: ${error}`); missed += group.length; continue; }

  for (const w of group) {
    const hit = map.get(w.key);
    if (!hit && soft?.has(w.key)) {
      // Fetch failed for a reason unrelated to the posting still existing.
      // Leave no tombstone so the next run tries again.
      failures.push(`${board}: fetch failed, will retry — ${w.title}`);
      missed++;
      continue;
    }
    if (!hit && REFRESH && hasPosting(w.key)) {
      // Already captured, and the board no longer lists it. That is expected on
      // an old row and is NOT grounds to replace a stored body with a tombstone.
      missed++;
      continue;
    }
    if (!hit) {
      // The board answered and this posting was not on it: it is closed. Record
      // a tombstone so it is never retried.
      //
      // Only reachable when the board fetch itself succeeded. A network error
      // takes the `error` branch above and leaves no tombstone, because "the
      // request failed" is not evidence the posting is gone.
      writePosting(w.key, {
        key: w.key, url: w.url, source: w.source, company: w.company, title: w.title,
        fetched: new Date().toISOString().slice(0, 10),
        unavailable: true,
        reason: 'not listed on the board when fetched — posting closed or removed',
      });
      failures.push(`${board}: delisted, tombstoned — ${w.title}`);
      missed++;
      continue;
    }
    const blocks = htmlToBlocks(hit.body);
    const prev = hasPosting(w.key) ? readPosting(w.key) : {};
    writePosting(w.key, {
      ...prev,
      key: w.key,
      url: w.url,
      source: w.source,
      company: w.company,
      title: w.title,
      fetched: new Date().toISOString().slice(0, 10),
      // Straight from the ATS, so exact where the ledger's column is a proxy
      // (decision 030). Undefined stays undefined rather than becoming '' —
      // "the board did not say" and "the board said nothing" are the same
      // answer here, and an empty string in a stored record reads as a fact.
      ...(hit.posted ? { posted: hit.posted } : {}),
      ...(hit.closes ? { closes: hit.closes } : {}),
      ...(hit.employment_type ? { employment_type: hit.employment_type } : {}),
      ...(hit.department ? { department: hit.department } : {}),
      format: hit.format,
      // Blocks are stored alongside the body so mining never re-parses HTML, and
      // so a change to the parser is visible as a diff in a re-fetch.
      blocks,
      body: hit.body,
    });
    stored++;
  }
}

console.log(`\nstored ${stored} | missed ${missed}`);
for (const f of failures) console.log(`  ! ${f}`);
const unsupportedByProvider = new Map();
for (const w of unsupported) unsupportedByProvider.set(w.provider, (unsupportedByProvider.get(w.provider) || 0) + 1);
for (const [p, n] of [...unsupportedByProvider].sort((a, b) => b[1] - a[1])) {
  console.log(`  - no reader for "${p}" (${n} posting(s))`);
}
