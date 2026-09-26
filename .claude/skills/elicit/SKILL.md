---
name: elicit
description: Interview the user about one employer to get real duties out of memory and into resume.json as linted bullets with provenance. Use when the corpus is thin for a role or field — especially a non-design one — or when a posting needs experience the corpus does not yet hold.
---

# Elicit experience for one employer

Getting what the user did out of memory and into the corpus, once, so every
future application inherits it. The reasoning behind the shape of this matters
more than the steps (decision 016), and several obvious designs here are wrong.

**Per employer, never per posting.** Facts are owner-scoped (012), so answers
amortize. Per-posting elicitation re-asks about the same employer every time a
similar role appears.

## Before you start

```
node src/cues.mjs --list                    # owners, and what the bank holds
node src/cues.mjs --owner <id> --limit 12   # the cue list
```

Then read the employer's existing bullets in `resume.json` — you are looking for
what is *missing*, and re-asking something already recorded produces duplicates
rather than material.

## The rules that make this safe

**A question cannot fabricate anything. Only a written bullet can.** So ask
freely. The entire constraint lives at the write step, and `add-bullet.mjs`
enforces it.

**Never show, quote or paraphrase the job description.** Not once. If a posting
prompted this session, it stays out of the conversation entirely. What hides it
is the cue list itself — it draws on many postings in a field, so a specific
posting's asks sit among items it never mentioned. Do not undo that by
mentioning which cue matters.

**Open questions before cues.** Start with *"what did a normal shift look
like"*, *"what were you actually responsible for"*. Free recall establishes the
frame. But do not stop there: free recall returns the modal day, and the
non-modal events — the Tuesday the POS died — are disproportionately what is
worth having, because they are what everyone else's shift did not contain.

**Then cues, generously.** Read them out in batches. Most will be a no; that is
fine and expected. A no costs nothing.

**You are not verifying the user.** They are the subject of their own corpus;
interrogating them is both rude and pointless. Follow-up questions exist to get
enough fact on record that a *strong* bullet is licensed — not to hold the
bullet down to their casual phrasing. "Yeah I fixed the POS a few times" is
someone being brief in conversation, not making a careful claim.

**So ask what makes a good bullet, not what proves the claim.** Was the store
busy? Did you work out the fault or power-cycle it? One terminal or the floor?
Those answers become facts, and facts are what license "diagnosed" and
"high-volume" honestly.

## Where the line actually falls

- **Words for the activity** need only that the activity happened. Fixed,
  diagnosed, resolved, handled, trained — one occasion licenses them. Frequency
  is not the standard for a resume; nobody writes "occasionally fixed the POS".
- **Words for frequency or scale** need a registered fact. "Routinely", "across
  the floor", "40+ incidents" assert a pattern. `add-bullet.mjs` will refuse
  these unless you `--declare` them, and you may only declare what the user told
  you.

If it refuses, the fix is usually to rewrite the bullet, not to declare the
number.

## Writing

**`add-bullet.mjs` is the only write path for a bullet.** Never add or edit a
bullet in `resume.json` by hand — a hand edit skips every check and this is the
most valuable file in the project.

```
node src/add-bullet.mjs --owner northwind --angle technical \
  --text "Restored frozen point-of-sale terminals during trading hours, isolating the fault and bringing the till back online without closing the lane." \
  --provenance prompted --tags pos,retail --dry
```

Run `--dry` first, show the user the bullet, then write it.

- **`--angle`** — `impact`, `process`, `ownership`, `technical`, `collaboration`,
  `research`. One bullet per group per angle. A new subject opens a new group;
  a second angle on something already recorded takes `--group`.
- **`--provenance`** — `volunteered` if they offered it unprompted, `prompted` if
  a cue surfaced it, `confirmed` if they verified something already in the
  corpus. This is metadata about how a claim arrived, not a suspicion score.
- **`--new-project "<name>" [--tools "..."]`** opens a project the corpus does
  not have yet, on its first bullet. Projects key their group on the project id,
  so a **second angle needs `--group <id>` explicitly**, or it allocates a
  numbered group and quietly breaks the convention. **A new employer is not
  creatable this way**: dates, title and location are not implied by any bullet,
  so add that entry deliberately and elicit into it.
- A second angle on an existing group is often better value than a seventh
  subject.

`add-bullet.mjs` checks the whole corpus before every write and refuses to leave
it inconsistent, so there is nothing else to run after adding bullets. The test
suites check the code, not the corpus.

## Stopping

Stop when the cues stop producing anything, or when the user tires — whichever
first. A cue list read carelessly is worse than a short one, because it makes
"yes" cheap again. Leave the rest; the session resumes from `cues.mjs` any time.

Tell the user what landed: how many bullets, under which groups, and what the
bank still has no cues for.
