// Find which ATS a company uses, by probing its public board API.
//
// Slugs cannot be guessed reliably, and a wrong slug fails silently forever —
// a dead board looks exactly like "no new jobs". So every entry in companies.tsv
// is verified here before it earns a place.
//
//   node src/discover.mjs "Wealthsimple" "Vidyard" "Ada"
//   node src/discover.mjs --file candidates.txt
//
// Prints a companies.tsv block for everything that resolved.

import { USER_AGENT as UA } from './config.mjs';

const TIMEOUT_MS = 12000;
const CONCURRENCY = 6;
const PAUSE_MS = 120;

// Each returns a job count, or null when the slug does not exist there.
const ATS = {
  greenhouse: {
    url: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    count: j => (Array.isArray(j?.jobs) ? j.jobs.length : null),
  },
  lever: {
    url: s => `https://api.lever.co/v0/postings/${s}?mode=json`,
    // Lever returns [] for a live board with no openings AND for some bad slugs;
    // treated as a hit only when non-empty, to avoid parking dead slugs in the file.
    count: j => (Array.isArray(j) ? j.length : null),
  },
  ashby: {
    url: s => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    count: j => (Array.isArray(j?.jobs) ? j.jobs.length : null),
  },
};

// "The Fabrikam Group" -> thefabrikamgroup, fabrikamgroup, fabrikam-group, ...
function slugCandidates(name) {
  const base = name.toLowerCase().trim();
  const alnum = base.replace(/[^a-z0-9]+/g, '');
  const dashed = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const noStop = base.replace(/\b(the|inc|ltd|corp|group|labs?|technologies|tech|software|studio|co)\b/g, '').trim();
  const noStopAlnum = noStop.replace(/[^a-z0-9]+/g, '');
  const noStopDashed = noStop.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const first = base.split(/[^a-z0-9]+/)[0];
  return [...new Set([alnum, dashed, noStopAlnum, noStopDashed, first].filter(s => s && s.length > 1))];
}

async function getJson(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!r.ok) return null;
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ── Workday ────────────────────────────────────────────────────────────────
// Workday cannot be probed the way the other three are. Its board is addressed
// by three values, not one — tenant, site and the wd{N} pod the tenant sits on —
// and DNS is no help: *.wd{N}.myworkdayjobs.com is a wildcard, so every tenant
// name "resolves" on every pod whether it exists or not. Only the API answers,
// with 200 for a real board and 422 for anything else.
//
// So there are two paths, and the first is much better than the second:
//
//   1. Paste the board URL. Company careers pages link it, and that link is
//      authoritative. `node src/discover.mjs "https://x.wd3.myworkdayjobs.com/Careers"`
//   2. Guess. Only the plain-alphanumeric tenant is tried, against the common
//      pods and site names — 20 requests, and a miss does not mean absence.
const WD_PODS = ['wd1', 'wd3', 'wd5', 'wd10', 'wd103'];
const WD_SITES = ['External', 'Careers', 'careers', 'External_Career_Site'];
const WD_URL = /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/i;

async function wdProbe(tenant, pod, site) {
  const url = `https://${tenant}.${pod}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: c.signal,
      headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }),
    });
    if (r.status !== 200) return null;
    const d = JSON.parse(await r.text());
    return typeof d.total === 'number' ? d.total : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function probeWorkday(name) {
  const m = String(name).match(WD_URL);
  if (m) {
    const [, tenant, pod, site] = m;
    const n = await wdProbe(tenant, pod, site);
    // A pasted URL is not a display name; fall back to the tenant so the printed
    // row is something you can actually paste.
    if (n !== null) return { ats: 'workday', slug: `${tenant}/${site}/${pod}`, jobs: n, display: tenant };
    return null;
  }
  const tenant = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '');
  if (!tenant) return null;
  for (const pod of WD_PODS) {
    for (const site of WD_SITES) {
      const n = await wdProbe(tenant, pod, site);
      if (n !== null) return { ats: 'workday', slug: `${tenant}/${site}/${pod}`, jobs: n };
      await new Promise(r => setTimeout(r, PAUSE_MS));
    }
  }
  return null;
}

async function probeCompany(name) {
  // A pasted Workday URL is unambiguous — do not waste probes on the others.
  if (WD_URL.test(String(name))) {
    const wd = await probeWorkday(name);
    return wd ? { name, ...wd } : { name, ats: null };
  }
  for (const slug of slugCandidates(name)) {
    for (const [ats, spec] of Object.entries(ATS)) {
      const j = await getJson(spec.url(slug));
      const n = j === null ? null : spec.count(j);
      if (n !== null && n > 0) return { name, ats, slug, jobs: n };
      await new Promise(r => setTimeout(r, PAUSE_MS));
    }
  }
  const wd = await probeWorkday(name);
  if (wd) return { name, ...wd };
  return { name, ats: null };
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
      process.stderr.write('.');
    }
  }));
  process.stderr.write('\n');
  return out;
}

const args = process.argv.slice(2);
let names = args;
if (args[0] === '--file') {
  const fs = await import('node:fs');
  names = fs.readFileSync(args[1], 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
}
if (!names.length) { console.error('usage: node src/discover.mjs "Company Name" ...  |  --file list.txt'); process.exit(1); }

console.error(`probing ${names.length} companies across ${Object.keys(ATS).length} ATS...`);
const results = await pool(names, CONCURRENCY, probeCompany);

const hits = results.filter(r => r.ats);
const misses = results.filter(r => !r.ats);

// Tab-separated, matching companies.tsv — ats, slug, display name.
console.log('# verified — append to src/companies.tsv');
console.log('# READ THE JOB LOCATIONS ON THE BOARD BEFORE KEEPING A ROW.');
console.log('# A slug that resolves is not proof it is the right company: "fellow" is a');
console.log('# San Francisco coffee brand, "sanctuary" is in Texas.');
for (const h of hits.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`${h.ats}\t${h.slug}\t${h.display || h.name}\t# ${h.jobs} open roles at probe time`);
}
console.log(`\n# ${hits.length} resolved, ${misses.length} did not`);
if (misses.length) console.log('# no public board found: ' + misses.map(m => m.name).join(', '));
