#!/usr/bin/env node
// Regression suite for the selection proposal (spec 004, decision 019).
//
//   node test-selection.mjs
//
// The guarantees here are the whole reason this design was chosen over the
// obvious one, and each has a specific way of going wrong quietly.
//
// A role must never be dropped. selection.mjs filters out roles with no picks,
// so a lost role does not error — it vanishes from the resume, and a gap in a
// timeline is harder to notice than a hole in a page.
//
// Design and retail experience must never mix. The baselines encode that
// boundary and swapping within a role preserves it, but only while swaps really
// are within-role.
//
// And expansion must be licensed by two distinct requirements, never by a tie:
// a tie means overlap could not separate two groups, and growing on weak
// evidence is exactly backwards.

import { FIXTURE } from './tests/use-fixture.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(ROOT, 'src', 'propose-selection.mjs');
const RESUME = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'resume.json'), 'utf8'));

let pass = 0, fail = 0;
const is = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log(`ok    ${name}`); pass++; }
  else { console.log(`FAIL  ${name}\n      expected ${w}\n      got      ${g}`); fail++; }
};
const ok = (name, cond, detail = '') => is(name + (detail && !cond ? `\n      ${detail}` : ''), !!cond, true);

const ownerOf = new Map();
for (const e of RESUME.experience) for (const b of e.bullets) ownerOf.set(b.id, e.id);
for (const p of RESUME.projects) for (const b of p.bullets) ownerOf.set(b.id, p.id);
const groupOf = new Map();
for (const s of [RESUME.experience, RESUME.projects]) for (const e of s) for (const b of e.bullets) groupOf.set(b.id, b.group);

const RETAIL = new Set(['northwind', 'tailspin']);
const DESIGN = new Set(['contoso', 'fabrikam']);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-sel-'));
const writeVerdict = (name, reqs) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify({ requirements: reqs }, null, 2));
  return p;
};
const run = (args, opts = {}) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT, ...opts });

// ── baselines are the scope boundary (criterion 5, written first) ──────────
// Asserted against the files themselves, not through the script: if the
// baselines ever mix, every guarantee downstream is already void.

const BASELINE_FILES = {
  'product-designer': 'baselines/product-designer/selection.json',
  'ux-designer': 'baselines/ux-designer/selection.json',
  'client-service': 'baselines/client-service/selection.json',
};
for (const [name, rel] of Object.entries(BASELINE_FILES)) {
  const p = path.join(FIXTURE, rel);
  if (!fs.existsSync(p)) { console.log(`FAIL  baseline "${name}" is missing at ${rel}`); fail++; continue; }
  const owners = new Set((JSON.parse(fs.readFileSync(p, 'utf8')).bullets || []).map(id => ownerOf.get(id)));
  const isRetail = name === 'client-service';
  ok(`baseline "${name}" draws only on ${isRetail ? 'retail' : 'design'} roles`,
    [...owners].every(o => (isRetail ? RETAIL : DESIGN).has(o)), [...owners].join(', '));
}

// ── the rest needs a posting in the store ──────────────────────────────────

const DESIGN_POSTING = 'https://example.test/jobs/litware-product-designer';
const SERVICE_POSTING = 'https://example.test/jobs/wide-world-importers-customer-service-representative';
// Distinguish "the posting is absent" from "the script failed for some other
// reason".
const probe = u => {
  try { run([u, '--verdict', writeVerdict('probe.json', []), '--json'], { stdio: 'pipe' }); return null; }
  catch (e) { return ((e.stderr || '') + (e.stdout || '')) || 'exited non-zero with no output'; }
};
const designErr = probe(DESIGN_POSTING), serviceErr = probe(SERVICE_POSTING);
const missing = e => e && /not in the store/.test(e);
const unexpected = [designErr, serviceErr].filter(e => e && !missing(e));

if (unexpected.length) {
  // Never skip past this. A broken script must fail the suite, not quietly
  // shrink it.
  ok('the fixture postings propose cleanly', false, unexpected[0].trim().split('\n').slice(0, 3).join(' | '));
} else if (missing(designErr) || missing(serviceErr)) {
  ok('the fixture postings are in tests/fixture/postings', false);
} else {
  const designVerdict = writeVerdict('design.json', [
    { index: 'R1', verdict: 'partial', cites: ['fb_1_ownership', 'co_5_ownership'] },
    { index: 'R2', verdict: 'covered', cites: ['co_3_technical'] },
    { index: 'R4', verdict: 'covered', cites: ['co_4_research'] },
    { index: 'R7', verdict: 'covered', cites: ['co_1_impact'] },
    { index: 'R8', verdict: 'covered', cites: ['fb_5_collaboration'] },
    { index: 'R9', verdict: 'covered', cites: ['co_3_collaboration'] },
  ]);
  const out = JSON.parse(run([DESIGN_POSTING, '--verdict', designVerdict, '--json']));
  const ids = out.selection.bullets;
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURE, BASELINE_FILES[out.baseline]), 'utf8')).bullets;

  const countBy = list => list.reduce((m, id) => (m[ownerOf.get(id)] = (m[ownerOf.get(id)] || 0) + 1, m), {});
  const baseCounts = countBy(base), outCounts = countBy(ids);

  is('a design title routes to a design baseline', out.baseline, 'product-designer');
  ok('every role in the output is a role in the baseline',
    Object.keys(outCounts).every(o => o in baseCounts), Object.keys(outCounts).join(', '));
  ok('no role loses bullets', Object.keys(baseCounts).every(o => (outCounts[o] || 0) >= baseCounts[o]));
  ok('no role gains more than one', Object.keys(baseCounts).every(o => (outCounts[o] || 0) <= baseCounts[o] + 1));
  ok('no role disappears', Object.keys(baseCounts).every(o => o in outCounts));
  ok('no two bullets share a group', new Set(ids.map(i => groupOf.get(i))).size === ids.length);
  ok('never exceeds 14 experience bullets', ids.length <= 14, `got ${ids.length}`);
  ok('no retail role reaches a design proposal', !Object.keys(outCounts).some(o => RETAIL.has(o)));
  ok('every change names the requirement behind it',
    out.changes.length > 0 && out.changes.every(c => Array.isArray(c.because) && c.because.length));
  ok('a baseline pick the verdict also cited is reported as confirmed, not as silence',
    out.counts.confirmed >= 1, JSON.stringify(out.counts));

  // Determinism — criterion 8. Two runs must agree, or a proposal cannot be
  // reviewed once and trusted.
  const again = JSON.parse(run([DESIGN_POSTING, '--verdict', designVerdict, '--json']));
  is('running twice produces identical output', again.selection.bullets, ids);

  // Expansion is licensed by two distinct requirements, never by a tie.
  const oneReq = writeVerdict('one.json', [
    { index: 'R1', verdict: 'covered', cites: ['co_1_impact', 'co_8_impact'] },
  ]);
  const single = JSON.parse(run([DESIGN_POSTING, '--verdict', oneReq, '--json']));
  const ffSingle = single.selection.bullets.filter(i => ownerOf.get(i) === 'contoso').length;
  const ffBase = base.filter(i => ownerOf.get(i) === 'contoso').length;
  is('one requirement citing two groups does not expand a role', ffSingle, ffBase);

  const twoReq = writeVerdict('two.json', [
    { index: 'R1', verdict: 'covered', cites: ['co_1_impact'] },
    { index: 'R2', verdict: 'covered', cites: ['co_8_impact'] },
  ]);
  const dual = JSON.parse(run([DESIGN_POSTING, '--verdict', twoReq, '--json']));
  const ffDual = dual.selection.bullets.filter(i => ownerOf.get(i) === 'contoso').length;
  ok('two requirements citing two groups expands the role by one', ffDual === ffBase + 1, `${ffBase} -> ${ffDual}`);

  const atCap = JSON.parse(run([DESIGN_POSTING, '--verdict', twoReq, '--baseline', 'ux-designer', '--json']));
  ok('a baseline already at the cap never grows',
    atCap.selection.bullets.length === 14 && !atCap.changes.some(c => c.kind === 'expand'), String(atCap.selection.bullets.length));

  const tie = JSON.parse(run([DESIGN_POSTING, '--verdict', writeVerdict('tie.json', [
    { index: 'R1', verdict: 'covered', cites: ['co_2_process'] },
    { index: 'R2', verdict: 'covered', cites: ['co_2_technical'] },
  ]), '--json']));
  ok('an angle tie keeps the baseline angle',
    tie.selection.bullets.includes('co_2_process') && !tie.selection.bullets.includes('co_2_technical'), tie.selection.bullets.join(', '));

  // Routing and the retail boundary from the other side.
  const csVerdict = writeVerdict('cs.json', [
    { index: 'R1', verdict: 'covered', cites: ['nw_3_process'] },
    { index: 'R2', verdict: 'covered', cites: ['ts_1_impact'] },
  ]);
  const cs = JSON.parse(run([SERVICE_POSTING, '--verdict', csVerdict, '--json']));
  is('a CSR title routes to the client-service baseline', cs.baseline, 'client-service');
  ok('no design role reaches a client-service proposal',
    cs.selection.bullets.every(i => RETAIL.has(ownerOf.get(i))),
    [...new Set(cs.selection.bullets.map(i => ownerOf.get(i)))].join(', '));

  // A verdict citing across the boundary must be ignored, not obeyed. This is
  // the one that matters most.
  const leak = writeVerdict('leak.json', [
    { index: 'R1', verdict: 'covered', cites: ['nw_4_technical', 'ts_2_technical'] },
    { index: 'R2', verdict: 'covered', cites: ['nw_3_process'] },
  ]);
  const leaked = JSON.parse(run([DESIGN_POSTING, '--verdict', leak, '--json']));
  ok('a verdict citing retail bullets cannot put them on a design resume',
    leaked.selection.bullets.every(i => !RETAIL.has(ownerOf.get(i))),
    [...new Set(leaked.selection.bullets.map(i => ownerOf.get(i)))].join(', '));
  is('and the design proposal is unchanged from its baseline', leaked.selection.bullets, base);

  ok('--baseline overrides the routing',
    JSON.parse(run([DESIGN_POSTING, '--verdict', designVerdict, '--baseline', 'ux-designer', '--json'])).baseline === 'ux-designer');

  // Criterion 1 — the output is not merely well-formed, it renders. A proposal
  // that only satisfies its own guards is a proposal that fails in build.mjs
  // instead, which is the last possible moment.
  {
    const dir = path.join(tmp, 'render-check');
    run([DESIGN_POSTING, '--verdict', designVerdict, '--out', dir], { stdio: 'pipe' });
    ok('--out writes a selection.json', fs.existsSync(path.join(dir, 'selection.json')));
    let loaded = null, err = '';
    try {
      const { loadSelection } = await import('./src/selection.mjs');
      loaded = loadSelection(path.join(dir, 'selection.json'));
    } catch (e) { err = String(e.message || e); }
    ok('the proposal loads through selection.mjs without error', loaded && !err, err);
    ok('and resolves to the same bullet count it proposed',
      loaded && loaded.expSections?.reduce((n, s) => n + s.picks.length, 0) === ids.length,
      loaded ? String(loaded.expSections?.reduce((n, s) => n + s.picks.length, 0)) : err);
  }
}

// Unknown baseline, missing verdict, unknown posting — all must fail loudly.
const fails = (args, re, name) => {
  let code = 0, err = '';
  try { execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT, stdio: 'pipe' }); }
  catch (e) { code = e.status; err = String(e.stderr || ''); }
  ok(name, code !== 0 && re.test(err), err.split('\n')[0]);
};
fails([DESIGN_POSTING, '--verdict', writeVerdict('e.json', []), '--baseline', 'nope'], /unknown baseline/, 'an unknown baseline exits non-zero');
fails([DESIGN_POSTING], /usage:/, 'a missing --verdict prints usage');
fails(['https://example.com/nope-xyz', '--verdict', writeVerdict('e2.json', [])], /not in the store/, 'an unknown posting names the store');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
