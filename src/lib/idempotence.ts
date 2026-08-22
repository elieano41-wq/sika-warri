// One key per TRANSACTION, not per attempt.
//
// ============================================================================
// THE BUG THIS FIXES, which was present on every write in the app.
//
// Standing rule 8 says every write carries an idempotency key, and every write
// did — generated with crypto.randomUUID() inside the submit handler. So:
//
//   1. The vendor taps Enregistrer.
//   2. The request reaches the server, the entry is written, and the response is
//      lost on the way back. Patchy signal at a market stall is the normal case,
//      not the edge case.
//   3. The app shows "Pas de connexion. Vérifiez votre réseau." — accurate, and
//      it says nothing about whether the entry landed, because the app does not
//      know.
//   4. The vendor taps Enregistrer again. A NEW key. A SECOND entry.
//
// The customer now holds 1 000 F where 500 F was recorded, or owes 4 000 F where
// 2 000 F was agreed. The key was doing nothing on the one scenario it exists
// for, and the failure is silent on both sides.
//
// A key is only idempotent if it survives the retry. So it is minted when the
// vendor commits to the amount, held while the attempt is in flight, and only
// cleared once the write is CONFIRMED — or deliberately abandoned.
// ============================================================================

import { useCallback, useRef } from 'react';

/**
 * A key that survives retries of the same transaction.
 *
 * `cle()` returns the same string until `terminer()` is called. Retrying after a
 * failure reuses it, so the server recognises the replay and returns the
 * original entry instead of writing a second one.
 *
 * Deliberately NOT keyed on the amount or the customer. If a vendor corrects a
 * typo from 500 to 5000 before the first attempt lands, both attempts must be
 * the same transaction — the one the vendor believes they are making — and the
 * server returning the 500 entry for the 5000 request is the right outcome: it
 * is visibly wrong on screen and correctable, where a silent double-write is
 * neither.
 */
export function useIdempotence() {
  const cleRef = useRef<string | null>(null);

  const cle = useCallback(() => {
    if (cleRef.current === null) {
      cleRef.current = crypto.randomUUID();
    }
    return cleRef.current;
  }, []);

  /** The write is confirmed, or the vendor started something else. */
  const terminer = useCallback(() => {
    cleRef.current = null;
  }, []);

  return { cle, terminer };
}
