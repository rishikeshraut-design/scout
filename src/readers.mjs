// Board readers: given a board slug, return posting bodies keyed by `keyOf`.
//
// Shared by fetch-postings.mjs and add-posting.mjs. Two copies of a reader
// drift, and the failure is silent — one path keeps working while the other
// quietly returns nothing.
//
// Each reader is called as reader(slug, wanted) and returns
// `{ map }`, `{ map, soft }`, or `{ error }`.
//
//   map   posting key -> { body, format, title, company }
//   soft  keys whose fetch failed for a reason unrelated to the posting still
//         existing. The caller must not tombstone these.
//   error the board itself failed. Nothing under it can be judged.
//
// `wanted` is the postings this run needs. Most readers ignore it — one request
// returns the whole board and filtering afterwards costs nothing. Workday is
// the exception: no bulk description endpoint, so it asks per posting.
//
// `format` is 'html' wherever the API offers it. List structure is what tells a
// duty line from prose, and the plain-text variants throw that away.

import { keyOf } from './postings.mjs';
import { iframeUrl, parsePosting, robotsAllows } from './icims.mjs';
import { USER_AGENT as UA } from './config.mjs';

const TIMEOUT_MS = 15000;

async function req(url, init) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: c.signal });
    if (!r.ok) return { error: `http ${r.status}` };
    return { data: await r.json() };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally { clearTimeout(t); }
}

export const getJson = url =>
  req(url, { headers: { 'user-agent': UA, accept: 'application/json' } });

// Same failure contract as getJson, for a board that serves HTML rather than an
// API. iCIMS is the only one: its JSON-LD is embedded in the page.
export const getText = async url => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: c.signal, redirect: 'follow' });
    if (!r.ok) return { error: `http ${r.status}` };
    return { data: await r.text() };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally { clearTimeout(t); }
};

export const postJson = (url, body) =>
  req(url, {
    method: 'POST',
    headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * A board's own posted/closing date as an ISO day, or '' (decision 030):
 * Workday as `startDate`, Greenhouse `first_published`, Lever `createdAt` in
 * epoch milliseconds, Ashby `publishedAt`. This is the exact value; the ledger's
 * column is a proxy from the market feed, good to about a day.
 */
const day = v => {
  if (!v) return '';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
};

/** Slug as a company name when the API does not carry one: "the-hive" -> "The Hive". */
const fromSlug = s => String(s || '').split(/[-_]/).filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Dayforce serves every tenant checked from board 1; see the reader's note. */
const DAYFORCE_BOARD_ID = 1;

/**
 * Posting id out of a Dayforce candidate-portal URL, or null.
 *
 *   https://jobs.dayforcehcm.com/en-US/qfg/candidateportal/jobs/17653  ->  '17653'
 *
 * `ns` is checked rather than assumed: readers are called per board, and a URL
 * from a DIFFERENT tenant must not be fetched against this one's namespace —
 * that would ask the wrong board about the wrong posting and get a 404 the miss
 * logic could then misread. Returns null so the caller records it as soft.
 */
export function dayforceJobId(url, ns) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.hostname.toLowerCase() !== 'jobs.dayforcehcm.com') return null;
  const seg = u.pathname.split('/').filter(Boolean);
  // {lang}/{ns}/candidateportal/jobs/{id}
  const i = seg.indexOf('candidateportal');
  if (i < 1 || seg[i + 1] !== 'jobs') return null;
  if (ns && seg[i - 1].toLowerCase() !== String(ns).toLowerCase()) return null;
  return /^\d+$/.test(seg[i + 2] || '') ? seg[i + 2] : null;
}

export const READERS = {
  async greenhouse(slug) {
    // `?content=true` returns the body. It arrives *double* encoded;
    // postings.mjs decodes.
    const { data, error } = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    if (error) return { error };
    const m = new Map();
    for (const j of data.jobs || []) {
      if (j.absolute_url && j.content) {
        m.set(keyOf(j.absolute_url), {
          body: j.content, format: 'html', title: j.title, company: j.company_name || fromSlug(slug),
          posted: day(j.first_published), closes: day(j.application_deadline),
          department: (j.departments || []).map(d => d.name).filter(Boolean).join(', ') || undefined,
        });
      }
    }
    return { map: m };
  },

  // A Greenhouse board served from the company's own domain: the hostname says
  // `epicgames.com` or `stripe.com` and only `?gh_jid=` names the platform.
  // `keyOf` already preserves that parameter.
  //
  // Per posting rather than per board, because `greenhouse` above keys its map by
  // `boards.greenhouse.io` URLs and those never match a custom-domain row's key.
  //
  // THE BOARD TOKEN IS GUESSED, and the usual objection does not apply here.
  // "A slug that resolves is not the right company" holds when the board is the
  // only evidence — `fellow` resolves to a coffee brand in San Francisco. Here
  // the job id is the evidence: the same valid id returns 404 against the wrong
  // token, so a candidate answering 200 for THAT id is the right board by
  // construction.
  async greenhouse_job(hint, wanted = []) {
    const m = new Map();
    const soft = new Set();
    const misses = [];
    let proven = null;

    for (const w of wanted) {
      let id = null;
      try { id = new URL(w.url).searchParams.get('gh_jid'); } catch { /* unparseable */ }
      // Our own inability to read the URL is never evidence about the posting.
      if (!id || !/^\d+$/.test(id)) { soft.add(w.key); continue; }

      const candidates = proven ? [proven] : greenhouseTokens(hint, w.company);
      let job = null, networkFailed = false;
      for (const t of candidates) {
        const { data, error } = await getJson(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs/${id}`);
        if (!error) { job = data; proven = t; break; }
        // A 4xx is the board answering. Anything else — 5xx, timeout, DNS — is
        // the network, and must not be read as "wrong token, try the next one".
        if (!/^http 4\d\d$/.test(error)) networkFailed = true;
      }

      if (!job || !job.content) {
        if (networkFailed) soft.add(w.key); else misses.push(w.key);
        continue;
      }
      m.set(w.key, {
        body: job.content, format: 'html', title: job.title,
        company: job.company_name || w.company || fromSlug(String(hint).split('.')[0]),
        posted: day(job.first_published), closes: day(job.application_deadline),
        department: (job.departments || []).map(d => d.name).filter(Boolean).join(', ') || undefined,
      });
    }

    // 026's rule, one layer over: a 404 here is ambiguous between a delisted
    // posting and a token we never proved. A miss may only count as a delisting
    // once some token has answered on this host in the same run.
    if (!proven) for (const k of misses) soft.add(k);
    return { map: m, soft };
  },

  async ashby(slug) {
    const { data, error } = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    if (error) return { error };
    const m = new Map();
    for (const j of data.jobs || []) {
      const body = j.descriptionHtml || j.descriptionPlain;
      if (j.jobUrl && body) {
        m.set(keyOf(j.jobUrl), {
          body, format: j.descriptionHtml ? 'html' : 'text', title: j.title, company: fromSlug(slug),
          posted: day(j.publishedAt), employment_type: j.employmentType, department: j.department,
        });
      }
    }
    return { map: m };
  },

  async lever(slug) {
    // Lever is the best-structured of the six. `description` is the intro, then
    // `lists` is an array of { text: heading, content: "<li>…" } — the posting's
    // own section split, already labelled, which is exactly what the miner's
    // sectionKind() wants and what Greenhouse and Ashby make it infer.
    //
    // `descriptionPlain` comes back EMPTY on the boards checked, so read
    // `description`, not the plain field.
    const { data, error } = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (error) return { error };
    const m = new Map();
    for (const j of Array.isArray(data) ? data : []) {
      if (!j.hostedUrl) continue;
      const parts = [j.description || ''];
      for (const l of j.lists || []) {
        if (l.text) parts.push(`<h3>${l.text}</h3>`);
        if (l.content) parts.push(l.content);
      }
      if (j.additional) parts.push(j.additional);
      const body = parts.filter(Boolean).join('\n');
      if (body.trim()) {
        m.set(keyOf(j.hostedUrl), {
          body, format: 'html', title: j.text, company: fromSlug(slug),
          posted: day(j.createdAt), employment_type: j.categories?.commitment, department: j.categories?.team,
        });
      }
    }
    return { map: m };
  },

  // Gem exposes `descriptionHtml` on the same board query scan.mjs already
  // uses. `description`, `content`, `jobDescription` and `body` all return a
  // generic server error rather than a schema error, so the field name was
  // found by trying them — do not assume a different one exists.
  async gem(slug) {
    const { data, error } = await postJson('https://jobs.gem.com/api/public/graphql', {
      operationName: 'JobBoardBodies',
      query: `query JobBoardBodies($boardId: String!) {
        oatsExternalJobPostings(boardId: $boardId) {
          jobPostings { extId title descriptionHtml }
        }
      }`,
      variables: { boardId: slug },
    });
    if (error) return { error };
    const posts = data?.data?.oatsExternalJobPostings?.jobPostings;
    if (!Array.isArray(posts)) return { error: 'unexpected gem response' };
    const m = new Map();
    for (const j of posts) {
      if (j.extId && j.descriptionHtml) {
        m.set(keyOf(`https://jobs.gem.com/${slug}/${j.extId}`), { body: j.descriptionHtml, format: 'html', title: j.title, company: fromSlug(slug) });
      }
    }
    return { map: m };
  },

  // Workday has no bulk description endpoint, so this is one GET per posting.
  // That is why readers receive `wanted` — walking a 400-role board to collect a
  // handful would be absurd.
  //
  // The detail URL is not the URL in the ledger. scan.mjs stores the human page
  // (`{host}/en-US/{site}{externalPath}`); the JSON lives at
  // `{host}/wday/cxs/{tenant}/{site}{externalPath}`, so externalPath is
  // recovered from the stored URL rather than kept anywhere.
  async workday(slug, wanted = []) {
    const [tenant, site, pod] = String(slug).split('/');
    if (!tenant || !site || !pod) return { error: 'workday slug must be tenant/site/pod' };
    const host = `https://${tenant}.${pod}.myworkdayjobs.com`;
    const m = new Map();
    const soft = new Set();
    for (const w of wanted) {
      // Two URL shapes reach this reader and only one carries a locale:
      //   {host}/en-US/{site}/job/...   (the company scan)
      //   {host}/{site}/job/...         (the jobdata feed, decision 028)
      // So anchor on the site segment rather than assuming `/en-US/`.
      // Search from host.length so a site named like the tenant cannot match
      // inside the hostname.
      const at = w.url.indexOf(`/${site}/`, host.length);
      if (at < 0) { soft.add(w.key); continue; }
      const { data, error } = await getJson(`${host}/wday/cxs/${tenant}/${site}${w.url.slice(at + site.length + 1)}`);
      if (error) { soft.add(w.key); continue; }
      const info = data?.jobPostingInfo;
      if (info?.jobDescription) {
        m.set(w.key, {
          body: info.jobDescription, format: 'html', title: info.title,
          company: data?.hiringOrganization?.name || fromSlug(tenant),
          posted: day(info.startDate), closes: day(info.endDate), employment_type: info.timeType,
        });
      }
      // No body and no error means Workday answered and the posting is not
      // there — that IS a delisting, so it is left out of `soft`.
    }
    return { map: m, soft };
  },

  // Dayforce. Body-only, and that is a hard limit rather than an omission:
  // the board's LISTING endpoint (POST /api/geo/{ns}/jobposting/search) sits
  // behind Cloudflare bot management and answers 403 to every non-browser
  // client. **Do not add a `dayforce` entry to scan.mjs's
  // ATS map**, and do not try to defeat the check — this reader exists to read
  // ONE posting whose URL arrived from somewhere else (a paste, or a listing
  // source that indexes Dayforce). Its per-posting GET is open and unauthenticated.
  //
  // The board id is not in the posting URL. Every tenant checked — qfg, price,
  // lavieenrose, unisync — serves board 1, so that is the default; a tenant on
  // another board simply 404s, which the miss logic below treats as soft.
  async dayforce(slug, wanted = []) {
    const ns = String(slug || '').trim();
    if (!ns) return { error: 'dayforce slug must be the client namespace' };

    const m = new Map();
    const soft = new Set();
    const misses = [];
    let anyResolved = false;

    for (const w of wanted) {
      const id = dayforceJobId(w.url, ns);
      // Our own inability to parse the URL is never evidence about the posting.
      if (!id) { soft.add(w.key); continue; }

      const { data, error } = await getJson(
        `https://jobs.dayforcehcm.com/api/geo/${ns}/jobposting/${ns}/en-US/${DAYFORCE_BOARD_ID}/${id}`,
      );
      if (error) { misses.push(w.key); continue; }

      // Header, body and footer are three fields and the split is editorial,
      // not structural: the header is usually the benefits pitch and the footer
      // the compensation note, while requirements sit in the middle. Join all
      // three — mine-duties.mjs classifies sections itself and files a benefits
      // heading under `benefit`, so nothing here has to guess which part matters.
      const c = data?.jobPostingContent;
      const body = [c?.jobDescriptionHeader, c?.jobDescription, c?.jobDescriptionFooter]
        .filter(Boolean).join('\n');
      if (!body) { misses.push(w.key); continue; }

      anyResolved = true;
      // No company name anywhere in the payload — jobPostingAttributes carries
      // only PayType. fromSlug is the same fallback the workday reader uses, and
      // it is poor for initialisms ("qfg" -> "Qfg"); `add-posting --company` overrides.
      m.set(w.key, { body, format: 'html', title: data.jobTitle, company: fromSlug(ns) });
    }

    // A Dayforce 404 is ambiguous by construction: a delisted posting, a wrong
    // board id and a wrong namespace all return the identical 139-byte body.
    // So a miss only counts as a delisting when something else on the SAME board
    // resolved this run — that proves the namespace and board id are right, and
    // makes the 404 about the posting. If nothing resolved, every miss is soft
    // and nothing gets tombstoned. Tombstoning on an ambiguous 404 would record
    // "this job is closed" from what may be a configuration error.
    if (!anyResolved) for (const k of misses) soft.add(k);
    return { map: m, soft };
  },

  // iCIMS. Body-only here, like dayforce and bamboohr — but with a difference
  // that matters: iCIMS rows do not reach the ledger on their own, because the
  // feed gives them no location. `icims-locate.mjs` is what admits them; this
  // reader is what fills in the body afterwards. Both parse the same JSON-LD
  // through `icims.mjs`, so the location a row was admitted on and the location
  // its body reports can never disagree.
  async icims(slug, wanted = []) {
    const m = new Map();
    const soft = new Set();
    const misses = [];
    let anyResolved = false;

    for (const w of wanted) {
      const target = iframeUrl(w.url);
      if (!target || !robotsAllows(w.url)) { soft.add(w.key); continue; }

      const { data, error } = await getText(target);
      if (error) { misses.push(w.key); continue; }

      const post = parsePosting(data);
      // No JSON-LD at all is the tell that the shell was served instead of the
      // iframe — our problem, not evidence the posting is gone.
      if (!post) { soft.add(w.key); continue; }
      if (!post.body) { misses.push(w.key); continue; }

      anyResolved = true;
      m.set(w.key, {
        body: post.body, format: 'html',
        title: post.title || w.title,
        company: post.company || w.company || fromSlug(String(slug).split('.')[0]),
        posted: post.posted, closes: post.closes,
        employment_type: post.employment_type || undefined,
        department: post.department || undefined,
      });
    }

    // 026's rule again.
    if (!anyResolved) for (const k of misses) soft.add(k);
    return { map: m, soft };
  },

  // BambooHR reads as unfetchable because the careers
  // page is a JS shell whose only visible text is the word "BambooHR".
  // `/careers/{id}/detail` returns the whole opening as JSON — name, status,
  // location, datePosted and the description — and `robots.txt` disallows only
  // `/jobs/embed.php` and `/jobs/embed2.php`.
  //
  // Body-only, like dayforce (026): there is no `bamboohr` in scan.mjs's ATS map
  // and no `companies.tsv` row belongs to one, because a row there promises a
  // daily scan this cannot do. Rows arrive from the market feed, which does
  // carry BambooHR; Scout reads the body.
  async bamboohr(slug, wanted = []) {
    const sub = String(slug || '').trim();
    if (!sub) return { error: 'bamboohr slug must be the subdomain' };

    const m = new Map();
    const soft = new Set();
    const misses = [];
    let anyResolved = false;

    for (const w of wanted) {
      let id = null;
      try {
        const s = new URL(w.url).pathname.split('/').filter(Boolean);
        if (s[0] === 'careers') id = s[1];
      } catch { /* unparseable */ }
      if (!id || !/^\d+$/.test(id)) { soft.add(w.key); continue; }

      const { data, error } = await getJson(`https://${sub}.bamboohr.com/careers/${id}/detail`);
      if (error) { misses.push(w.key); continue; }

      const o = data?.result?.jobOpening;
      if (!o?.description) { misses.push(w.key); continue; }

      anyResolved = true;
      m.set(w.key, {
        body: o.description, format: 'html',
        title: o.jobOpeningName, company: fromSlug(sub),
        posted: day(o.datePosted),
        employment_type: o.employmentStatusLabel || undefined,
        department: o.departmentLabel || undefined,
      });
    }

    // Same rule as dayforce above, for the same reason.
    if (!anyResolved) for (const k of misses) soft.add(k);
    return { map: m, soft };
  },

  async remotive(arg) {
    const { data, error } = await getJson(`https://remotive.com/api/remote-jobs?category=${arg || 'design'}&limit=200`);
    if (error) return { error };
    const m = new Map();
    for (const j of data.jobs || []) {
      if (j.url && j.description) {
        m.set(keyOf(j.url), { body: j.description, format: 'html', title: j.title, company: j.company_name });
      }
    }
    return { map: m };
  },
};

/**
 * Work out which board a posting URL belongs to, as `{ provider, slug }`.
 *
 * Returns null when the URL cannot be resolved, which is not rare and is not a
 * bug: Greenhouse and Ashby both let a company serve a board from its own
 * domain, so `instacart.careers/job/?gh_jid=…` carries no slug in its host or
 * path. The caller asks for `--board` in that case rather than guessing.
 *
 * Greenhouse's custom domains are not in that set —
 * `gh_jid` names the platform and carries the job id, and `greenhouse_job`
 * proves a guessed board token against that id before trusting it. The
 * "a slug that resolves is not the right company" rule is unchanged and still
 * governs every other branch here: it is about a board being the ONLY evidence,
 * and for those rows the posting is the evidence instead. Ashby's custom domains
 * carry no equivalent parameter and still need `--board`.
 */
/**
 * Board-token candidates for a Greenhouse board on a company domain, best first.
 * Only ever guesses — `greenhouse_job` validates each against the job id, which
 * is what makes guessing safe there and nowhere else.
 */
const GH_PREFIX = /^(www|jobs|careers|career|job-boards|boards|apply|talent|recruiting)$/;

export function greenhouseTokens(hint, company) {
  const out = [];
  const push = v => {
    const s = String(v || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    // A subdomain prefix is never a board token, and every candidate costs a
    // request that can only 404.
    if (s && !GH_PREFIX.test(s) && !out.includes(s)) out.push(s);
  };
  const h = String(hint || '').toLowerCase();
  // A hint with no dot is already a board slug, lifted out of the path — the
  // multi-tenant hosts put it there (`app.careerpuck.com/job-board/<slug>/...`).
  if (h && !h.includes('.')) push(h);
  push(h.replace(/^[a-z0-9-]+\./, m => (GH_PREFIX.test(m.slice(0, -1)) ? '' : m)).split('.')[0]);
  push(h.split('.')[0]);
  push(company);
  return out.slice(0, 4);
}

export function providerFromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);

  if (host.endsWith('jobs.ashbyhq.com') && seg[0]) return { provider: 'ashby', slug: seg[0] };
  if (host.endsWith('jobs.lever.co') && seg[0]) return { provider: 'lever', slug: seg[0] };
  if (host.endsWith('jobs.gem.com') && seg[0]) return { provider: 'gem', slug: seg[0] };
  if (host.endsWith('greenhouse.io') && seg[0]) return { provider: 'greenhouse', slug: seg[0] };
  if (host.endsWith('remotive.com')) return { provider: 'remotive', slug: seg[1] || 'design' };

  // Two real shapes, and only one carries the language segment:
  //   {tenant}.{pod}.myworkdayjobs.com/en-US/{site}/job/...   (the company scan)
  //   {tenant}.{pod}.myworkdayjobs.com/{site}/job/...         (the jobdata feed)
  // So the site is the segment before `job`, never a fixed index — the same
  // shape the dayforce branch below has to handle, for the same reason.
  const wd = host.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (wd) {
    const j = seg.indexOf('job');
    const site = j >= 1 ? seg[j - 1] : (seg[1] || seg[0]);
    if (site) return { provider: 'workday', slug: `${wd[1]}/${site}/${wd[2]}` };
  }

  // jobs.dayforcehcm.com/{lang}/{ns}/candidateportal/jobs/{id} — the namespace
  // sits before `candidateportal`, not at seg[0], because the language leads.
  if (host === 'jobs.dayforcehcm.com') {
    const i = seg.indexOf('candidateportal');
    if (i >= 1 && seg[i + 1] === 'jobs') return { provider: 'dayforce', slug: seg[i - 1] };
  }

  // {host}.icims.com/jobs/{id}/{slug}/job. The whole host is the board, because
  // both `careers-acme.icims.com` and `acme.icims.com` occur and neither reduces
  // to a slug the API would take — there is no API.
  if (host.endsWith('.icims.com') && seg[0] === 'jobs' && /^\d+$/.test(seg[1] || '')) {
    return { provider: 'icims', slug: host };
  }

  // {sub}.bamboohr.com/careers/{id}. The subdomain is the board.
  const bam = host.match(/^([a-z0-9-]+)\.bamboohr\.com$/);
  if (bam && seg[0] === 'careers' && /^\d+$/.test(seg[1] || '')) {
    return { provider: 'bamboohr', slug: bam[1] };
  }

  // Last, because it is the only branch that reads the query string rather than
  // the host: a Greenhouse board on the company's own domain. Kept after every
  // hostname rule so a real Greenhouse URL carrying `gh_jid` still routes to the
  // board reader, which is cheaper — one request for a whole board.
  //
  // The slug here is a HINT, not an identity: the host, or the board slug when a
  // multi-tenant host puts one in the path. `greenhouse_job` turns it into
  // candidates and proves one against the job id.
  const ghJid = u.searchParams.get('gh_jid');
  if (ghJid && /^\d+$/.test(ghJid)) {
    const hint = seg[0] === 'job-board' && seg[1] ? seg[1] : host;
    return { provider: 'greenhouse_job', slug: hint };
  }

  return null;
}
