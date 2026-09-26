// Deterministic resume renderer. No model calls — selection is judgment and
// happens before this runs; this turns a selection into HTML and PDF.
//
//   node src/build.mjs out/2026-01-15-litware-product-designer/selection.json
//
// selection.json:
//   {
//     "job":        { "company", "title", "url" },        // provenance only
//     "variant":    "product-designer",                    // key into resume.json variants
//     "title_line": "Product Designer",                    // optional override
//     "summary":    "ai_design",                           // optional override (summaries key)
//     "skills_order": ["design_tools", ...],               // optional category order
//     "bullets":    ["co_1_impact", "fb_1_ownership", ...],// experience bullets, order kept within a role
//     "projects":   ["compass_ownership", ...],            // at most one per project
//     "overrides":  { "co_1_impact": "text..." }           // optional synonym swaps, linted hard
//   }
//
// Enforced here, mechanically (decision 001):
//   - at most ONE bullet per achievement group
//   - every id must exist
//   - an override may not introduce a number absent from the source bullet,
//     and may not introduce a banned-vocabulary word

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadSelection, contactFields, segments, fmtDate, atsNormalize, SRC } from './selection.mjs';

const selPath = process.argv[2];
if (!selPath) { console.error('usage: node src/build.mjs <selection.json>'); process.exit(1); }

// Loading, linting and section assembly are shared with docgen.mjs; only the
// emitter below is specific to HTML and PDF.
const { sel, resume, contact, outDir, titleLine, summary,
        expSections, projSections, skillCats, stem, emphasis } = loadSelection(selPath);

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Bullet text may carry **emphasis**. Escape each span first, then wrap — the
// other order would let a < in the source escape into markup.
const rich = t => segments(t, emphasis).map(g => (g.bold ? `<b>${esc(g.text)}</b>` : esc(g.text))).join('');

// ── the typeface travels with the repo ─────────────────────────────────────
//
// Decision 006 picked Inter. Depending on it being INSTALLED on the machine is
// not durable and fails silently: on Windows a per-user install only becomes
// visible to Chromium after AddFontResourceW and a WM_FONTCHANGE broadcast,
// which is session-scoped. The CSS fallback chain does its job and the document
// is simply in the wrong typeface.
//
// Embedding the faces removes the dependency on every machine at once. The PDF
// subsets to the glyphs actually used, so the deliverable does not carry the
// ~1.6MB the HTML does.
//
// If the directory is missing the render still works and falls back — a missing
// font must never be a failed render — but it says so, because a silent fallback
// is exactly the failure this replaces.
const FONT_DIR = path.join(SRC, 'fonts');
const FACES = [
  ['Inter-Regular.ttf', 400, 'normal'],
  ['Inter-Bold.ttf', 700, 'normal'],
  ['Inter-Italic.ttf', 400, 'italic'],
  ['Inter-BoldItalic.ttf', 700, 'italic'],
];
const fontFaces = FACES.map(([file, weight, style]) => {
  const p = path.join(FONT_DIR, file);
  if (!fs.existsSync(p)) return null;
  const b64 = fs.readFileSync(p).toString('base64');
  return `@font-face { font-family: 'Inter'; font-weight: ${weight}; font-style: ${style};
    font-display: block; src: url(data:font/ttf;base64,${b64}) format('truetype'); }`;
}).filter(Boolean).join('\n  ');
if (!fontFaces) {
  console.warn(`warning: no faces found in src/fonts — rendering in the CSS fallback, not Inter.`);
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(contact.name)} — Resume</title>
<style>
  /* Decision 006 typography. Three sizes carry the document — 20pt name,
     10.5pt role and body, 9.5pt meta — and weight, caps and grey do the rest.
     One rule, under the header, replaces the five h2 underlines: five hairlines
     spend five lines of vertical space stating a boundary that caps and
     whitespace already state, and against a page budget that space is bullets. */
  ${fontFaces}
  @page { size: Letter; margin: 0.5in; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font: 10.5pt/1.36 Inter, Helvetica, Arial, sans-serif; color: #1a1a1a; }
  h1 { font-size: 20pt; }
  .titleline { font-size: 11pt; color: #333; margin-top: 1px; }
  .contact { font-size: 9.5pt; color: #444; margin-top: 3px; padding-bottom: 5px; border-bottom: 1.2px solid #1a1a1a; }
  h2 { font-size: 10pt; text-transform: uppercase; margin: 9px 0 3px; font-weight: bold; }
  .role { margin-bottom: 5px; }
  .rolehead { display: flex; justify-content: space-between; }
  .rolehead b { font-size: 10.5pt; }
  .dates { color: #444; font-size: 9.5pt; white-space: nowrap; padding-left: 12px; }
  .sub { color: #444; font-size: 9.5pt; margin-bottom: 1px; }
  ul { margin: 1px 0 0 14px; }
  li { margin-bottom: 1.5px; }
  .skills p { margin-bottom: 1px; }
  .skills b { font-weight: bold; }
  .edu p { margin-bottom: 1px; }
  .edu > div { margin-bottom: 3px; }
  /* A resume header with five blue underlined URLs is noise. The links are
     real — they resolve on click and survive the Docs import — they just do
     not announce themselves (decision 006's header is already dense). */
  a { color: inherit; text-decoration: none; }
</style></head><body>

<h1>${esc(contact.name)}</h1>
<div class="titleline">${esc(titleLine)}</div>
<div class="contact">${contactFields(contact)
  .map(row => row
    .map(f => (f.label ? `${esc(f.label)} ` : '') +
      (f.href ? `<a href="${esc(f.href)}">${esc(f.text)}</a>` : esc(f.text)))
    .join(' &nbsp;•&nbsp; '))
  .join('<br>')}</div>

<h2>Summary</h2>
<p>${rich(summary)}</p>

<h2>Education</h2>
<div class="edu">
${resume.education.map(ed => {
  const earned = [ed.grade && `Grade ${esc(ed.grade)}`, ed.honours && esc(ed.honours)].filter(Boolean).join(' &nbsp;•&nbsp; ');
  return `<div><p class="rolehead"><span><b>${esc(ed.degree)}</b> — ${esc(ed.institution)}, ${esc(ed.location)}</span><span class="dates">${esc(String(ed.start_date))} – ${esc(String(ed.end_date))}</span></p>${earned ? `<p class="sub">${earned}</p>` : ''}</div>`;
}).join('\n')}
</div>

<h2>Work Experience</h2>
${expSections.map(({ e, picks }) => `<div class="role">
  <div class="rolehead"><b>${esc(e.title)} — ${esc(e.company)}</b><span class="dates">${fmtDate(e.start_date)} – ${fmtDate(e.end_date)}</span></div>
  <div class="sub">${esc(e.location)}${e.company_description ? ' &nbsp;•&nbsp; ' + esc(e.company_description) : ''}</div>
  <ul>${picks.map(b => `<li>${rich(b.text)}</li>`).join('')}</ul>
</div>`).join('\n')}

<h2>Skills</h2>
<div class="skills">
${skillCats.map(c => `<p><b>${esc(c.category_label)}:</b> ${esc(c.keywords.join(', '))}</p>`).join('\n')}
</div>

${projSections.length ? `<h2>Projects</h2>
${projSections.map(({ p, picks }) => `<div class="role">
  <div class="rolehead"><b>${p.url ? `<a href="${esc(p.url)}">${esc(p.name)}</a>` : esc(p.name)}</b></div>
  <ul>${picks.map(b => `<li>${rich(b.text)}</li>`).join('')}</ul>
</div>`).join('\n')}` : ''}

</body></html>`;

// The output filename — jordan_example_litware.pdf — is derived in
// selection.mjs, so both renderers name their files the same way.
const htmlPath = path.join(outDir, `${stem}.html`);
// Decision 012: the template's own separators ("Title \u2014 Company", date
// ranges) never pass through loadSelection, so normalize the emitted document
// rather than the data alone.
fs.writeFileSync(htmlPath, atsNormalize(html), 'utf8');

// ── PDF via headless Chromium (Playwright's cached binary), else a system browser ─
// Same shape on all three platforms: look through Playwright's download cache
// first, then take whatever browser the machine already has. This workspace is
// meant to survive a clone to a Mac, so the only absolute paths permitted here
// are the conventional install locations — anything reachable through PATH is
// resolved through PATH instead.
//
// Order: $CHROME_PATH, Playwright's cache, PATH, conventional install locations.
// Returns null on a miss; the caller reports it and exits without a PDF.
const CHROMIUM = {
  win32: {
    cache: path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    execs: ['chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe'],
    onPath: [],
    // Edge sits at a fixed location on every Windows install and is never on
    // PATH, so this one has no PATH-resolved equivalent to prefer over it.
    installed: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  },
  darwin: {
    cache: path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    execs: [
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    ],
    onPath: ['chromium', 'google-chrome'],  // Homebrew shims, if there are any
    installed: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  },
  linux: {
    cache: path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright'),
    execs: ['chrome-linux/chrome', 'chrome-linux64/chrome'],
    // Every Linux packaging — apt, snap, the flatpak wrapper — lands on PATH
    // under one of these names, so Linux needs no hardcoded location at all.
    onPath: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
    installed: [],
  },
};

const isExe = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Minimal `which`: walk PATH here rather than spawn one, since `which` does not
// exist on Windows and `where` answers differently. The executable bit matters
// on POSIX — a directory or a stray data file of the same name must not win.
function resolveOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); } catch { continue; }
    if (isExe(p)) return p;
  }
  return null;
}

function findChromium() {
  const override = process.env.CHROME_PATH;
  if (override && isExe(override)) return override;

  const plat = CHROMIUM[process.platform];
  if (!plat) return null;

  try {
    for (const d of fs.readdirSync(plat.cache)) {
      if (!d.startsWith('chromium-') || d.includes('headless_shell')) continue;
      for (const sub of plat.execs) {
        const p = path.join(plat.cache, d, sub);
        if (isExe(p)) return p;
      }
    }
  } catch { /* no cache directory; fall through */ }

  for (const name of plat.onPath) {
    const p = resolveOnPath(name);
    if (p) return p;
  }
  for (const p of plat.installed) if (isExe(p)) return p;

  return null;
}

const browser = findChromium();
if (!browser) {
  console.error('no Chromium, Chrome or Edge found; set CHROME_PATH to a browser binary. HTML written, PDF skipped');
  process.exit(1);
}

const pdfPath = path.join(outDir, `${stem}.pdf`);
// pathToFileURL, not string concatenation: a POSIX path already opens with a
// slash, so a string prefix produces file://// on a Mac, and this also encodes
// the spaces a company name can leave in the output folder.
const fileUrl = pathToFileURL(htmlPath).href;
const r = spawnSync(browser, [
  '--headless', '--disable-gpu', '--no-pdf-header-footer',
  `--print-to-pdf=${pdfPath}`, fileUrl,
], { timeout: 60000 });
if (!fs.existsSync(pdfPath)) {
  console.error('PDF generation failed:', r.stderr?.toString().slice(0, 400));
  process.exit(1);
}

const bulletCount = expSections.reduce((n, x) => n + x.picks.length, 0);
const allPicks = [...expSections, ...projSections].flatMap(x => x.picks);
const spans = allPicks.map(b => segments(b.text, emphasis).filter(g => g.bold).length);

console.log(`ok: ${pdfPath}`);
console.log(`   ${bulletCount} experience bullets across ${expSections.length} roles, ${projSections.length} projects`);
console.log(`   variant=${sel.variant} title="${titleLine}"`);
console.log(`   emphasis: ${spans.reduce((a, b) => a + b, 0)} spans over ${spans.length} bullets, max ${Math.max(...spans)} in one`);
