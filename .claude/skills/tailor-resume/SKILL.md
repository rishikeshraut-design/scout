---
name: tailor-resume
description: Set the header of a proposed resume — title_line, summary, skills order and keywords — by SELECTING from resume.json, never writing prose. Use after propose-selection.mjs and propose-projects.mjs have produced a selection.json.
---

# The header, and nothing else

`propose-selection.mjs` and `propose-projects.mjs` choose the bullets and the projects. This skill
sets the four fields they leave alone, and it is invoked at step 6 of `/build-resume`.

Fetching the JD, reading it for signals, selecting bullets and rendering are done by
`add-posting.mjs`, the `coverage` skill, the two proposal passes and `build.mjs` — not here.

## The one rule everything here sits under

**Selection, never generation** (decision 001, amended by 012). Every field below chooses among
things already written in `resume.json`. If you find yourself composing a sentence, stop.

## 1. `title_line` — the field with no lint

`auditOverride()` governs bullet overrides only. This is free text in the largest type on the page,
and **nothing checks it**.

**Every term must trace to a bullet that is actually on this document.** Not to the corpus — to the
selection you are about to render. A swap can remove the only bullet supporting a term the baseline
claimed, and then the term has to go.

Read the selected bullets first. Then, if the posting asks for something no bullet on the page
supports, **leave it out** — an unsupported term here is the one invented claim that reaches a
reader and passes every test.

The variants in `resume.json` carry a `title_line` each; take one, or write a narrower honest
combination of terms the page supports. Three terms is the established shape.

## 2. `summary` — a key, not a sentence

Select one of the keys in `resume.json.summaries`. Writing a new one is not permitted here; a new
summary is a corpus edit and goes through the normal review.

Prefer the one whose headline claims are on this page: a summary that leads on a particular
achievement is the right pick only when the bullet carrying that achievement is selected.

## 3. `skills_order` and `skills_keywords`

Decision 007: narrowing the keyword list per posting is selection, same as the bullets. **Every
keyword must already exist in that category in `resume.json`.** The shape, in `selection.json`:

```json
"skills_order": ["methods", "design_tools"],
"skills_keywords": { "design_tools": ["Figma", "FigJam"] }
```

A category missing from `skills_keywords` keeps all its keywords.

Put the categories the posting cares about first. A research-led posting leads with the research or
methods category; a visual one with a visual category.

Be aware that the skills list is **not** covered by the lint — it governs bullets. A keyword with
no supporting bullet behind it is a claim you would have to defend in an interview, so narrowing
toward what the posting asks for also narrows what you would have to defend.

## 4. Overrides are rare, and usually unnecessary

Only a synonym swap toward the posting's vocabulary — "usability testing" → "user testing". Never
restructure, never add a claim. `auditOverride()` rejects new numbers, new entities and banned
vocabulary, scoped to the employer that owns the bullet.

If you are reaching for one, check first whether a different angle of the same group already says
it — that is what the angles are for.

## Refuse

- **A posting far enough from the corpus that selection produces a weak resume.** Say so. A bad
  fit is a fit signal, not a tailoring problem; never stretch claims to fit.
- **Any urge to improve a bullet's wording.** The fix belongs in `resume.json`, hand-written and
  reviewed, through `add-bullet.mjs`.
- **Setting `jobs.tsv` status.** Building a resume is not sending one (decision 022). The row stays
  `new` and only the user moves it.
