#!/usr/bin/env node
// Regression suite for the override lint (decision 012).
//
//   node test-lint.mjs
//
// The lint is the only thing standing between "reshape a verified claim" and
// "write whatever gets shortlisted". Every case below is a claim about what it
// permits, so a change that quietly loosens it fails here rather than in a
// resume someone sends.

import { FIXTURE } from './tests/use-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { auditOverride, tokensOf, atsNormalize, ownerScope } from './src/selection.mjs';

const resume = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'resume.json'), 'utf8'));

const bullets = new Map();
for (const e of [...resume.experience, ...resume.projects])
  for (const b of e.bullets) bullets.set(b.id, { ...b, owner: e.id });

let pass = 0, fail = 0;

/** `expect` names the classes that must fire. [] means the override is clean. */
function check(name, bulletId, override, expect, accepted = []) {
  const b = bullets.get(bulletId);
  if (!b) { console.log(`FAIL  ${name}\n      unknown bullet "${bulletId}"`); fail++; return; }
  const n = auditOverride(b.text, override, resume, b.owner, accepted);
  const fired = ['quantities', 'entities', 'banned', 'words'].filter(k => n[k].length);
  const want = [...expect].sort().join(',');
  const got = [...fired].sort().join(',');
  if (want === got) { console.log(`ok    ${name}`); pass++; }
  else {
    console.log(`FAIL  ${name}\n      expected [${want || 'clean'}] got [${got || 'clean'}]`);
    for (const k of fired) console.log(`      ${k}: ${n[k].join(', ')}`);
    fail++;
  }
}

const NW1 = 'nw_1_ownership';   // Northwind: crew of 5-6, $12,500 daily, 6/9/12-hour shifts
const CO2 = 'co_2_process';     // Contoso: 3 two-week sprints, Figma

console.log('— fabrication —');
check('invented scope, responsibilities and counterparties is rejected', NW1,
  'Led a crew of 5-6 across three store locations, owning P&L accountability and vendor negotiations.',
  // "three" fires too: owner scoping means Northwind asserting no such number is
  // enough.
  ['quantities', 'entities', 'words']);
check('invented quantity is rejected', NW1,
  'Led a crew of 25 on a floor averaging $99,000 in daily sales.',
  ['quantities']);
check('number words count as quantities', NW1,
  'Led a crew of seven on a busy grocery floor.',
  ['quantities']);

console.log('\n— owner scoping —');
// Figma is all over this corpus. It is not true of Northwind.
check('entity borrowed from another employer is rejected', NW1,
  'Led a crew of 5-6, planning floor coverage in Figma.',
  ['entities']);
check('same entity at its real owner is fine', CO2,
  'Designed the appointment-booking flow in Figma across 3 two-week sprints.',
  []);

console.log('\n— vocabulary —');
check('novel content word is rejected without acceptance', NW1,
  'Led a crew of 5-6, orchestrating floor coverage across shifts.',
  ['words']);
check('the same word passes when accepted explicitly', NW1,
  'Led a crew of 5-6, orchestrating floor coverage across shifts.',
  [], ['orchestrating']);
check('banned vocabulary is rejected and cannot be accepted away', NW1,
  'Spearheaded a crew of 5-6, driving seamless floor coverage.',
  ['banned'], ['spearheaded', 'seamless', 'driving']);

console.log('\n— legitimate reshaping —');
check('reordering and trimming a verified claim is clean', NW1,
  'Planned breaks and floor coverage for a crew of 5-6 across 6, 9, and 12-hour shifts.',
  []);
check('dropping detail is clean', NW1,
  'Led a crew of 5-6 on a busy grocery floor averaging $12,500 in daily sales.',
  []);

console.log('\n— token extraction —');
const t = tokensOf('Designed the live voting interface for Studio7 across 5 markets.');
if (!t.quantities.includes('5') || !t.entities.includes('Studio7')) {
  console.log('FAIL  Studio7 must not license the numeral 5 on its own'); fail++;
} else if (tokensOf('Designed for Studio7.').quantities.length) {
  console.log('FAIL  "Studio7" alone leaked a quantity:', tokensOf('Designed for Studio7.').quantities); fail++;
} else { console.log('ok    digits inside a name are not quantities'); pass++; }

if (atsNormalize('a — b – c “d” ‘e’ f…') === 'a - b - c "d" \'e\' f...') { console.log('ok    ATS normalization'); pass++; }
else { console.log('FAIL  ATS normalization ->', JSON.stringify(atsNormalize('a — b – c “d” ‘e’ f…'))); fail++; }

console.log('\n— corpus integrity —');
const missing = [];
for (const [group, f] of Object.entries(resume.facts || {})) {
  for (const id of f.bullets) if (!bullets.has(id)) missing.push(`${group} -> ${id}`);
  const scope = ownerScope(resume, f.owner);
  for (const q of f.quantities) if (!scope.quantities.has(q)) missing.push(`${group} quantity ${q} outside owner scope`);
}
if (missing.length) { console.log('FAIL  facts reference unknown bullets:\n      ' + missing.join('\n      ')); fail++; }
else { console.log(`ok    all ${Object.keys(resume.facts || {}).length} facts resolve to real bullets`); pass++; }

const unstamped = [...bullets.values()].filter(b => !b.provenance);
if (unstamped.length) { console.log(`FAIL  ${unstamped.length} bullets have no provenance`); fail++; }
else { console.log(`ok    all ${bullets.size} bullets carry provenance`); pass++; }


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
