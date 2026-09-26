// Turn a coverage verdict into a proposed selection.json (spec 004, decision 019).
//
//   node src/propose-selection.mjs <url|key> --verdict verdict.json
//   node src/propose-selection.mjs <url|key> --verdict v.json --baseline ux-designer
//   node src/propose-selection.mjs <url|key> --verdict v.json --out out/2026-08-30-acme
//
// Reads a baseline selection, the verdict, and resume.json. Writes only where
// --out says, and never resume.json or a baseline.
//
// The shape of this, and why it is not the obvious one:
//
// The obvious design assembles a selection from the bullets coverage matched.
// It silently deletes roles. selection.mjs filters out roles with no picks, so
// an unmatched role does not render as an empty shell — it vanishes, with no
// error.
//
// So: start from a baseline — a complete, already-good resume — and swap within
// roles. Completeness is structural rather than a floor rule bolted on, and the
// output is a DIFF against a known-good document rather than a fresh assembly
// that has to be checked from scratch.
//
// The baseline is also the scope boundary. The design baselines and the
// client-service baseline draw on role sets that do not overlap. Swapping
// within a role therefore cannot put retail work on a design resume — enforced
// by structure, not by a filter someone could reorder away.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyOf, hasPosting, readPosting } from './postings.mjs';
import { archetypeOf } from './mine-duties.mjs';
import { readJson } from './selection.mjs';
import { indexCorpus, tallyCitations, swapWithin } from './propose.mjs';
import { RESUME, listBaselines, baselinePath } from './paths.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SRC);

const BASELINES = listBaselines();
const DESIGN_DEFAULT = 'product-designer';
const MAX_EXPERIENCE_BULLETS = 14;   // spec 004 R4

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? '') : null; };
const JSON_OUT = argv.includes('--json');
const VERDICT = flag('verdict');
const BASELINE = flag('baseline');
const OUT = flag('out');
const valueFlags = new Set(['--verdict', '--baseline', '--out']);
const target = argv.find((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1]));

const die = m => { console.error(m); process.exit(1); };

if (!target || !VERDICT) {
  die(`usage: node src/propose-selection.mjs <url|key> --verdict <file> [--baseline N] [--out DIR] [--json]

Starts from a baseline selection and swaps bullets within each role, driven by a
coverage verdict. Never drops a role, never mixes design and retail experience.

  --verdict   REQUIRED. The coverage skill's judged output:
              { "requirements": [ { "index":"R1", "verdict":"covered",
                                    "cites":["co_1_ownership"] } ] }
              There is deliberately no fallback to raw overlap ranking.
  --baseline  ${BASELINES.join(', ')}
  --out       directory to write selection.json into (default: stdout only)`);
}

// ── posting and baseline ───────────────────────────────────────────────────

const key = keyOf(target);
if (!hasPosting(key)) die(`not in the store: ${key}\n\n  node src/add-posting.mjs ${/^https?:/i.test(target) ? target : '<url>'}`);
const posting = readPosting(key);

// The family is the expensive decision and the easy one: archetypeOf reads the
// title. WHICH design baseline is the cheap decision and the hard one — the
// verdict re-ranks within the same roles — so it defaults and a human
// overrides. (decision 019)
const archetype = archetypeOf(posting.title);
let baselineName, why;
if (BASELINE) {
  if (!BASELINES.includes(BASELINE)) die(`unknown baseline "${BASELINE}"\nchoose one of: ${BASELINES.join(', ')}`);
  baselineName = BASELINE; why = 'named with --baseline';
} else if (archetype === 'client-service') {
  baselineName = 'client-service'; why = `title "${posting.title}" reads as client-service`;
} else {
  baselineName = DESIGN_DEFAULT; why = `title "${posting.title}" reads as ${archetype} — design family, defaulting`;
}

const baselineFile = baselinePath(baselineName);
if (!fs.existsSync(baselineFile)) die(`baseline file missing: ${baselineFile}`);
const baseline = readJson(baselineFile);

// ── the verdict ────────────────────────────────────────────────────────────

const verdictPath = path.isAbsolute(VERDICT) ? VERDICT : path.join(process.cwd(), VERDICT);
if (!fs.existsSync(verdictPath)) die(`no verdict file at ${VERDICT}\n\nThe coverage skill writes it. Run coverage first.`);
const verdict = readJson(verdictPath);
if (!Array.isArray(verdict.requirements)) die(`verdict file has no "requirements" array`);

// ── corpus index ───────────────────────────────────────────────────────────

// The corpus index, the citation tally and the swap loop are shared with
// propose-projects.mjs — see propose.mjs.
const resume = readJson(RESUME);
const { bulletOf, roleOf, groupBullets } = indexCorpus(resume);
const { citesByGroup, citedBullets, support } = tallyCitations(verdict, bulletOf);
const ctx = { bulletOf, groupBullets, citedBullets, citesByGroup, support };

// ── propose, role by role ──────────────────────────────────────────────────

const baselineIds = baseline.bullets || [];
const byRole = new Map();            // owner -> [bullet ids, baseline order]
for (const id of baselineIds) {
  const b = bulletOf.get(id);
  if (!b) die(`baseline "${baselineName}" names unknown bullet "${id}" — the corpus moved under it`);
  if (!byRole.has(b.owner)) byRole.set(b.owner, []);
  byRole.get(b.owner).push(id);
}

const changes = [];
const nearMisses = [];
let total = baselineIds.length;
const proposedByRole = new Map();

for (const [owner, ids] of byRole) {
  // A cited group competes for a slot in this role only if this role OWNS it.
  // That filter is what keeps retail work off a design resume without a check
  // anyone could reorder away.
  const r = swapWithin({
    picked: ids,
    eligible: g => (groupBullets.get(g) || []).some(id => bulletOf.get(id).owner === owner),
    ctx,
    expand: {
      allowed: () => total < MAX_EXPERIENCE_BULLETS,
      onExpand: () => { total++; },
      capNote: `cap of ${MAX_EXPERIENCE_BULLETS} experience bullets reached`,
    },
    owner,
  });
  changes.push(...r.changes);
  nearMisses.push(...r.nearMisses);
  proposedByRole.set(owner, r.picked);
}

// ── assemble, in resume.json role order ────────────────────────────────────

const proposedBullets = [...proposedByRole.entries()]
  .sort((a, b) => (roleOf.get(a[0]) ?? 99) - (roleOf.get(b[0]) ?? 99))
  .flatMap(([, ids]) => ids);

// The `job` block is provenance, and it is also what names the rendered file:
// selection.mjs derives the stem from contact.name plus job.company, so without
// it four applications produce four indistinguishable resume.pdf files. The
// baseline has no job block because a baseline targets nobody; the proposal
// does, and it already read the posting.
const selection = {
  ...baseline,
  job: { company: posting.company || '', title: posting.title || '', url: posting.url || key },
  bullets: proposedBullets,
};

// ── guards, before anything is printed or written ──────────────────────────
// These are the guarantees decision 019 makes load-bearing. Checked here rather
// than trusted: a proposal that violates one must not reach a human as if it
// were fine.

const problems = [];
const seenGroups = new Set();
for (const id of proposedBullets) {
  const b = bulletOf.get(id);
  if (!b) { problems.push(`proposed unknown bullet "${id}"`); continue; }
  if (seenGroups.has(b.group)) problems.push(`two bullets from group "${b.group}"`);
  seenGroups.add(b.group);
}
const baselineRoles = new Set(byRole.keys());
for (const id of proposedBullets) {
  const b = bulletOf.get(id);
  if (b && !baselineRoles.has(b.owner)) problems.push(`role "${b.owner}" is not in baseline "${baselineName}"`);
}
for (const [owner, ids] of byRole) {
  const n = proposedByRole.get(owner).length;
  if (n < ids.length) problems.push(`role "${owner}" lost bullets: ${ids.length} -> ${n}`);
  if (n > ids.length + 1) problems.push(`role "${owner}" grew by more than one: ${ids.length} -> ${n}`);
}
if (proposedBullets.length > MAX_EXPERIENCE_BULLETS) problems.push(`${proposedBullets.length} experience bullets exceeds the cap of ${MAX_EXPERIENCE_BULLETS}`);
if (problems.length) die(`refusing to emit a proposal that breaks its own guarantees:\n  ${problems.join('\n  ')}`);

// ── output ─────────────────────────────────────────────────────────────────

const nameOf = id => resume.experience.find(e => e.id === id)?.company || id;

// "Kept because the verdict said nothing" and "kept because the baseline was
// already right" are different facts, and conflating them under-reports how well
// the baseline fits.
const confirmed = new Set(proposedBullets.filter(id => citedBullets.has(id) && baselineIds.includes(id)));
const counts = {
  kept: proposedBullets.length - changes.length,
  confirmed: confirmed.size,
  angle: changes.filter(c => c.kind === 'angle').length,
  group: changes.filter(c => c.kind === 'group').length,
  expand: changes.filter(c => c.kind === 'expand').length,
};

if (JSON_OUT) {
  console.log(JSON.stringify({ baseline: baselineName, why, selection, changes, nearMisses, counts,
    note: 'a change with no requirement behind it is reported as baseline kept, never dressed as a decision' }, null, 2));
} else {
  console.log(`\nproposal — ${posting.company || '?'}, ${posting.title || '?'}`);
  console.log(`baseline: ${baselineName}  (${why})\n`);
  for (const [owner, ids] of [...proposedByRole.entries()].sort((a, b) => (roleOf.get(a[0]) ?? 99) - (roleOf.get(b[0]) ?? 99))) {
    const mine = changes.filter(c => c.role === owner);
    const kept = ids.filter(id => confirmed.has(id));
    console.log(`  ${nameOf(owner)}  ${byRole.get(owner).length} -> ${ids.length} bullets`);
    if (!mine.length && kept.length) console.log(`      unchanged — the baseline already had what the verdict cited: ${kept.join(', ')}`);
    else if (!mine.length) console.log(`      unchanged — the verdict cited nothing in this role`);
    else for (const id of kept) console.log(`      = ${id}   baseline pick, confirmed by the verdict`);
    for (const c of mine) {
      if (c.kind === 'expand') console.log(`      + ${c.to}   (${c.because.join(', ')})`);
      else console.log(`      ${c.from} -> ${c.to}   ${c.kind} swap  (${c.because.join(', ')})`);
    }
  }
  if (nearMisses.length) {
    console.log(`\n  near misses — supported, not selected:`);
    for (const n of nearMisses) console.log(`      ${nameOf(n.role)}: ${n.group} (${n.because.join(', ')}) — ${n.note}`);
  }
  console.log(`\n  ${proposedBullets.length} experience bullets: ${counts.kept} baseline kept (${counts.confirmed} of them cited by the verdict), ${counts.angle} angle swaps, ${counts.group} group swaps, ${counts.expand} expansions`);
  console.log(`  cap is ${MAX_EXPERIENCE_BULLETS}. A change with no requirement behind it is not a change.\n`);
}

if (OUT) {
  const dir = path.isAbsolute(OUT) ? OUT : path.join(process.cwd(), OUT);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'selection.json');
  fs.writeFileSync(p, JSON.stringify(selection, null, 2) + '\n');
  console.error(`wrote ${path.relative(ROOT, p)}`);
}
