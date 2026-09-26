// Everything the header step needs, in one output (spec 006 / decision 022 step 6).
//
//   node src/header-inputs.mjs <selection.json>
//
// `title_line` has no lint and every term in it must trace to a bullet ACTUALLY
// ON the document — not to the corpus. This prints, in one output, the selected
// bullet ids, their text from resume.json, and the summaries and variant title
// lines to choose among.
//
// Prints only what step 6 decides with. Deliberately not the whole corpus: the
// bullets that did NOT get selected cannot support a term in the header, so
// showing them would invite exactly the error this step exists to prevent.

import fs from 'node:fs';
import path from 'node:path';
import { RESUME } from './paths.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node src/header-inputs.mjs <selection.json>'); process.exit(1); }

const sel = JSON.parse(fs.readFileSync(file, 'utf8'));
const resume = JSON.parse(fs.readFileSync(RESUME, 'utf8'));

const text = new Map(), owner = new Map();
for (const section of [resume.experience, resume.projects]) {
  for (const entry of section) {
    for (const b of entry.bullets) { text.set(b.id, b.text); owner.set(b.id, entry.id); }
  }
}

const w = s => String(s ?? '');
console.log(`header inputs — ${w(sel.job?.company)}, ${w(sel.job?.title)}`);
console.log(`variant: ${w(sel.variant)}   label: ${w(sel.label)}`);

console.log(`\nON THE PAGE — ${sel.bullets.length} experience bullets`);
console.log('(every term in title_line must trace to one of these)\n');
const idWidth = Math.max(22, ...[...sel.bullets, ...(sel.projects || [])].map(id => String(id).length + 2));
for (const id of sel.bullets) console.log(`  ${id.padEnd(idWidth)}${w(text.get(id)).replace(/\s+/g, ' ')}`);

console.log(`\nPROJECTS — ${(sel.projects || []).length}\n`);
for (const id of sel.projects || []) console.log(`  ${w(id).padEnd(idWidth)}${w(text.get(id)).replace(/\s+/g, ' ')}`);

console.log('\nSUMMARIES — select a key, never write one\n');
for (const [k, v] of Object.entries(resume.summaries)) {
  console.log(`  ${k.padEnd(18)}${w(v).replace(/\s+/g, ' ')}`);
}

console.log('\nVARIANT TITLE LINES — take one, or a narrower honest combination\n');
for (const [k, v] of Object.entries(resume.variants)) {
  console.log(`  ${k.padEnd(18)}${w(v.title_line)}`);
}

console.log('\nSKILLS CATEGORIES (decision 007 — narrowing is selection)\n');
console.log(`  ${Object.keys(resume.skills).join(', ')}`);
console.log(`  current order: ${(sel.skills_order || []).join(', ') || '(unset)'}`);
console.log(`\ncurrent title_line: ${sel.title_line ?? '(unset)'}`);
console.log(`current summary   : ${sel.summary ?? '(unset)'}`);
