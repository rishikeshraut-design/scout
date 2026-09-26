// The posting store (decision 014).
//
// Posting bodies live one-file-per-posting under `postings/`, keyed by the same
// `keyOf(url)` the ledger uses, so the store and `jobs.tsv` can never disagree
// about what "the same posting" means.
//
// Side-effect free on import — `scan.mjs` imports `keyOf` from here and must not
// pay for anything else.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORE } from './paths.mjs';

export const SRC = path.dirname(fileURLToPath(import.meta.url));
export { STORE };

/**
 * Tracking parameters, which say where a click came from and nothing about which
 * posting it is. Dropped so the same job reached two ways keys the same.
 */
const TRACKING = /^(utm_[a-z_]+|gh_src|ref|referer|referrer|source|src|lever-source(\[\])?|trk|trkid|mc_cid|mc_eid|fbclid|gclid|msclkid|igshid)$/i;

/**
 * Posting identity, shared by the ledger and the store.
 *
 * Dropping the whole query string would collapse boards that carry the job id
 * in a query parameter to one key, and every later posting would look
 * already-seen. "A URL we have not recorded before is new" only holds if the
 * URL survives keying.
 *
 * So: drop tracking parameters by name, keep everything else, and sort what
 * remains so parameter order cannot produce two keys for one posting.
 *
 * The one path-shape exception is Workday, which serves the SAME posting at two
 * URLs — `{host}/en-US/{site}/job/…` from the company scan and `{host}/{site}/job/…`
 * from the jobdata feed. Without this, a company in `companies.tsv` that the feed
 * also carries gets two ledger rows, two store files and two shortlist entries.
 *
 * Stripped for Workday hosts only. A locale never names a different posting (an
 * `/fr-CA/` and an `/en-US/` URL are one job in two languages), but `/xx-XX/` is an
 * ordinary path segment elsewhere and collapsing it globally would merge postings
 * that are genuinely distinct.
 */
const WORKDAY_HOST = /(^|\.)myworkdayjobs\.com$/i;
const LOCALE_SEG = /^\/[a-z]{2}-[a-z]{2}\//;

export function keyOf(url) {
  const raw = String(url || '');
  let u;
  try { u = new URL(raw); } catch { return raw.split('?')[0].replace(/\/+$/, '').toLowerCase(); }

  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => a.localeCompare(b));

  const origin = (u.origin || '').toLowerCase();
  let pathname = u.pathname.replace(/\/+$/, '').toLowerCase();
  if (WORKDAY_HOST.test(u.hostname)) pathname = pathname.replace(LOCALE_SEG, '/');
  const query = kept.map(([k, v]) => `${k.toLowerCase()}=${v}`).join('&');
  return origin + pathname + (query ? '?' + query : '');
}

/** Filesystem-safe name for a posting key. */
export const fileOf = key => key.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 180) + '.json';

export const postingPath = key => path.join(STORE, fileOf(key));
export const hasPosting = key => fs.existsSync(postingPath(key));
export const readPosting = key => JSON.parse(fs.readFileSync(postingPath(key), 'utf8'));

export function writePosting(key, record) {
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(postingPath(key), JSON.stringify(record, null, 2) + '\n', 'utf8');
}

/**
 * Postings with a body. Tombstones — postings the board no longer lists — are
 * stored so the fetcher stops retrying them, and skipped here so nothing tries
 * to mine a record that has no text. Pass `{ all: true }` to see them.
 */
export function listPostings({ all = false } = {}) {
  if (!fs.existsSync(STORE)) return [];
  const records = fs.readdirSync(STORE)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(STORE, f), 'utf8')));
  return all ? records : records.filter(r => !r.unavailable);
}

// ── text ───────────────────────────────────────────────────────────────────

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•',
};

/**
 * Decode HTML entities. Greenhouse returns its `content` field *double* encoded
 * — the payload literally contains `&lt;div&gt;` — so this runs before any tag
 * stripping, and runs twice where the first pass reveals more entities.
 */
export function decodeEntities(s) {
  let out = String(s ?? '');
  for (let i = 0; i < 2; i++) {
    const before = out;
    out = out
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
    if (out === before) break;
  }
  return out;
}

/**
 * HTML to blocks, keeping the distinction that matters for mining: a `<li>` is a
 * duty line, a `<p>` is usually prose, an `<h*>` is the section it sits under.
 * Everything else collapses to prose. Structure is the whole reason this stores
 * HTML rather than the `descriptionPlain` the same APIs offer.
 */
export function htmlToBlocks(html) {
  const s = decodeEntities(String(html ?? ''))
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n');

  const blocks = [];
  const re = /<(li|p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(s))) {
    const tag = m[1].toLowerCase();
    const text = tidy(m[2]);
    if (text) blocks.push({ kind: tag === 'li' ? 'li' : tag[0] === 'h' ? 'h' : 'p', text });
  }

  // A description with no markup at all still has to yield something — and it
  // has to yield the RIGHT thing. Pasted text is the `--text` path in
  // add-posting.mjs, used for boards with no reader, and a posting whose lines
  // all came back as `p` would store cleanly and contribute nothing at all to
  // the bank, because mine-duties.mjs reads only `li`. So a line that opens
  // with a list glyph is a list item, whatever the markup says.
  if (!blocks.length) {
    for (const line of tidy(s).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const bullet = /^[-*•·▪‣⁃]\s+/.test(t) || /^\d+[.)]\s+/.test(t);
      blocks.push({ kind: bullet ? 'li' : 'p', text: t.replace(/^[-*•·▪‣⁃]\s+|^\d+[.)]\s+/, '') });
    }
  }
  return blocks;
}

/** Strip remaining tags, normalize whitespace, drop bullet glyphs. */
export function tidy(fragment) {
  return decodeEntities(String(fragment ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/[•·●▪‣⁃]/g, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * A job description is observed content (decision 014). Text inside one that
 * addresses the reader as an instruction is data about the posting, never a
 * command to this project — and this store feeds a pipeline that ends in resume
 * prose, which is exactly where an injected line would want to land. Phrases
 * matching this are quarantined in the bank instead of banked as duties.
 */
// Precision matters more than reach here: a bare `you are an?` flags "You are a
// writer. You have exceptional communications skills", and `act as an?` would
// flag "act as a mentor to junior designers". Both are ordinary second-person JD
// prose. A false positive silently deletes a real duty line from the bank, so
// every alternative below has to name something a job description has no reason
// to say.
const AI_NOUN = String.raw`(ai|a\.i\.|assistant|language model|llm|chat ?bot|bot|agent)`;

export const INJECTION_RE = new RegExp([
  String.raw`ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instruction|prompt|direction|rule|message)`,
  String.raw`disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instruction|prompt|direction|rule|message)`,
  String.raw`system\s+prompt`,
  String.raw`you\s+are\s+now\s+an?\s`,
  String.raw`you\s+are\s+an?\s+` + AI_NOUN + String.raw`\b`,
  String.raw`act\s+as\s+an?\s+` + AI_NOUN + String.raw`\b`,
  String.raw`(follow|obey)\s+these\s+new\s+instructions?`,
  String.raw`new\s+instructions?\s*:`,
  String.raw`override\s+(the\s+|your\s+)?(previous\s+)?instructions?`,
  String.raw`prompt\s+injection`,
].join('|'), 'i');

export const looksInjected = text => INJECTION_RE.test(String(text ?? ''));
