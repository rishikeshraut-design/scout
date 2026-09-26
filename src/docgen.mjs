// The editable master. Decision 006:
//
//   resume.json -> generated document -> Google Docs -> PDF
//
//   node src/docgen.mjs out/2026-01-15-litware-product-designer/selection.json
//   node src/docgen.mjs <selection.json> --font="Helvetica Neue"
//
// The .docx this writes is an IMPORT VEHICLE, not a deliverable. Upload it to
// Google Docs, edit there, export PDF from there. Never export Word back out of
// Docs — that round trip is the one thing decision 006 forbids, because Docs and
// Word disagree on font substitution, line-height, letter-spacing and
// widow/orphan control, and none of it is fixable by layout.
//
// Single column only. Decision 009 retired --two-column: it was never ATS-safe,
// and a sidebar with no background of its own does not read as a column anyway.
//
// Selection loading and linting are shared with build.mjs via selection.mjs, so
// a selection this accepts is exactly a selection the PDF renderer accepts.

import fs from 'node:fs';
import path from 'node:path';
import { loadSelection, contactFields, segments, fmtDate, atsNormalize } from './selection.mjs';
import { docx, para, run, tab, hyperlink } from './docx.mjs';

const args = process.argv.slice(2);
const selPath = args.find(a => !a.startsWith('--'));
if (!selPath) {
  console.error('usage: node src/docgen.mjs <selection.json> [--font=NAME]');
  process.exit(1);
}
const fontArg = args.find(a => a.startsWith('--font='));

// Decision 006's type spec names Inter. Docs pulls its extended list from Google
// Fonts, where Inter lives, but a font the target does not have is substituted
// silently — so this is one flag away from being changed without a code edit.
const FONT = fontArg ? fontArg.slice('--font='.length).replace(/^"|"$/g, '') : 'Inter';

const { sel, resume, contact, outDir, titleLine, summary,
        expSections, projSections, skillCats, stem, emphasis } = loadSelection(selPath);

// Twips. Letter is 12240 wide; 0.5in margins leave 10800 of text.
const FULL = 10800;

// Three sizes carry the document — 20pt name, 10.5pt role and body, 9.5pt meta.
// Weight, caps and grey do the rest (decision 006). The skills block is body
// size, because it is scanned.
const NAME = 20, BODY = 10.5, META = 9.5, HEAD = 10;
const GREY = '444444', SUBTLE = '333333', LINK = '1A1A1A';

// Every external link needs a relationship id; docx() writes them into
// document.xml.rels. Registering here keeps the ids and the targets in step.
const links = [];
const linkId = url => {
  const id = `rIdLink${links.length + 1}`;
  links.push({ id, url });
  return id;
};

// No letter-spacing on the headings. Docs has no native tracking and drops
// w:spacing outright on import. Asking for it only makes the PDF preview
// disagree with the file that actually gets sent.
const heading = text =>
  para(run(text, { size: HEAD, bold: true, caps: true }),
       { before: 160, after: 60, keepNext: true });

// One run per emphasis span, so the named technology and the quantified claim
// land in bold and the rest does not. The vocabulary is declared in
// resume.json's `emphasis` list, never inline in the bullet.
const richRuns = (text, size = BODY) =>
  segments(text, emphasis).map(g => run(g.text, { size, bold: g.bold }));

const bullet = text => para(richRuns(text), { bullet: true, after: 30 });

function role(title, dates, sub, picks, href = null) {
  const out = [];
  const name = run(title, { size: BODY, bold: true });
  const titleRun = href ? hyperlink(linkId(href), name) : name;
  const head = dates
    ? [titleRun, tab(), run(dates, { size: META, color: GREY })]
    : [titleRun];
  out.push(para(head, { tabStop: dates ? FULL : null, keepNext: true }));
  if (sub) out.push(para(run(sub, { size: META, color: GREY }), { after: 20, keepNext: true }));
  for (const b of picks) out.push(bullet(b.text));
  out.push(para('', { after: 40 }));
  return out;
}

// ── header: name, title line, and a contact block whose fields are clickable ──
// Links are styled like the surrounding text on purpose — blue underlined URLs
// in a resume header are visual noise, and this header carries five fields.
// One paragraph per row (032), with the rule and the trailing space on the last
// only — otherwise the border draws under the middle of the block.
const contactParas = contactFields(contact).map((row, ri, rows) => {
  const runs = [];
  row.forEach((f, i) => {
    if (i) runs.push(run('  •  ', { size: META, color: GREY }));
    if (f.label) runs.push(run(`${f.label} `, { size: META, color: GREY }));
    const r = run(f.text, { size: META, color: f.href ? LINK : GREY });
    runs.push(f.href ? hyperlink(linkId(f.href), r) : r);
  });
  const last = ri === rows.length - 1;
  return para(runs, last ? { after: 100, rule: true } : {});
});

const header = [
  para(run(contact.name, { size: NAME, bold: true }), { after: 20 }),
  para(run(titleLine, { size: 11, color: SUBTLE }), { after: 20 }),
  ...contactParas,
];

// ── the five sections ─────────────────────────────────────────────────────
const summaryBlock = () => [heading('Summary'), para(richRuns(summary), { after: 40 })];

// Work experience's shape, two lines: bold subject and a right tab stop carrying
// the years, then grade and honours on a meta line underneath. Education sits
// directly under the summary — both sample resumes put the credential above the
// work history, and for a career-changer the most recent thing on the page is
// the qualification, not the job before it.
const educationBlock = () => [
  heading('Education'),
  ...resume.education.flatMap(ed => {
    const earned = [ed.grade && `Grade ${ed.grade}`, ed.honours].filter(Boolean).join('  •  ');
    return [
      para([
        run(ed.degree, { size: BODY, bold: true }),
        run(` — ${ed.institution}, ${ed.location}`, { size: BODY }),
        tab(),
        run(`${ed.start_date} – ${ed.end_date}`, { size: META, color: GREY }),
      ], { after: earned ? 0 : 20, tabStop: FULL, keepNext: !!earned }),
      ...(earned ? [para(run(earned, { size: META, color: GREY }), { after: 20 })] : []),
    ];
  }),
];

const experienceBlock = () => [
  heading('Work Experience'),
  ...expSections.flatMap(({ e, picks }) => role(
    `${e.title} — ${e.company}`,
    `${fmtDate(e.start_date)} – ${fmtDate(e.end_date)}`,
    [e.location, e.company_description].filter(Boolean).join('  •  '),
    picks,
  )),
];

const skillsBlock = () => [
  heading('Skills'),
  ...skillCats.map(c => para(
    [run(`${c.category_label}: `, { size: BODY, bold: true }), run(c.keywords.join(', '), { size: BODY })],
    { after: 20 },
  )),
];

const projectsBlock = () => projSections.length
  ? [heading('Projects'),
     ...projSections.flatMap(({ p, picks }) => role(p.name, null, null, picks, p.url || null))]
  : [];

const body = [
  ...header,
  ...summaryBlock(),
  ...educationBlock(),
  ...experienceBlock(),
  ...skillsBlock(),
  ...projectsBlock(),
].join('');

const outPath = path.join(outDir, `${stem}.docx`);
// Decision 012: normalize the document XML, not the zip. Same reason as
// build.mjs - the separators are template literals, not selection data.
fs.writeFileSync(outPath, docx(atsNormalize(body), FONT, links));

const bulletCount = expSections.reduce((n, x) => n + x.picks.length, 0);
const kw = skillCats.reduce((n, c) => n + c.keywords.length, 0);
const allPicks = [...expSections, ...projSections].flatMap(x => x.picks);
const spans = allPicks.map(b => segments(b.text, emphasis).filter(g => g.bold).length);

console.log(`ok: ${outPath}`);
console.log(`   single column, font "${FONT}", ${links.length} hyperlinks`);
console.log(`   ${bulletCount} experience bullets across ${expSections.length} roles, ${projSections.length} projects`);
console.log(`   skills: ${kw} keywords in ${skillCats.length} categories`);
console.log(`   emphasis: ${spans.reduce((a, b) => a + b, 0)} spans over ${spans.length} bullets, max ${Math.max(...spans)} in one`);
console.log('   import into Google Docs, edit there, export PDF from there. Never export Word out of Docs.');
