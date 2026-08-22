import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import { Montant } from './ui';
import { formatCfa, formatPhoneLocal } from '../lib/format';

/**
 * The last few customers this vendor dealt with, by name.
 *
 * ============================================================================
 * WHY: 16 TAPS BECAME 7. Recording 500 F of change for an existing customer took
 * 1 tap to start, TEN to type a phone number the vendor has typed before, 1 to
 * continue, 3 for the amount and 1 to confirm. At a counter with people waiting,
 * ten taps of a remembered number is the difference between using this and
 * reaching for the paper carnet.
 *
 * Most transactions are regulars, so the entry point leads with them.
 * ============================================================================
 *
 * TYPING STAYS. A new customer has no entry here, which is precisely the case
 * where the full number is the only way in — so this is an addition, never a
 * replacement, and the keypad is one tap below.
 *
 * Both figures per row, separately. A shortlist showing one number would have to
 * choose between change held and debt owed, and either choice is wrong half the
 * time.
 */
export function ClientsRecents({
  session,
  vendorId,
  actorUserId,
  onChoisir,
}: {
  session: api.Session;
  vendorId: string;
  actorUserId: string;
  /** Receives the customer id AND the phone, so the caller needs no second lookup. */
  onChoisir: (client: api.RecentCustomerRow) => void;
}) {
  const [recents, setRecents] = useState<api.RecentCustomerRow[] | null>(null);

  useEffect(() => {
    let annule = false;
    api
      .vendorRecentCustomers(session.accessToken, vendorId, actorUserId)
      .then((r) => { if (!annule) setRecents(r); })
      // A failed load is not worth an error here: the keypad below still works,
      // and a vendor mid-transaction should not be shown a problem they cannot
      // act on when the path they need is right there.
      .catch(() => { if (!annule) setRecents([]); });
    return () => { annule = true; };
  }, [session.accessToken, vendorId, actorUserId]);

  // Nothing to show for a vendor's first customers, and no empty box either:
  // rendering a heading over nothing would suggest something is missing.
  if (recents === null || recents.length === 0) return null;

  return (
    <div className="pile">
      <p className="discret">Vos derniers clients</p>
      <ul className="pile recents" style={{ listStyle: 'none' }}>
        {recents.map((c) => (
          <li key={c.customer_id}>
            <button
              type="button"
              className="ligne-client"
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => onChoisir(c)}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 'var(--texte-grand)' }}>
                  {c.your_label ?? formatPhoneLocal(c.phone)}
                </div>
                <div className="discret">
                  {formatPhoneLocal(c.phone)}
                  {c.is_registered ? '' : ' · sans compte'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {c.change_cfa > 0 ? <Montant value={c.change_cfa} taille="ligne" /> : null}
                {c.debt_cfa > 0 ? (
                  <div className="discret" style={{ color: 'var(--alerte)' }}>
                    doit {formatCfa(c.debt_cfa)}
                  </div>
                ) : null}
              </div>
            </button>
          </li>
        ))}
      </ul>
      <p className="discret">Ou tapez un numéro ci-dessous.</p>
    </div>
  );
}
