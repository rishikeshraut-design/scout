// What one job description asks for, and which bullets bear on each ask
// (spec 003, Phase 3 slice 1).
//
//   node src/coverage.mjs <url|key>            human-readable
//   node src/coverage.mjs <url|key> --json     for the `coverage` skill
//
// Reads the posting store and src/resume.json. Writes NOTHING, ever.
//
// This script retrieves; it does not judge. The verdict — covered / partial /
// gap — belongs to the `coverage` skill under decision 018, and the split is
// the same one cues.mjs and the elicit skill already use: deterministic code
// assembles the evidence, a skill makes the call, a human checks it.
//
// Why the requirement LINE and not the mined concept: mine-duties' conceptsOf()
// exists to find what two or more postings SHARE, and at N=1 nothing aggregates.
// Run over a single JD it emits sliding word pairs — "mindset comfortably",
// "tool uses", "insight curiou". The line is already clean and already
// correctly sectioned; the concept machinery is the wrong tool one posting down.
//
// Why there is no candidate ranking (decision 031): if the skill it feeds
// follows its instruction not to trust it, the ranking cannot affect the
// verdict; if it does not, it does harm. So the corpus travels whole and the
// judgment is made over the corpus, which is what decision 018 always said it
// was.

import fs from 'node:fs';
import path from 'node:path';
import { keyOf, hasPosting, readPosting, looksInjected } from './postings.mjs';
import { sectionedLines } from './mine-duties.mjs';
import { readJson, atsNormalize } from './selection.mjs';
import { RESUME } from './paths.mjs';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const target = argv.find(a => !a.startsWith('--'));

const die = m => { console.error(m); process.exit(1); };

if (!target) {
  die(`usage: node src/coverage.mjs <url|key> [--json]

Prints what a stored posting asks for, each line with the heading it sat under,
and the whole bullet corpus to judge it against. Retrieval only — the verdict is
the coverage skill's job (018), and it is made over the corpus, not a ranking.

The posting must already be in the store:
  node src/add-posting.mjs <url>                    a board with a reader
  node src/add-posting.mjs <url> --text file.txt    pasted text`);
}

// ── the posting ────────────────────────────────────────────────────────────
// keyOf is the shared identity function, so the store and the ledger cannot
// disagree about what one posting is. Never fetch as a side effect: an analysis
// command that silently writes to the store is a command you cannot run twice
// to compare (R1).

const key = keyOf(target);
if (!hasPosting(key)) {
  die(`not in the store: ${key}

Add it first, then run this again:
  node src/add-posting.mjs ${/^https?:/i.test(target) ? target : '<url>'}`);
}
const posting = readPosting(key);
if (posting.unavailable) die(`that posting is a tombstone — the board no longer lists it, and the body was never captured.`);

// ── sections ───────────────────────────────────────────────────────────────
// sectionedLines owns the walk (spec 003 R2). company and benefits are dropped
// exactly as mine-duties drops them: nobody can be asked whether they performed
// "we're transforming the grocery industry".

const requirements = [];
const duties = [];
const quarantined = [];

for (const { block, section, carriedOver, kind, heading } of sectionedLines(posting.blocks, { paragraphs: true })) {
  const text = atsNormalize(block.text).trim();
  if (!text) continue;
  if (section === 'company' || section === 'benefits') continue;

  // A job description is text from the internet on its way to a model that
  // writes a resume. A line reading as an instruction never reaches the report.
  // The filter must stay narrow: over-firing deletes real requirements and the
  // report simply looks shorter, with nothing to say why.
  if (looksInjected(text)) { quarantined.push({ text, section }); continue; }

  (section === 'requirements' ? requirements : duties).push({ text, section, carriedOver, kind, heading });
}

// ── the corpus side ────────────────────────────────────────────────────────

const resume = readJson(RESUME);

/** bullet id -> the employer or project that owns it, via the facts layer. */
const ownerOf = new Map();
for (const [, fact] of Object.entries(resume.facts || {})) {
  for (const id of fact.bullets || []) ownerOf.set(id, fact.owner);
}

const bullets = [];
for (const section of [resume.experience, resume.projects]) {
  for (const entry of section || []) {
    for (const b of entry.bullets || []) {
      bullets.push({
        id: b.id,
        text: b.text,
        owner: ownerOf.get(b.id) || entry.company || entry.name || '?',
      });
    }
  }
}

const analysed = requirements.map((r, i) => ({
  index: `R${i + 1}`,
  text: r.text,
  // Both, because they answer different questions. headingNamedSection says
  // whether the classifier recognised the section; `heading` says what the
  // posting actually wrote. Only the text distinguishes a disposition list from
  // an inverted disqualifier list from a benefits list.
  headingNamedSection: !r.carriedOver,
  heading: r.heading,
}));

const totals = {
  requirements: requirements.length,
  duties: duties.length,
  carriedOver: requirements.filter(r => r.carriedOver).length,
  quarantined: quarantined.length,
  bulletsInCorpus: bullets.length,
};

// ── output ─────────────────────────────────────────────────────────────────

if (JSON_OUT) {
  console.log(JSON.stringify({
    posting: { key, url: posting.url, company: posting.company, title: posting.title, source: posting.source },
    requirements: analysed,
    duties: duties.map((d, i) => ({ index: `D${i + 1}`, text: d.text, headingNamedSection: !d.carriedOver, heading: d.heading })),
    // The WHOLE corpus, and the only evidence in the payload (031). A ranking by
    // word overlap misses semantic matches outright, and false negatives are the
    // worse half of the error because they are invisible: a bad candidate can be
    // rejected on sight, a missing one cannot.
    corpus: bullets.map(b => ({ id: b.id, owner: b.owner, text: b.text })),
    totals,
    // Restated in the payload on purpose. The consumer is a skill deciding
    // covered/partial/gap, and the thing it must not do is treat any subset of
    // the corpus as the set of bullets worth considering.
    judgeOverTheCorpus: 'this payload ranks nothing. Read every bullet in `corpus` before calling a requirement a gap — a bullet can cover a requirement in words the requirement never uses. Under decision 018 nothing is "covered" without a named bullet id.',
    readTheHeading: '`heading` is what the posting wrote above each line, verbatim. A line under "you won\'t fit in if you:" is an exclusion stated in the negative, and one under "Company advantages:" is a benefit. Neither is a requirement. `headingNamedSection: false` means the classifier did not recognise the heading, not that the line is unimportant.',
  }, null, 2));
  process.exit(0);
}

console.log(`\ncoverage — ${posting.company || '?'}, ${posting.title || '?'}`);
console.log(`${posting.source || '?'} | ${posting.url || key}\n`);

// Grouped by heading rather than listed flat: the heading is the fastest way to
// see that a run of "requirements" is really a benefits list, and reading them
// interleaved buries exactly that.
const groupByHeading = rows => {
  const out = new Map();
  for (const r of rows) {
    const h = r.heading || '(no heading above this)';
    if (!out.has(h)) out.set(h, []);
    out.get(h).push(r);
  }
  return out;
};

console.log(`REQUIREMENTS (${totals.requirements}) — ${totals.requirements - totals.carriedOver} under their own heading, ${totals.carriedOver} carried over`);
for (const [h, rows] of groupByHeading(analysed)) {
  console.log(`\n  under: "${h}"`);
  for (const r of rows) {
    console.log(`   ${r.index.padEnd(4)} [${r.headingNamedSection ? 'own' : 'carried'}]  ${r.text}`);
  }
}

console.log(`\n\nDUTIES (${totals.duties})`);
for (const [h, rows] of groupByHeading(duties.map((d, i) => ({ ...d, index: `D${i + 1}` })))) {
  console.log(`\n  under: "${h}"`);
  for (const d of rows) {
    console.log(`   ${d.index.padEnd(4)} [${d.carriedOver ? 'carried' : 'own'}]  ${d.text}`);
  }
}

if (quarantined.length) {
  console.log(`\nQUARANTINED (${quarantined.length}) — read as instructions rather than job description, not shown`);
}

console.log(`\nTOTALS`);
console.log(`  ${totals.requirements} requirements, ${totals.duties} duties, judged against ${totals.bulletsInCorpus} bullets`);
console.log(`  ${totals.carriedOver} requirement(s) inherited their section from an earlier heading — read the heading above them`);
console.log(`\n  This report ranks nothing (decision 031). It says what the posting asks and what heading`);
console.log(`  each ask sat under; which bullets meet them is the coverage skill's call, made over the`);
console.log(`  whole corpus. Under decision 018 nothing is "covered" without a named bullet id.`);
console.log(`  A line under a heading like "you won't fit in if you:" is stated in the negative and is`);
console.log(`  not a requirement at all — the heading is how you can tell.\n`);
