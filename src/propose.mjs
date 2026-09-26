// The swap mechanism, shared by propose-selection.mjs (experience) and
// propose-projects.mjs (projects). Spec 005, decision 021.
//
// Extracted rather than duplicated. The pieces below carry the reasoning of
// decisions 018 and 019 — the two-distinct-requirements licence, the tie
// handling, victim displacement — and a second copy would have to be fixed
// twice.
//
// Both callers describe the same shape: a set of SLOTS, each holding exactly
// one bullet from one group, and a verdict that cites groups. What differs is
// what a slot belongs to and whether the set may grow:
//
//                  experience                     projects
//   slot set       one per role, 2-5 slots        the whole section, 1 per project
//   the group      the achievement                the project itself
//   may grow?      yes, +1 per role, licensed     no (decision 021, page budget)
//   order          chronological, resume.json     by support (spec 005 R8)
//
// swapWithin() takes those differences as parameters and knows nothing else
// about either caller.

/**
 * Index the corpus once. Projects are included deliberately: coverage ranks
 * against both pools (coverage.mjs:105) and a verdict cites from both, so a
 * citation must resolve here whichever half it names.
 */
export function indexCorpus(resume) {
  const bulletOf = new Map();        // bullet id -> { id, group, owner }
  const roleOf = new Map();          // experience owner id -> chronological order
  const groupBullets = new Map();    // group -> bullet ids, so an angle swap has somewhere to go

  for (const [i, e] of resume.experience.entries()) {
    roleOf.set(e.id, i);
    for (const b of e.bullets) bulletOf.set(b.id, { id: b.id, group: b.group, owner: e.id });
  }
  for (const p of resume.projects) {
    for (const b of p.bullets) bulletOf.set(b.id, { id: b.id, group: b.group, owner: p.id });
  }
  for (const { id, group } of bulletOf.values()) {
    if (!groupBullets.has(group)) groupBullets.set(group, []);
    groupBullets.get(group).push(id);
  }
  return { bulletOf, roleOf, groupBullets };
}

/**
 * What the verdict cites, per bullet and per group.
 *
 * A group cited by TWO DISTINCT requirements is what licenses a role to grow —
 * see swapWithin. Counting requirement indices rather than citations is the
 * whole point: one requirement naming both co_1 and co_8 is a single ask.
 */
export function tallyCitations(verdict, bulletOf) {
  const citesByGroup = new Map();    // group -> Set(requirement index)
  const citedBullets = new Map();    // bullet id -> Set(requirement index)

  for (const r of verdict.requirements) {
    for (const id of r.cites || []) {
      const b = bulletOf.get(id);
      // A verdict naming a bullet that no longer exists is not fatal here; the
      // loader catches a bad selection with a better message than this could.
      if (!b) continue;
      if (!citedBullets.has(id)) citedBullets.set(id, new Set());
      citedBullets.get(id).add(r.index);
      if (!citesByGroup.has(b.group)) citesByGroup.set(b.group, new Set());
      citesByGroup.get(b.group).add(r.index);
    }
  }
  const support = g => (citesByGroup.get(g)?.size ?? 0);
  return { citesByGroup, citedBullets, support };
}

/**
 * The best-cited bullet from a list. Most requirement indices wins; the id is
 * the tiebreak, so two runs on the same verdict agree.
 */
export function bestCited(ids, citedBullets) {
  return (ids || [])
    .filter(id => citedBullets.has(id))
    .sort((a, b) => citedBullets.get(b).size - citedBullets.get(a).size || a.localeCompare(b))[0];
}

/**
 * Swap within one set of slots.
 *
 * @param picked        bullet ids currently held, in their existing order (mutated copy returned)
 * @param eligible      (group) => bool — may this cited group compete for a slot here?
 * @param ctx           { bulletOf, groupBullets, citedBullets, citesByGroup, support }
 * @param expand        null, or { allowed: () => bool } — see the licence below.
 *                      Projects pass null: the section never grows (decision 021).
 * @param owner         label carried on each change/near-miss, for the caller's report
 * @param noRoomNote    what to say when a cited group loses because nothing here is weaker
 *
 * @returns { picked, changes, nearMisses }
 */
export function swapWithin({ picked: initial, eligible, ctx, expand = null, owner = null,
                             noRoomNote = 'nothing in this role is less supported' }) {
  const { bulletOf, groupBullets, citedBullets, citesByGroup, support } = ctx;
  const picked = [...initial];
  const changes = [];
  const nearMisses = [];
  const groupsHere = new Set(picked.map(id => bulletOf.get(id).group));

  // 1. Angle swaps. Same achievement, told the way the posting asked for.
  //
  // A sibling must BEAT the incumbent, not merely tie it. The baseline's angle
  // choice is a considered judgment (019) and a tie means the verdict could not
  // separate the two, so swapping there discards judgment for noise — the same
  // reasoning the expansion licence makes explicit below.
  for (let i = 0; i < picked.length; i++) {
    const cur = bulletOf.get(picked[i]);
    const sibling = bestCited((groupBullets.get(cur.group) || []).filter(id => id !== cur.id), citedBullets);
    const beats = sibling && (citedBullets.get(sibling).size > (citedBullets.get(cur.id)?.size ?? 0));
    if (beats) {
      changes.push({ role: owner, kind: 'angle', from: picked[i], to: sibling, because: [...citedBullets.get(sibling)] });
      picked[i] = sibling;
    }
  }

  // 2. Group swaps and expansion. Cited groups this set could hold that the
  //    baseline did not use, most-supported first.
  const wanted = [...citesByGroup.keys()]
    .filter(g => !groupsHere.has(g))
    .filter(g => eligible(g))
    .sort((a, b) => support(b) - support(a) || String(a).localeCompare(String(b)));

  let expandedHere = false;
  for (const g of wanted) {
    const bring = bestCited(groupBullets.get(g), citedBullets);
    if (!bring) continue;

    // Expansion is licensed by EVIDENCE, never by indecision. A set grows only
    // when two DISTINCT requirements cite two DISTINCT groups in it — two asks,
    // two lines. A tie means overlap could not separate them, and expanding on
    // a tie is "add more when the evidence is weakest", which is backwards.
    // 009 retired the page limit and replaced it with "does this bullet say
    // something the others do not"; this is that rule made mechanical.
    // Two DISTINCT requirements, not merely two cited groups. One requirement
    // citing both co_1 and co_8 is a single ask and earns a single line; R3
    // citing co_8 while R7 cites co_5 is two asks and earns two.
    const mineReqs = citesByGroup.get(g) || new Set();
    const otherReqs = new Set();
    for (const id of picked) for (const r of citesByGroup.get(bulletOf.get(id).group) || []) otherReqs.add(r);
    const distinctAsk = [...otherReqs].some(r => !mineReqs.has(r));
    const canExpand = !!expand && !expandedHere && distinctAsk && mineReqs.size > 0 && expand.allowed();

    if (canExpand) {
      picked.push(bring);
      expandedHere = true;
      expand.onExpand?.();
      changes.push({ role: owner, kind: 'expand', to: bring, because: [...citesByGroup.get(g)] });
      continue;
    }

    // Otherwise displace the least-supported group here — an uncited one first,
    // and the existing order as the tiebreak so two runs agree.
    const victim = picked
      .map((id, i) => ({ i, id, s: support(bulletOf.get(id).group) }))
      .filter(x => x.s < support(g))
      .sort((a, b) => a.s - b.s || b.i - a.i)[0];

    if (!victim) {
      nearMisses.push({
        role: owner, group: g, because: [...citesByGroup.get(g)],
        note: expand && !expand.allowed() ? expand.capNote : noRoomNote,
      });
      continue;
    }
    changes.push({ role: owner, kind: 'group', from: picked[victim.i], to: bring, because: [...citesByGroup.get(g)] });
    picked[victim.i] = bring;
  }

  return { picked, changes, nearMisses };
}
