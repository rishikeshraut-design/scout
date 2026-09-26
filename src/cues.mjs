// Cue list for one employer (spec 002, decision 016).
//
//   node src/cues.mjs --owner northwind
//   node src/cues.mjs --owner northwind --archetype client-service --limit 14
//   node src/cues.mjs --list                     # owners and their coverage
//
// Reads  src/duty-bank.json, src/resume.json, src/checklists.json
// Writes nothing. This half only asks.
//
// A cue is a prompt for recall, not a claim. Decision 016: a question cannot
// fabricate anything — only a written answer can — so cue generously and put
// the whole constraint on the write step, which is add-bullet.mjs.
//
// Two things this must not do.
//
// It must not reveal which cues a particular posting wanted. The cue list mixes
// what a field's postings generally mention, so a specific JD's asks sit among
// items it never raised. That is how the JD stays hidden while cues stay useful
// — camouflage rather than withholding.
//
// And it must not let checklist cues pass as observed data. Bank cues come from
// real postings and name them; checklist cues are ones I wrote. Both are fine as
// questions, but the mix is reported every run, because a bank contributing
// nothing should be visible rather than quietly replaced by my guesses.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, contentWords, stem } from './selection.mjs';
import { RESUME, DUTY_BANK } from './paths.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? '') : null; };

const OWNER = flag('owner');
const ARCHETYPE = flag('archetype');
const LIMIT = Number(flag('limit') || 12);
const LIST = argv.includes('--list');

const resume = readJson(RESUME);
const bankPath = DUTY_BANK;
const bank = fs.existsSync(bankPath) ? readJson(bankPath) : { archetypes: {} };
const clPath = path.join(SRC, 'checklists.json');
const checklists = fs.existsSync(clPath) ? readJson(clPath) : {};

const owners = [...resume.experience, ...resume.projects];

if (LIST || !OWNER) {
  console.log('owners in the corpus:\n');
  for (const e of owners) {
    const groups = new Set(e.bullets.map(b => b.group));
    const angles = new Set(e.bullets.map(b => b.angle).filter(Boolean));
    console.log(`  ${e.id.padEnd(22)} ${String(e.company || e.name || '').padEnd(26)} ${String(groups.size).padStart(2)} groups, ${String(e.bullets.length).padStart(2)} bullets, ${angles.size} angles`);
  }
  console.log('\narchetypes in the bank:\n');
  for (const [n, a] of Object.entries(bank.archetypes || {})) {
    console.log(`  ${n.padEnd(18)} ${a.postings} postings, ${a.phrases.length} shared phrases`);
  }
  if (!OWNER) { console.log('\npass --owner <id> for a cue list'); process.exit(0); }
}

const owner = owners.find(e => e.id === OWNER);
if (!owner) { console.error(`no such owner: ${OWNER}\nrun --list to see them`); process.exit(1); }

// What this employer's bullets already say. A cue for something already covered
// wastes a question, and worse, invites re-confirming a claim that is already
// recorded — which produces duplicate bullets rather than new material.
const covered = new Set();
for (const b of owner.bullets) for (const w of contentWords(b.text)) covered.add(stem(w));

/** Cues the bank holds for an archetype: shared phrases, most-shared first. */
function bankCues(archetype) {
  const a = bank.archetypes?.[archetype];
  if (!a) return [];
  return a.phrases.map(p => ({
    text: p.term,
    source: 'bank',
    detail: `${p.postings} posting${p.postings === 1 ? '' : 's'}: ${p.companies.join(', ')}`,
    evidence: p.evidence?.[0] || '',
    weight: p.postings,
  }));
}

/** Cues I wrote, for a field. Honest questions; not observed data. */
function checklistCues(archetype) {
  return (checklists[archetype] || []).map(text => ({
    text, source: 'checklist', detail: 'written by hand, not observed in a posting', evidence: '', weight: 0,
  }));
}

const archetype = ARCHETYPE || owner.tags?.find(t => bank.archetypes?.[t]) || 'client-service';

const all = [...bankCues(archetype), ...checklistCues(archetype)];

// Drop cues this employer's bullets already cover.
const fresh = all.filter(c => {
  const words = [...contentWords(c.text)].map(stem);
  return words.length > 0 && !words.every(w => covered.has(w));
});

// Interleave sources rather than ranking, so the list does not read as "the
// real ones first, then the filler" — and so no cue's position hints at where
// it came from or how much any posting wanted it.
const bankQ = fresh.filter(c => c.source === 'bank').sort((a, b) => b.weight - a.weight);
const listQ = fresh.filter(c => c.source === 'checklist');
const mixed = [];
while ((bankQ.length || listQ.length) && mixed.length < LIMIT) {
  if (bankQ.length) mixed.push(bankQ.shift());
  if (listQ.length && mixed.length < LIMIT) mixed.push(listQ.shift());
}

console.log(`\ncues for ${owner.company || owner.name} (${owner.id}) — archetype ${archetype}\n`);
console.log(`corpus already covers ${covered.size} content words across ${owner.bullets.length} bullets`);
console.log(`cue pool: ${all.length} total, ${fresh.length} not already covered, showing ${mixed.length}\n`);

mixed.forEach((c, i) => {
  console.log(`${String(i + 1).padStart(2)}. ${c.text}`);
  console.log(`    [${c.source}] ${c.detail}`);
  if (c.evidence) console.log(`    e.g. "${c.evidence.slice(0, 100)}${c.evidence.length > 100 ? '…' : ''}"`);
});

const fromBank = mixed.filter(c => c.source === 'bank').length;
console.log(`\n${fromBank} from the bank, ${mixed.length - fromBank} from checklists.`);
if (!fromBank) {
  console.log(`The bank has nothing for "${archetype}" — every cue above is one I wrote.`);
  console.log('Add real postings with `node src/add-posting.mjs <url>` to change that.');
}
console.log('\nThese are questions, not claims. Answers become bullets only through add-bullet.mjs.');
