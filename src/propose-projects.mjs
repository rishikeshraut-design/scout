// The second tailoring pass: projects. Spec 005, decision 021.
//
//   node src/propose-projects.mjs <url|key> --verdict v.json --selection out/x/selection.json
//   node src/propose-projects.mjs <url|key> --verdict v.json --selection sel.json --write
//   node src/propose-projects.mjs <url|key> --verdict v.json --selection sel.json --json
//
// Runs AFTER propose-selection.mjs, over the file it wrote. Reads that
// selection, replaces its `projects` array, writes it back in place.
//
// Why in place, and not a second file:
//
// build.mjs reads exactly one selection.json, and loadSelection takes projects
// from sel.projects inside it. A parallel projects.json would reach the page
// only through a merge step — and a merge step that silently does nothing is
// the precise failure this slice exists to end. Rewriting one file is a
// transformation; there is nothing to forget to merge.
//
// Why a separate script and not a flag on slice 2:
//
// Projects differ from experience in three ways that would each need a flag in
// the subtlest code in the repo — one slot per owner instead of 2-5, no
// expansion, and an ORDER that is itself a tailoring decision rather than
// chronology. The swap mechanism itself is shared (propose.mjs), so the licence
// logic exists once.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyOf, hasPosting, readPosting } from './postings.mjs';
import { archetypeOf } from './mine-duties.mjs';
import { readJson } from './selection.mjs';
import { indexCorpus, tallyCitations, swapWithin, bestCited } from './propose.mjs';
import { RESUME } from './paths.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SRC);

// Archetypes whose resumes carry no projects at all. A RULE, not an accident of
// the baseline file: a later edit to that baseline cannot quietly put a project
// on a customer service resume. (decision 021)
const NO_PROJECTS = new Set(['client-service']);
const DESIGN_DEFAULT = 'product-designer';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? '') : null; };
const JSON_OUT = argv.includes('--json');
const WRITE = argv.includes('--write');
const VERDICT = flag('verdict');
const SELECTION = flag('selection');
const BASELINE = flag('baseline');
const valueFlags = new Set(['--verdict', '--selection', '--baseline']);
const target = argv.find((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1]));

const die = m => { console.error(m); process.exit(1); };

if (!target || !VERDICT || !SELECTION) {
  die(`usage: node src/propose-projects.mjs <url|key> --verdict <file> --selection <file> [--baseline N] [--write] [--json]

The second tailoring pass. Swaps and reorders the PROJECTS in a selection that
propose-selection.mjs already wrote. The count never changes.

  --verdict    REQUIRED. The coverage skill's judged output, same file slice 2 read.
  --selection  REQUIRED. The selection.json propose-selection.mjs wrote. Rewritten in
               place with --write; without it, nothing is written.
  --baseline   only if you overrode it in slice 2 — pass the SAME name to both.
  --write      rewrite the selection file. Without it this is a dry run.`);
}

// ── posting ────────────────────────────────────────────────────────────────

const key = keyOf(target);
if (!hasPosting(key)) die(`not in the store: ${key}\n\n  node src/add-posting.mjs ${/^https?:/i.test(target) ? target : '<url>'}`);
const posting = readPosting(key);

// ── the selection slice 2 wrote ────────────────────────────────────────────

const selPath = path.isAbsolute(SELECTION) ? SELECTION : path.join(process.cwd(), SELECTION);
if (!fs.existsSync(selPath)) die(`no selection at ${SELECTION}\n\nRun propose-selection.mjs first.`);
const selection = readJson(selPath);

// Spec 005 R2. The `job` block is written by propose-selection.mjs and by
// nothing else, so its absence proves slice 2 has not run over this file. Without
// this guard, pointing at a BASELINE would tailor projects against an untailored
// resume and look exactly like success — the ordering dependency has to be a
// guard rather than a convention.
if (!selection.job) {
  die(`"${path.relative(ROOT, selPath)}" has no "job" block, so propose-selection.mjs has not run over it.

This pass tailors the projects of an already-tailored selection; run slice 2 first:

  node src/propose-selection.mjs ${posting.url || key} --verdict ${VERDICT} --out <dir>`);
}

// ── the verdict ────────────────────────────────────────────────────────────

const verdictPath = path.isAbsolute(VERDICT) ? VERDICT : path.join(process.cwd(), VERDICT);
if (!fs.existsSync(verdictPath)) die(`no verdict file at ${VERDICT}\n\nThe coverage skill writes it. Run coverage first.`);
const verdict = readJson(verdictPath);
if (!Array.isArray(verdict.requirements)) die(`verdict file has no "requirements" array`);

// ── baseline family, routed exactly as slice 2 routes it ───────────────────

const archetype = archetypeOf(posting.title);
let baselineName, why;
if (BASELINE) { baselineName = BASELINE; why = 'named with --baseline'; }
else if (archetype === 'client-service') { baselineName = 'client-service'; why = `title "${posting.title}" reads as client-service`; }
else { baselineName = DESIGN_DEFAULT; why = `title "${posting.title}" reads as ${archetype} — design family`; }

// ── corpus ─────────────────────────────────────────────────────────────────

const resume = readJson(RESUME);
const { bulletOf, groupBullets } = indexCorpus(resume);
const { citesByGroup, citedBullets, support } = tallyCitations(verdict, bulletOf);
const ctx = { bulletOf, groupBullets, citedBullets, citesByGroup, support };

const projectIds = new Set(resume.projects.map(p => p.id));
// One group per project, so a project IS a group — that is what makes the whole
// section a single slot set. resume.projects[].bullets holds bullet OBJECTS,
// unlike a selection's arrays of ids.
const projectByGroup = new Map(resume.projects.filter(p => p.bullets?.length).map(p => [p.bullets[0].group, p]));
const nameOf = id => resume.projects.find(p => p.id === id)?.name || id;

const baselineProjects = selection.projects || [];
const changes = [];
const nearMisses = [];
let proposed = [...baselineProjects];

// ── the rule that beats every other consideration ──────────────────────────
// Spec 005 R9. Checked before any candidate work, and REPORTED rather than
// silently applied.

const ruledOut = NO_PROJECTS.has(baselineName);
if (ruledOut) {
  proposed = [];
  for (const [g, reqs] of citesByGroup) {
    if (!projectByGroup.has(g)) continue;
    nearMisses.push({ group: g, because: [...reqs], note: `the "${baselineName}" resume carries no projects by rule` });
  }
} else {
  // ── swap ─────────────────────────────────────────────────────────────────
  //
  // The whole section is ONE slot set: a project holds exactly one bullet, so
  // "displace the least-supported group here" means "replace that project".
  // No expansion — decision 021 fixed the count.

  // Spec 005 R7 — supersession, resolved FIRST and as a direct slot handover.
  //
  // A superseded project and its successor describe the same work, so two
  // entries read as redundant rather than as evolution: when both are cited,
  // only the successor appears.
  //
  // It has to be a handover rather than a candidacy filter. Filtering candidacy
  // leaves the superseded project sitting in its baseline slot — well supported,
  // so the general rule displaces something UNCITED instead. Taking its slot
  // directly keeps the count and honours the decision.
  const citedProjects = new Set();
  for (const g of citesByGroup.keys()) if (projectByGroup.has(g)) citedProjects.add(projectByGroup.get(g).id);

  // Supersession is decided by the VERDICT, not by what the baseline happens to
  // hold. Deriving it from `picked` makes the pass non-idempotent, and running a
  // tool over its own output must be a no-op.
  const superseded = new Set();
  for (const p of resume.projects) {
    if (p.supersededBy && citedProjects.has(p.supersededBy) && citedProjects.has(p.id)) superseded.add(p.id);
  }

  let picked = [...baselineProjects];
  for (let i = 0; i < picked.length; i++) {
    const held = resume.projects.find(p => p.id === bulletOf.get(picked[i]).owner);
    const heir = held?.supersededBy;
    if (!superseded.has(held?.id)) continue;
    // Only if the successor is not already on the page — otherwise both slots
    // would resolve to it and the one-per-project guard would fire.
    if (picked.some(id => bulletOf.get(id).owner === heir)) continue;
    const heirProject = resume.projects.find(p => p.id === heir);
    const bring = bestCited(heirProject.bullets.map(b => b.id), citedBullets);
    if (!bring) continue;
    changes.push({ kind: 'supersede', from: picked[i], to: bring,
      because: [...(citesByGroup.get(bulletOf.get(bring).group) || [])] });
    picked[i] = bring;
  }

  const r = swapWithin({
    picked,
    eligible: g => {
      const p = projectByGroup.get(g);
      return !!p && !superseded.has(p.id);
    },
    ctx,
    expand: null,                    // the section never grows
    noRoomNote: 'nothing in the project section is less supported',
  });
  changes.push(...r.changes);
  nearMisses.push(...r.nearMisses);
  proposed = r.picked;

  // Reported as a near-miss because it WAS cited and did not reach the page —
  // the whole point of R10. It is not silence, and it is not a swap either: the
  // change list already carries the handover.
  for (const id of superseded) {
    const p = resume.projects.find(x => x.id === id);
    const g = p.bullets[0].group;
    nearMisses.push({ group: g, because: [...(citesByGroup.get(g) || [])],
      note: `dropped for "${nameOf(p.supersededBy)}", which supersedes it and the verdict also cites` });
  }

  // ── order ────────────────────────────────────────────────────────────────
  // Spec 005 R8. Most-supported first, then the baseline's relative order.
  // selection.mjs sorts the rendered section by position in sel.projects, so
  // writing the array in this order IS the implementation.
  const baseRank = new Map(baselineProjects.map((id, i) => [bulletOf.get(id)?.group, i]));
  proposed = [...proposed].sort((a, b) => {
    const ga = bulletOf.get(a).group, gb = bulletOf.get(b).group;
    return support(gb) - support(ga)
        || (baseRank.get(ga) ?? 99) - (baseRank.get(gb) ?? 99)
        || String(ga).localeCompare(String(gb));
  });
}

// ── guards, before anything is printed or written ──────────────────────────
// Spec 005 R12. A proposal that breaks its own guarantees must not reach a
// human as if it were fine.

const problems = [];
if (ruledOut) {
  if (proposed.length) problems.push(`"${baselineName}" carries no projects by rule, but ${proposed.length} were proposed`);
} else if (proposed.length !== baselineProjects.length) {
  problems.push(`project count changed: ${baselineProjects.length} -> ${proposed.length}`);
}
const seenProjects = new Set();
for (const id of proposed) {
  const b = bulletOf.get(id);
  if (!b) { problems.push(`proposed unknown bullet "${id}"`); continue; }
  if (!projectIds.has(b.owner)) problems.push(`"${id}" belongs to "${b.owner}", which is not a project`);
  if (seenProjects.has(b.owner)) problems.push(`two bullets from project "${b.owner}"`);
  seenProjects.add(b.owner);
}
if (problems.length) die(`refusing to emit a proposal that breaks its own guarantees:\n  ${problems.join('\n  ')}`);

// ── output ─────────────────────────────────────────────────────────────────

const out = { ...selection, projects: proposed };
// "Reordered" means the projects that SURVIVED changed their relative order —
// a swap moving into slot 0 is a swap, not a reorder, and conflating them
// overstates what the pass did.
const survivors = proposed.filter(id => baselineProjects.includes(id));
const counts = {
  kept: survivors.length,
  angle: changes.filter(c => c.kind === 'angle').length,
  group: changes.filter(c => c.kind === 'group').length,
  supersede: changes.filter(c => c.kind === 'supersede').length,
  reordered: survivors.some((id, i) => baselineProjects.filter(x => survivors.includes(x))[i] !== id),
};

if (JSON_OUT) {
  console.log(JSON.stringify({ baseline: baselineName, why, ruledOut, projects: proposed, changes, nearMisses, counts,
    note: 'the project count never changes; order is most-supported first' }, null, 2));
} else {
  console.log(`\nprojects — ${posting.company || '?'}, ${posting.title || '?'}`);
  console.log(`baseline: ${baselineName}  (${why})\n`);
  if (ruledOut) {
    console.log(`  none. The "${baselineName}" resume carries no projects by rule.`);
  } else if (!baselineProjects.length) {
    console.log(`  the baseline carries no projects, and this pass never adds one`);
  } else {
    for (const id of proposed) {
      const b = bulletOf.get(id);
      const was = changes.find(c => c.to === id);
      const reqs = citesByGroup.get(b.group);
      const kindWord = { angle: 'angle swap', group: 'project swap', supersede: 'supersedes' };
      const mark = was ? `${was.from} -> ${id}   ${kindWord[was.kind]}` : `= ${id}`;
      console.log(`  ${nameOf(b.owner).padEnd(38)} ${mark}${reqs ? `   (${[...reqs].join(', ')})` : '   not cited'}`);
    }
  }
  if (nearMisses.length) {
    console.log(`\n  near misses — cited, not selected:`);
    for (const n of nearMisses) {
      const p = projectByGroup.get(n.group);
      console.log(`      ${(p ? nameOf(p.id) : n.group)}: (${n.because.join(', ')}) — ${n.note}`);
    }
  }
  console.log(`\n  ${proposed.length} projects: ${counts.kept} kept, ${counts.angle} angle swaps, ${counts.group} project swaps, ${counts.supersede} superseded${counts.reordered ? ', reordered' : ''}`);
  console.log(`  the count never changes. Order is most-supported first.\n`);
}

if (WRITE) {
  fs.writeFileSync(selPath, JSON.stringify(out, null, 2) + '\n');
  console.error(`rewrote ${path.relative(ROOT, selPath)}`);
} else if (!JSON_OUT) {
  console.error(`dry run — pass --write to rewrite ${path.relative(ROOT, selPath)}`);
}
