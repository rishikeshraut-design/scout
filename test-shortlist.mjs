#!/usr/bin/env node
// Regression suite for the shortlist (spec 006).
//
//   node test-shortlist.mjs
//
// The trailing \b. `/\bproduct design\b/` does not match "Product Designer" —
// there is no word boundary between `design` and `er`. Every inclusion term is
// asserted against its -er and plural forms below.
//
// The first years figure. Postings name two bands — "8+ for Staff, 3+ for the
// role" — and taking the first match reads whichever sits higher on the page.
//
// And the drop counts must sum. A filter removes rows, and removed rows leave
// no trace to notice.

import './tests/use-fixture.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  IN_SCOPE, OUT_OF_SCOPE, ABOVE_SENIOR, REMOTE_CANADA, BELOW_TARGET, STUDENT_BOARD,
  lowestYears, tierOf, daysBetween, ageBand, FRESH_DAYS, STALE_DAYS,
  shortlist, toCsv, toHtml, toAppliedCsv, buildCommand, MAX_YEARS,
} from './src/shortlist.mjs';
import { maybeCorridor } from './src/reach.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(ROOT, 'src', 'shortlist.mjs');

let pass = 0, fail = 0;
const is = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log(`ok    ${name}`); pass++; }
  else { console.log(`FAIL  ${name}\n      expected ${w}\n      got      ${g}`); fail++; }
};
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`ok    ${name}`); pass++; }
  else { console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); fail++; }
};

// ── the trailing-\b trap (R4) ──────────────────────────────────────────────
// The whole point: a term written as a prefix must survive its own inflections.

console.log('\n— inclusion terms survive their -er and plural forms —\n');

const INFLECTIONS = [
  ['product design', ['Product Designer', 'Product Designers', 'Senior Product Designer, Fintech', 'Product Design Lead']],
  ['experience design', ['Experience Designer', 'Staff Experience Designer', '[Contoso] Product Experience Designer']],
  ['interaction design', ['Interaction Designer', 'Senior Interaction Designer']],
  ['visual design', ['Visual Designer', 'Manager, Visual Design']],
  ['user research', ['User Researcher', 'Senior User Researcher', 'User Research Lead']],
  ['design research', ['Design Researcher', 'Senior Design Researcher - Evinova']],
  ['service design', ['Service Designer']],
  ['digital design', ['Digital Designer']],
  ['product manage', ['Product Manager', 'Product Management']],
  ['information architect', ['Information Architect']],
  ['design technologist', ['Design Technologist']],
];
for (const [term, titles] of INFLECTIONS) {
  for (const t of titles) ok(`"${t}" matches (${term})`, IN_SCOPE.test(t), `IN_SCOPE missed it — check for a trailing \\b on "${term}"`);
}

// The bare acronyms are the opposite case: they DO need boundaries, or "ui"
// matches "building" and "ux" matches nothing useful.
ok('"UX Designer" matches', IN_SCOPE.test('UX Designer'));
ok('"UI Designer" matches', IN_SCOPE.test('UI Designer'));
ok('"Building Manager" does NOT match on "ui"', !IN_SCOPE.test('Building Manager'));
ok('"Auxiliary Nurse" does NOT match on "ux"', !IN_SCOPE.test('Auxiliary Nurse'));

// French — 31 ledger rows are French or bilingual.
ok('"Concepteur.trice UX Senior" matches', IN_SCOPE.test('Concepteur.trice UX Senior / Senior UX Designer'));
ok('"Conceptrice de produits" matches', IN_SCOPE.test('Conceptrice de produits'));

// ── exclusion beats inclusion (R3) ─────────────────────────────────────────
// The four real collisions from the ledger, all marketing roles that say "brand".

console.log('\n— a title carrying both an in- and an out-word is excluded —\n');

const COLLISIONS = [
  'Graphic Designer – Social Media & Brand Design',
  'Brand Graphic Designer',
  'Social Media and Brand Creative',
  'Brand / creative direction / marketing collateral Evaluator',
];
for (const t of COLLISIONS) {
  ok(`excluded: "${t.slice(0, 46)}"`, IN_SCOPE.test(t) && OUT_OF_SCOPE.test(t),
    'must match BOTH, so that exclusion-first is what decides it');
}

// Brand and visual stay when nothing marketing is present.
for (const t of ['Brand Designer', 'Senior Brand Designer', 'Brand Design Lead', 'Visual Designer']) {
  ok(`kept: "${t}"`, IN_SCOPE.test(t) && !OUT_OF_SCOPE.test(t));
}

// ── the applied tab ────────────────────────────────────────────────────────
// Applied rows leave the pipeline before any filter touches them.
{
  const tmp = path.join(os.tmpdir(), `scout-applied-${process.pid}.tsv`);
  const head = ['first_seen', 'source', 'company', 'title', 'location', 'reach', 'url', 'status',
    'applied_date', 'outcome', 'outcome_date', 'notes', 'posted'].join('\t');
  const today = '2026-09-11';
  const row = (co, ti, status, ad, oc, od, url) =>
    ['2026-09-01', 'jobdata:60', co, ti, 'Toronto, ON', 'local', url, status, ad, oc, od, '', '2026-09-10'].join('\t');
  fs.writeFileSync(tmp, [head,
    row('openco', 'Product Designer', 'new', '', '', '', 'https://jobs.lever.co/openco/1'),
    row('sentco', 'UX Designer', 'applied', '2026-09-04', '', '', 'https://jobs.lever.co/sentco/2'),
    row('rejco', 'Product Designer', 'applied', '2026-09-04', 'rejected', '2026-09-09', 'https://jobs.lever.co/rejco/3'),
    // A wrong-discipline title that was applied to anyway. It must still appear
    // in the record: the filters answer "worth looking at", which is settled.
    row('oddco', 'Piping Designer', 'applied', '2026-09-02', '', '', 'https://jobs.lever.co/oddco/4'),
  ].join('\n') + '\n', 'utf8');

  const { jobs, applied, report } = shortlist({ jobsPath: tmp, today });

  is('applied: the record holds every sent row', applied.length, 3);
  is('applied: newest first', applied.map(a => a.company), ['sentco', 'rejco', 'oddco']);
  ok('applied: a row that was sent is NOT in the tiers',
    !jobs.some(j => j.company === 'rejco'), 'a rejected application must not sort into a tier');
  ok('applied: an unsent row still is', jobs.some(j => j.company === 'openco'));
  ok('applied: a wrong-discipline row that was sent still appears in the record',
    applied.some(a => a.company === 'oddco'),
    'filters answer "worth looking at" and that is settled for a sent row');
  ok('applied: the drop report names it', report.some(r => r.label === 'minus already applied' && r.dropped === 3));

  const rej = applied.find(a => a.company === 'rejco');
  is('applied: turnaround is applied to outcome', rej.days, 5);
  ok('applied: a decided row is not open', !rej.open);
  const waiting = applied.find(a => a.company === 'sentco');
  is('applied: an open row counts to today instead', waiting.days, 7);
  ok('applied: and reads as open', waiting.open);

  const csv = toAppliedCsv(applied);
  ok('applied csv: has a header and a row per application', csv.trim().split('\n').length === 4);
  ok('applied csv: carries the outcome', csv.includes('rejected'));
  ok('applied csv: carries no build command — these are sent, not candidates', !csv.includes('/build-resume'));

  const html = toHtml({ jobs, applied, today });
  ok('applied html: the tab exists', html.includes('data-tier="applied"'));
  ok('applied html: the pane exists', html.includes('data-pane="applied"'));
  ok('applied html: the outcome is shown', html.includes('rejected'));

  is('applied html: an empty record still renders a tab',
    toHtml({ jobs, applied: [], today }).includes('data-tier="applied"'), true);

  fs.unlinkSync(tmp);
}

// Growth is a DOMAIN, not a discipline. Every token in OUT_OF_SCOPE names what
// kind of work the role is; growth names what part of the product it points at.
for (const t of ['Lead Product Designer, Growth (Upper Funnel)', 'Staff Product Designer, Growth',
  'Product Designer (Growth)', 'UX Researcher (Growth)', 'Sr./Staff Product Designer, Growth',
  'Senior Product Designer II - Lifecycle & Growth']) {
  ok(`growth kept: "${t.slice(0, 46)}"`, IN_SCOPE.test(t) && !OUT_OF_SCOPE.test(t),
    'growth names the domain, not the discipline — a product designer on the growth team is one');
}

// Content DESIGN is a UX discipline. Content STRATEGY is editorial and
// marketing, and must not come with it.
for (const t of ['Content Designer', 'Staff Content Designer', 'Contract Senior Content Designer',
  'Staff AI Content Designer', 'Staff Content Designer, Investing', 'Content Designer (Contract Role, PT)']) {
  ok(`content design kept: "${t.slice(0, 42)}"`, IN_SCOPE.test(t) && !OUT_OF_SCOPE.test(t));
}
for (const t of ['Content Strategist', 'Content Strategist Lead', 'YouTube Content Strategist',
  'Senior SEO & Content Strategist', 'Short-Form Content Strategist', 'Video Content Strategist']) {
  ok(`content strategy stays out: "${t.slice(0, 38)}"`, !IN_SCOPE.test(t),
    'strategy is editorial; only `content design` was added, never `content strateg`');
}
// Three narrow terms, each a discipline already in band. They exist BECAUSE a
// bare \bdesigner\b was rejected: it admits piping, embedded software and
// concept art.
for (const t of ['Designer Produit', 'Designer de produit senior.e', 'Designer de produits senior',
  'Designer web', 'Web Designer', 'Senior Web Designer', 'Web Designer - RSI', 'UIUX Designer (Part-time)']) {
  ok(`narrow term kept: "${t.slice(0, 40)}"`, IN_SCOPE.test(t) && !OUT_OF_SCOPE.test(t));
}

// THE GUARD THAT MAKES THE ABOVE SAFE. A bare designer term was rejected
// because tier 1 is "Definite — apply" and a 12% hit rate does not belong
// there. If any of these ever start matching, the bare term came back.
for (const t of ['Senior Curtainwall Designer', 'Embedded Software Designer', 'Floral Designer',
  'Solution Designer, AWS', 'Senior Designer', 'Staff Designer', 'Intermediate Piping Designer',
  'Analog Mixed-Signal IC Designer', 'Injection Mold Designer']) {
  ok(`bare designer still out: "${t.slice(0, 40)}"`, !IN_SCOPE.test(t),
    'IN_SCOPE must never gain a bare \\bdesigner\\b — it admits 150 rows at a ~12% hit rate');
}

// The two the new terms touch that must still lose, and to the exclusion list.
ok('"Web Designer & Webflow Developer" is excluded by `developer`',
  OUT_OF_SCOPE.test('Web Designer & Webflow Developer'));
ok('"UIUX Designer (Mobile Game)" is excluded by `game`',
  OUT_OF_SCOPE.test('UIUX Designer (Mobile Game)'));

// UX writing is the same job under another name and already passed on \bux\b —
// asserted so nobody "fixes" it by widening the content term.
ok('"UX Writer" already passes on the ux boundary, no content term needed', IN_SCOPE.test('UX Writer'));
// A marketing content title must still lose, and to the exclusion list rather
// than to IN_SCOPE — exclusion-first is what decides it.
ok('"Senior Content Marketing Partner" is excluded by `marketing`',
  OUT_OF_SCOPE.test('Senior Content Marketing Partner - Creative Services'));
ok('"Social Media Content Creator & Designer" is excluded by `social media`',
  OUT_OF_SCOPE.test('Social Media Content Creator & Designer'));

// The other half of the same change: deleting the token must not have let
// growth MARKETING through. This is the "a new pattern did not steal from a
// group tested earlier" case, in reverse — a removed pattern must not orphan
// what another one was covering.
ok('growth marketing is still excluded, by `marketing`',
  OUT_OF_SCOPE.test('Designer, Growth Marketing'));
for (const t of ['Senior Growth Creative Strategist', 'Creative Lead, Growth',
  'Growth Creative Marketer', 'Senior Manager, Growth Creative Strategy']) {
  ok(`growth non-design still out: "${t.slice(0, 40)}"`, !IN_SCOPE.test(t),
    'these fail IN_SCOPE rather than the exclusion list, which is the correct bucket');
}

// Wrong disciplines that all clear a loose "design" match.
for (const t of ['Instructional Designer III', 'Game Designer', 'Senior Graphic Designer',
  'Combat Designer (Gameplay)', 'Sr. Electronic Designer', 'Landscape Designer',
  'Part-Time Key Lead (McArthurGlen Designer Outlet) - New Store Opening!']) {
  ok(`out of scope: "${t.slice(0, 46)}"`, OUT_OF_SCOPE.test(t));
}

// ── seniority (R5) ─────────────────────────────────────────────────────────

console.log('\n— above-senior is out, staff and lead stay —\n');

for (const t of ['Senior Director, User Experience', 'VP of Design', 'Head of Product Design', 'Chief Design Officer']) {
  ok(`above senior: "${t}"`, ABOVE_SENIOR.test(t));
}
for (const t of ['Staff Product Designer', 'Principal Designer', 'Design Lead', 'Senior UX Designer']) {
  ok(`still in reach: "${t}"`, !ABOVE_SENIOR.test(t));
}

// ── years: lowest, never first (R6) ────────────────────────────────────────

console.log('\n— the lowest years figure wins, never the first —\n');

is('single figure', lowestYears('5+ years of product design experience'), 5);
is('two bands, higher first', lowestYears('8+ years for Staff. 3+ years for this role.'), 3);
is('three figures', lowestYears('13 years leading. 2+ years design. 10 years total.'), 2);
is('no figure', lowestYears('We want a thoughtful designer.'), null);
is('empty body', lowestYears(''), null);
is('ignores absurd numbers', lowestYears('founded 1998, 40 years in business, 4+ years experience'), 4);
is('range phrasing', lowestYears('3-5 years of experience'), 3);

// ── tiers (R7) ─────────────────────────────────────────────────────────────

console.log('\n— tiering, and the two distinctions that bury good roles —\n');

// A fresh posting by default; staleness has its own block below.
const T = o => tierOf({ reach: 'local', years: null, hasBody: true, location: 'Toronto, ON', posted_age: 3, ...o });

is('local, body states no years -> tier 1', T({}), 1);
is('local, 3 years -> tier 1', T({ years: 3 }), 1);
is('local, 5 years -> tier 1', T({ years: 5 }), 1);
is('local, 6 years -> tier 2', T({ years: 6 }), 2);
is('local, 7 years -> tier 2', T({ years: 7 }), 2);
is('canada, 4 years -> tier 1', T({ reach: 'canada', years: 4, location: 'Vancouver, BC' }), 1);

// A missing body and a missing country are different uncertainties.
is('local, NO body -> tier 2 (location settled, years unknown)', T({ hasBody: false }), 2);
is('canada, NO body -> tier 2', T({ reach: 'canada', hasBody: false, location: 'Montreal, QC' }), 2);

// reach=remote is the dirty bucket: classify() returns it for "Remote" naming
// no place at all, and the US-only exclusion catches almost nothing.
is('undated local -> tier 3, never assumed fresh', T({ posted_age: null }), 3);
is('remote naming Canada -> tier 2', T({ reach: 'remote', location: 'Remote - Canada' }), 2);
is('remote naming EST -> tier 2', T({ reach: 'remote', location: 'Remote (EST)' }), 2);
is('remote naming nothing -> tier 3', T({ reach: 'remote', location: 'Remote' }), 3);
is('remote, fully remote -> tier 3', T({ reach: 'remote', location: 'Fully Remote' }), 3);
is('blank reach -> tier 3', T({ reach: '' }), 3);

// A corridor city that is also a city elsewhere: classify() refuses to guess,
// and the shortlist must send it to a human rather than discard it. Cambridge,
// Hamilton and Burlington are all real Ontario cities inside commuting distance
// of Toronto — dropping a bare one silently loses a job you could take.
is('unsettled corridor city -> tier 3', tierOf({ reach: '', years: null, hasBody: true, location: 'Cambridge' }), 3);
ok('bare "Cambridge" is unsettled', maybeCorridor('Cambridge'));
ok('bare "Hamilton" is unsettled', maybeCorridor('Hamilton'));
ok('"Cambridge Office" is unsettled', maybeCorridor('Cambridge Office'));
ok('"Cambridge, MA" is settled — foreign', !maybeCorridor('Cambridge, MA'));
ok('"Cambridge, United Kingdom" is settled — foreign', !maybeCorridor('Cambridge, United Kingdom'));
ok('"Burlington, VT" is settled — foreign', !maybeCorridor('Burlington, VT'));
ok('a Connecticut street called Hamilton Rd is settled', !maybeCorridor('US-CT-WINDSOR LOCKS-B1 ~ 1 Hamilton Rd'));
ok('"Toronto" is not ambiguous at all', !maybeCorridor('Toronto'));
ok('bare "Newmarket" is unsettled', maybeCorridor('Newmarket'));
ok('"Newmarket, Auckland" is settled — foreign', !maybeCorridor('Newmarket, Auckland'));
ok('"Milton Keynes, United Kingdom" is settled — foreign', !maybeCorridor('Milton Keynes, United Kingdom'));
ok('"Milton, FL" is settled — foreign', !maybeCorridor('Milton, FL'));

ok('"Remote - Canada" reads as reachable', REMOTE_CANADA.test('Remote - Canada'));
ok('"Remote" alone does not', !REMOTE_CANADA.test('Remote'));

// ── level: below the target band (decision 030) ────────────────────────────

console.log('\n— intern, co-op and student boards are below the band —\n');

for (const t of ['Intern, Research Associate (HCI)', 'Design Intern (Winter 2027)', 'UX Design Co-op',
  'Product Design Internship', 'New Grad Product Designer', 'Winter Product Design (4-16 Months)']) {
  ok(`below target: "${t.slice(0, 44)}"`, BELOW_TARGET.test(t));
}
// The word boundary on `intern` is what keeps these in.
for (const t of ['Internal Communications Designer', 'International Brand Designer', 'Senior Product Designer']) {
  ok(`still in band: "${t}"`, !BELOW_TARGET.test(t));
}
ok('RBC early-talent board is excluded by URL',
  STUDENT_BOARD.test('https://rbc.wd3.myworkdayjobs.com/rbcearlytalent1/job/TORONTO/x'));
ok('an ordinary board is not', !STUDENT_BOARD.test('https://jobs.lever.co/contoso/abc'));

// Learning design and front-end development both clear a loose design match.
for (const t of ['Sr Learning and Experience Designer', 'Learning Experience Designer',
  'Web UI Engineer', 'UI Engineer', 'Frontend Designer', 'Concepteur logiciel systemes C++ senior']) {
  ok(`out of scope: "${t.slice(0, 44)}"`, OUT_OF_SCOPE.test(t));
}
// ...but "UX Engineer" and "Design Technologist" must survive: never exclude on
// the word engineer.
for (const t of ['UX Engineer', 'Design Technologist', 'Concepteur.trice UX Senior']) {
  ok(`kept despite the neighbours: "${t}"`, !OUT_OF_SCOPE.test(t));
}

// ── staleness (decision 030) ───────────────────────────────────────────────

console.log('\n— posting age bands —\n');

is('unknown when undated', ageBand(null), 'unknown');
is('fresh at 0', ageBand(0), 'fresh');
is(`fresh at ${FRESH_DAYS}`, ageBand(FRESH_DAYS), 'fresh');
is(`aging at ${FRESH_DAYS + 1}`, ageBand(FRESH_DAYS + 1), 'aging');
is(`aging at ${STALE_DAYS}`, ageBand(STALE_DAYS), 'aging');
is(`stale at ${STALE_DAYS + 1}`, ageBand(STALE_DAYS + 1), 'stale');
is('stale at 400', ageBand(400), 'stale');

// Staleness outranks location and years: a posting nobody is still reading is
// not "optimistic" whatever else is true of it.
const A = o => tierOf({ reach: 'local', years: 3, hasBody: true, location: 'Toronto, ON', posted_age: 3, ...o });
is('fresh, local, 3 years -> tier 1', A({}), 1);
is('aging (30d) -> tier 2', A({ posted_age: 30 }), 2);
is('stale (60d) -> tier 3 even when local and fresh-looking otherwise', A({ posted_age: 60 }), 3);
is('undated -> tier 3, never treated as fresh', A({ posted_age: null }), 3);
is('stale outranks a perfect match', A({ posted_age: 90, years: 2, reach: 'local' }), 3);

// ── age ────────────────────────────────────────────────────────────────────

console.log('\n— age is days since first_seen —\n');

is('same day is 0', daysBetween('2026-09-01', '2026-09-01'), 0);
is('one day', daysBetween('2026-08-31', '2026-09-01'), 1);
is('across a month', daysBetween('2026-08-20', '2026-09-01'), 12);
is('never negative', daysBetween('2026-09-05', '2026-09-01'), 0);

// ── the whole pass, against a fixture ledger ───────────────────────────────

console.log('\n— the pass over a fixture ledger —\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-shortlist-'));
const HEAD = 'first_seen\tsource\tcompany\ttitle\tlocation\treach\turl\tstatus\tapplied_date\toutcome\toutcome_date\tnotes\tposted';
const row = (o) => [
  o.first_seen ?? '2026-09-01', o.source ?? 'jobdata:1', o.company ?? 'Acme', o.title ?? 'Product Designer',
  o.location ?? 'Toronto, ON', o.reach ?? 'local', o.url, 'new', '', '', '', '', o.posted ?? '2026-08-30',
].join('\t');

const ledger = path.join(tmp, 'jobs.tsv');
fs.writeFileSync(ledger, [HEAD,
  row({ url: 'https://jobs.lever.co/a/1', title: 'Product Designer' }),
  row({ url: 'https://jobs.lever.co/a/2', title: 'Game Designer' }),
  row({ url: 'https://jobs.lever.co/a/3', title: 'Senior Director, User Experience' }),
  row({ url: 'https://jobs.lever.co/a/4', title: 'Accounts Payable Clerk' }),
  row({ url: 'https://jobs.lever.co/a/5', title: 'Product Designer' }),           // same company and title as #1 — both kept (038)
  row({ url: 'https://jobs.lever.co/a/6', title: 'UX Designer', company: 'Beta', first_seen: '2026-08-20', posted: '2026-08-10' }),
  row({ url: 'https://jobs.lever.co/a/7', title: 'Product Design Intern', company: 'Gamma' }),
].join('\n') + '\n');

const res = shortlist({ jobsPath: ledger, today: '2026-09-01' });

is('drop counts sum to the input', res.report[0].n,
  res.report[res.report.length - 1].n + res.report.slice(1).reduce((s, r) => s + r.dropped, 0));
ok('every step reports a drop count', res.report.slice(1).every(r => typeof r.dropped === 'number'));
// No company|title dedupe (038): keeping one copy of a role hides the others.
is('every copy of a role is kept', res.jobs.filter(j => j.title === 'Product Designer').map(j => j.url).sort(),
  ['https://jobs.lever.co/a/1', 'https://jobs.lever.co/a/5']);
ok('the game role is gone', !res.jobs.some(j => j.title === 'Game Designer'));
ok('the director role is gone', !res.jobs.some(j => /Director/.test(j.title)));
ok('the clerk is gone', !res.jobs.some(j => /Clerk/.test(j.title)));
// Sort: freshness band, then reach, then date. Location decides between two
// live postings and must never promote one that probably is not.
{
  const order = shortlist({ jobsPath: ledger, today: '2026-09-01' }).jobs;
  const bands = order.map(j => ageBand(j.posted_age));
  const rank = { fresh: 0, aging: 1, stale: 2, unknown: 3 };
  ok('freshness never goes backwards down the list',
    bands.every((b, i) => i === 0 || rank[bands[i - 1]] <= rank[b]),
    bands.join(' '));
}
{
  const rank = { fresh: 0, aging: 1, stale: 2, unknown: 3 };
  const reach = { local: 0, canada: 1, remote: 2, '': 3 };
  const daysAgo = d => new Date(Date.UTC(2026, 8, 1) - d * 864e5).toISOString().slice(0, 10);
  const sortLedger = path.join(tmp, 'sort.tsv');
  fs.writeFileSync(sortLedger, [HEAD,
    row({ url: 'https://jobs.lever.co/s/1', company: 'S1', posted: daysAgo(1) }),
    row({ url: 'https://jobs.lever.co/s/2', company: 'S2', posted: daysAgo(3) }),
    row({ url: 'https://jobs.lever.co/s/3', company: 'S3', posted: daysAgo(0), location: 'Montreal, QC', reach: 'canada' }),
    row({ url: 'https://jobs.lever.co/s/4', company: 'S4', posted: daysAgo(2), location: 'Remote', reach: 'remote' }),
    row({ url: 'https://jobs.lever.co/s/5', company: 'S5', posted: daysAgo(FRESH_DAYS + 3) }),
    row({ url: 'https://jobs.lever.co/s/6', company: 'S6', posted: daysAgo(FRESH_DAYS + 1), location: 'Montreal, QC', reach: 'canada' }),
    row({ url: 'https://jobs.lever.co/s/7', company: 'S7', posted: daysAgo(STALE_DAYS + 5) }),
    row({ url: 'https://jobs.lever.co/s/8', company: 'S8', posted: '' }),
  ].join('\n') + '\n');
  const real = shortlist({ jobsPath: sortLedger, today: '2026-09-01' }).jobs;
  ok('the sort ledger spans every band and three reaches',
    real.length === 8 && new Set(real.map(j => ageBand(j.posted_age))).size === 4 && new Set(real.map(j => j.reach)).size === 3,
    real.map(j => `${ageBand(j.posted_age)}/${j.reach}`).join(' '));
  ok('no stale row outranks a fresh one',
    real.every((j, i) => i === 0 || rank[ageBand(real[i - 1].posted_age)] <= rank[ageBand(j.posted_age)]));
  ok('within a freshness band, reach never goes backwards',
    real.every((j, i) => {
      if (i === 0) return true;
      const p = real[i - 1];
      return ageBand(p.posted_age) !== ageBand(j.posted_age) || (reach[p.reach] ?? 3) <= (reach[j.reach] ?? 3);
    }));
  ok('within a band and a reach, newest posted first',
    real.every((j, i) => {
      if (i === 0) return true;
      const p = real[i - 1];
      if (ageBand(p.posted_age) !== ageBand(j.posted_age) || p.reach !== j.reach) return true;
      return String(p.posted || '') >= String(j.posted || '');
    }));
}

is('newest first', res.jobs.map(j => j.first_seen), ['2026-09-01', '2026-09-01', '2026-08-20']);
is('listed age is computed', res.jobs.find(j => j.company === 'Beta').listed_age, 12);
is('posted age comes from the ledger column', res.jobs.find(j => j.company === 'Beta').posted_age, 22);
is('the posted date is carried through', res.jobs.find(j => j.company === 'Beta').posted, '2026-08-10');

const cmd = buildCommand(res.jobs[0]);
ok('build_command carries company, title and url', cmd.startsWith('/build-resume ') && cmd.includes(' | ') && cmd.includes('https://'),
  cmd);

// Output shapes.
const csv = toCsv(res.jobs);
is('csv header', csv.split('\n')[0],
  'posted,posted_age_days,listed_age_days,company,title,location,reach,years,employment_type,closes,url,build_command');
is('csv has a line per job plus the header', csv.trim().split('\n').length, res.jobs.length + 1);
ok('csv quotes a title containing a comma',
  toCsv([{ ...res.jobs[0], title: 'Designer, Growth' }]).includes('"Designer, Growth"'));

const html = toHtml({ jobs: res.jobs, today: '2026-09-01' });
ok('html is standalone — no external fetch', !/<(script|link|img)[^>]+(src|href)=["']https?:/i.test(html));
ok('html escapes a title', toHtml({ jobs: [{ ...res.jobs[0], title: '<script>x</script>', body: '', tier: 1 }], today: 'x' })
  .includes('&lt;script&gt;'));
// Every localStorage reference must sit inside a try. A page opened where
// storage is blocked has to show every row, not fail into a blank state.
const storageLines = html.split('\n').filter(l => /localStorage/.test(l));
ok('the page touches storage at all', storageLines.length > 0);
ok('every localStorage access is guarded', storageLines.every(l => /try\s*\{/.test(l)),
  storageLines.filter(l => !/try\s*\{/.test(l)).join('\n      '));
ok('html carries all three tiers', [1, 2, 3].every(t => html.includes(`data-pane="${t}"`)));

// ── --dry writes nothing (R1, R8) ──────────────────────────────────────────

console.log('\n— --dry writes nothing —\n');

const outDir = path.join(ROOT, 'out', 'shortlist');
const before = fs.existsSync(outDir) ? fs.readdirSync(outDir).sort() : null;
const dryOut = execFileSync('node', [SCRIPT, '--dry'], { encoding: 'utf8', cwd: ROOT });
const after = fs.existsSync(outDir) ? fs.readdirSync(outDir).sort() : null;
is('out/shortlist/ is untouched by --dry', after, before);
ok('--dry says so', /nothing written/.test(dryOut));
ok('--dry prints the drop report', /ledger, everything/.test(dryOut) && /minus known-dead/.test(dryOut));
ok('--dry prints all three tiers', /TIER 1/.test(dryOut) && /TIER 2/.test(dryOut) && /TIER 3/.test(dryOut));

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
