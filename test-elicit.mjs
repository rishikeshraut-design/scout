#!/usr/bin/env node
// Regression suite for elicitation (spec 002, decision 016).
//
//   node test-elicit.mjs
//
// These drive the real CLIs rather than importing their internals, because the
// contract IS the command line: an exit code, a refusal message naming the
// offending token, and — the one that matters most — writing nothing when it
// says it wrote nothing. A refusal that silently half-writes resume.json would
// be the worst failure this slice can have, so every case here runs against a
// hash of the file taken before and after.

import { spawnSync } from 'node:child_process';
import { FIXTURE } from './tests/use-fixture.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RESUME = path.join(FIXTURE, 'resume.json');
const hash = () => crypto.createHash('sha256').update(fs.readFileSync(RESUME)).digest('hex');

let pass = 0, fail = 0;
const before = hash();

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', script), ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function ok(name, cond, detail = '') {
  if (cond) { console.log(`ok    ${name}`); pass++; }
  else { console.log(`FAIL  ${name}${detail ? '\n      ' + detail : ''}`); fail++; }
}

const BASE = ['--owner', 'northwind', '--angle', 'technical', '--provenance', 'prompted'];
const CLEAN = 'Restored frozen point-of-sale terminals during trading hours, isolating the fault and bringing the till back online.';

// ── group id allocation ────────────────────────────────────────────────────

{
  // Derived, never hardcoded. A test coupled to how much of the corpus exists
  // fails every time the corpus grows.
  const groups = Object.keys(JSON.parse(fs.readFileSync(RESUME, 'utf8')).facts)
    .filter(id => /^nw_\d+$/.test(id))
    .map(id => Number(id.slice(3)));
  const next = `nw_${Math.max(0, ...groups) + 1}`;

  const r = run('add-bullet.mjs', [...BASE, '--text', CLEAN, '--dry']);
  ok('allocates the next free group for the owner prefix', r.out.includes(next) && r.code === 0, r.out.trim().split('\n')[0]);
  ok('marks a freshly allocated group as new', new RegExp(`${next} \\(new\\)`).test(r.out));
  ok('builds the id as <group>_<angle>', r.out.includes(`${next}_technical`));
}

{
  // A second angle on an existing subject is the common case for retail, which
  // currently carries one angle per group.
  const r = run('add-bullet.mjs', ['--owner', 'northwind', '--angle', 'impact', '--provenance', 'prompted',
    '--group', 'nw_6', '--text', 'Kept the shelves accurate against the count sheet through a full trading day.', '--dry']);
  ok('adds a second angle to an existing group', r.code === 0 && r.out.includes('nw_6_impact') && r.out.includes('(existing)'), r.out.trim());
}

{
  const r = run('add-bullet.mjs', ['--owner', 'northwind', '--angle', 'ownership', '--provenance', 'prompted',
    '--group', 'nw_1', '--text', 'Anything at all here for the store floor.', '--dry']);
  ok('refuses a duplicate id', r.code === 1 && /already exists/.test(r.out));
}

{
  const r = run('add-bullet.mjs', [...BASE, '--group', 'ts_2', '--text', CLEAN, '--dry']);
  ok('refuses a group belonging to another owner', r.code === 1 && /does not belong/.test(r.out));
}

// ── the check that matters ─────────────────────────────────────────────────

{
  const r = run('add-bullet.mjs', [...BASE, '--text', 'Resolved 40 point-of-sale failures across the floor.', '--dry']);
  ok('refuses an undeclared quantity', r.code === 1 && /undeclared quantities/.test(r.out));
  ok('names the offending token', /\b40\b/.test(r.out));
  ok('suggests --declare rather than just failing', /--declare/.test(r.out));
}

{
  const r = run('add-bullet.mjs', [...BASE, '--text', 'Resolved 40 point-of-sale failures across the floor.',
    '--declare', '40', '--dry']);
  ok('--declare admits the quantity', r.code === 0 && r.out.includes('quantities  40'), r.out.trim());
}

{
  // The point of decision 016: strong ACTIVITY words are not policed. If the
  // activity happened, the word for it is licensed. A version of this that
  // constrained bullets to the user's casual phrasing would fail here, and
  // would understate every bullet in the corpus.
  const r = run('add-bullet.mjs', [...BASE, '--text',
    'Diagnosed and resolved point-of-sale faults on a high-volume store floor, restoring service without closing the lane.', '--dry']);
  ok('does NOT police strong activity words', r.code === 0, r.out.trim());
}

// ── argument validation ────────────────────────────────────────────────────

{
  const r = run('add-bullet.mjs', ['--owner', 'northwind', '--angle', 'technical', '--provenance', 'guessed', '--text', CLEAN, '--dry']);
  ok('refuses an unknown provenance', r.code === 1 && /provenance must be one of/.test(r.out));
}
{
  const r = run('add-bullet.mjs', ['--owner', 'northwind', '--angle', 'vibes', '--provenance', 'prompted', '--text', CLEAN, '--dry']);
  ok('refuses an unknown angle', r.code === 1 && /angle must be one of/.test(r.out));
}
{
  const r = run('add-bullet.mjs', ['--owner', 'nowhere', '--angle', 'technical', '--provenance', 'prompted', '--text', CLEAN, '--dry']);
  ok('refuses an unknown owner', r.code === 1 && /no such owner/.test(r.out));
  ok('and points at --new-project as the way to open one', /--new-project/.test(r.out));
}

// ── --new-project ──────────────────────────────────────────────────────────
// The group convention is the breakable part: projects key the group on the
// project id, and the employer path would allocate a numbered prefix here,
// which only shows up in a rendered resume.
{
  const NEW = ['--owner', 'testproj', '--new-project', 'Test Project', '--angle', 'technical',
    '--provenance', 'prompted', '--text', CLEAN, '--dry'];
  const r = run('add-bullet.mjs', NEW);
  ok('--new-project opens a project the corpus does not have', r.code === 0 && /would add\s+testproj_technical/.test(r.out));
  ok('a new project keys its group on the project id, not a numbered prefix',
    /group\s+testproj \(new\)/.test(r.out), r.out.split('\n').find(l => /group/.test(l)));
  ok('--new-project does NOT apply to a name that already exists as an employer',
    run('add-bullet.mjs', ['--owner', 'northwind', '--new-project', 'Hijack', '--angle', 'research',
      '--provenance', 'prompted', '--text', CLEAN, '--dry']).out.includes('northwind (Northwind Traders)'));
}
{
  const r = run('add-bullet.mjs', ['--owner', 'northwind', '--dry']);
  ok('prints usage when required flags are missing', r.code === 1 && /usage:/.test(r.out));
}

// ── cues ───────────────────────────────────────────────────────────────────

{
  const r = run('cues.mjs', ['--owner', 'northwind', '--limit', '6']);
  ok('cues run clean', r.code === 0, r.out.trim().slice(0, 120));
  ok('every cue carries a source label', (r.out.match(/\[(bank|checklist)\]/g) || []).length >= 1);
  ok('reports the bank/checklist mix', /from the bank, .* from checklists/.test(r.out));
  ok('says plainly when the bank contributed nothing',
    !/0 from the bank/.test(r.out) || /every cue above is one I wrote/.test(r.out));
  ok('states that cues are questions, not claims', /questions, not claims/.test(r.out));
}
{
  const r = run('cues.mjs', ['--owner', 'nowhere']);
  ok('cues refuse an unknown owner', r.code === 1 && /no such owner/.test(r.out));
}

// ── the invariant ──────────────────────────────────────────────────────────

ok('no --dry run and no refusal touched resume.json', hash() === before,
  hash() === before ? '' : 'resume.json CHANGED during a suite that only ran --dry and refusals');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
