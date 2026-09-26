# Setting up Scout

From a fresh copy to your first rendered resume, built from **your own** experience. Nothing here
asks you to copy the invented person in `tests/fixture/` — that data exists only so the tests can
run, and it is not a template.

## 1. Keep your copy private

Scout writes your career history to `src/resume.json` and every job you track or apply to to
`src/jobs.tsv`. If your copy lives on GitHub, **make the repository private before you commit
either file.** Your contact details go in `src/contact.json`, which git ignores.

## 2. What you need

- **Node 18 or newer** — `node --version`.
- **Git.**
- **Chrome, Chromium or Edge**, for PDF rendering. Nothing to configure: `build.mjs` finds it.
  If it cannot, set `CHROME_PATH` to the browser's executable.
- **Claude Code**, for the judgment steps (optional for scanning; needed for a tailored resume).
  Open it **in this folder**, so it finds the skills in `.claude/`.

There is nothing to install. No `npm install`, no `package.json`.

## 3. Check the install

```bash
node test-lint.mjs && node test-mine.mjs && node test-elicit.mjs && node test-coverage.mjs && node test-selection.mjs && node test-projects.mjs && node test-shortlist.mjs
```

Every suite should end `N passed, 0 failed`. They run on invented data and never touch yours.

## 4. Your contact details

```bash
cp src/contact.example.json src/contact.json
```

Edit `src/contact.json`: name, email, phone, LinkedIn, portfolio, location. Leave a field as `""`
to drop it from the header. `tagline` is not printed — the line under your name is the variant's
`title_line` (step 5).

## 5. Your corpus — `src/resume.json`

This file is the only source of claims on any resume Scout builds. Create it with the skeleton
below and edit it by hand — employers, education, variants, summaries, skills — **except the
bullets**, which only ever go in **through `add-bullet.mjs`**.

```json
{
  "schema": 2,
  "note": "My corpus. Bullets are added with src/add-bullet.mjs, never by hand.",
  "facts": {},
  "variants": {
    "product-designer": {
      "title_line": "Product Designer",
      "summary": "product_designer",
      "angle_priority": ["impact", "ownership", "process", "collaboration", "technical", "research"]
    }
  },
  "summaries": {
    "product_designer": "Two sentences, in your own words, that are true of every resume you send."
  },
  "skills": {
    "design_tools": { "category_label": "Design Tools", "keywords": ["Figma"] }
  },
  "experience": [
    {
      "id": "acme", "company": "Acme Corp", "company_description": "What the company does",
      "location": "Toronto, ON", "title": "Product Designer",
      "start_date": "2023.01", "end_date": "2025.06",
      "industry": "Software", "tags": [], "bullets": [], "suggested_bullets": []
    }
  ],
  "education": [
    {
      "id": "school", "degree": "Your degree", "institution": "Your school",
      "location": "City, Province", "start_date": "2018", "end_date": "2022"
    }
  ],
  "projects": [],
  "emphasis": []
}
```

- **One `experience` entry per job**, newest first. `id` is a short lowercase name you will type
  often — no spaces and **no underscores**, since bullet groups are numbered from it. Dates are
  `YYYY.MM`; use `"Present"` for a current role.
- **`variants`** are named resume shapes. `product-designer` must exist — it is the default a
  design posting routes to. A `client-service` variant, with a matching baseline, is what a
  customer-service posting routes to, if you want that track.
- **`title_line`** is the headline under your name, and **nothing checks it**. Add a term after
  the job title — `Product Designer | Accessibility, Design Systems` — only when a bullet on that
  resume backs it up.
- **`summaries`** are written once, by you, and selected per posting — never generated. Every
  variant needs one, and it must not be empty: the render refuses without it.
- **`skills`** — category keys are your own names (`design_tools`, `methods`…); a baseline lists
  them in `skills_order`. Every keyword must be something you can back up.
- **`facts`** stays `{}`: `add-bullet.mjs` fills it. `industry`, `tags` and `suggested_bullets` may
  stay empty.
- **`emphasis`** lists terms to bold wherever they appear: tools, figures. Optional.

### Adding bullets

Every bullet goes through `add-bullet.mjs`, which refuses anything that asserts a number or a
named thing the employer's own bullets do not already establish — unless you declare it:

```bash
node src/add-bullet.mjs --owner acme --group acme_1 --angle impact \
  --text "Redesigned the checkout flow, cutting abandoned carts by 18% in 3 months." \
  --provenance volunteered --declare "18%" --declare "3" --dry
```

Run it with `--dry` first, read what it prints, then run it again without `--dry` to write. Named
things include tools and acronyms — `Figma`, `A/B` — and numbers include number words — the `two`
in "two-week" — and all are declared the same way.

- **`--group`** names the achievement. Give an employer's first bullet `--group <id>_1` — here
  `acme_1` — and later bullets for that employer are numbered from it automatically when you leave
  `--group` out. A second telling of the same achievement reuses its group with a different
  `--angle`.
- **`--angle`** is one of `impact`, `process`, `ownership`, `technical`, `collaboration`,
  `research`: the same achievement told for a different kind of posting.
- **`--provenance`** records how the claim arrived: `volunteered`, `prompted` or `confirmed`.
- **`--new-project "Name" --tools "..."`** opens a project on its first bullet. Employers cannot be
  created this way; add them to `experience` by hand first.

In Claude Code, the **`elicit`** skill interviews you about one employer and writes the bullets
through the same script. It is the easier way to build a corpus from memory.

`add-bullet.mjs` checks the whole corpus before every write and refuses to leave it inconsistent.
The test suites check the code, not your data, so there is nothing to rerun after adding bullets.

## 6. Your baseline resume — `src/baselines/`

A baseline is a complete, untailored resume: the bullets you would send if you knew nothing about
the posting. Tailoring starts from one and swaps within each role, so it can never drop a job from
your timeline.

Create `src/baselines/product-designer/selection.json`:

```json
{
  "label": "product-designer",
  "variant": "product-designer",
  "skills_order": ["design_tools"],
  "bullets": ["acme_1_impact"],
  "projects": [],
  "overrides": {},
  "rationale": {}
}
```

List your strongest bullets, at most one per group and **at most 14**, across every role you want
on the page. Each further baseline — `ux-designer`, `client-service` — is another folder with its
own `selection.json`; Scout finds them by listing the folder.

Render a copy to check it, in `out/`, where renders are ignored by git:

```bash
mkdir -p out/baseline-check
cp src/baselines/product-designer/selection.json out/baseline-check/
node src/build.mjs out/baseline-check/selection.json
```

Open the PDF it names. Then check what is inside it — page count, and that the font is Inter, not
a fallback:

```bash
node -e "const s=require('fs').readFileSync(process.argv[1]).toString('latin1');console.log([...new Set(s.match(/\/Count\s+[0-9]+/g))].join(' '),[...new Set(s.match(/\/BaseFont\s*\/[A-Za-z0-9+#_-]+/g))].join(' '))" out/baseline-check/<the file>.pdf
```

Expect `/Count 1` or `/Count 2`, and `Inter-Bold` and `Inter-Regular`.

## 7. Aim the search

- **`src/config.mjs`** — which titles count as a design role, which places are in reach, which
  titles the shortlist keeps. The defaults are a UX / product design search around Toronto. The
  settings are regular expressions with a comment explaining each; leave them alone unless your
  search is different and you are comfortable editing a pattern.
- **`src/companies.tsv`** — the companies whose boards are scanned directly. Add one with
  `node src/discover.mjs "Company Name"`, and read the job locations on the board it finds before
  keeping the row: a slug that resolves is not proof it is the right company.
- **`src/boards.tsv`** — the aggregate sources.

## 8. The first scan

```bash
node src/intake.mjs
node src/shortlist.mjs
```

`intake` scans every source, appends new postings to `src/jobs.tsv` (it creates the file), and
fetches their text into `src/postings/`. The first run downloads a large daily dataset, so give it
a few minutes. `shortlist` writes `out/shortlist/shortlist.html` — open it.

## 9. A tailored resume

In Claude Code, from this folder:

```
/build-resume <company> | <title> | <posting-url>
```

It stores the posting, judges what the corpus covers (the `coverage` skill), proposes a selection
from your baseline, sets the header (the `tailor-resume` skill), renders the PDF, and records the
row in `src/jobs.tsv` with status `new`. Moving that status to `applied` is yours to do.

Without an agent, follow the numbered steps in `.claude/commands/build-resume.md` by hand — every
command is there with its arguments. The judgment steps become yours: write
`coverage-verdict.json` yourself (the format is in `.claude/skills/coverage/SKILL.md`), and set
`title_line` and `summary` in `selection.json`.

## 10. Optional: scan every morning

`.github/workflows/scan.yml` runs the intake on GitHub Actions when started by hand, and commits
the new rows. To run it daily, add a `schedule` trigger to it — **on a private repository only**:

```yaml
on:
  schedule:
    - cron: '0 11 * * *'
  workflow_dispatch:
  workflow_call:
```

Then pull before you scan on your own machine, so the two never append the same posting twice.
