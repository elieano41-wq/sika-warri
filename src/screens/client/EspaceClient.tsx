import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, CustomerProfile } from '../../lib/api';
import { Confirmation } from './Confirmation';
import { MaMonnaie } from './MaMonnaie';

/**
 * The customer's app: their balances, unless something needs confirming.
 *
 * Ordering is a judgement about urgency, not a menu. A vendor waiting at a
 * counter with a 180-second window beats browsing a history — so a pending
 * request takes over the screen rather than sitting behind a tab the customer
 * has to know to look at. Web Push is Phase 2; until then the app being open is
 * the only notification there is, and polling has to be quick enough that a
 * customer holding out their phone sees the request appear.
 */
export function EspaceClient({
  session,
  client,
  onDeconnexion,
}: {
  session: Session;
  client: CustomerProfile;
  onDeconnexion: () => void;
}) {
  const [enAttente, setEnAttente] = useState(false);
  const minuteur = useRef<number | null>(null);

  const verifier = useCallback(async () => {
    try {
      const demandes = await api.pendingForMe(session.accessToken, client.authUserId);
      setEnAttente(demandes.length > 0);
    } catch {
      // A failed poll on patchy signal is normal. Leave the current view in
      // place rather than yanking the customer out of whatever they are doing.
    }
  }, [session.accessToken, client.authUserId]);

  useEffect(() => {
    verifier();
    minuteur.current = window.setInterval(verifier, 2500);
    return () => {
      if (minuteur.current) window.clearInterval(minuteur.current);
    };
  }, [verifier]);

  if (enAttente) {
    return (
      <Confirmation
        session={session}
        client={client}
        onDeconnexion={onDeconnexion}
      />
    );
  }

  return <MaMonnaie session={session} client={client} onDeconnexion={onDeconnexion} />;
}
