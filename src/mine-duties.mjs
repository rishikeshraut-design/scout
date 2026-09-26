// Mine stored postings into a duty bank (spec 001, decision 014).
//
//   node src/mine-duties.mjs          # write src/duty-bank.json
//   node src/mine-duties.mjs --print  # also print the top concepts per archetype
//
// Reads  src/postings/*.json
// Writes src/duty-bank.json
//
// The bank is a source of QUESTIONS, never of bullets. Nothing here writes
// resume.json, and nothing that reads the bank may. 013 names suggestion
// laundering as the way elicitation fabricates: a tool that proposes duties
// makes the human the rubber stamp. Keeping the bank structurally unable to
// reach the corpus is the mitigation.
//
// Deterministic and zero model calls, per the stack rule: this is line
// extraction and counting. Judgment happens later, in a skill, over a bank a
// human can already read.
//
// The unit of analysis is the CONCEPT, not the sentence: no two postings write
// a sentence the same way, so sentences never aggregate. Concepts collide
// across postings; sentences do not.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPostings, looksInjected } from './postings.mjs';
import { contentWords, stem } from './selection.mjs';
import { DUTY_BANK } from './paths.mjs';

const OUT = DUTY_BANK;
const PRINT = process.argv.includes('--print');

// ── archetypes ─────────────────────────────────────────────────────────────
// Title keywords, first hit wins — the cheap trick career-ops uses in
// modes/_shared.md. Deterministic and inspectable: when it is wrong it is
// visibly wrong, which a classifier would not be.

const ARCHETYPES = [
  ['research',       /\b(user research|ux research|researcher)\b/i],
  ['content',        /\b(content design|ux writ|content strateg|technical writ)/i],
  ['design-systems', /\bdesign system/i],
  ['design-eng',     /\b(ux engineer|design technologist|front[- ]?end)/i],
  ['brand-visual',   /\b(visual|graphic|brand|motion|creative|marketing design|illustrat)/i],
  ['product-design', /\b(product design|ux|u\/x|user experience|experience design|interaction design|ui design|designer)\b/i],
  // Deliberately limited to support and service work — the rest of the working
  // world gets `other` until there is a posting that needs naming. Inventing a
  // taxonomy ahead of the data is how this list stops being inspectable.
  //
  // It sits AFTER the design archetypes, and must stay there: "Customer
  // Experience Designer" matches `customer experience` here and `designer`
  // there, and it is a designer. Ordered the other way this widening would
  // have quietly reclassified CX and service-design roles out of design.
  ['client-service', /\b(customer|client) ?(service|support|success|experience|retention|care)\b|\b(product |technical )?(support|service) (specialist|representative|advisor|associate|agent|consultant)\b|\b(help ?desk|call cent(re|er)|teller|concierge)\b/i],
];

export const archetypeOf = title => (ARCHETYPES.find(([, re]) => re.test(String(title || '')))?.[0]) || 'other';

/** Seniority is a separate axis — a Staff designer still does designer duties. */
export const seniorityOf = title => {
  const t = String(title || '');
  if (/\b(vp|vice president|head of|director)\b/i.test(t)) return 'leadership';
  if (/\b(principal|staff|lead)\b/i.test(t)) return 'staff';
  if (/\b(senior|sr\.?)\b/i.test(t)) return 'senior';
  if (/\b(junior|jr\.?|associate|intern|entry)\b/i.test(t)) return 'junior';
  return 'mid';
};

// ── sections ───────────────────────────────────────────────────────────────
// What a posting asks you to DO and what it asks you to HAVE are different
// questions. Postings signpost the split; not all of them use <h> to do it.

// No trailing \b anywhere below. Several of these are deliberate prefixes —
// `responsibilit`, `qualification`, `requirement`, `benefit` — and a closing \b
// makes every one fail on its own plural: "Responsibilities" has no boundary
// between the `t` and the `i`.
//
// Order matters. `company` and `benefits` are tested first so "Why You'll ♥️
// Working at Loopio" cannot be read as a duty, and `requirements` precedes
// `duties` so "What You'll Bring To The Role:" is not captured by the bare
// "the role" alternative.
//
// Patterns are grouped per kind rather than crammed into one alternation,
// because several need their own anchor and a 300-character regex is not
// reviewable.
const SECTION = [
  // Marketing, culture, logistics and boilerplate. Lines under these are
  // dropped, not banked — "we're transforming the grocery industry" is not a
  // duty anyone can be asked whether they performed.
  ['company', [
    /\bwhy (join|work|you.?ll|we\b|our\b)/i,
    /\bwhy [a-z][a-z.'-]*\s*\?/i,                    // "Why Wealthsimple?"
    /\babout (us|the team|our|this (company|position))/i,
    /\ba bit more about|who we are|the vibe|icymi/i,
    /\bour (story|mission|values|culture|hiring process|approach to)/i,
    /\blife at\b|current open roles|join our\b|take your career/i,
    /\bwhere (we|you.?ll) work/i,
    /^remote,|^#|^note:/i,                           // "#LI-Remote", location lines
    /\bwe.?re transforming|flex first|existing vacancy/i,
    /\bdiversity|inclusion|accessibilit|equal opportunity/i,
    /\bhiring process|what you can expect from|please apply/i,
  ]],
  ['benefits', [
    /\bbenefit|perks|total rewards|what we offer/i,
    /\bcompensation|salary|ote range|pay range/i,
    // Questions are a common heading form here — "What's in it for you as an
    // employee of ...?" — and `headingLike` already passes them.
    /\bwhat.?s in it for you/i,
  ]],
  ['requirements', [
    /\bqualification|requirement/i,
    // `you will` spelled out, not only `you'll`. `you.?ll` cannot reach "you
    // will": after "you" it consumes one character and then demands "ll", which
    // " wi" is not.
    /\bwhat you(.?ll| will) (bring|need)|what you bring/i,
    /\bskills (you bring|we are|we.?re)/i,
    // Named skill headings. Deliberately NOT a bare /\bskills\b/ — this group is
    // tested before `duties`, so a bare match would take "Skills &
    // Responsibilities" away from it. Name the forms the corpus actually uses.
    /\b(must[- ]?have|soft|technical|hard|core|key) skills\b/i,
    /\bskills? (required|needed)\b|\bknowledge, skills\b|\babilities\b/i,
    /\babout you\b|who you are|nice to have/i,
    /\blooking for someone|you.?re probably someone|to be successful/i,
    // Same contraction gap: `we.?re` cannot reach "What We Are Looking For".
    /\bwhat we(.?re| are) looking for|you have\b|how you work/i,
    // The optional ask. The `coverage` skill's own heading table already names
    // "Bonus points for" as a real-but-optional requirement and tells the reader
    // to say so in the verdict. Benefits is tested before this group, so a
    // heading pairing it with a perk
    // still goes there.
    /\bbonus points?\b/i,
    // A tools list is an ask: the posting is naming what you will be expected to
    // work in.
    /\btech(nology)? stack\b/i,
    // "So are YOU our next ...? You are if you…" — a requirements heading phrased
    // as a question. A heading that names no section carries the previous one
    // forward (014). Written to the observed phrasing rather than a guessed
    // family.
    /\byou are if you\b/i,
  ]],
  ['duties', [
    // Folding `will` into the group covers all four forms of "what you'll do"
    // instead of enumerating the ones someone happened to hit.
    /\bwhat you(.?ll| will) (do|be doing)/i,
    // Bare `duties`, on purpose. Nothing in company, benefits or requirements
    // contains "duties", so a bare match cannot steal from a group tested
    // earlier.
    // `accountabilities` sits beside `responsibilities` in enterprise postings
    // and shares no stem with it. Nothing in company, benefits or requirements contains the
    // stem, so a bare match cannot steal from a group tested earlier.
    /\bresponsibilit|\bduties\b|\baccountabilit/i,
    // "The Product Support Specialist will:" — a heading that names the role and
    // ends in a colon is announcing what the role does.
    /\bwill:\s*$/i,
    /^the role|about the (job|role)/i,
    /\bday to day|in this role|your impact/i,
    /\bwhat success looks like|the opportunity/i,
  ]],
];

/**
 * The section a heading names, or `null` when it names none.
 *
 * `null` is not `other`, and the difference carries real weight: postings
 * group their duties under *topical* sub-headings — "Craft and
 * Quality", "AI & Agentic Mastery", "Cross-functional Partnership" — which no
 * keyword can catch. Returning null lets the caller keep the section already in
 * force, so those lines stay duties instead of collapsing to `other`.
 */
export const sectionKind = heading => {
  const t = String(heading || '');
  return SECTION.find(([, pats]) => pats.some(re => re.test(t)))?.[0] || null;
};

/**
 * Some postings carry no <h> at all — their sections are short bold
 * paragraphs. A `p` that is short and does not end like a sentence is acting as
 * a heading, so treat it as one.
 */
export const headingLike = b =>
  b.kind === 'h' || (b.kind === 'p' && b.text.length <= 60 && !/[.!?]$/.test(b.text));

/**
 * Walk a posting's blocks in document order, yielding every list item with the
 * section in force.
 *
 * `carriedOver` says whether the last heading above this line actually NAMED
 * its section, or whether the section persisted through a heading that named
 * nothing. Both callers need the walk; only `coverage.mjs` needs the flag, and
 * it needs it because the carry-over that 014 introduced deliberately — so
 * "Craft and Quality" keeps its lines in `duties` — also drags a posting's
 * career-growth tracks into `requirements`. That is a known cost, and a report
 * that cannot show which lines paid it is overstating its own precision.
 *
 * `heading` is the text of the last heading above this line, verbatim, whether
 * or not it named a section (decision 031). It exists because `carriedOver`
 * says only THAT the classifier was unsure, never what it was unsure about.
 * Five headings can reach `requirements` in one posting:
 * "What you bring:", "Bonus points for:", "You'll do well if you:", "It's not
 * you, it's us - you won't fit in if you:" and "Company advantages:" — a hard
 * ask, an optional one, a disposition, an inverted list and a benefit, all
 * arriving identical apart from this field.
 *
 * Extracted from mine-duties' own loop rather than copied: spec 003 R2 forbids
 * a second classifier, and a fork would drift from the cases test-mine covers.
 */
export function* sectionedLines(blocks, { start = 'other', paragraphs = false } = {}) {
  let section = start;
  let carriedOver = true;        // nothing has named a section yet
  // The most recent heading VERBATIM, named or not (decision 031). Deliberately
  // not the heading that last named a section: the ones worth seeing downstream
  // are precisely the ones sectionKind() rejects. No keyword list settles
  // whether a heading is asking or telling; the text itself does, one layer up.
  //
  // Additive on purpose. mine-duties ignores this field, so it cannot
  // reclassify the duty corpus.
  let heading = '';
  for (const b of blocks || []) {
    if (headingLike(b)) {
      heading = String(b.text ?? '').trim();
      const named = sectionKind(b.text);
      if (named) { section = named; carriedOver = false; }
      else carriedOver = true;
      continue;
    }
    if (b.kind === 'li') { yield { block: b, section, carriedOver, kind: 'li', heading }; continue; }

    // A requirement is not always a list item. A posting can write its hardest
    // filter as a bare paragraph:
    //
    //   ## Your qualifications should include:
    //   5+ years of experience working as a designer on cross-functional teams
    //   A portfolio with recent case studies that demonstrates:
    //     - ...
    //
    // Opt-in, and only inside a NAMED requirements section. Reading every
    // paragraph would flood the report with company prose. A
    // short unpunctuated paragraph was already consumed as a heading above,
    // which is what keeps "A portfolio with recent case studies that
    // demonstrates:" from becoming a requirement of its own.
    //
    // mine-duties does NOT opt in. A years line is not a duty anyone performed
    // — NOT_A_DUTY excludes it deliberately. `carriedOver` is the guard that
    // makes this safe; checking the section alone is not enough, because a
    // requirements label can carry past the list all the way to the footer.
    //
    // So: a LIST ITEM may rely on carry-over — that is what carry-over is for,
    // keeping topical sub-headings like "Craft and Quality" inside their
    // section. A PARAGRAPH may not. It is weaker evidence and needs the
    // stronger signal.
    // Three guards, and each is needed.
    if (paragraphs && b.kind === 'p' && section === 'requirements' && !carriedOver
        && looksLikeRequirement(b.text)) {
      yield { block: b, section, carriedOver, kind: 'p', heading };
    }
  }
}

// ── what counts as a duty line ─────────────────────────────────────────────

/**
 * Boilerplate that appears in list form but says nothing about the work. Kept
 * deliberately tight: over-filtering silently shrinks the bank, and a thin bank
 * that looks clean is worse than a noisy one you can see through.
 */
// Prose that is not a requirement and not a duty: legal boilerplate, benefits,
// compensation, recruiting copy. Split out from NOT_A_DUTY so coverage can
// reuse it WITHOUT the years rule below, which is the one exclusion the two
// callers disagree about.
const NOT_A_CLAIM = [
  /\b(equal opportunity|eeo|accommodat|discriminat|veteran status|protected class)/i,
  /\b(dental|vision|health (insurance|benefit)|rrsp|401k|parental leave|paid time off|pto|vacation|stock option|equity grant|talent development team|paid holiday)/i,
  /\b(salary range|compensation|base pay|base salary|per (hour|annum)|\$\s?\d{2,}|hours per week)/i,
  /^\s*(apply|click here|learn more|read more|see more|about us|who we are|to apply)/i,
  /\b(we are an?|we offer|our mission is|founded in|headquartered in|takes pride in)/i,
];

// A years line is not a DUTY — nobody performed "5+ years of experience". It IS
// a requirement, which is why coverage checks NOT_A_CLAIM instead of this.
const NOT_A_DUTY = [...NOT_A_CLAIM, /^\d+\+? years?\b/i];

/**
 * Could this line be something a posting asks a candidate to HAVE?
 *
 * Used for paragraphs admitted into the requirements list. The section guard
 * alone is not enough: it lets in salary ranges, accommodation statements,
 * benefits and "click Apply".
 */
export const looksLikeRequirement = t => {
  const s = String(t ?? "");
  return s.length >= 25 && s.length <= 400 && !NOT_A_CLAIM.some(re => re.test(s));
};

const isDutyLine = t =>
  t.length >= 25 && t.length <= 320 && /[a-z]/.test(t) && !NOT_A_DUTY.some(re => re.test(t));

/**
 * Surface form, cleaned for display. The text still reads as the posting wrote
 * it — this is quoted evidence, not a rewrite.
 */
export function normalizePhrase(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—•·*]+/, '')
    .replace(/^(and|or|also|plus)\s+/i, '')
    .replace(/[;,.]+\s*$/, '')
    .trim();
}

/**
 * Concepts in a line: stemmed content words, plus stemmed adjacent pairs.
 * Pairs are what make the bank specific — "design system", "user research" and
 * "cross functional" say something "design" alone does not. Shares stem() and
 * contentWords() with the lint so the bank and the safety floor cannot drift
 * into two vocabularies (spec R7).
 */
export function conceptsOf(text) {
  const keep = contentWords(text);
  const seq = String(text).toLowerCase().split(/[^a-z0-9'-]+/)
    .map(w => w.replace(/^['-]+|['-]+$/g, ''))
    .filter(w => keep.has(w))
    .map(stem);
  const out = new Set(seq);
  for (let i = 0; i + 1 < seq.length; i++) out.add(seq[i] + ' ' + seq[i + 1]);
  return out;
}

/** True when this file was run directly, false when imported by the tests. */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function main() {
  // ── run ────────────────────────────────────────────────────────────────────
  
  const postings = listPostings();
  if (!postings.length) {
    console.error('posting store is empty — run src/fetch-postings.mjs first');
    process.exit(1);
  }

  // Rebuilding from a smaller store would overwrite a good bank with a smaller
  // one, and the loss is invisible — a bank that is too small looks exactly like
  // a bank.
  //
  // Some of it is recoverable (fetch-postings re-fetches whatever jobs.tsv
  // lists) and some is not: postings added by hand with add-posting.mjs have no
  // ledger row, and anything supplied as pasted text cannot be re-fetched at all.
  if (fs.existsSync(OUT) && !process.argv.includes('--shrink')) {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const had = prev?.corpus?.postings ?? 0;
    if (postings.length < had) {
      console.error(`refusing to shrink the bank: ${had} postings recorded, ${postings.length} in the store.

Likely fixes:
  node src/fetch-postings.mjs     re-fetch everything jobs.tsv lists
  node src/add-posting.mjs <url>  re-add postings that have no ledger row

Postings added from pasted text cannot be re-fetched.
Pass --shrink if the smaller corpus is genuinely correct.`);
      process.exit(1);
    }
  }
  
  const groups = new Map();   // archetype -> { concepts: Map, lines: [] }
  const quarantined = [];
  let listLines = 0, kept = 0;
  
  for (const p of postings) {
    const archetype = archetypeOf(p.title);
    if (!groups.has(archetype)) groups.set(archetype, { concepts: new Map(), lines: [] });
    const g = groups.get(archetype);
  
    // Blocks are stored in document order, so the last heading seen is the
    // section this line sits under. Only a heading we RECOGNIZE changes the
    // section — an unrecognized one leaves the current section standing, so
    // topical sub-headings under "What you'll do" keep their lines as duties
    // rather than dropping them into `other`. `sectionedLines` owns that walk.
    for (const { block: b, section } of sectionedLines(p.blocks)) {
      listLines++;
  
      const phrase = normalizePhrase(b.text);
      if (!phrase) continue;
  
      // Decision 014: posting text is observed content. A line reading as an
      // instruction to whoever processes this document is quarantined, never
      // banked — this pipeline ends in resume prose, which is where such a line
      // would want to arrive.
      if (looksInjected(phrase)) {
        quarantined.push({ phrase, source: p.key, company: p.company, title: p.title });
        continue;
      }
  
      // Perks and company marketing are not things anyone can be asked whether
      // they did. Dropping them is the point of classifying them.
      if (section === 'benefits' || section === 'company' || !isDutyLine(phrase)) continue;
      kept++;
      g.lines.push({ phrase, section, company: p.company, posting: p.key });
  
      for (const c of conceptsOf(phrase)) {
        const hit = g.concepts.get(c) || { term: c, postings: new Set(), companies: new Set(), sections: new Set(), evidence: [] };
        hit.postings.add(p.key);
        hit.companies.add(p.company);
        hit.sections.add(section);
        if (hit.evidence.length < 3 && !hit.evidence.includes(phrase)) hit.evidence.push(phrase);
        g.concepts.set(c, hit);
      }
    }
  }
  
  /** Concepts at least two postings share, ranked by how many said them. */
  const shared = g => [...g.concepts.values()]
    .filter(c => c.postings.size >= 2)
    .map(c => ({
      term: c.term,
      postings: c.postings.size,
      companies: [...c.companies].sort(),
      sections: [...c.sections].sort(),
      evidence: c.evidence,
    }))
    .sort((a, b) => b.postings - a.postings || a.term.localeCompare(b.term));
  
  const archetypes = Object.fromEntries([...groups].sort().map(([name, g]) => {
    const mine = postings.filter(p => archetypeOf(p.title) === name);
    return [name, {
      postings: mine.length,
      companies: [...new Set(mine.map(p => p.company))].sort(),
      seniorities: [...new Set(mine.map(p => seniorityOf(p.title)))].sort(),
      // A concept only one posting mentions is noise at this corpus size; it stays
      // countable in `singletons` so thinness is visible rather than hidden.
      //
      // Phrases and terms are split because they are not equally useful. "design
      // system" and "pain point" are question material; "work", "team" and
      // "strong" are the words every posting uses and ask nothing. Ranking them
      // in one list buries the useful half, because the useless half is by
      // definition the more frequent.
      phrases: shared(g).filter(c => c.term.includes(' ')),
      terms: shared(g).filter(c => !c.term.includes(' ')),
      singletons: [...g.concepts.values()].filter(c => c.postings.size < 2).length,
      lines: g.lines,
    }];
  }));
  
  const bank = {
    generated: new Date().toISOString().slice(0, 10),
    // Provenance for the bank itself. The named risk in spec 001 is a thin corpus
    // read as authoritative, so the corpus states its own size at the top.
    corpus: {
      postings: postings.length,
      companies: [...new Set(postings.map(p => p.company))].sort(),
      listLines,
      keptLines: kept,
    },
    archetypes,
    quarantined,
  };
  
  fs.writeFileSync(OUT, JSON.stringify(bank, null, 2) + '\n', 'utf8');
  
  const totalPhrases = Object.values(archetypes).reduce((n, a) => n + a.phrases.length, 0);
  const totalTerms = Object.values(archetypes).reduce((n, a) => n + a.terms.length, 0);
  console.log(`${postings.length} postings | ${listLines} list lines | ${kept} kept | ${totalPhrases} shared phrases, ${totalTerms} shared terms`);
  console.log(`quarantined: ${quarantined.length}`);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  
  if (PRINT) {
    for (const [name, a] of Object.entries(archetypes)) {
      console.log(`\n── ${name} — ${a.postings} postings, ${a.phrases.length} shared phrases (${a.singletons} concepts seen once) ──`);
      for (const c of a.phrases.slice(0, 10)) {
        console.log(`  ${c.postings}/${a.postings}  ${c.term.padEnd(26)} ${c.sections.join(',')}`);
      }
    }
  }
}

if (isMain) main();
