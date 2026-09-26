// Put one specific posting into the corpus, without the scanner (spec 001).
//
//   node src/add-posting.mjs <url>
//   node src/add-posting.mjs <url> --board ashby:contoso     # custom domain
//   node src/add-posting.mjs <url> --text posting.txt        # no reader exists
//   node src/add-posting.mjs <url> --track                   # also log a jobs.tsv row
//
// Writes src/postings/<key>.json. Writes NOTHING else by default.
//
// Why this exists: the scanner was the only door into the corpus, and it is
// design-only by construction — TITLE_HIT in scan.mjs matches design, ux, ui,
// interaction, visual, creative, brand. So the ledger only ever held design
// postings, the store only ever held design bodies, and the duty bank could
// only ever grow design archetypes. This is the second door.
//
// It does NOT append to jobs.tsv unless asked. That file is the application
// record — a row in it means "I am pursuing this", and wanting a posting's text
// in the corpus is not the same thing as applying to it. `--track` when it is.

import fs from 'node:fs';
import path from 'node:path';
import { keyOf, hasPosting, readPosting, writePosting, htmlToBlocks } from './postings.mjs';
import { READERS, providerFromUrl } from './readers.mjs';
import { JOBS } from './paths.mjs';

const argv = process.argv.slice(2);
const flag = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? '') : null;
};
const has = name => argv.includes(`--${name}`);

const url = argv.find(a => /^https?:\/\//i.test(a));
const TRACK = has('track');
const FORCE = has('force');
const textFile = flag('text');
const boardArg = flag('board');
const titleArg = flag('title');
const companyArg = flag('company');

if (!url) {
  console.error(`usage: node src/add-posting.mjs <url> [--board ats:slug] [--text file] [--title T] [--company C] [--track] [--force]

  --board    when the URL carries no slug (Greenhouse and Ashby both allow a
             company's own domain, so instacart.careers/job/?gh_jid=... names
             no board anywhere in it)
  --text     a file holding the posting text, for boards with no reader
             (Shopify and Clio are self-hosted with no public JSON)
  --track    also append a jobs.tsv row with status=new
  --force    re-fetch a posting already in the store`);
  process.exit(1);
}

const key = keyOf(url);

/**
 * Append the ledger row. Append only, and only on request — the scanner's own
 * concurrency strategy is append-only for the same reason: a scheduled run and a
 * live session must not be able to clobber each other.
 *
 * status is always `new`. Storing a posting is not applying to it, and neither is
 * building a resume from it (decision 022).
 */
function track(record) {
  const clean = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  const today = new Date().toISOString().slice(0, 10);
  const rows = fs.existsSync(JOBS) ? fs.readFileSync(JOBS, 'utf8').split('\n').slice(1).filter(Boolean) : [];
  if (rows.some(r => keyOf(r.split('\t')[6]) === key)) {
    console.log('        jobs.tsv already has a row for this posting');
    return;
  }
  fs.appendFileSync(JOBS, [
    today, record.source, clean(record.company), clean(record.title), '', '', url, 'new', '', '', '', '',
  ].join('\t') + '\n', 'utf8');
  console.log('        jobs.tsv row appended (status=new)');
}

if (hasPosting(key) && !FORCE) {
  // The body is already captured, so there is nothing to fetch — but --track is
  // about the LEDGER, not the store, and the two are independent.
  console.log(`already stored: ${key}`);
  if (TRACK) track(readPosting(key));
  else console.log('nothing to do — pass --force to re-fetch, or --track to add the ledger row');
  process.exit(0);
}

let record;

if (textFile) {
  // Pasted text. Everything a reader would have supplied has to be given, so
  // ask rather than invent: archetypeOf() keys on the title, and a wrong title
  // files the posting under the wrong archetype where it silently skews counts.
  if (!fs.existsSync(textFile)) { console.error(`no such file: ${textFile}`); process.exit(1); }
  if (!titleArg) { console.error('--text needs --title: the archetype is derived from it'); process.exit(1); }
  const body = fs.readFileSync(textFile, 'utf8');
  record = {
    key, url, source: boardArg || 'manual', company: companyArg || 'unknown', title: titleArg,
    fetched: new Date().toISOString().slice(0, 10),
    format: /<[a-z][^>]*>/i.test(body) ? 'html' : 'text',
    blocks: htmlToBlocks(body),
    body,
  };
} else {
  const board = boardArg
    ? { provider: boardArg.split(':')[0], slug: boardArg.slice(boardArg.indexOf(':') + 1) }
    : providerFromUrl(url);

  if (!board || !READERS[board.provider]) {
    console.error(`cannot tell which board this URL belongs to: ${url}

Pass --board ats:slug (e.g. --board greenhouse:instacart), or supply the text
with --text if no reader covers that board.`);
    process.exit(1);
  }

  // Workday asks per posting, so it needs the shape fetch-postings passes.
  const { map, error, soft } = await READERS[board.provider](board.slug, [{ key, url }]);
  if (error) { console.error(`${board.provider}:${board.slug} — ${error}`); process.exit(1); }

  const hit = map.get(key);
  if (!hit) {
    const why = soft?.has(key)
      ? 'the fetch failed — try again rather than concluding anything'
      : 'the board answered and this posting was not on it, so it is closed or the URL is wrong';
    console.error(`no body for ${key}\n  ${why}`);
    process.exit(1);
  }

  record = {
    key, url,
    source: `${board.provider}:${board.slug}`,
    company: companyArg || hit.company || 'unknown',
    title: titleArg || hit.title || 'unknown',
    fetched: new Date().toISOString().slice(0, 10),
    // Board metadata, same as fetch-postings stores (decision 030). A posting
    // added by hand should not be poorer than one the scan found.
    ...(hit.posted ? { posted: hit.posted } : {}),
    ...(hit.closes ? { closes: hit.closes } : {}),
    ...(hit.employment_type ? { employment_type: hit.employment_type } : {}),
    ...(hit.department ? { department: hit.department } : {}),
    format: hit.format,
    blocks: htmlToBlocks(hit.body),
    body: hit.body,
  };
}

writePosting(key, record);

const li = record.blocks.filter(b => b.kind === 'li').length;
const h = record.blocks.filter(b => b.kind === 'h').length;
console.log(`stored  ${record.company} — ${record.title}`);
console.log(`        ${record.source} | ${li} list items, ${h} headings | ${key}`);

if (TRACK) track(record);

console.log('\nrun `node src/mine-duties.mjs` to fold it into the bank');
