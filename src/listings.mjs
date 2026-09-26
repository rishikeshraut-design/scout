// Listing readers: given a board, return every posting it currently advertises.
//
// Shared by scan.mjs and discover-boards.mjs. scan.mjs runs its whole network
// pass at import, so nothing defined inside it is reachable from another script.
// Two copies of a reader drift and the failure is silent, so there is exactly
// one definition and both callers import it.
//
// NOT the same thing as readers.mjs. That one fetches ONE posting body by URL;
// this one lists a whole board. Same boards, different questions, different shapes.
// Keep them apart: conflating them is how a body reader ends up pretending to be a
// scanner.
//
// Each source returns { jobs: [...normalized] } or { error }. An error is never an
// empty board — the caller must be able to tell a refusal from a quiet company.

import fsSync from 'node:fs';
import zlib from 'node:zlib';
import { WD_CANADA, USER_AGENT as UA } from './config.mjs';

const TIMEOUT_MS = 15000;

// Workday. The page size is not a preference — 20 is the maximum the API accepts
// and anything larger is rejected outright. The page cap is a runaway guard.
const WD_LIMIT = 20;
const WD_MAX_PAGES = 25;

// Gem's public board query, lifted verbatim from Gem's own JS bundle because
// introspection is disabled on the public endpoint.
const GEM_QUERY = `query JobBoardList($boardId: String!) {
  oatsExternalJobPostings(boardId: $boardId) {
    jobPostings {
      extId
      title
      locations { name city isoCountry isRemote }
    }
  }
}`;
// ── fetch ──────────────────────────────────────────────────────────────────
export async function getJson(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!r.ok) return { error: `http ${r.status}` };
    return { data: JSON.parse(await r.text()) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

// Workday and Gem both POST. Workday needs one request per page; Gem returns
// a whole board in one.
export async function postJson(url, body) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: c.signal,
      headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { error: `http ${r.status}` };
    return { data: JSON.parse(await r.text()) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

// ── sources ────────────────────────────────────────────────────────────────
// Each returns { jobs: [...normalized], error }.
// `posted` is the date the posting went up, as an ISO day or '' (decision 030).
// The ATS listings publish it as a field, and the market feed publishes
// `first_seen`.
const day = v => {
  if (!v) return '';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
};

export const norm = (company, title, location, url, remote, posted) =>
  ({ company, title, location: location || '', url, remote: !!remote, posted: day(posted) });

export const ATS = {
  async greenhouse(slug, name) {
    const { data, error } = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    if (error) return { error };
    return { jobs: (data.jobs || []).map(j => norm(name, j.title, j.location?.name, j.absolute_url, false, j.first_published)) };
  },
  async lever(slug, name) {
    const { data, error } = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (error) return { error };
    return { jobs: (data || []).map(j => norm(name, j.text, j.categories?.location, j.hostedUrl, /remote/i.test(j.workplaceType || ''), j.createdAt)) };
  },
  async ashby(slug, name) {
    const { data, error } = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    if (error) return { error };
    return { jobs: (data.jobs || []).map(j => norm(name, j.title, j.location, j.jobUrl, j.isRemote, j.publishedAt)) };
  },

  // Workday breaks every assumption greenhouse, lever and ashby share, so read
  // this before touching it.
  //
  //   - POST, not GET, and one POST per page.
  //   - `limit` is capped at 20. Asking for 50 returns http 400, not 20 rows.
  //   - A posting carries exactly three fields: title, externalPath,
  //     locationsText. There is no posted date and no remote flag. That costs
  //     nothing here — the first-seen ledger was never going to trust a board's
  //     date anyway — but it does mean `remote` is always false for Workday.
  //   - `locationsText` collapses a multi-site posting to "7 Locations", which
  //     contains no place name. Location is how this scanner filters, so those
  //     rows would silently vanish. The fix is to make the SERVER filter by
  //     country and then trust it; see below.
  //   - The slug is three fields, not one: tenant/site/pod.
  async workday(slug, name) {
    const [tenant, site, pod] = String(slug).split('/');
    if (!tenant || !site || !pod) return { error: 'workday slug must be tenant/site/pod' };
    const host = `https://${tenant}.${pod}.myworkdayjobs.com`;
    const api = `${host}/wday/cxs/${tenant}/${site}/jobs`;
    const page = (appliedFacets, offset) =>
      postJson(api, { appliedFacets, limit: WD_LIMIT, offset, searchText: '' });

    const all = await page({}, 0);
    if (all.error) return { error: all.error };
    if (typeof all.data?.total !== 'number') return { error: 'unexpected workday response' };

    // Does this tenant honour the country facet? If applying it narrows the
    // total, it does. If the total comes back unchanged the facet was ignored,
    // and an "7 Locations" row cannot then be assumed Canadian — so we say
    // nothing rather than guess, and classify() drops it.
    const ca = await page({ locationCountry: [WD_CANADA] }, 0);
    const faceted = !ca.error && typeof ca.data?.total === 'number' && ca.data.total < all.data.total;
    const facets = faceted ? { locationCountry: [WD_CANADA] } : {};
    const head = faceted ? ca.data : all.data;
    const total = head.total;

    const jobs = [];
    for (let offset = 0, p = 0; offset < total && p < WD_MAX_PAGES; offset += WD_LIMIT, p++) {
      const r = offset === 0 ? { data: head } : await page(facets, offset);
      if (r.error) break;
      for (const j of r.data.jobPostings || []) {
        const multi = /^\d+\s+locations?$/i.test(j.locationsText || '');
        const location = multi ? (faceted ? 'Canada' : '') : (j.locationsText || '');
        jobs.push(norm(name, j.title, location, host + `/en-US/${site}` + j.externalPath, false));
      }
    }
    return { jobs };
  },

  // Gem hands over what every other source makes us infer.
  //
  //   - POST, but one request returns the entire board. No paging.
  //   - `/api/public/graphql/batch` also works and takes an array of
  //     operations; the plain endpoint returns the same data without the
  //     wrapper, so use it.
  //   - A posting carries MANY locations, each with an ISO country code and
  //     its own `isRemote` boolean. That is the whole reason this reader
  //     earns its place: every other source hands classify() a prose string to
  //     pattern-match, where "Ontario, California" is indistinguishable from
  //     Ontario, Canada. Here we filter on isoCountry === 'CAN' FIRST and build
  //     the location string out of only those, so classify() never sees a
  //     foreign place name and never has to guess.
  //   - The slug is the board's vanity path: the last segment of the public
  //     board URL, so jobs.gem.com/axonify -> axonify.
  //   - Posting URLs are `/<board>/<extId>`, confirmed against Gem's own
  //     router (path:"/:boardId/:jobId"). The board is a single-page app that
  //     answers 200 to any path, so a status code proves nothing about a URL
  //     here — the extId came from the API and is what makes it valid.
  async gem(slug, name) {
    const { data, error } = await postJson('https://jobs.gem.com/api/public/graphql', {
      operationName: 'JobBoardList', query: GEM_QUERY, variables: { boardId: slug },
    });
    if (error) return { error };
    const posts = data?.data?.oatsExternalJobPostings?.jobPostings;
    if (!Array.isArray(posts)) return { error: 'unexpected gem response' };
    return {
      jobs: posts.map(j => {
        const all = j.locations || [];
        const ca = all.filter(l => l.isoCountry === 'CAN');
        const use = ca.length ? ca : all;
        // Bare country name rather than '' when a Canadian location is unnamed:
        // classify() reads '' as "no information" and would drop a real hit.
        const location = use.map(l => l.name).filter(Boolean).join('; ') || (ca.length ? 'Canada' : '');
        return norm(name, j.title, location, `https://jobs.gem.com/${slug}/${j.extId}`, use.some(l => l.isRemote));
      }),
    };
  },
};

export const BOARDS = {
  // The whole ATS market as one download, instead of one request per board.
  //
  // Feashliaa/job-board-data publishes every posting its pipeline holds as ~59
  // gzipped JSON chunks over GitHub Pages, rebuilt daily and pruned to 30 days.
  //
  // Why this is a BOARDS entry and not a sweep: it is a published dataset served
  // for consumption, MIT licensed, so there is no rate limit to respect, no
  // refusal to misread as an empty board, and no robots question. discover-boards
  // still exists for what this misses.
  //
  // Two things it does NOT carry, both load-bearing:
  //   - **No job description.** Titles and locations only, so bodies still come
  //     from `fetch-postings.mjs` through the per-platform readers. BambooHR,
  //     Paylocity and iCIMS have no body reader, so their rows land in the ledger
  //     readable only by hand.
  //   - **No Dayforce.** Seven platforms, and Dayforce is not among them (026).
  //
  // `first_seen` is THEIR ledger, not ours. It is a useful hint and never the
  // authority: scan.mjs decides what is new by `keyOf` against jobs.tsv, which
  // stays right even if this dataset resets, re-dates, or disappears.
  async jobdata(arg) {
    const base = 'https://raw.githubusercontent.com/Feashliaa/job-board-data/main/data';
    const meta = await getJson(`${base}/metadata.json`);
    if (meta.error) return { error: `metadata: ${meta.error}` };

    // Cache on the dataset's own timestamp. It is force-pushed once a run, so a
    // second scan the same day should cost nothing rather than 70MB.
    const stamp = String(meta.data?.last_updated || '').slice(0, 19);
    const cacheDir = new URL('../scratch/jobdata-cache/', import.meta.url);
    const cacheFile = new URL(`${stamp.replace(/[:T]/g, '-')}.json`, cacheDir);
    try {
      const cached = fsSync.readFileSync(cacheFile, 'utf8');
      return { jobs: JSON.parse(cached) };
    } catch { /* not cached yet */ }

    const CHUNKS = Number(arg || 60);
    const jobs = [];
    let missing = 0, failed = 0;
    let i = 0;
    const worker = async () => {
      while (i < CHUNKS) {
        const n = i++;
        const r = await fetch(`${base}/chunks/jobs_chunk_${n}.json.gz`, { headers: { 'user-agent': UA } });
        // A 404 is the end of the chunk list, which is expected — the count is not
        // published. Anything else is a refusal and must not pass as "no jobs".
        if (r.status === 404) { missing++; continue; }
        if (!r.ok) { failed++; continue; }
        try {
          const arr = JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
          for (const j of arr) {
            if (!j?.url || !j?.title) continue;
            jobs.push(norm(j.company, j.title, j.location, j.url, /remote/i.test(j.location || ''), j.first_seen));
          }
        } catch { failed++; }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));

    // Refuse the whole source rather than report a partial market as the market.
    // A silently short download looks exactly like a quiet day.
    if (failed) return { error: `${failed} chunk(s) failed to download — refusing a partial dataset` };
    if (!jobs.length) return { error: 'dataset returned no postings' };

    try {
      fsSync.mkdirSync(new URL('.', cacheDir), { recursive: true });
      fsSync.mkdirSync(cacheDir, { recursive: true });
      for (const f of fsSync.readdirSync(cacheDir)) fsSync.unlinkSync(new URL(f, cacheDir));
      fsSync.writeFileSync(cacheFile, JSON.stringify(jobs), 'utf8');
    } catch { /* cache is an optimisation, never a requirement */ }

    return { jobs };
  },

  async remotive(arg) {
    const { data, error } = await getJson(`https://remotive.com/api/remote-jobs?category=${arg || 'design'}&limit=200`);
    if (error) return { error };
    return { jobs: (data.jobs || []).map(j => norm(j.company_name, j.title, j.candidate_required_location, j.url, true)) };
  },
  async himalayas() {
    const { data, error } = await getJson('https://himalayas.app/jobs/api?limit=200');
    if (error) return { error };
    return { jobs: (data.jobs || []).map(j => norm(j.companyName, j.title, (j.locationRestrictions || []).join(', '), j.applicationLink || j.guid, true)) };
  },
};
