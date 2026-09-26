#!/usr/bin/env node
// Regression suite for the projects pass (spec 005, decision 021).
//
//   node test-projects.mjs
//
// The load-bearing assertions are about what gets SAID, not only what gets
// selected: a cited project that cannot be placed must appear as a near-miss
// every single time. Silence is the failure being tested for.
//
// The count is the other guarantee: a pass that grows the project section has
// broken its contract even if every individual choice was defensible.

import { FIXTURE } from './tests/use-fixture.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(ROOT, 'src', 'propose-projects.mjs');
const SELECT = path.join(ROOT, 'src', 'propose-selection.mjs');
const RESUME = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'resume.json'), 'utf8'));

let pass = 0, fail = 0;
const is = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log(`ok    ${name}`); pass++; }
  else { console.log(`FAIL  ${name}\n      expected ${w}\n      got      ${g}`); fail++; }
};
const ok = (name, cond, detail = '') => is(name + (detail && !cond ? `\n      ${detail}` : ''), !!cond, true);

// Derived from the corpus, never hardcoded.
const projectOf = new Map();         // bullet id -> project id
const groupOf = new Map();           // bullet id -> group
for (const p of RESUME.projects) for (const b of p.bullets) { projectOf.set(b.id, p.id); groupOf.set(b.id, b.group); }
const bulletsOfProject = id => RESUME.projects.find(p => p.id === id).bullets.map(b => b.id);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-projects-'));
const DESIGN_POSTING = 'https://example.test/jobs/litware-product-designer';
const CSR = 'https://example.test/jobs/wide-world-importers-customer-service-representative';

const write = (name, obj) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); return p; };
const verdictOf = reqs => write(`v-${Math.abs(JSON.stringify(reqs).split('').reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7))}.json`,
  { requirements: reqs.map((cites, i) => ({ index: `R${i + 1}`, verdict: 'covered', cites })) });

/** A selection as slice 2 would have written it: a job block, and some projects. */
const selectionOf = (projects, extra = {}) =>
  write(`s-${Math.abs(JSON.stringify([projects, extra]).split('').reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 3))}.json`,
    { label: 'test', variant: 'product_designer', bullets: [], projects,
      job: { company: 'Acme', title: 'Product Designer', url: 'https://example.com/x' }, ...extra });

const run = (args, opts = {}) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT, ...opts });
const runJson = (url, verdict, sel, more = []) => JSON.parse(run([url, '--verdict', verdict, '--selection', sel, '--json', ...more]));
const fails = (args) => {
  try { execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT, stdio: 'pipe' }); return null; }
  catch (e) { return (e.stderr || '') + (e.stdout || ''); }
};

console.log('\n— the fixture run verdict (spec 005 acceptance 1, 2) —\n');
{
  const V = path.join(FIXTURE, 'runs/litware-product-designer/coverage-verdict.json');
  const baseline = ['atlas_technical', 'lumen_ownership', 'kite_research'];
  const r = runJson(DESIGN_POSTING, V, selectionOf(baseline));

  ok('Compass reaches the page — the bug this slice exists to fix',
    r.projects.some(id => projectOf.get(id) === 'compass'),
    `got ${r.projects.join(', ')}`);
  ok('Atlas does not, because Compass supersedes it and both are cited',
    !r.projects.some(id => projectOf.get(id) === 'atlas'),
    `got ${r.projects.join(', ')}`);
  is('Compass leads — most-supported first (R8)', projectOf.get(r.projects[0]), 'compass');
  is('the count is unchanged (R4)', r.projects.length, baseline.length);
  is('the order: Compass, Lumen, Kite',
    r.projects.map(id => projectOf.get(id)), ['compass', 'lumen', 'kite']);
  ok('Atlas is REPORTED, not silently dropped (R10)',
    r.nearMisses.some(n => n.note.includes('supersedes') && n.because.length),
    JSON.stringify(r.nearMisses));
  ok('the handover appears as a change with its requirement indices',
    r.changes.some(c => c.kind === 'supersede' && c.from === 'atlas_technical' && c.because.length));
}

console.log('\n— the count never moves (R4) —\n');
{
  // Every project cited, by distinct requirements. Under the experience rules
  // this would license expansion; here nothing may grow.
  const V = verdictOf(RESUME.projects.map(p => [p.bullets[0].id]));
  for (const baseline of [
    ['atlas_technical', 'lumen_ownership', 'kite_research'],
    ['lumen_process', 'kite_process'],
    ['kite_research'],
  ]) {
    const r = runJson(DESIGN_POSTING, V, selectionOf(baseline));
    is(`${baseline.length} in, ${baseline.length} out`, r.projects.length, baseline.length);
  }
}
{
  const V = verdictOf([['compass_process'], ['beacon_research'], ['lumen_process']]);
  const r = runJson(DESIGN_POSTING, V, selectionOf(['atlas_technical', 'kite_research']));
  is('three cited projects cannot inflate a two-project section', r.projects.length, 2);
  ok('and the one that lost is reported', r.nearMisses.length > 0, JSON.stringify(r.nearMisses));
}

console.log('\n— one bullet per project, always —\n');
{
  const V = verdictOf([bulletsOfProject('compass')]);   // all three Scout angles, one requirement
  const r = runJson(DESIGN_POSTING, V, selectionOf(['atlas_technical', 'lumen_ownership', 'kite_research']));
  const owners = r.projects.map(id => projectOf.get(id));
  is('no project appears twice', owners.length, new Set(owners).size);
}

console.log('\n— angle swaps within a project the baseline already holds (R5) —\n');
{
  const V = verdictOf([['lumen_process']]);
  const r = runJson(DESIGN_POSTING, V, selectionOf(['atlas_technical', 'lumen_ownership', 'kite_research']));
  ok('lumen_ownership -> lumen_process', r.projects.includes('lumen_process'),
    `got ${r.projects.join(', ')}`);
  is('and it is an angle swap, not a project swap',
    r.changes.find(c => c.to === 'lumen_process')?.kind, 'angle');
  is('the count still holds', r.projects.length, 3);
}

console.log('\n— supersession (R7) —\n');
{
  const V = verdictOf([['atlas_ownership']]);       // Atlas cited, Compass NOT
  const r = runJson(DESIGN_POSTING, V, selectionOf(['atlas_technical', 'lumen_ownership', 'kite_research']));
  ok('Atlas survives when Compass is not cited', r.projects.includes('atlas_ownership'),
    `got ${r.projects.join(', ')}`);
  is('no supersede change fired', r.changes.filter(c => c.kind === 'supersede').length, 0);
}
{
  const V = verdictOf([['atlas_ownership'], ['compass_process']]);
  const r = runJson(DESIGN_POSTING, V, selectionOf(['atlas_technical', 'compass_ownership', 'kite_research']));
  ok('Compass already on the page: Atlas is not handed the slot twice',
    r.projects.filter(id => projectOf.get(id) === 'compass').length === 1,
    `got ${r.projects.join(', ')}`);
  is('and the count holds', r.projects.length, 3);
}

console.log('\n— client-service carries no projects, by rule (R9, acceptance 3) —\n');
{
  const V = verdictOf([['compass_process'], ['atlas_ownership']]);
  const r = runJson(CSR, V, selectionOf(['atlas_technical', 'lumen_ownership']));
  is('routed to client-service by title', r.baseline, 'client-service');
  is('projects is empty', r.projects, []);
  ok('and the rule is stated, not silently applied',
    r.nearMisses.length > 0 && r.nearMisses.every(n => n.note.includes('by rule')),
    JSON.stringify(r.nearMisses));
}
{
  // The rule beats the baseline file: even handed a selection carrying projects,
  // a client-service posting renders none.
  const V = verdictOf([['lumen_process']]);
  const r = runJson(CSR, V, selectionOf(['lumen_ownership', 'kite_research']));
  is('a client-service run never emits a project', r.projects, []);
}

console.log('\n— every cited project that loses is reported (R10) —\n');
{
  // Two projects cited, one slot, and it is already held by a better-supported
  // project. The loser must not vanish.
  const V = verdictOf([['kite_research'], ['kite_process'], ['compass_process']]);
  const r = runJson(DESIGN_POSTING, V, selectionOf(['kite_research']));
  is('the held project keeps the slot', r.projects, ['kite_research']);
  ok('Compass is reported rather than dropped',
    r.nearMisses.some(n => n.because.includes('R3')), JSON.stringify(r.nearMisses));
}
{
  const V = verdictOf([['beacon_research']]);
  const r = runJson(DESIGN_POSTING, V, selectionOf(['atlas_technical', 'lumen_ownership', 'kite_research']));
  const placed = r.projects.some(id => projectOf.get(id) === 'beacon');
  const reported = r.nearMisses.some(n => n.because.length);
  ok('a cited project is either placed or reported — never neither', placed || reported,
    `projects=${r.projects.join(',')} nearMisses=${JSON.stringify(r.nearMisses)}`);
}

console.log('\n— refusing to run before slice 2 (R2, acceptance 5) —\n');
{
  const noJob = write('nojob.json', { label: 'baseline', bullets: [], projects: ['atlas_technical'] });
  const V = verdictOf([['compass_process']]);
  const err = fails([DESIGN_POSTING, '--verdict', V, '--selection', noJob]);
  ok('a selection with no job block is refused', !!err);
  ok('and the message names propose-selection.mjs', /propose-selection\.mjs/.test(err || ''), err || '');
}
{
  const V = verdictOf([['compass_process']]);
  ok('a missing selection file is refused', !!fails([DESIGN_POSTING, '--verdict', V, '--selection', path.join(tmp, 'nope.json')]));
  ok('a posting not in the store is refused',
    !!fails(['https://example.com/not-a-posting', '--verdict', V, '--selection', selectionOf(['atlas_technical'])]));
  ok('a missing verdict is refused',
    !!fails([DESIGN_POSTING, '--verdict', path.join(tmp, 'nope.json'), '--selection', selectionOf(['atlas_technical'])]));
}

console.log('\n— determinism and idempotence (acceptance 6) —\n');
{
  const V = path.join(FIXTURE, 'runs/litware-product-designer/coverage-verdict.json');
  const sel = selectionOf(['atlas_technical', 'lumen_ownership', 'kite_research']);
  const a = run([DESIGN_POSTING, '--verdict', V, '--selection', sel, '--json']);
  const b = run([DESIGN_POSTING, '--verdict', V, '--selection', sel, '--json']);
  is('two runs agree', a, b);

  // Write, then run again over the written file: a no-op.
  const live = path.join(tmp, 'live.json');
  fs.copyFileSync(sel, live);
  run([DESIGN_POSTING, '--verdict', V, '--selection', live, '--write'], { stdio: 'pipe' });
  const once = JSON.parse(fs.readFileSync(live, 'utf8')).projects;
  run([DESIGN_POSTING, '--verdict', V, '--selection', live, '--write'], { stdio: 'pipe' });
  const twice = JSON.parse(fs.readFileSync(live, 'utf8')).projects;
  is('running over its own output changes nothing', twice, once);
}

console.log('\n— it writes one file, in place (R11) —\n');
{
  const V = verdictOf([['compass_process']]);
  const sel = selectionOf(['atlas_technical', 'lumen_ownership', 'kite_research'],
    { skills_order: ['design_tools'], overrides: { lumen_ownership: 'kept' } });
  const live = path.join(tmp, 'inplace.json');
  fs.copyFileSync(sel, live);
  const before = JSON.parse(fs.readFileSync(live, 'utf8'));
  run([DESIGN_POSTING, '--verdict', V, '--selection', live, '--write'], { stdio: 'pipe' });
  const after = JSON.parse(fs.readFileSync(live, 'utf8'));

  is('only "projects" changed',
    Object.keys(after).filter(k => JSON.stringify(after[k]) !== JSON.stringify(before[k])), ['projects']);
  is('the job block survives', after.job, before.job);
  is('overrides survive', after.overrides, before.overrides);
  ok('no second file appears beside it',
    !fs.readdirSync(tmp).includes('projects.json'));
}
{
  const V = verdictOf([['compass_process']]);
  const sel = selectionOf(['atlas_technical', 'lumen_ownership', 'kite_research']);
  const before = fs.readFileSync(sel, 'utf8');
  run([DESIGN_POSTING, '--verdict', V, '--selection', sel]);          // no --write
  is('a dry run writes nothing', fs.readFileSync(sel, 'utf8'), before);
}

console.log('\n— the output still loads (acceptance 7) —\n');
{
  // The real guarantee is that build.mjs can render what this pass produced, and
  // loadSelection is the gate build.mjs goes through. Checking it here rather
  // than trusting it: this pass rewrites the file build.mjs reads.
  const V = path.join(FIXTURE, 'runs/litware-product-designer/coverage-verdict.json');
  const real = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'runs/litware-product-designer/selection.json'), 'utf8'));
  const live = write('loadable.json', real);
  run([DESIGN_POSTING, '--verdict', V, '--selection', live, '--write'], { stdio: 'pipe' });
  const { loadSelection } = await import('./src/selection.mjs');
  let loaded = null;
  try { loaded = loadSelection(live); } catch (e) { /* loadSelection exits on failure */ }
  ok('loadSelection accepts the rewritten selection', !!loaded);
  is('and it resolves the projects it proposed',
    loaded?.projSections.length, JSON.parse(fs.readFileSync(live, 'utf8')).projects.length);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
