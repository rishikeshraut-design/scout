# Scout

A job-search engine that builds a tailored resume **without ever generating a claim**.

Scout scans company job boards for new postings, keeps its own first-seen ledger so "new" means
new to *you* rather than trusting a board's unreliable posted date, triages what is worth reading,
and then builds a resume for one posting by **selecting** bullets you wrote — reshaping them only
within what a lint can prove.

It ships with no personal data. You bring your own corpus — see **[SETUP.md](SETUP.md)**. The
defaults are tuned for a UX / product design search in Canada; the search settings live in one
file, `src/config.mjs`.

> **Keep your copy private.** Scout records every job you track and apply to in `src/jobs.tsv`,
> and your career history in `src/resume.json`. If you use GitHub, make the repository private
> before you commit either.

## The idea

Most AI resume tools generate bullets from a job description. That produces text that reads well
and quietly asserts things you never did — and you find out in the interview.

Scout inverts it. Every claim on the page was **written by you, once, and reviewed**. Tailoring is
the act of choosing *which* of those claims to show and in what order. An agent decides what to
select; it is never permitted to author a claim, and a lint checks that what ships is still what
was written.

The consequence worth stating plainly: **Scout cannot make you look better than you are.** When a
posting asks for something the corpus cannot prove, the honest output is a gap, and the honest
response is to go do the thing or skip the posting.

## How it splits

The split is the architecture, not an implementation detail.

**Deterministic scripts — no model calls, ever.** Board scanning, posting capture, the ledger,
the shortlist, claim linting, rendering. Every one of these is a plain Node script you can run,
diff and test. `src/` makes **zero** model calls.

**A judgment layer — markdown files.** Reading a job description and deciding whether the corpus
covers each requirement; choosing which bullet angle answers which ask; writing the header line.
These are genuine judgment and they run through an agent: the skills in `.claude/skills/` and the
`/build-resume` command in `.claude/commands/`.

Two things follow. Running the scan costs nothing but electricity, so it can run on a schedule.
And the safety-critical parts — *is this claim supported?* — are the deterministic half, so they
are inspectable and testable rather than a matter of trusting a model.

Scout is **not tied to a particular agent**. The judgment layer is markdown; the agent-specific
surface is a few frontmatter keys and one argument placeholder. Anything with a filesystem and a
shell can run it.

References like "decision 016" or "spec 004" in the code and skills point to the design record
Scout was built with. That record is not part of this repository; the rule each one names is
stated where it is cited.

## Requirements

- **Node 18 or newer.** Node 22 is what the CI uses.
- **A Chromium-family browser** for PDF rendering — Chrome, Chromium or Edge. `build.mjs` finds
  one already on the machine; it does not download one.
- **An agent** for the judgment steps, if you want a tailored resume rather than just the scan.
  The skills are written for Claude Code.

**No npm dependencies.** There is no `package.json` and nothing to install — the scripts use only
the Node standard library. A job-search tool that rots because a transitive dependency broke is
worse than no tool.

## Running it

Find and store postings — no agent, no cost:

```bash
node src/intake.mjs
```

Triage the ledger into three tiers:

```bash
node src/shortlist.mjs
```

Writes `out/shortlist/` — a CSV per tier, one for jobs you applied to, and a standalone HTML page,
regenerated whole every run.
`scout-daily` and `scout-shortlist` (`.cmd` on Windows, `.command` on macOS) do the same with a
double-click, pulling first.

Read what one posting asks for, against the whole corpus:

```bash
node src/coverage.mjs <posting-url>
```

Store a posting from a board with no reader:

```bash
node src/add-posting.mjs <url> --text posting.txt --title "..." --company "..."
```

Build a tailored resume, end to end, in Claude Code:

```
/build-resume <company> | <title> | <posting-url>
```

Run the tests:

```bash
node test-lint.mjs && node test-mine.mjs && node test-elicit.mjs && node test-coverage.mjs && node test-selection.mjs && node test-projects.mjs && node test-shortlist.mjs
```

The tests run on an invented person in `tests/fixture/` — never on your data. Watch the case
count, not only the failure count: a suite that stops asserting still passes.

## Where it looks

| Source | What Scout reads |
|---|---|
| Greenhouse, Lever, Ashby, Workday, Gem | each board's public job API, for the companies in `src/companies.tsv` |
| A published dataset of ATS postings | one daily download instead of one request per board (`src/boards.tsv`) |
| Remotive, Himalayas | their public job APIs (`src/boards.tsv`), one request a day |
| Dayforce, BambooHR, iCIMS | one posting at a time, when a posting's URL points there |

Scout fetches only paths each host's `robots.txt` allows. Remotive and Himalayas ask that anything
you display links back to their posting and names them as the source, and that their jobs are not
resubmitted to other sites; Scout is built for personal use and does neither. A board that answers
200 has not granted permission, so check `robots.txt` — and the source's terms — before pointing a
reader at a new one.

## The data

| | |
|---|---|
| `src/jobs.tsv` | The ledger. Every scanned role from `new` through `applied` to an outcome. Append-only; status edits are yours and deliberate. |
| `src/postings/` | One JSON file per posting body, plus tombstones for postings a board no longer lists — primary, perishable data. |
| `src/companies.tsv` | Verified company boards. Add to it with `node src/discover.mjs "Company"`. |
| `src/resume.json` | Your corpus: hand-written bullets, each scoped to the employer that owns it. **`add-bullet.mjs` is the only write path.** |
| `src/baselines/` | Your complete, untailored resumes, one per role family. Tailoring starts from one. |
| `src/config.mjs` | What counts as a relevant title, and which places are in reach. |
| `src/fonts/` | Inter, bundled so a render does not depend on what is installed. |

## What it does not do

- **It does not apply for you.** Building a resume is not sending one. A row's status stays `new`
  until you move it.
- **It does not score your fit as a percentage.** Counts of covered requirements and gaps, never
  a ratio — a number like that compresses a judgment into something that reads as measurement.
- **It does not reword your experience to match a posting.** The lint cannot tell whether a
  reframe still asserts the same actor doing the same activity, so the rewrite path does not exist.
- **It does not know whether anyone is still reading applications.** It can measure whether a
  posting is still listed. Competition is invisible to it.

## License

MIT, for the code. See [LICENSE](LICENSE) — the bundled font is under the SIL Open Font License
1.1 instead.
