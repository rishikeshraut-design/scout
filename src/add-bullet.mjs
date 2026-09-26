// The only way a bullet enters resume.json (spec 002, decision 016).
//
//   node src/add-bullet.mjs --owner northwind --angle technical \
//     --text "Restored point-of-sale terminals during trading hours…" \
//     --provenance prompted --tags pos,retail --dry
//
//   ...--declare "40" --declare "Moneris"     # register a new quantity/entity
//
// Reads and writes src/resume.json. Refuses more often than it writes.
//
// Why a script and not a hand edit: a hand edit skips every check below, and
// resume.json is the most valuable file in the project. Decision 016 puts the
// entire elicitation constraint on this step — a question cannot fabricate
// anything, only a written bullet can — so this is where the discipline lives.
//
// What it checks, and what it deliberately does not:
//
//   It does NOT judge whether prose is too strong. 016 settled that the lint
//   checks whether a claim is TRUE, not whether it is modest: if the store was
//   high-volume then "high-volume" is a fact about the store, and constraining
//   every bullet to the user's casual phrasing would understate permanently.
//   Words for the activity need only that the activity happened.
//
//   It DOES refuse an undeclared quantity or named entity. Those assert scale,
//   frequency or a specific thing, and they are exactly what auditOverride()
//   already scopes to the owner. A number may not arrive as a side effect of
//   writing prose — `--declare` makes it a deliberate, visible act.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, tokensOf, ownerScope } from './selection.mjs';
import { RESUME, listBaselines, baselinePath } from './paths.mjs';

const ANGLES = ['impact', 'process', 'ownership', 'technical', 'collaboration', 'research'];
const PROVENANCE = ['volunteered', 'prompted', 'confirmed'];

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? '') : null; };
const many = n => argv.reduce((a, v, i) => (v === `--${n}` && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
const DRY = argv.includes('--dry') || argv.includes('--dry-run');

const OWNER = flag('owner');
const ANGLE = flag('angle');
const TEXT = flag('text');
const PROV = flag('provenance');
const GROUP = flag('group');
const TAGS = (flag('tags') || '').split(',').map(s => s.trim()).filter(Boolean);
const DECLARED = many('declare');
const NEW_PROJECT = flag('new-project');
const TOOLS = flag('tools');

const die = m => { console.error(m); process.exit(1); };

if (!OWNER || !ANGLE || !TEXT || !PROV) {
  die(`usage: node src/add-bullet.mjs --owner ID --angle ANGLE --text "..." --provenance P [options]

  --angle       ${ANGLES.join(' | ')}
  --provenance  ${PROVENANCE.join(' | ')}
                volunteered = they offered it, prompted = a cue surfaced it,
                confirmed   = they verified a claim already in the corpus
  --group       existing group id to add an angle to; omit to open a new one
  --tags        comma separated
  --declare     register a quantity or entity this bullet introduces.
                Repeatable. Without it, a novel number or name is refused.
  --new-project open a new PROJECT with this display name, on its first bullet.
                Projects only — a new employer needs dates and a title no
                bullet implies, so add that entry deliberately instead.
  --tools       tools line for a --new-project entry
  --dry         validate and print, write nothing`);
}

if (!ANGLES.includes(ANGLE)) die(`--angle must be one of: ${ANGLES.join(', ')}`);
if (!PROVENANCE.includes(PROV)) die(`--provenance must be one of: ${PROVENANCE.join(', ')}`);

const resume = readJson(RESUME);
let owner = [...resume.experience, ...resume.projects].find(e => e.id === OWNER);

// Opening a new project through the write path rather than by hand.
//
// Editing resume.json to add the shell first would be a hand edit, and would
// leave a project with no bullets, a state nothing validates. So the first
// bullet creates the entry, in the same validated write.
//
// Projects only. A new EMPLOYER is a different thing: it carries dates, title,
// location and company description that no bullet implies, and inventing that
// shape from a --flag is how the most valuable file in the project acquires a
// half-filled row nobody notices.
if (!owner && NEW_PROJECT) {
  owner = { id: OWNER, name: NEW_PROJECT, tools: TOOLS || '', tags: TAGS, bullets: [] };
  resume.projects.push(owner);
}
if (!owner) {
  die(`no such owner: ${OWNER}
run \`node src/cues.mjs --list\` to see them.

To open a NEW PROJECT, name it on the first bullet:
  --new-project "Compass — Budget App" --tools "Node.js, Figma"

A new employer is not creatable this way — it needs dates and a title that no
bullet implies. Add the experience entry deliberately, then elicit into it.`);
}

// ── group and id ───────────────────────────────────────────────────────────
// A brand-new project has no bullets to infer a prefix from, and projects key
// their group on the project id itself (`compass`, not `cm_1`).
const prefixes = owner.bullets.length
  ? [...new Set(owner.bullets.map(b => String(b.group).split('_')[0]))]
  : [OWNER];
if (prefixes.length !== 1) die(`cannot infer a group prefix for ${OWNER} (found: ${prefixes.join(', ') || 'none'}) — pass --group`);
const prefix = prefixes[0];

let group = GROUP;
if (!group && !owner.bullets.length) {
  // Projects key the group on the project id itself — `compass`, `lumen` —
  // not a numbered prefix. A first bullet that allocated `compass_1` would break
  // that convention silently and only show up in a rendered resume.
  group = OWNER;
} else if (!group) {
  const used = owner.bullets
    .map(b => Number(String(b.group).slice(prefix.length + 1)))
    .filter(n => Number.isFinite(n));
  group = `${prefix}_${Math.max(0, ...used) + 1}`;
} else if (group !== prefix && !group.startsWith(prefix + '_')) {
  die(`--group ${group} does not belong to ${OWNER} (prefix is "${prefix}_")`);
}

const id = `${group}_${ANGLE}`;
const allIds = new Set([...resume.experience, ...resume.projects].flatMap(e => e.bullets.map(b => b.id)));
if (allIds.has(id)) die(`bullet ${id} already exists — pick another angle, or a different group`);

// ── the check that matters ─────────────────────────────────────────────────
// Quantities and named entities are owner-scoped (decision 012). A bullet may
// use anything this employer's corpus already verifies; anything new has to be
// declared, so a number can never arrive as a side effect of writing prose.

const tok = tokensOf(TEXT);
const scope = ownerScope(resume, owner.id);
const declared = new Set(DECLARED);

const novelQ = tok.quantities.filter(q => !scope.quantities.has(q) && !declared.has(q));
const novelE = tok.entities.filter(e => !scope.entities.has(e) && !declared.has(e));

if (novelQ.length || novelE.length) {
  console.error(`refused: this bullet asserts something ${owner.company || owner.name} has never verified.\n`);
  if (novelQ.length) console.error(`  undeclared quantities: ${novelQ.join(', ')}`);
  if (novelE.length) console.error(`  undeclared entities:   ${novelE.join(', ')}`);
  console.error(`
Each of these asserts scale, frequency or a specific named thing. If they told you
it, register it: ${[...novelQ, ...novelE].map(v => `--declare "${v}"`).join(' ')}

If they did not, the bullet is claiming more than the answer did — rewrite it.
Words for the ACTIVITY need only that the activity happened; words for
FREQUENCY or SCALE need a fact. (decision 016)`);
  process.exit(1);
}

// ── assemble ───────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
const bullet = { id, group, angle: ANGLE, text: TEXT, tags: TAGS, provenance: PROV };

const fact = resume.facts[group] || {
  owner: owner.id,
  kind: resume.experience.includes(owner) ? 'experience' : 'project',
  quantities: [], entities: [], verified: today, bullets: [],
};
fact.quantities = [...new Set([...fact.quantities, ...tok.quantities, ...DECLARED.filter(d => tok.quantities.includes(d))])].sort();
fact.entities = [...new Set([...fact.entities, ...tok.entities, ...DECLARED.filter(d => tok.entities.includes(d))])].sort();
fact.bullets = [...new Set([...fact.bullets, id])];
fact.verified = today;

// ── validate before touching disk ──────────────────────────────────────────
// The same integrity check test-lint.mjs runs, applied to the proposed state.
// A corpus that fails it must never reach the file: a half-written resume.json
// is worse than a refused write, and nothing downstream re-checks.

const proposed = structuredClone(resume);
const pOwner = [...proposed.experience, ...proposed.projects].find(e => e.id === OWNER);
pOwner.bullets.push(structuredClone(bullet));
proposed.facts[group] = structuredClone(fact);

const pIds = new Set([...proposed.experience, ...proposed.projects].flatMap(e => e.bullets.map(b => b.id)));
const problems = [];
for (const [g, f] of Object.entries(proposed.facts)) {
  for (const bid of f.bullets) if (!pIds.has(bid)) problems.push(`fact ${g} names missing bullet ${bid}`);
  const s = ownerScope(proposed, f.owner);
  for (const q of f.quantities) if (!s.quantities.has(q)) problems.push(`fact ${g} quantity ${q} outside owner scope`);
}
for (const e of [...proposed.experience, ...proposed.projects]) {
  for (const b of e.bullets) if (!b.provenance) problems.push(`bullet ${b.id} has no provenance`);
}
if (problems.length) die(`refused: the result would not be internally consistent.\n  ${problems.join('\n  ')}`);

// ── report, then write ─────────────────────────────────────────────────────

console.log(`${DRY ? 'would add' : 'added'}  ${id}`);
console.log(`  owner       ${owner.id} (${owner.company || owner.name})`);
console.log(`  group       ${group}${owner.bullets.some(b => b.group === group) ? ' (existing)' : ' (new)'}`);
console.log(`  provenance  ${PROV}`);
if (TAGS.length) console.log(`  tags        ${TAGS.join(', ')}`);
if (tok.quantities.length) console.log(`  quantities  ${tok.quantities.join(', ')}`);
if (tok.entities.length) console.log(`  entities    ${tok.entities.join(', ')}`);
console.log(`  text        ${TEXT}`);

if (DRY) { console.log('\ndry run, nothing written'); process.exit(0); }

fs.writeFileSync(RESUME, JSON.stringify(proposed, null, 2) + '\n', 'utf8');
console.log(`\nwrote ${path.relative(process.cwd(), RESUME)} — the whole corpus was checked before writing`);

// ── which baselines just went behind ───────────────────────────────────────
// A baseline cannot select a bullet that did not exist when it was written, so
// every write here silently narrows the palette a tailored resume draws from —
// the resume is simply a little worse, with nothing to say why. Baselines are
// rebuilt by hand; this only reports, at the one moment the staleness is cheap
// to notice, which is the moment it is created.
const stale = [];
for (const name of listBaselines()) {
  const ids = JSON.parse(fs.readFileSync(baselinePath(name), 'utf8')).bullets || [];
  const ownsIt = ids.some(bid => owner.bullets.some(b => b.id === bid));
  if (ownsIt) stale.push(name);
}
if (stale.length) {
  console.log(`\n${stale.length} baseline(s) now predate this bullet and cannot select it:`);
  for (const s of stale) console.log(`  ${s}`);
  console.log('Rebuild them when you want this bullet reachable by a tailored resume.');
}
