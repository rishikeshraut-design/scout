// The selection contract, shared by every renderer.
//
// A selection.json names what goes on the page; this module turns it into
// resolved sections and rejects anything that violates decision 001. Both
// renderers import it, so a rule enforced here is enforced everywhere:
//
//   build.mjs   -> HTML + PDF   (the delivered file)
//   docgen.mjs  -> .docx        (the vehicle Google Docs imports)
//
// Decision 006 puts the emitters in separate files on purpose — HTML through
// Chromium has no path to a word-processor format. What they share is the
// loader and the contract, which is exactly this file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESUME, CONTACT } from './paths.mjs';

export const SRC = path.dirname(fileURLToPath(import.meta.url));

// Strip a UTF-8 BOM before parsing: Windows editors and PowerShell redirects
// add one, and JSON.parse rejects it. Cheap insurance on hand-edited files.
export const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

// ── vocabulary ban: the AI fingerprint list, applied to any text we alter ──
const BANNED = /\b(delve|realm|harness|unlock|tapestry|paradigm|cutting-edge|revolutioniz\w*|landscape|intricate|intricacies|showcas\w*|crucial|pivotal|meticulous\w*|vibrant|unparalleled|underscore|leverag\w*|synergy|innovative|game-chang\w*|testament|commendable|groundbreaking|foster\w*|holistic|garner\w*|accentuate|pioneering|trailblazing|unleash\w*|transformative|redefine|seamless\w*|robust|breakthrough|empower\w*|streamlin\w*|frictionless|elevate|effortless|insightful|mission-critical|visionary|disruptive|reimagine|unprecedented|leading-edge|synergize|democratize|state-of-the-art|immersive|turnkey|future-proof|supercharge|spearheaded)\b/i;

// ── ATS normalization (decision 012) ───────────────────────────────────────
// Legacy resume parsers mangle typographic Unicode. resume.json keeps
// em-dashes and curly apostrophes because that is how the text was written
// and verified, and rewriting a stored claim to satisfy a parser is an
// unlinted edit to a verified fact. So this runs at RENDER time instead, over
// every text surface AND over the emphasis lexicon — normalize one without the
// other and "crew of 5–6" stops matching "crew of 5-6".
const ATS_MAP = [
  [/[—–]/g, '-'],   // em-dash, en-dash
  [/[“”]/g, '"'],   // curly double quotes
  [/[‘’]/g, "'"],   // curly single quotes
  [/…/g, '...'],         // ellipsis
  [/​/g, ''],            // zero-width space
  [/ /g, ' '],           // non-breaking space
];
export const atsNormalize = t => ATS_MAP.reduce((s, [re, to]) => s.replace(re, to), String(t ?? ''));

/** Normalize every string in a loaded object, in place. Keys are left alone. */
export function normalizeInPlace(node) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => { if (typeof v === 'string') node[i] = atsNormalize(v); else normalizeInPlace(v); });
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') node[k] = atsNormalize(v);
      else normalizeInPlace(v);
    }
  }
  return node;
}

// ── token classes (decision 012) ───────────────────────────────────────────
// ONE definition of "what is a quantity", used by the lint and by the fact
// generator. If those two ever disagree the allow-list is decorative.
//
// The lookbehind is load-bearing: without it "Studio7" licenses the numeral 7
// across the corpus, and a fabricated "7 markets" then passes the lint.
const QTY_RE = /(?<![A-Za-z])[$₹£€]?\d[\d,.]*\s*(?:%|\+)?/g;
const NUMWORD_RE = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|single|dual|triple)\b/gi;
const ACRONYM_RE = /\b[A-Z][A-Z0-9&.\/]+\b/g;
const trimQty = s => s.replace(/^[^0-9$₹£€]+|[^0-9%+]+$/g, '');

/** The quantities and named entities a piece of text asserts. */
export function tokensOf(text) {
  const t = atsNormalize(text);
  const quantities = new Set(), entities = new Set();
  for (const m of t.match(QTY_RE) || []) { const v = trimQty(m); if (v) quantities.add(v); }
  for (const m of t.match(NUMWORD_RE) || []) quantities.add(m.toLowerCase());
  for (const m of t.match(ACRONYM_RE) || []) entities.add(m);
  const words = t.split(/\s+/);
  words.forEach((w, i) => {
    const c = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (i > 0 && /^[A-Z][a-z]/.test(c) && !/[.!?:]$/.test(words[i - 1])) entities.add(c);
  });
  return { quantities: [...quantities].sort(), entities: [...entities].sort() };
}

const STOP = new Set(('a an and are as at be been being both but by for from had has have her his if in into ' +
  'is it its more most no nor not of off on once only or other our out over own same she so some such than ' +
  'that the their them then there these they this those through to too under until up very was we were what ' +
  'when where which while who whom why will with you your each every any all can could did do does doing ' +
  'done during how just like made make making my new now per via across also after again against about ' +
  'above below down further here would should shall may might must am been').split(/\s+/));

/** The lowercase content words a piece of text uses. */
export const contentWords = text =>
  new Set(atsNormalize(text).toLowerCase().split(/[^a-z0-9'-]+/)
    .map(w => w.replace(/^['-]+|['-]+$/g, ''))
    .filter(w => w.length > 2 && !STOP.has(w)));

/**
 * Strip inflection only — never derivation.
 *
 * "scheduling" and "scheduled" are the same claim in two tenses, and making a
 * human accept every tense change would get accept_novel rubber-stamped, which
 * costs more than it buys. Derivational endings are deliberately left alone:
 * "negotiations" must NOT license "negotiating", because the corpus saying a
 * thing exists is not the corpus saying they did it.
 */
export const stem = w => {
  let s = String(w).toLowerCase().replace(/'s$/, '');
  for (const suf of ['ing', 'ed', 'es', 's']) {
    if (s.endsWith(suf) && s.length - suf.length >= 4) return s.slice(0, -suf.length);
  }
  return s;
};

/**
 * Every content word the corpus verifiably uses. Corpus-wide on purpose:
 * vocabulary is not a factual claim, so borrowing a word from another role is
 * a style choice, not an invention. Quantities and entities are NOT pooled
 * this way — see ownerScope().
 */
export function vocabulary(resume) {
  const words = new Set();
  const eat = t => contentWords(t).forEach(w => words.add(w));
  for (const e of [...resume.experience, ...resume.projects]) {
    eat([e.company, e.name, e.title, e.company_description, e.industry].filter(Boolean).join(' '));
    for (const b of e.bullets) eat(b.text);
  }
  Object.values(resume.summaries).forEach(eat);
  Object.values(resume.skills).forEach(c => { eat(c.keywords.join(' ')); eat(c.category_label); });
  (resume.education || []).forEach(d => eat(Object.values(d).filter(v => typeof v === 'string').join(' ')));
  (resume.emphasis || []).forEach(eat);
  return words;
}

/**
 * The quantities and entities one employer is allowed to assert.
 *
 * Owner-scoped rather than corpus-wide because "Figma" is true of a design role
 * and false of a retail one. A corpus-wide allow-list would cheerfully license
 * "Led a crew of 5-6 using Figma" — every token present, the claim invented.
 */
export function ownerScope(resume, ownerId) {
  const quantities = new Set(), entities = new Set();
  const owner = [...resume.experience, ...resume.projects].find(e => e.id === ownerId);
  if (!owner) return { quantities, entities };
  for (const b of owner.bullets) {
    const t = tokensOf(b.text);
    t.quantities.forEach(x => quantities.add(x));
    t.entities.forEach(x => entities.add(x));
  }
  for (const g of Object.values(resume.facts || {})) {
    if (g.owner !== ownerId) continue;
    (g.quantities || []).forEach(x => quantities.add(x));
    (g.entities || []).forEach(x => entities.add(x));
  }
  return { quantities, entities };
}

/**
 * Audit one rewritten bullet: return everything it introduces that the corpus
 * does not support. This decides whether a rewrite INVENTS, never whether it
 * is any good.
 */
export function auditOverride(sourceText, overrideText, resume, ownerId, accepted = []) {
  const ok = new Set(accepted.map(atsNormalize));
  const okLower = new Set([...ok].map(a => a.toLowerCase()));
  const scope = ownerScope(resume, ownerId);
  const src = tokensOf(sourceText);
  src.quantities.forEach(x => scope.quantities.add(x));
  src.entities.forEach(x => scope.entities.add(x));

  const srcWords = contentWords(sourceText);
  const vocab = vocabulary(resume);
  srcWords.forEach(w => vocab.add(w));
  const stems = new Set([...vocab].map(stem));
  const okStems = new Set([...okLower].map(stem));

  const got = tokensOf(overrideText);
  const ovWords = [...contentWords(overrideText)];
  const quantities = got.quantities.filter(x => !scope.quantities.has(x) && !ok.has(x));
  // A number word already reported as an invented quantity is not also reported
  // as unknown vocabulary — one fault, one line.
  const asQty = new Set(quantities.map(q => q.toLowerCase()));
  return {
    quantities,
    entities: got.entities.filter(x => !scope.entities.has(x) && !ok.has(x)),
    banned: ovWords.filter(w => !srcWords.has(w) && BANNED.test(w)),
    words: ovWords
      .filter(w => !stems.has(stem(w)) && !okStems.has(stem(w)) && !BANNED.test(w) && !asQty.has(w))
      .sort(),
  };
}

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmtDate = d => {
  const m = String(d || '').match(/^(\d{4})\.(\d{2})$/);
  return m ? `${MONTHS[Number(m[2])]} ${m[1]}` : String(d || '');
};

// Named for the recipient, not the contents. These files get attached to an
// application or dropped in Downloads, where "resume.pdf" from four companies
// is four indistinguishable files. The folder still carries the date and role;
// the filename carries the only thing you need when picking one off a list.
export const slug = s =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

// ── emphasis ──────────────────────────────────────────────────────────
// Emphasis is declared once, in resume.json's `emphasis` list, and applied at
// render time to whatever text a selection puts on the page. It is not markup
// inside the bullet: a term bolded in one angle of a group would otherwise be
// plain in the sibling angle, so which words stood out depended on which
// variant got picked. Declaring it once makes every variant agree.
//
// What belongs in the list: named technology, and the quantified claim.
// Not descriptions of the work — bolding the sentence is the same as bolding
// nothing.
const escapeRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compile a lexicon into one matcher. Longest term first, so 'Figma Make'
 *  wins over 'Figma'. Case-sensitive: these are proper nouns and figures. */
export function matcher(lexicon) {
  if (!lexicon || !lexicon.length) return null;
  const terms = [...lexicon].sort((a, b) => b.length - a.length).map(escapeRe);
  return new RegExp('(?<!\\w)(?:' + terms.join('|') + ')(?!\\w)', 'g');
}

/** Split text into [{ text, bold }] runs against a compiled matcher. */
export function segments(text, re) {
  if (!re) return [{ text: String(text), bold: false }];
  const s = String(text);
  const out = [];
  let last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), bold: false });
    out.push({ text: m[0], bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), bold: false });
  return out;
}

/**
 * The contact block, as ROWS of fields, with the ones that should be clickable
 * carrying a URL. Both renderers build their header from this, so a link that
 * works in the PDF is the same link that works after the Docs import.
 *
 * Rows, not one flat list, because the portfolio gets a row to itself (032).
 * On one row the line wraps and drops the portfolio alone onto the second — the
 * worst slot on the page for the highest-value link on a design resume.
 * Labelling it is what turns that second row from a wrap into a callout.
 *
 * The shape is rows rather than a flat list carrying a `break` flag on purpose:
 * a later consumer that maps and joins gets arrays where it wanted strings and
 * fails loudly, where an ignored flag would render a wrong header quietly.
 *
 * `label` renders as plain text before the link, so the hyperlink stays the
 * bare URL.
 */
export function contactFields(contact) {
  const url = v => (/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
  const rows = [
    [
      { text: contact.location, href: null },
      { text: contact.email, href: contact.email && `mailto:${contact.email}` },
      { text: contact.phone, href: contact.phone && `tel:${contact.phone.replace(/[^\d+]/g, '')}` },
      { text: contact.linkedin, href: contact.linkedin && url(contact.linkedin) },
    ],
    [
      { text: contact.portfolio, href: contact.portfolio && url(contact.portfolio), label: 'Portfolio:' },
    ],
  ];
  return rows.map(r => r.filter(f => f.text)).filter(r => r.length);
}

/**
 * Load and validate a selection. Throws nothing — on any violation it prints
 * every problem at once and exits, because a half-valid resume is worse than
 * no resume and the caller has no useful way to recover.
 */
export function loadSelection(selPath) {
  const sel = readJson(selPath);
  const resume = readJson(RESUME);
  const contact = readJson(CONTACT);
  const outDir = path.dirname(path.resolve(selPath));

  const fail = [];

  // ATS normalization, decision 012. Applied to the whole loaded object before
  // anything reads it, so every surface and the emphasis lexicon are normalized
  // together and stay matchable. resume.json on disk is untouched — the stored
  // text is the verified claim and only the render is normalized.
  normalizeInPlace(resume);
  normalizeInPlace(sel);

  const variant = resume.variants[sel.variant];
  if (!variant) fail.push(`unknown variant "${sel.variant}"`);
  const titleLine = sel.title_line || variant?.title_line || '';
  const summaryKey = sel.summary || variant?.summary;
  const summary = resume.summaries[summaryKey];
  if (!summaryKey) fail.push(`no summary: set "summary" on variant "${sel.variant}" or in the selection`);
  else if (typeof summary === 'string' && !summary.trim()) fail.push(`summary "${summaryKey}" is empty — write it in resume.json "summaries"`);
  else if (!summary) fail.push(`unknown summary "${summaryKey}"`);

  const allBullets = new Map();
  for (const e of [...resume.experience, ...resume.projects]) {
    for (const b of e.bullets) allBullets.set(b.id, { ...b, owner: e.id });
  }

  function resolveIds(ids, label) {
    const seenGroups = new Set();
    const out = [];
    for (const id of ids || []) {
      const b = allBullets.get(id);
      if (!b) { fail.push(`${label}: unknown bullet id "${id}"`); continue; }
      if (seenGroups.has(b.group)) { fail.push(`${label}: second bullet from group "${b.group}" (${id}) — one per group`); continue; }
      seenGroups.add(b.group);

      let text = b.text;
      const ov = sel.overrides?.[id];
      if (ov) {
        // Decision 012. An override may RESHAPE a verified claim; it may not
        // introduce one. Quantities and entities are checked against this
        // bullet's owner, never the whole corpus — see ownerScope().
        const novel = auditOverride(b.text, ov, resume, b.owner, sel.accept_novel || []);
        for (const n of novel.quantities) fail.push(`override on ${id} introduces quantity "${n}" — not asserted anywhere by ${b.owner}`);
        for (const n of novel.entities) fail.push(`override on ${id} introduces entity "${n}" — not asserted anywhere by ${b.owner}`);
        for (const n of novel.banned) fail.push(`override on ${id} introduces banned word "${n}"`);
        for (const n of novel.words) fail.push(`override on ${id} introduces "${n}" — no verified text in resume.json uses that word. If this is a synonym swap, list it in the selection's "accept_novel".`);
        text = ov;
      }
      out.push({ ...b, text });
    }
    return out;
  }

  const expBullets = resolveIds(sel.bullets, 'bullets');
  const projBullets = resolveIds(sel.projects, 'projects');

  const expSections = resume.experience
    .map(e => ({ e, picks: expBullets.filter(b => b.owner === e.id) }))
    .filter(x => x.picks.length);

  // Experience stays chronological (resume.json order); projects follow the
  // SELECTION's order — which project leads is itself a tailoring decision.
  const projSections = resume.projects
    .map(p => ({ p, picks: projBullets.filter(b => b.owner === p.id) }))
    .filter(x => x.picks.length)
    .sort((a, b) => sel.projects.indexOf(a.picks[0].id) - sel.projects.indexOf(b.picks[0].id));

  // A category may be narrowed to the keywords a posting actually asks for.
  // Selection only: every keyword must already exist in resume.json, so the
  // skills line is subject to the same rule as the bullets (decision 001).
  const skillCats = (sel.skills_order || Object.keys(resume.skills)).map(k => {
    const c = resume.skills[k];
    if (!c) { fail.push(`unknown skills category "${k}"`); return null; }
    const pick = sel.skills_keywords?.[k];
    if (!pick) return c;
    for (const w of pick) {
      if (!c.keywords.includes(w)) fail.push(`skills_keywords: "${w}" is not in category "${k}"`);
    }
    return { ...c, keywords: pick };
  }).filter(Boolean);

  if (fail.length) {
    console.error('SELECTION REJECTED:\n  ' + fail.join('\n  '));
    process.exit(1);
  }

  // A tailored selection names a posting and takes the company; a baseline
  // skeleton has no posting, so it carries `label` instead. Either way the
  // filename says which document this is — six files called jordan_example.pdf
  // is the problem the naming convention exists to prevent.
  // One compiled matcher per render, from the vocabulary resume.json declares.
  const emphasis = matcher(resume.emphasis);

  const stem =
    [slug(contact.name), slug(sel.job?.company || sel.label)].filter(Boolean).join('_') || 'resume';

  return { sel, resume, contact, outDir, titleLine, summary, expSections, projSections, skillCats, stem, emphasis };
}
