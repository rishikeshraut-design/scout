#!/usr/bin/env node
// discover-boards.mjs — find companies worth watching, by sweeping the public
// per-ATS company directories instead of typing names in by hand.
//
//   node src/discover-boards.mjs --limit 200          # sample, propose, write nothing
//   node src/discover-boards.mjs --ats greenhouse     # one directory
//   node src/discover-boards.mjs --limit 500 --write  # append the hits to companies.tsv
//   node src/discover-boards.mjs --shuffle           # random sample — use this to ESTIMATE
//   node src/discover-boards.mjs --resume             # continue an interrupted sweep
//
// THIS IS A CENSUS, NOT A SCAN. It answers "which companies should Scout be
// watching?", once in a while. `scan.mjs` answers "what is new at the companies
// it watches", every day. Keeping them apart is the whole design: this writes
// candidate rows for `companies.tsv` and **never touches `jobs.tsv`**, so the
// ledger keeps one author and the first-seen guarantee is untouched.
//
// Why it exists: the public dataset lists tens of thousands of companies on
// Greenhouse, Lever, Ashby and Workday — all four already readable. The readers
// are not the gap. The address book is.
//
// Preview by default. `companies.tsv` is a curated file and a sweep proposing
// hundreds of rows into it unattended is how a curated file stops being one;
// --write is the opt-in, and it dedupes against what is already there.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ATS } from './listings.mjs';
import { classify, isDesignTitle } from './reach.mjs';
import { USER_AGENT } from './config.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const P = n => path.join(DIR, n);

// The dataset is a third party's repository, so nothing from it is trusted as a
// URL. Each entry is turned into a board id by `toEntry` and then checked to
// resolve to that ATS's OWN host — a tampered or simply wrong list can at worst
// name boards that do not exist, never point the scanner somewhere else.
const DATASET = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';

// Greenhouse, Lever and Ashby each serve their entire directory from ONE host,
// so concurrency here is sustained connections to a single API across thousands
// of boards. career-ops measured what that costs when it is too high: two sweeps
// an hour apart saw lever's unreachable count go 2,436 -> 4,100 and ashby's
// 683 -> 1,675, then recover after a cooldown with no change to the dataset. The
// boards were never dead. They were refused, and the matches on them were lost.
const CONCURRENCY = 4;
const TIMEOUT_MS = 20000;

// A refusing API fails every request in milliseconds, so a sweep that keeps going
// just feeds it. Stop after this many consecutive failures — high enough that a
// handful of genuinely dead boards cannot trip it.
const FAILURE_LIMIT = 40;

const CACHE_DIR = P('../scratch/discover-cache');
const CACHE_HOURS = 24;
const CHECKPOINT = P('../scratch/discover-checkpoint.json');
const CHECKPOINT_EVERY = 250;

export const SOURCES = {
  greenhouse: {
    dataset: 'greenhouse_companies.json',
    toEntry: slug => onHost(slug, `https://boards.greenhouse.io/${slug}`, 'boards.greenhouse.io'),
  },
  lever: {
    dataset: 'lever_companies.json',
    toEntry: slug => onHost(slug, `https://jobs.lever.co/${slug}`, 'jobs.lever.co'),
  },
  ashby: {
    dataset: 'ashby_companies.json',
    toEntry: slug => onHost(slug, `https://jobs.ashbyhq.com/${slug}`, 'jobs.ashbyhq.com'),
  },
};

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

// Strongest evidence first: a corridor role beats a named Canadian one, which
// beats a remote posting that named no country at all.
export const TIER_RANK = { local: 0, canada: 1, remote: 2 };

/** A readable guess at a company name. Never a fact — see the note at the call site. */
export const titleFromSlug = s => String(s || '').split(/[-_.]/).filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/** A dataset entry becomes a board only if it is a plausible slug on the right host. */
export function onHost(slug, url, host) {
  const s = String(slug || '').trim();
  if (!SLUG_RE.test(s)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  return u.hostname.toLowerCase() === host ? s : null;
}

// Everything below runs the sweep. Guarded so the helpers above can be imported
// and tested.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) { await main(); }

async function main() {

// ── args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const val = (n, d) => {
  const i = argv.indexOf(n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : d;
};

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

// --limit is per directory. Unbounded is 15,862 boards and hours of wall time, so
// it is not the default — measure the hit rate on a sample and decide.
const LIMIT = Number(val('--limit', 200));
const WRITE = flag('--write');
const RESUME = flag('--resume');
const ONLY = String(val('--ats', '')).split(',').map(s => s.trim()).filter(Boolean);
const SHUFFLE = flag('--shuffle');

if (SHUFFLE && RESUME) {
  console.error('--shuffle and --resume are incompatible: a reshuffled order cannot be continued.');
  process.exit(1);
}

if (!Number.isFinite(LIMIT) || LIMIT <= 0) {
  console.error('--limit must be a positive number');
  process.exit(1);
}

// ── dataset ────────────────────────────────────────────────────────────────
async function loadDataset(name, file) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, file);
  if (fs.existsSync(cached)) {
    const age = (Date.now() - fs.statSync(cached).mtimeMs) / 36e5;
    if (age < CACHE_HOURS) return JSON.parse(fs.readFileSync(cached, 'utf8'));
  }
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 60000);
  try {
    const r = await fetch(`${DATASET}/${file}`, { signal: c.signal, headers: { 'user-agent': USER_AGENT } });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const text = await r.text();
    JSON.parse(text);                       // fail here rather than half-writing a cache
    fs.writeFileSync(cached, text, 'utf8');
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

// ── sweep ──────────────────────────────────────────────────────────────────
const known = new Set(
  (fs.existsSync(P('companies.tsv')) ? fs.readFileSync(P('companies.tsv'), 'utf8').split('\n') : [])
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split('\t').slice(0, 2).join(':').toLowerCase()),
);

const hits = [];
const stats = {};
let consecutiveFailures = 0;
let aborted = false;

async function sweepOne(ats, slug) {
  const s = stats[ats];
  // A reader that throws or errors is a REFUSAL, never an empty board. Conflating
  // them is how career-ops silently lost 1,700 boards: the sweep recorded "no
  // matching jobs" for boards that had simply declined to answer.
  let r;
  try {
    r = await Promise.race([
      ATS[ats](slug, slug),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
    ]);
  } catch (e) {
    s.refused++; consecutiveFailures++; return;
  }
  if (r?.error) {
    // GONE and REFUSED are different answers and lumping them is the same mistake
    // this file exists to avoid, one layer up. A 404 means the dataset's slug is
    // stale — the company left the platform, which is expected in a third-party
    // list and costs nothing. A 429, a 5xx or a timeout means the board was never
    // asked properly, and every match on it was lost. Only the second kind is
    // evidence the sweep is going too fast, so only it trips the abort.
    if (/\b(404|410)\b/.test(r.error)) { s.gone++; consecutiveFailures = 0; return; }
    s.refused++; consecutiveFailures++;
    s.reasons[r.error] = (s.reasons[r.error] || 0) + 1;
    return;
  }

  consecutiveFailures = 0;
  const jobs = r.jobs || [];
  s.boards++;
  s.postings += jobs.length;
  if (!jobs.length) { s.empty++; return; }

  // Same two questions the daily scan asks, from the same module — a census that
  // used different filters would propose companies the scan then ignores.
  const matches = jobs.filter(j => j.title && j.url && isDesignTitle(j.title) && classify(j.location, j.remote));
  if (!matches.length) return;

  s.hits++;
  // The company NAME is a PLACEHOLDER and the report says so. Greenhouse, Lever
  // and Ashby all take the display name as an argument rather than returning one,
  // so the board cannot tell us what the company is called — `norm` just echoes
  // back the slug we passed in. Title-casing it is a readable guess, not a fact,
  // which is one of the reasons this command previews by default: the row a human
  // approves is the row that gets a real name.
  const company = titleFromSlug(slug);
  // Rank the tiers so the strongest evidence sorts first. A corridor role is a
  // reason to watch a company; a remote posting that names no country is the same
  // signal the daily scan accepts, and no stronger.
  const best = matches.map(m => ({ m, tier: classify(m.location, m.remote) }))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])[0];
  hits.push({
    ats, slug, company, count: matches.length,
    tier: best.tier, sample: best.m.title, location: best.m.location,
  });
}

function loadCheckpoint() {
  if (!RESUME || !fs.existsSync(CHECKPOINT)) return null;
  try {
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));
    // A checkpoint written under different settings must not be resumed — mixing
    // caps or directories silently changes what the run means.
    if (cp.version !== 1 || cp.limit !== LIMIT || String(cp.only) !== String(ONLY)) return null;
    if (cp.shuffle) return null;   // never resumable, see --shuffle
    if (!Number.isInteger(cp.done) || cp.done < 0) return null;
    return cp;
  } catch { return null; }
}

const cp = loadCheckpoint();
const targets = [];
for (const [ats, cfg] of Object.entries(SOURCES)) {
  if (ONLY.length && !ONLY.includes(ats)) continue;
  stats[ats] = { boards: 0, postings: 0, empty: 0, gone: 0, refused: 0, hits: 0, skipped: 0, invalid: 0, reasons: {} };
  let list;
  try {
    list = await loadDataset(ats, cfg.dataset);
  } catch (e) {
    console.error(`! ${ats}: dataset unavailable — ${e.message}`);
    continue;
  }
  // The datasets are alphabetical, so the first N is NOT a sample — it is every
  // company whose name starts with a digit or an "a". A hit rate measured that way
  // says nothing about the directory, and the whole point of --limit is to decide
  // whether the full sweep is worth it. --shuffle makes the estimate honest;
  // it is deliberately incompatible with --resume, because a reshuffled order
  // cannot be continued.
  let pool = (Array.isArray(list) ? list : []).slice();
  if (SHUFFLE) for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  let taken = 0;
  for (const raw of pool) {
    if (taken >= LIMIT) break;
    const slug = cfg.toEntry(raw);
    if (!slug) { stats[ats].invalid++; continue; }
    if (known.has(`${ats}:${slug}`.toLowerCase())) { stats[ats].skipped++; continue; }
    targets.push({ ats, slug });
    taken++;
  }
}

const startAt = cp ? cp.done : 0;
if (cp) console.error(`resuming at ${startAt} of ${targets.length}`);

let cursor = startAt;
let done = startAt;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < targets.length && !aborted) {
    const t = targets[cursor++];
    await sweepOne(t.ats, t.slug);
    done++;
    if (done % 25 === 0) process.stderr.write('.');
    if (done % CHECKPOINT_EVERY === 0) {
      fs.mkdirSync(path.dirname(CHECKPOINT), { recursive: true });
      fs.writeFileSync(CHECKPOINT, JSON.stringify({ version: 1, done, limit: LIMIT, only: ONLY, shuffle: SHUFFLE, hits }), 'utf8');
    }
    if (consecutiveFailures >= FAILURE_LIMIT) {
      aborted = true;
      console.error(`\n! ${FAILURE_LIMIT} consecutive failures — stopping. This is rate limiting, not ${FAILURE_LIMIT} dead boards.`);
      console.error(`! Wait, then \`--resume\`. Treating these as "no jobs" would silently drop every board after this point.`);
    }
  }
}));
process.stderr.write('\n');

// ── report ─────────────────────────────────────────────────────────────────
const swept = Object.values(stats).reduce((n, s) => n + s.boards + s.gone + s.refused, 0);
console.log(`\nswept ${swept} boards${aborted ? ' (ABORTED — partial)' : ''} | ${hits.length} with a live Canadian design role\n`);

for (const [ats, s] of Object.entries(stats)) {
  const rate = s.boards ? ((s.hits / s.boards) * 100).toFixed(1) : '0.0';
  console.log(`  ${ats.padEnd(11)} ${String(s.boards).padStart(5)} answered  ${String(s.hits).padStart(4)} hits (${rate}%)  ${String(s.empty).padStart(5)} empty  ${String(s.gone).padStart(5)} gone  ${String(s.refused).padStart(5)} REFUSED  ${String(s.skipped).padStart(4)} tracked`);
}

if (hits.length) {
  console.log('\ncandidate rows for companies.tsv — strongest evidence first.');
  console.log('The third column is a GUESS from the slug; fix the names you keep.\n');
  hits.sort((a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (b.count - a.count));
  for (const h of hits) {
    console.log(`  [${h.tier}] ${h.ats}\t${h.slug}\t${h.company}`);
    console.log(`      ${h.count} matching — e.g. ${String(h.sample).slice(0, 54)}${h.location ? `  (${String(h.location).slice(0, 34)})` : '  (no location given)'}`);
  }
  const weak = hits.filter(h => h.tier === 'remote').length;
  if (weak) console.log(`\n${weak} of these rest on a REMOTE posting that named no country — the same signal the daily scan takes, and no stronger.`);
}

const errored = Object.values(stats).reduce((n, s) => n + s.errors, 0);
if (errored) {
  console.log(`\n${errored} boards refused or timed out. They are NOT recorded as empty — re-run to reach them.`);
}

if (WRITE && hits.length && !aborted) {
  const rows = hits.map(h => `${h.ats}\t${h.slug}\t${h.company}`).join('\n');
  fs.appendFileSync(P('companies.tsv'), rows + '\n', 'utf8');
  console.log(`\nappended ${hits.length} rows to companies.tsv`);
  if (fs.existsSync(CHECKPOINT)) fs.unlinkSync(CHECKPOINT);
} else if (WRITE && aborted) {
  console.log('\n--write ignored: the sweep aborted, so its hit list is partial and its misses are unexplained.');
} else if (hits.length) {
  console.log('\npreview only — pass --write to append these to companies.tsv');
}

} // end main()
