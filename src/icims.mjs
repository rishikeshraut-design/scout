// iCIMS — the platform the market feed can see but cannot describe.
//
//   import { iframeUrl, parsePosting, isCanadian, displayLocation } from './icims.mjs';
//
// The feed collects iCIMS by SITEMAP (`icims_sitemap` in its metadata.json), and a
// sitemap carries URLs, not fields. So all 254,808 iCIMS postings arrive with the
// literal location string "Not specified", classify() correctly drops every one,
// and 17% of the market is invisible with no error anywhere.
//
// The fix is one request. The public posting page is a JS shell, but its own
// iframe — the same URL plus `?in_iframe=1` — serves a complete JSON-LD
// JobPosting block carrying jobLocation, description, datePosted, validThrough,
// employmentType and hiringOrganization. Location AND body in one fetch.
//
// robots.txt on an iCIMS careers host disallows referral, login, candidate,
// reminder and connect paths, and publishes a sitemap. `/jobs/{id}/{slug}/job` is
// permitted — except that three of those rules are wildcards, so a slug containing
// referral, login or candidate is not. robotsAllows() is the check.
//
// WHY THE COUNTRY FIELD IS THE AUTHORITY AND THE STRING IS NOT.
// A real posting in this dataset reads addressRegion "CA" with addressCountry
// "US" — Huntington Beach, California. Handing "HUNTINGTON BEACH, CA" to
// classify() is the `ca` must never mean Canada trap, and "ONTARIO, CA" is worse:
// Ontario, California is a city of 175,000 and classify() matches `ontario` by
// name, case-insensitively. It would manufacture a Canadian row out of a
// Californian one. The structured addressCountry removes the guess entirely, so
// this module decides nationality from that field and never from the text.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CANADA = new Set(['ca', 'can', 'canada']);

export const LOCATIONS_TSV = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icims-locations.tsv');
export const LOCATIONS_COLUMNS = ['key', 'checked', 'country', 'location', 'remote', 'title'];

/**
 * The resolved-location cache, keyed by `keyOf(url)`.
 *
 * This lives HERE rather than in icims-locate.mjs on purpose: that file runs its
 * feed download at import, so importing it from scan.mjs would make every scan
 * pull 300MB before appending a row.
 */
export function readLocations(file = LOCATIONS_TSV) {
  if (!fs.existsSync(file)) return new Map();
  const m = new Map();
  for (const l of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
    if (!l.trim()) continue;
    const c = l.replace(/\r$/, '').split('\t');
    m.set(c[0], { key: c[0], checked: c[1], country: c[2], location: c[3], remote: c[4] === 'yes', title: c[5] });
  }
  return m;
}

/**
 * Whether the host's robots.txt permits fetching this posting. The rules are
 * `Disallow: /jobs/*referral`, `/jobs/*login` and `/jobs/*candidate` — wildcard
 * prefixes, so a "Candidate Experience Designer" posting is off limits whatever
 * the rest of its path says — plus a plain `/jobs/reminder`.
 */
export function robotsAllows(url) {
  let p;
  try { p = new URL(url).pathname; } catch { return false; }
  if (!p.startsWith('/jobs/')) return true;
  const rest = p.slice('/jobs/'.length).toLowerCase();
  return !/referral|login|candidate/.test(rest) && !rest.startsWith('reminder');
}

/** The iframe URL for a posting page — where the JSON-LD actually lives. */
export function iframeUrl(url) {
  try {
    const u = new URL(String(url));
    u.searchParams.set('in_iframe', '1');
    return u.toString();
  } catch { return null; }
}

/** Every JSON-LD block on the page, parsed, tolerating the ones that are not JSON. */
function ldBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html || '').matchAll(re)) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* a broken block is not a failure */ }
  }
  return out;
}

const day = v => {
  if (!v) return '';
  const d = new Date(String(v));
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
};

/**
 * `addressCountry` normalized, or '' when the posting does not say.
 *
 * iCIMS fills unknown address fields with the literal string "UNAVAILABLE" —
 * `streetAddress`, `postOfficeBoxNumber` and sometimes the country too. That is
 * the posting saying nothing, so it reduces
 * to '' rather than becoming a third spelling of "not Canadian" in the cache.
 */
function countryOf(place) {
  const a = place && place.address;
  const c = a && (a.addressCountry || a.addressCountryName);
  if (!c) return '';
  const s = String(typeof c === 'object' ? (c.name || c['@id'] || '') : c).trim().toLowerCase();
  return s === 'unavailable' ? '' : s;
}

export const isCanadian = country => CANADA.has(String(country || '').trim().toLowerCase());

/**
 * A location string classify() can read, built from structured parts rather than
 * echoed from the page. The country word is appended ONLY for Canada, and in full:
 * classify() matches `canada` by name and deliberately refuses the `ca` code, so
 * spelling it out is what makes the row resolvable without reintroducing the trap.
 */
export function displayLocation(place) {
  const a = (place && place.address) || {};
  const junk = v => !v || /^unavailable$/i.test(String(v).trim());
  const city = junk(a.addressLocality) ? '' : String(a.addressLocality).trim();
  const region = junk(a.addressRegion) ? '' : String(a.addressRegion).trim();
  const parts = [city, region].filter(Boolean);
  if (isCanadian(countryOf(place))) parts.push('Canada');
  return parts.join(', ');
}

/**
 * The JobPosting block, flattened. Returns null when the page carried none —
 * which is what the outer shell URL does, and is the tell that `?in_iframe=1`
 * was not used.
 *
 * `jobLocation` is an array and a posting may list several. A Canadian entry
 * anywhere in it makes the posting reachable, so prefer the first Canadian place
 * and fall back to the first place at all. Same spirit as Workday's multi-site
 * rows, and the opposite outcome: there the country was unknowable and the row
 * had to be dropped, here every place names its own country.
 */
export function parsePosting(html) {
  const post = ldBlocks(html).find(j => j && j['@type'] === 'JobPosting');
  if (!post) return null;

  const places = [].concat(post.jobLocation || []).filter(Boolean);
  const place = places.find(p => isCanadian(countryOf(p))) || places[0] || null;
  const org = post.hiringOrganization;

  return {
    title: post.title ? String(post.title).trim() : '',
    company: org && typeof org === 'object' ? String(org.name || '').trim() : String(org || '').trim(),
    body: post.description || '',
    country: countryOf(place),
    location: displayLocation(place),
    // TELECOMMUTE is schema.org's flag and iCIMS does emit it. Remote is a reach
    // question, not a country question, so it is reported rather than resolved.
    remote: String(post.jobLocationType || '').toUpperCase() === 'TELECOMMUTE',
    posted: day(post.datePosted),
    closes: day(post.validThrough),
    employment_type: post.employmentType
      ? String([].concat(post.employmentType)[0]).replace(/_/g, ' ').toLowerCase()
      : '',
    department: post.occupationalCategory ? String(post.occupationalCategory).trim() : '',
  };
}
