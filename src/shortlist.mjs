// Triage the ledger into a shortlist (spec 006).
//
//   node src/shortlist.mjs          # write out/shortlist/
//   node src/shortlist.mjs --dry    # print the drop report, write nothing
//
// Reads  src/jobs.tsv, src/postings/    (never writes either)
// Writes out/shortlist/                 (gitignored, regenerated whole)
//
// THIS IS TRIAGE, NEVER A VERDICT. It answers "is this worth looking at" —
// location, discipline, liveness, years. Whether the corpus can actually prove
// a fit is coverage.mjs's question, and the moment this file starts deciding
// that it is doing coverage's job with no corpus to check against.
//
// Why it exists at all, since coverage.mjs already judges fit: coverage ships
// 47KB of JSON per posting on purpose, so the ledger would be ~58MB through a
// model, and it NEVER READS LOCATION — a perfect-fit role in Austin scores as
// covered, and a posting delisted three weeks ago gets assessed anyway.
//
// Nothing here is incremental. The whole list is rebuilt from the whole ledger
// every run, which costs milliseconds and picks up a corrected rule, a body
// that arrived overnight, and a posting tombstoned since yesterday. An
// incremental pass would carry yesterday's mistakes forward indefinitely.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyOf, listPostings } from './postings.mjs';
import { classify, maybeCorridor } from './reach.mjs';
import { OUT_OF_SCOPE, IN_SCOPE } from './config.mjs';
import { JOBS } from './paths.mjs';

export { OUT_OF_SCOPE, IN_SCOPE };

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SRC);
const OUT = path.join(ROOT, 'out', 'shortlist');

// ── the rules ──────────────────────────────────────────────────────────────

/** Above senior. `lead`, `staff`, `principal`, `senior` all stay — still designer work. */
export const ABOVE_SENIOR = /\b(director|vp|vice president|head of|chief)\b/i;

/**
 * Below the target band. Decision 004 targets junior and mid; an internship is a
 * step backwards, not the bottom of that range.
 *
 * The word boundary on `intern` is load-bearing: without it this eats "Internal
 * Communications Designer" and "International Brand Designer".
 */
export const BELOW_TARGET = /\b(intern|interns|internship|co-op|coop|new grad|new graduate|graduate program|apprentice|placement student|work term|early talent|campus recruit)\b|\(\d{1,2}\s*-\s*\d{1,2}\s*months?\)/i;

/**
 * Boards that only ever carry student and co-op postings. Excluding by URL is
 * unusual here and earns its place: a whole board that is out of band is a
 * cleaner signal than any phrasing its titles happen to use.
 */
export const STUDENT_BOARD = /earlytalent|early-talent|students?|campus|newgrad|new-grad|university/i;

/** Remote that names Canada is reachable; remote naming nothing is not. */
export const REMOTE_CANADA = /\b(canada|canadian|\bcan\b|ontario|toronto|america|americas|north america|est\b|eastern time)\b/i;

// Two patterns, because a range states its minimum on the LEFT and the bare
// pattern only ever sees the number touching the word "years". "3-5 years of
// experience" reads as 5 under the bare pattern alone, which is the wrong end
// of the range and the wrong answer for a minimum requirement.
const YEARS_RANGE = /(\d{1,2})\s*(?:-|–|—|to)\s*\d{1,2}\s*\+?\s*years?/gi;
const YEARS_BARE = /(\d{1,2})\s*\+?\s*years?/gi;
export const MAX_YEARS = 7;

/**
 * The LOWEST years figure a posting names, or null.
 *
 * Never the first. Postings routinely name two bands — "8+ for Staff, 3+ for
 * the role" — and the first match is whichever sits higher on the page.
 */
export function lowestYears(text) {
  const s = String(text ?? '');
  const nums = [...s.matchAll(YEARS_RANGE), ...s.matchAll(YEARS_BARE)]
    .map(m => Number(m[1]))
    .filter(n => n > 0 && n < 31);
  return nums.length ? Math.min(...nums) : null;
}

export const daysBetween = (from, to) =>
  Math.max(0, Math.round((new Date(to) - new Date(from)) / 86400000));

// Staleness bands (decision 030). Nothing is DROPPED on age — it is inferred
// from a third party's index in most cases, and dropping is the only
// irreversible move here. A 40-day-old posting can still be open; it just must
// not sit above one posted yesterday.
export const FRESH_DAYS = 14;      // eligible for tier 1
export const STALE_DAYS = 35;      // beyond this, tier 3

/** How a posting's age reads: 'fresh' | 'aging' | 'stale' | 'unknown'. */
export const ageBand = days => {
  if (days === null || days === undefined) return 'unknown';
  if (days <= FRESH_DAYS) return 'fresh';
  if (days <= STALE_DAYS) return 'aging';
  return 'stale';
};

/**
 * Which tier a surviving row belongs in.
 *
 * Tier 3 means "look at this yourself" and NEVER means rejected. Only the
 * mechanical removals and the years rule remove a row at all.
 *
 * The two distinctions that matter, because collapsing either buries good work:
 *   - No body and "a body naming no years" are different answers. The second is
 *     no barrier stated, not uncertainty, and they belong in tier 1.
 *   - reach=remote is the dirty bucket: classify() returns it when a posting
 *     says "Remote" and names no place at all, and the US-only exclusion only
 *     catches postings that literally say so, which almost none do.
 */
export function tierOf({ reach, years, hasBody, location, posted_age }) {
  if (!reach) return 3;                                   // added by hand; scan never classified it
  if (reach === 'remote' && !REMOTE_CANADA.test(location || '')) return 3;

  // Staleness outranks everything below it. A posting nobody can still apply to
  // is not "optimistic", whatever its location and years say (decision 030).
  const band = ageBand(posted_age);
  if (band === 'unknown' || band === 'stale') return 3;   // cannot tell, or too late

  if (reach === 'remote') return 2;                       // remote naming Canada
  if (band === 'aging') return 2;                         // 22-35 days: worth a try
  if (!hasBody) return 2;                                 // location settled, years unknown
  if (years !== null && years > 5) return 2;              // 6-7; above 7 was dropped
  return 1;                                               // fresh, in reach, no barrier stated
}

// ── the pass ───────────────────────────────────────────────────────────────

export function shortlist({ jobsPath = JOBS, today = new Date().toISOString().slice(0, 10) } = {}) {
  const raw = fs.readFileSync(jobsPath, 'utf8').split('\n');
  const rows = raw.slice(1).filter(Boolean).map(l => l.split('\t'));

  const dead = new Set();
  const bodies = new Map();
  for (const p of listPostings({ all: true })) {
    if (p.unavailable) dead.add(keyOf(p.url));
    else bodies.set(keyOf(p.url), p);
  }

  // Every rule reports what it removed. Not optional: a filter drops things
  // invisibly, which is this project's most expensive failure shape.
  // Applied rows leave the pipeline FIRST, before any filter can touch them.
  // Taking them out here rather than at the end is the whole
  // point: a job you applied to and that was later delisted, or that a
  // discipline rule would now exclude, still belongs in your own record. Every
  // filter below exists to answer "is this worth looking at", and that question
  // is already settled for these.
  //
  // This does NOT make the shortlist a verdict (030). Removing a row you have
  // already sent is a fact about the ledger, not a judgment about fit.
  const isApplied = r => (r[7] || '').trim() && (r[7] || '').trim() !== 'new';
  const appliedRows = rows.filter(isApplied);
  const open = rows.filter(r => !isApplied(r));

  const report = [{ label: 'ledger, everything', n: rows.length }];
  const step = (label, arr) => { report.push({ label, n: arr.length, dropped: report[report.length - 1].n - arr.length }); return arr; };
  step('minus already applied', open);

  // Layer 1 — mechanical. It cannot be wrong, so it runs first and the later
  // drop counts describe real candidates rather than corpses.
  const alive = step('minus known-dead', open.filter(r => !dead.has(keyOf(r[6]))));

  // There is NO company|title dedupe, on purpose (038): keeping one copy of a
  // role hides the others. Every copy stays; a role on two hosts shows twice,
  // and a visible duplicate costs a glance where a hidden posting costs an
  // application.

  // Layer 2 — discipline, title, seniority, years.
  const T = r => r[3] || '';
  const inDiscipline = step('minus wrong disciplines', alive.filter(r => !OUT_OF_SCOPE.test(T(r))));
  const notLeadership = step('minus above-senior', inDiscipline.filter(r => !ABOVE_SENIOR.test(T(r))));
  const notJunior = step('minus intern, co-op and student boards',
    notLeadership.filter(r => !BELOW_TARGET.test(T(r)) && !STUDENT_BOARD.test(r[6] || '')));
  const inScope = step('minus titles outside scope', notJunior.filter(r => IN_SCOPE.test(T(r))));

  const enriched = inScope.map(r => {
    const key = keyOf(r[6]);
    const body = bodies.get(key);
    const text = body ? ((body.blocks || []).map(b => b.text).join(' ') || body.body || '') : '';

    // Re-check reach through classify() rather than trusting the ledger's column.
    // That column was written at scan time by whatever the classifier said THEN,
    // and a fix to it otherwise only reaches rows scanned afterwards. Recomputing
    // means a corrected rule improves the shortlist immediately, with no rescan
    // and no second classifier — spec 003 R2 forbids a second one, and this calls
    // the same exported function scan.mjs does.
    //
    // The ledger's value is kept as the fallback: the scanner had a remote flag
    // from the board that the location string may not carry, so an empty recompute
    // on a row the scanner called remote should not silently downgrade it.
    // A bare "Cambridge" or "Hamilton" names a real corridor city 100km from
    // Toronto and also names one in Massachusetts, and nothing in the string
    // settles it. classify() correctly refuses to guess, but discarding the row
    // is the one irreversible move here — so an unsettled corridor city keeps an
    // empty reach and lands in tier 3, where a human looks. "Cambridge, MA" is
    // settled and is dropped normally.
    const recomputed = classify(r[4], r[5] === 'remote');
    const unsettled = !recomputed && maybeCorridor(r[4]);

    // Take the LATER of the two dates, and keep both.
    //
    // Neither is authoritative and they mean different things. The ATS field is
    // a lower bound on when the posting EXISTED — Lever exposes only
    // `createdAt`, which is when the requisition record was made and never moves
    // on a repost. The feed's is a lower bound on when it became VISIBLE. The
    // feed can never predate the ATS, so the later value is the best estimate of
    // "recently active", and it is the only one that cannot make a live posting
    // look dead.
    const atsPosted = (body && body.posted) || '';
    const feedPosted = r[12] || '';
    const posted = (atsPosted > feedPosted ? atsPosted : feedPosted) || '';
    return {
      first_seen: r[0], company: r[2], title: r[3], location: r[4], url: r[6],
      reach: recomputed ?? (r[5] === 'remote' ? 'remote' : ''),
      unsettled,
      posted,
      posted_ats: atsPosted,
      posted_feed: feedPosted,
      // A wide gap means the requisition predates its publication by a long way
      // — usually a repost. Worth surfacing rather than smoothing over.
      posted_gap: atsPosted && feedPosted ? daysBetween(atsPosted, feedPosted) : null,
      posted_age: posted ? daysBetween(posted, today) : null,
      listed_age: r[0] ? daysBetween(r[0], today) : null,
      employment_type: (body && body.employment_type) || '',
      closes: (body && body.closes) || '',
      years: body ? lowestYears(text) : null,
      hasBody: !!body,
    };
  });

  // A row the classifier no longer places is out of reach — the same answer
  // scan.mjs would have given it today. Reported, never silent.
  const reachable = step('minus out of reach (re-checked)', enriched.filter(j => j.reach || j.unsettled));
  const kept = step(`minus years above ${MAX_YEARS}`, reachable.filter(j => j.years === null || j.years <= MAX_YEARS));

  for (const j of kept) j.tier = tierOf(j);
  // Freshness band, then reach, then most recently posted (decision 030).
  //
  // Banding by freshness first: location decides between two postings that are
  // both still live, and never promotes one that probably is not. A stale local
  // role cannot outrank a fresh one; a fresh local role still beats a fresh
  // remote one.
  const REACH_ORDER = { local: 0, canada: 1, remote: 2, '': 3 };
  const BAND_ORDER = { fresh: 0, aging: 1, stale: 2, unknown: 3 };
  kept.sort((a, b) =>
    BAND_ORDER[ageBand(a.posted_age)] - BAND_ORDER[ageBand(b.posted_age)] ||
    (REACH_ORDER[a.reach] ?? 3) - (REACH_ORDER[b.reach] ?? 3) ||
    String(b.posted || '').localeCompare(String(a.posted || '')) ||
    String(a.company).localeCompare(String(b.company)));

  // The applied record. Deliberately thin: this reads the four ledger columns
  // that only the user ever writes (022) and computes nothing about fit. `days`
  // is the turnaround — send to outcome, or send to today while it is still open.
  const applied = appliedRows.map(r => {
    const body = bodies.get(keyOf(r[6]));
    const appliedDate = r[8] || '';
    const outcomeDate = r[10] || '';
    return {
      company: r[2], title: r[3], location: r[4], url: r[6],
      status: r[7] || '', applied_date: appliedDate,
      outcome: r[9] || '', outcome_date: outcomeDate,
      days: appliedDate ? daysBetween(appliedDate, outcomeDate || today) : null,
      open: !r[9],
      posted: (body && body.posted) || r[12] || '',
      notes: r[11] || '',
    };
  }).sort((a, b) => String(b.applied_date || '').localeCompare(String(a.applied_date || '')));

  return { report, jobs: kept, applied, today };
}

export const buildCommand = j => `/build-resume ${j.company} | ${j.title} | ${j.url}`;

// ── output ─────────────────────────────────────────────────────────────────

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(jobs) {
  const head = ['posted', 'posted_age_days', 'listed_age_days', 'company', 'title', 'location',
    'reach', 'years', 'employment_type', 'closes', 'url', 'build_command'];
  const lines = [head.join(',')];
  for (const j of jobs) {
    lines.push([
      j.posted || '', j.posted_age ?? '', j.listed_age ?? '', j.company, j.title, j.location,
      j.reach, j.years ?? '', j.employment_type || '', j.closes || '', j.url, buildCommand(j),
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** The applied record as CSV. No build_command — these are sent, not candidates. */
export function toAppliedCsv(applied) {
  const head = ['applied_date', 'company', 'title', 'location', 'status', 'outcome',
    'outcome_date', 'days', 'posted', 'url', 'notes'];
  const lines = [head.join(',')];
  for (const a of applied) {
    lines.push([
      a.applied_date || '', a.company, a.title, a.location, a.status, a.outcome || '',
      a.outcome_date || '', a.days ?? '', a.posted || '', a.url, a.notes || '',
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TIER_LABEL = {
  1: 'Definite — apply',
  2: 'Optimistic — worth a try',
  3: 'Review — needs your eyes',
  applied: 'Applied',
};

export function toHtml({ jobs, applied = [], today }) {
  // No inline job description. The stored body is blocks joined with spaces, so
  // it renders as one unbroken wall of text. Making it readable means
  // re-deriving the posting's structure here, which is a second renderer for a
  // surface the board already does better. The title is a link. (decision 030)
  const rowsFor = tier => jobs.filter(j => j.tier === tier).map(j => `
    <tr class="job" data-url="${esc(j.url)}">
      <td class="age ${ageBand(j.posted_age)}">${j.posted_age === null ? '?' : j.posted_age + 'd'}</td>
      <td class="listed">${j.listed_age === null ? '&mdash;' : j.listed_age + 'd'}${j.listed_age !== null && j.listed_age <= 2 ? '<span class="new">new</span>' : ''}</td>
      <td class="co">${esc(j.company)}</td>
      <td class="ti"><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></td>
      <td class="lo">${esc(j.location) || '<span class="dim">&mdash;</span>'}</td>
      <td class="yr">${j.years === null ? '<span class="dim">&mdash;</span>' : esc(j.years)}</td>
      <td class="et">${esc(j.employment_type) || '<span class="dim">&mdash;</span>'}</td>
      <td class="ac">
        <button class="copy" data-cmd="${esc(buildCommand(j))}">copy</button>
        <button class="dismiss">dismiss</button>
      </td>
    </tr>`).join('');

  const counts = [1, 2, 3].map(t => jobs.filter(j => j.tier === t).length);

  // The applied tab. No dismiss and no copy button — these are not candidates,
  // and the only mutable thing about them is a status only the user writes (022).
  const appliedRows = applied.map(a => `
    <tr>
      <td class="age">${esc(a.applied_date) || '<span class="dim">&mdash;</span>'}</td>
      <td class="co">${esc(a.company)}</td>
      <td class="ti"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></td>
      <td class="lo">${esc(a.location) || '<span class="dim">&mdash;</span>'}</td>
      <td><span class="pill ${a.outcome ? esc(a.outcome).toLowerCase().replace(/[^a-z]/g, '') : 'open'}">${esc(a.outcome || a.status)}</span></td>
      <td class="age">${esc(a.outcome_date) || (a.open ? '<span class="dim">waiting</span>' : '<span class="dim">&mdash;</span>')}</td>
      <td class="yr">${a.days === null ? '<span class="dim">&mdash;</span>' : a.days + 'd'}</td>
    </tr>`).join('');

  return `<!doctype html>
<meta charset="utf-8">
<title>Scout shortlist — ${esc(today)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#777; --line:#e3e3e3; --accent:#1a5fb4; --newbg:#d7f5dd; --newfg:#0a5c27; --rejbg:#fbe0e0; --rejfg:#8a1f1f; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --fg:#e8e8e8; --dim:#8b8b8b; --line:#2c2f36; --accent:#7cb0ee; --newbg:#153d22; --newfg:#7fe0a0; --rejbg:#3d1717; --rejfg:#f0a0a0; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; }
  .meta { color:var(--dim); margin-bottom:18px; }
  .tabs { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px; }
  .tabs button { font:inherit; padding:7px 13px; border:1px solid var(--line); border-radius:7px;
                 background:transparent; color:var(--fg); cursor:pointer; }
  .tabs button[aria-selected="true"] { background:var(--accent); border-color:var(--accent); color:#fff; }
  table { border-collapse:collapse; width:100%; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  a { color:var(--accent); }
  .age { white-space:nowrap; color:var(--dim); }
  .new { background:var(--newbg); color:var(--newfg); border-radius:4px; padding:1px 5px; margin-left:6px; font-size:11px; }
  .dim { color:var(--dim); }
  .ac { white-space:nowrap; }
  .ac button { font:inherit; font-size:12px; padding:3px 8px; margin-right:4px; cursor:pointer;
               border:1px solid var(--line); border-radius:5px; background:transparent; color:var(--fg); }
  .age.fresh { color:var(--newfg); font-weight:600; }
  .age.aging { color:var(--fg); }
  .age.stale, .age.unknown { color:var(--dim); }
  .listed { white-space:nowrap; color:var(--dim); }
  .hidden { display:none; }
  .empty { color:var(--dim); padding:22px 0; }
  .note { color:var(--dim); font-size:12px; margin-top:14px; max-width:76ch; }
  .tabs button.applied-tab { margin-left:auto; }
  .pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:12px;
          border:1px solid var(--line); text-transform:capitalize; }
  .pill.open, .pill.applied { background:var(--newbg); color:var(--newfg); border-color:transparent; }
  .pill.rejected { background:var(--rejbg); color:var(--rejfg); border-color:transparent; }
  footer { margin-top:26px; color:var(--dim); font-size:12px; }
</style>
<h1>Scout shortlist</h1>
<div class="meta">${esc(today)} · ${jobs.length} roles · corridor first, then most recently posted ·
  <a href="#" id="restore">restore dismissed</a></div>
<div class="tabs">
  ${[1, 2, 3].map(t => `<button data-tier="${t}" aria-selected="${t === 1}">${TIER_LABEL[t]} (${counts[t - 1]})</button>`).join('')}
  <button data-tier="applied" aria-selected="false" class="applied-tab">${TIER_LABEL.applied} (${applied.length})</button>
</div>
${[1, 2, 3].map(t => `
<div class="pane${t === 1 ? '' : ' hidden'}" data-pane="${t}">
  ${counts[t - 1] ? `<table>
    <thead><tr><th title="days since the board posted it">Posted</th><th title="days since Scout first listed it">Listed</th><th>Company</th><th>Title</th><th>Location</th><th>Yrs</th><th>Type</th><th></th></tr></thead>
    <tbody>${rowsFor(t)}</tbody>
  </table>` : '<p class="empty">Nothing in this tier.</p>'}
</div>`).join('')}
<div class="pane hidden" data-pane="applied">
  ${applied.length ? `<table>
    <thead><tr><th>Applied</th><th>Company</th><th>Title</th><th>Location</th><th>Status</th><th>Heard back</th><th title="applied to outcome, or applied to today while still open">Turnaround</th></tr></thead>
    <tbody>${appliedRows}</tbody>
  </table>
  <p class="note">Straight from <code>jobs.tsv</code> — <code>status</code>, <code>applied_date</code>,
  <code>outcome</code> and <code>outcome_date</code>. Scout never writes these; building a resume is
  not sending one (decision 022). Applied rows are pulled out before every triage filter, so one that
  was later delisted still shows here.</p>`
  : '<p class="empty">Nothing applied yet. <code>status</code> in <code>jobs.tsv</code> is what puts a row here.</p>'}
</div>
<footer><strong>Posted</strong> is days since the board published it — green under 21 days, grey over 35,
<code>?</code> when no source carried a date. <strong>Listed</strong> is days since Scout first saw it.
Sorted corridor first, then most recently posted. Triage only: it never judges whether the corpus can
prove a fit — copy a row and run <code>/build-resume</code> for that. Dismissals live in this browser only.</footer>
<script>
// Dismissals live in this browser, never in the repo — that keeps the shortlist
// purely derived and regenerable. Every access is guarded: a page opened where
// storage is unavailable must show every row rather than fail.
const KEY = 'scout-shortlist-dismissed';
const load = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); } };
const save = s => { try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch {} };
let gone = load();

const apply = () => {
  for (const tr of document.querySelectorAll('tr.job')) {
    const hide = gone.has(tr.dataset.url);
    tr.classList.toggle('hidden', hide);
  }
};
apply();

document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tier));
});

document.addEventListener('click', e => {
  const t = e.target;
  if (t.classList.contains('copy')) {
    navigator.clipboard.writeText(t.dataset.cmd).then(() => { t.textContent = 'copied'; setTimeout(() => t.textContent = 'copy', 1200); },
      () => { t.textContent = 'select it'; });
  }
  if (t.classList.contains('dismiss')) {
    const tr = t.closest('tr.job');
    gone.add(tr.dataset.url); save(gone); apply();
  }
});

document.getElementById('restore').onclick = e => { e.preventDefault(); gone = new Set(); save(gone); apply(); };
</script>
`;
}

// ── cli ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
  if (!fs.existsSync(JOBS)) {
    console.error(`no ledger yet at ${path.relative(process.cwd(), JOBS)} — run the first scan: node src/intake.mjs`);
    process.exit(1);
  }
  const { report, jobs, applied, today } = shortlist();

  for (const r of report) {
    console.log(String(r.n).padStart(6) + '   ' + r.label.padEnd(40) + (r.dropped ? `(-${r.dropped})` : ''));
  }
  const counts = [1, 2, 3].map(t => jobs.filter(j => j.tier === t).length);
  console.log('');
  console.log(`  TIER 1  ${TIER_LABEL[1].padEnd(28)} ${counts[0]}`);
  console.log(`  TIER 2  ${TIER_LABEL[2].padEnd(28)} ${counts[1]}`);
  console.log(`  TIER 3  ${TIER_LABEL[3].padEnd(28)} ${counts[2]}`);

  if (DRY) { console.log('\ndry run, nothing written'); process.exit(0); }

  fs.mkdirSync(OUT, { recursive: true });
  const files = [
    ['tier-1-definite.csv', toCsv(jobs.filter(j => j.tier === 1))],
    ['tier-2-optimistic.csv', toCsv(jobs.filter(j => j.tier === 2))],
    ['tier-3-review.csv', toCsv(jobs.filter(j => j.tier === 3))],
    ['applied.csv', toAppliedCsv(applied)],
    ['shortlist.html', toHtml({ jobs, applied, today })],
  ];
  for (const [name, content] of files) fs.writeFileSync(path.join(OUT, name), content, 'utf8');
  console.log(`\nwrote ${files.length} files to out/shortlist/`);
  console.log('  open in a browser: out/shortlist/shortlist.html');
}
