import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, CustomerProfile } from '../../lib/api';
import { Confirmation } from './Confirmation';
import { MaMonnaie } from './MaMonnaie';
import { MonCode } from './MonCode';
import { Historique } from './Historique';
import { Compte, ChangerCode } from '../Compte';
import {
  Navigation, IconeMonnaie, IconeHistorique, IconeCode, IconeCompte,
  type Onglet,
} from '../../components/Navigation';

/**
 * The customer's app: four destinations, unless something needs confirming.
 *
 * URGENCY OUTRANKS NAVIGATION. A pending request takes over the whole screen and
 * the tab bar disappears with it. A vendor is standing at a counter with 180
 * seconds on the clock; putting that behind a tab the customer has to know to
 * look at would lose transactions, and leaving the bar visible invites a tap
 * away mid-confirmation. Web Push is Phase 2, so until then the app being open
 * is the only notification there is, and the poll has to be quick enough that a
 * customer holding out their phone sees the request appear.
 *
 * The chosen tab is remembered across the takeover: someone reading their
 * history who confirms a debit comes back to their history, not to the top.
 */

type OngletClient = 'monnaie' | 'historique' | 'code' | 'compte';

const ONGLETS: Array<Onglet<OngletClient>> = [
  { cle: 'monnaie', etiquette: 'Ma monnaie', icone: IconeMonnaie },
  { cle: 'historique', etiquette: 'Historique', icone: IconeHistorique },
  { cle: 'code', etiquette: 'Mon code', icone: IconeCode },
  { cle: 'compte', etiquette: 'Compte', icone: IconeCompte },
];

export function EspaceClient({
  session,
  client,
  estAdmin,
  onAdmin,
  onDeconnexion,
}: {
  session: Session;
  client: CustomerProfile;
  estAdmin: boolean;
  onAdmin?: () => void;
  onDeconnexion: () => void;
}) {
  const [enAttente, setEnAttente] = useState(false);
  const [onglet, setOnglet] = useState<OngletClient>('monnaie');
  // The one task on this side. Held here rather than inside Compte so the tab
  // bar can be taken off the screen while it runs.
  const [changeCode, setChangeCode] = useState(false);
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
      <Confirmation session={session} client={client} onDeconnexion={onDeconnexion} />
    );
  }

  // A task: no tab bar, for the same reason a half-typed code should not be
  // abandoned by a stray tap.
  if (changeCode) {
    return (
      <ChangerCode
        session={session}
        onTermine={() => setChangeCode(false)}
        onAnnuler={() => setChangeCode(false)}
      />
    );
  }

  return (
    <>
      {/* key on the tab so the entry animation replays per destination. Without
          it React reuses the node and the screen changes with no transition. */}
      <div key={onglet}>
        {onglet === 'monnaie' ? (
          <MaMonnaie session={session} client={client} />
        ) : onglet === 'historique' ? (
          <Historique session={session} client={client} />
        ) : onglet === 'code' ? (
          <MonCode session={session} />
        ) : (
          <Compte
            session={session}
            client={client}
            estAdmin={estAdmin}
            onAdmin={onAdmin}
            onChangerCode={() => setChangeCode(true)}
            onDeconnexion={onDeconnexion}
          />
        )}
      </div>

      <Navigation onglets={ONGLETS} actif={onglet} onChoisir={setOnglet} />
    </>
  );
}
