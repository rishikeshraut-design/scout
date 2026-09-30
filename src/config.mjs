// Scout's settings: which titles count as design roles, which places are in reach,
// and which titles the shortlist keeps. Edit these to aim Scout at a different search.

// ── title ──────────────────────────────────────────────────────────────────
// Loose on title by design. At 20-60 postings a week a tight regex silently
// drops good roles and you never learn what you missed. discover-boards.mjs
// asks the same question of a candidate board that the daily scan asks of a
// tracked one — a census that used a different title filter would propose
// companies the scan then ignores.
export const TITLE_HIT = /\b(design(er|ing)?|ux|ui|u\/x|u\/i|user experience|user interface|interaction|visual|creative|brand (designer|strategist)|branding|prototyp\w*|human factors|hci|content strategist|information architect|product analyst)\b/i;

// Only obvious non-matches. "UX Engineer" and "Design Technologist" must survive,
// so this never excludes on "engineer" alone — it names the wrong *disciplines*.
// The silicon terms keep a chip company from flooding a scan with "Physical
// Design Engineer" and "SoC RTL Design", which clear TITLE_HIT on the word
// "design". None of these words appear in a UX title.
export const TITLE_MISS = /\b(design verification|chip|circuit|mechanical|hardware|electrical|structural|hvac|cad|plant|manufacturing|rtl|soc|asic|fpga|semiconductor|silicon|physical design|account executive|sales|recruiter|controller|nurse|driver|welder|machinist)\b/i;

// ── place ──────────────────────────────────────────────────────────────────
// The Toronto-Waterloo corridor. Deliberately a place list rather than a radius —
// there is no geocoding here and none is wanted.
export const ONTARIO_NEAR = /\b(toronto|waterloo|kitchener|guelph|mississauga|etobicoke|brampton|oakville|markham|vaughan|richmond hill|scarborough|north york|barrie|oshawa|pickering|ajax|whitby|gta|greater toronto)\b/i;

// Corridor cities that are ALSO cities elsewhere. These name the corridor only
// when something else in the same string says Canada — a bare "Cambridge" is
// more often Massachusetts or England. Before adding a corridor city anywhere,
// ask whether a place abroad shares the name; if it does, it belongs here.
export const ONTARIO_AMBIGUOUS = /\b(cambridge|hamilton|burlington|milton|newmarket)\b/i;

// Somewhere that is definitely not Canada. Used only to tell a bare "Cambridge"
// — which really might be the Ontario one, a commutable 100km from Toronto —
// apart from "Cambridge, MA", which is not. Deliberately a short list of the
// markers that actually appear in this ledger; it decides nothing on its own.
export const FOREIGN_NAME = /\b(united states|usa|united kingdom|england|scotland|ireland|india|singapore|australia|germany|france|netherlands|poland|brazil|mexico|japan|israel|new zealand|auckland|massachusetts|california|new york|texas|washington|illinois|colorado|georgia|florida|virginia|oregon|utah|arizona|vermont|connecticut|new jersey|pennsylvania|michigan|ohio)\b/i;

// State CODES, case-sensitive against the raw string for the same reason
// CANADA_CODE is: "MA" is Massachusetts and the word "ma" is not.
export const FOREIGN_CODE = /\b(MA|CA|NY|TX|WA|IL|CO|GA|FL|VA|OR|UT|AZ|VT|CT|NJ|PA|MI|OH|UK|US|USA)\b/;

// Country and province NAMES, matched case-insensitively against the lowercased
// string. `can` is here because boards really do write it, as in "(CAN)".
//
// `ca` is deliberately absent and must stay absent — it is California far more
// often than Canada ("Palo Alto, CA"), and adding it would flood the ledger with
// US roles. Two-letter province codes are handled by CANADA_CODE instead.
//
// The city list is short on purpose. Province codes and province names already
// catch "Vancouver, BC" and "Calgary, Alberta", so a city only earns a place here
// if it is unambiguous. Ottawa, Halifax, Victoria, London, Windsor, Kingston and
// Richmond are all US or UK cities too, and are left out for that reason.
export const CANADA = /\b(canada|canadian|can|ontario|british columbia|alberta|quebec|québec|manitoba|saskatchewan|nova scotia|newfoundland|labrador|prince edward island|yukon|northwest territories|nunavut|vancouver|montreal|montréal|calgary|edmonton|winnipeg|saskatoon|gatineau)\b/;

// Province names that are ALSO places abroad: New Brunswick is a city in New
// Jersey. These count as Canada UNLESS something in the same string names a
// place outside it (FOREIGN_NAME or FOREIGN_CODE). That is the opposite default
// from ONTARIO_AMBIGUOUS, on purpose: "Moncton, New Brunswick" carries no other
// Canadian marker, so demanding one would drop real Canadian roles.
export const CANADA_AMBIGUOUS = /\b(new brunswick)\b/;

// Province CODES, matched case-SENSITIVELY against the original string, never the
// lowercased one. That is the whole point: "Toronto, ON" names a province and the
// English word "on" does not, and /\bon\b/i cannot tell them apart — a phrase like
// "work on site" would classify as Canada. Boards write these in caps. None of
// the thirteen collides with a US state code.
export const CANADA_CODE = /\b(ON|BC|AB|QC|MB|SK|NS|NB|NL|PE|YT|NT|NU)\b/;

export const REMOTE = /\bremote|work from home|distributed|anywhere\b/i;
export const REMOTE_OK = /\b(canada|canadian|north america|americas|anywhere|worldwide|global)\b/i;
export const REMOTE_NOT = /\b(us only|u\.s\. only|usa only|united states only|us-based only|eu only|uk only|europe only)\b/i;

// A remote posting that names no place at all. "Remote", "Flexible / Remote" and
// "Fully Remote" are the same claim. Strip the remote vocabulary and everything
// that is not a letter; if nothing survives, no place was named.
//
// This stays deliberately strict about the other direction: "United States -
// Remote" leaves "unitedstates" behind and is rejected, which is correct. Decision
// 014's rule holds — dropping a row is recoverable, labelling it with a country it
// may not have is not.
export const REMOTE_WORDS = /\b(remote|remotely|fully|flexible|anywhere|hybrid|work from home|wfh|distributed|global|worldwide)\b/gi;

// ── shortlist scope ───────────────────────────────────────────────────────────
//
// NO TRAILING \b ON ANY PREFIX. `/\bproduct design\b/` does not match "Product
// Designer" — there is no word boundary between `design` and `er`.
// test-shortlist.mjs asserts every term below against its -er and plural forms.

/** Wrong discipline. Checked BEFORE inclusion — exclusion always wins. */
export const OUT_OF_SCOPE = new RegExp([
  // EVERY TOKEN IN THIS LIST MUST NAME A DISCIPLINE, NEVER A DOMAIN. `growth`
  // names what part of the product the work points at, not what kind of work it
  // is: a product designer on the growth team is a product designer. Every
  // growth-MARKETING title is already caught — `Designer, Growth Marketing` by
  // `marketing` below, and the creative-strategist ones by failing IN_SCOPE.
  // Do not add `platform`, `core`, `lifecycle` or any other domain word here.
  'graphic', 'marketing', 'social media', 'advertis', 'campaign', 'copywrit',
  'game', 'gameplay', 'level design', 'combat', 'sound design',
  'technical artist', '3d artist', 'character artist', 'environment artist', 'narrative design',
  'mechanical', 'industrial design', 'architectur', 'packaging', 'textile', 'apparel',
  'interior design', 'civil', 'electrical', 'electronic', 'design engineer', 'systems design',
  'quantum', 'photonics',
  // Learning design is its own profession and it clears every loose design
  // match, so `instructional` alone is not enough.
  'instructional', 'curriculum', 'e-learning', 'learning design',
  'learning experience', 'learning and experience', 'learning technolog',
  // Front-end development. `engineer` alone must NEVER go in this list — "UX
  // Engineer" and "Design Technologist" are design roles — so these name the
  // specific dev titles that clear IN_SCOPE on "ui".
  'developer', 'programmer', 'full-stack', 'fullstack',
  'ui engineer', 'front-end', 'front end', 'frontend', 'web engineer',
  // French. `concepteur` is in IN_SCOPE because postings are often French or
  // bilingual, but "concepteur logiciel" is a software developer, not a
  // designer.
  'logiciel', 'developpeur', 'développeur',
  'motion design', 'animator', 'video editor',
  'landscape', 'transportation', 'presentation design',
  'outlet', 'store', 'merchandis',
].join('|'), 'i');

/** In scope. Brand and visual stay; graphic and marketing go. */
export const IN_SCOPE = new RegExp([
  '\\bux\\b', '\\bui\\b', '\\bu/x\\b', '\\bu/i\\b',
  'user experience', 'user interface', 'experience design', 'interaction design',
  'product design', 'product manage', 'product analyst', 'product lead',
  'service design', 'design technologist', 'information architect',
  'human factors', '\\bhci\\b', 'user research', 'design research',
  'digital design', '\\bbrand\\b', 'visual design',
  // Content DESIGN is a UX discipline — UI copy, labels, error states, the
  // information architecture of words. Content STRATEGY is not — its titles are
  // YouTube, SEO, short-form, video and advocacy. So this matches the design
  // half only.
  // **Do not widen it to `content strateg`.** `UX Writer` already passes on
  // `\bux\b`, and a marketing content title is caught by `marketing` above.
  'content design',
  // Three narrow terms, each a discipline already in band. A bare
  // `\\bdesigner\\b` was REJECTED: it admits piping, embedded software and
  // concept art.
  //
  // French. `concepteur`/`conceptrice` covers one Quebec phrasing and not the
  // other: "Designer de produit senior.e" and "Designer Produit" are product
  // design roles that matched nothing.
  'designer\\s+(?:de\\s+)?produits?',
  // `\\bui\\b` and `u/i` are both here; `uiux` is the same token written without
  // a separator, so the word boundary never fires.
  '\\buiux\\b',
  // Web design is in band, and `digital design` catches only some of it.
  'web\\s*designer', 'designer\\s+web',
  'concepteur', 'conceptrice',            // 31 rows are French or bilingual
].join('|'), 'i');

// ── Workday ───────────────────────────────────────────────────────────────────
// Workday's global reference id for Canada, identical across tenants.
export const WD_CANADA = 'a30a87ed25634629aa6c3958aa2b91ea';

// ── identity ─────────────────────────────────────────────────────────────────
// How every request introduces itself. Names the tool and nothing else.
export const USER_AGENT = 'scout/0.1 (personal job search)';
