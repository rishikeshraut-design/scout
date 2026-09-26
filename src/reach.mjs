// Does a posting's location reach me? One question, one module.
//
//   classify('Toronto, Ontario')  -> 'local'
//   classify('KOHO (CAN)')        -> 'canada'
//   classify('Flexible / Remote') -> 'remote'
//   classify('Palo Alto, CA')     -> null
//
// Kept out of scan.mjs so it can be tested: scan.mjs runs its whole network pass
// at import time, and this is a twenty-alternative pattern deciding what the
// ledger is allowed to contain. Test the specific alternative you rely on.
//
// The tiers are ordered, and the order is the point: a Toronto posting is 'local'
// even though it is also Canadian, because the corridor is the target.

import {
  TITLE_HIT, TITLE_MISS, ONTARIO_NEAR, ONTARIO_AMBIGUOUS, FOREIGN_NAME, FOREIGN_CODE,
  CANADA, CANADA_CODE, REMOTE, REMOTE_OK, REMOTE_NOT, REMOTE_WORDS,
} from './config.mjs';

export { ONTARIO_AMBIGUOUS };

/** Is this title a design role we want to see? Loose on purpose; see TITLE_HIT in config.mjs. */
export function isDesignTitle(title) {
  const t = String(title || '');
  return TITLE_HIT.test(t) && !TITLE_MISS.test(t);
}

/**
 * True when a string names a corridor city that is ALSO a city elsewhere, and
 * nothing in it settles which. "Cambridge" alone is genuinely unknown; the
 * Ontario one is a commutable 100km. "Cambridge, MA" is not unknown.
 *
 * classify() stays strict and returns null for both, because the ledger must
 * never fill with US rows. This exists so a caller can tell the two apart and
 * send the genuinely unknown ones to a human rather than discarding them —
 * dropping is the only irreversible move in the shortlist.
 */
export const maybeCorridor = location => {
  const raw = String(location || '');
  return ONTARIO_AMBIGUOUS.test(raw) && !FOREIGN_NAME.test(raw) && !FOREIGN_CODE.test(raw);
};

export function unlocated(l) {
  return !l.replace(REMOTE_WORDS, ' ').replace(/[^a-zà-ɏ]/gi, '').length;
}

export function classify(location, remoteFlag) {
  const raw = location || '';
  const l = raw.toLowerCase();
  if (ONTARIO_NEAR.test(l)) return 'local';
  if (ONTARIO_AMBIGUOUS.test(l) && (CANADA.test(l) || CANADA_CODE.test(raw))) return 'local';
  if ((remoteFlag || REMOTE.test(l)) && !REMOTE_NOT.test(l) && (REMOTE_OK.test(l) || unlocated(l))) return 'remote';
  if (CANADA.test(l) || CANADA_CODE.test(raw)) return 'canada';
  return null;
}
