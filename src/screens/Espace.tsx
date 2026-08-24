import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import type { Session, VendorProfile, CustomerProfile } from '../lib/api';
import { Message } from '../components/ui';
import {
  Navigation, IconeBoutique, IconeClients, IconeMonnaie, IconeCompte,
  type Onglet,
} from '../components/Navigation';

import { Accueil } from './Accueil';
import { Compte, ChangerCode } from './Compte';
import { Conditions } from './Conditions';
import { GarderLaMonnaie } from './vendeur/GarderLaMonnaie';
import { UtiliserLaMonnaie } from './vendeur/UtiliserLaMonnaie';
import { NoterUneDette } from './vendeur/NoterUneDette';
import { Corriger } from './vendeur/Corriger';
import { MesClients } from './vendeur/MesClients';
import { MesDettes } from './vendeur/MesDettes';
import { Historique as HistoriqueVendeur } from './vendeur/Historique';
import { MaMonnaie } from './client/MaMonnaie';
import { MonCode } from './client/MonCode';
import { Historique as HistoriqueClient } from './client/Historique';
import { Confirmation } from './client/Confirmation';
import { AVerifier } from './client/AVerifier';
import { DemandesDette } from './client/ConfirmerDette';

/**
 * Espace — the whole app, for one kind of account.
 *
 * ============================================================================
 * WHAT THIS REPLACED. Two shells: EspaceClient and a vendor branch inside
 * App.tsx, each with its own tab bar, and which one you got was decided at
 * signup and never again. That is what stopped an ordinary person recording a
 * debt owed to them — not a missing screen, a missing shell.
 *
 * Every screen below is the SAME FILE it was before. None of them ever cared
 * which kind of account was rendering them; they take a vendor profile or a
 * customer profile, and one account now has both. The split was in the routing.
 * ============================================================================
 *
 * TASKS TAKE THE WHOLE SCREEN, and the bar goes with them. A fixed bar over a
 * task's own footer makes its last button unpressable — which happened, and
 * which the harness caught by retrying a click on "Annuler" until it timed out.
 * So every task belongs to this shell, because this shell is what hides the bar.
 */

type OngletCle = 'accueil' | 'jegarde' | 'onmedoit' | 'compte';

/**
 * Four destinations, named by DIRECTION rather than by role.
 *
 * "Mes clients" and "Mes dettes" were the old vendor labels and they still
 * describe the same two lists; what changed is that they no longer imply the
 * person reading them is a business. "Je garde" is money in my till that I owe
 * back; "On me doit" is money owed to me.
 */
const ONGLETS: Array<Onglet<OngletCle>> = [
  { cle: 'accueil', etiquette: 'Accueil', icone: IconeBoutique },
  { cle: 'jegarde', etiquette: 'Je garde', icone: IconeClients },
  { cle: 'onmedoit', etiquette: 'On me doit', icone: IconeMonnaie },
  { cle: 'compte', etiquette: 'Compte', icone: IconeCompte },
];

/** Full-screen flows. The bar is absent for all of them. */
type Tache =
  | 'garder' | 'utiliser' | 'dette' | 'code'
  | 'corriger' | 'historique' | 'carnets' | 'verifier'
  // Two screens that were tabs under the customer shell and had nowhere to go
  // when the two bars became one. Found by the UI harness, which navigated to
  // them by tab label and could not: dropping a tab is not the same as deciding
  // where its screen lives.
  | 'moncode' | 'histoclient'
  | null;

/**
 * The three things you cannot do without having acknowledged the disclosure.
 *
 * Not a UI preference: SQL refuses a credit and a debt claim from an
 * unacknowledged account (SW033). This list is the app asking BEFORE the
 * refusal, so nobody is stopped mid-transaction with a customer waiting and
 * then handed six lines of legal text.
 *
 * "utiliser" is NOT here. Spending change RELEASES custody, and a refund is
 * standing rule 9 — neither is ever gated, in SQL or here.
 */
const EXIGENT_CONDITIONS: Tache[] = ['garder', 'dette'];

export function Espace({
  session,
  vendeur,
  client,
  estAdmin,
  onAdmin,
  onDeconnexion,
}: {
  session: Session;
  /** Both halves. Either may be null on an account created before 0042. */
  vendeur: VendorProfile | null;
  client: CustomerProfile | null;
  estAdmin: boolean;
  onAdmin?: () => void;
  onDeconnexion: () => void;
}) {
  const [onglet, setOnglet] = useState<OngletCle>('accueil');
  const [tache, setTache] = useState<Tache>(null);
  /** The task waiting behind the disclosure, resumed once it is accepted. */
  const [apresConditions, setApresConditions] = useState<Tache>(null);

  /**
   * Start a task, asking for the acknowledgement first if it needs one.
   *
   * The task is remembered and resumed, so accepting lands where the tap was
   * going rather than back on the home screen — being sent back to start over
   * after reading a disclosure is how a shopkeeper decides the app is not worth
   * it in front of a customer.
   */
  const demarrer = (t: Tache) => {
    if (t && EXIGENT_CONDITIONS.includes(t) && vendeur && !vendeur.termsAcceptedAt) {
      setApresConditions(t);
      return;
    }
    setTache(t);
  };

  // ---- somebody is waiting on this phone ---------------------------------
  // Polling, moved here from EspaceClient unchanged. It runs for every account
  // now, because every account can be asked to confirm something.
  const [enAttente, setEnAttente] = useState(false);
  // Latched. Once a request has been shown, the confirmation screen stays until
  // IT says it is done — otherwise consuming the request pulls the receipt off
  // the screen before it can be read.
  const [montreDemande, setMontreDemande] = useState(false);
  const [demandeDette, setDemandeDette] = useState(false);
  const minuteur = useRef<number | null>(null);

  const idClient = client?.authUserId ?? null;

  const verifier = useCallback(async () => {
    if (!idClient) return;
    try {
      const [demandes, dettes, comps] = await Promise.all([
        api.pendingForMe(session.accessToken, idClient),
        api.pendingDebtsForMe(session.accessToken, idClient),
        api.pendingCompensationsForMe(session.accessToken, idClient),
      ]);
      setEnAttente(demandes.length > 0);
      if (demandes.length > 0) setMontreDemande(true);
      setDemandeDette(dettes.length > 0 || comps.length > 0);
    } catch {
      // A failed poll on patchy signal is normal. Leave the current view in
      // place rather than yanking somebody out of whatever they are doing.
    }
  }, [session.accessToken, idClient]);

  useEffect(() => {
    verifier();
    minuteur.current = window.setInterval(verifier, 2500);
    return () => {
      if (minuteur.current) window.clearInterval(minuteur.current);
    };
  }, [verifier]);

  // ---- interruptions, in urgency order -----------------------------------
  // A debit spends change already held; a debt creates an obligation. Both have
  // somebody waiting, so whichever is pending takes the screen — the debit
  // first, because it is the more common act.
  if (client && (enAttente || montreDemande)) {
    return (
      <Confirmation
        session={session}
        client={client}
        onDeconnexion={onDeconnexion}
        onTermine={() => setMontreDemande(false)}
      />
    );
  }

  if (client && demandeDette && !enAttente) {
    return (
      <DemandesDette
        session={session}
        client={client}
        onRien={() => setDemandeDette(false)}
      />
    );
  }

  // ---- the disclosure, before the task that needs it ---------------------
  if (vendeur && apresConditions) {
    return (
      <Conditions
        session={session}
        vendeur={vendeur}
        onAccepte={() => {
          const suite = apresConditions;
          setApresConditions(null);
          // The profile still says null until App refetches, so the task is
          // started directly rather than routed back through demarrer(), which
          // would ask again and loop.
          setTache(suite);
        }}
        onAnnuler={() => setApresConditions(null)}
      />
    );
  }

  // ---- tasks -------------------------------------------------------------
  if (tache === 'code') {
    return (
      <ChangerCode
        session={session}
        onTermine={() => setTache(null)}
        onAnnuler={() => setTache(null)}
      />
    );
  }

  if (vendeur && tache === 'garder') {
    return (
      <GarderLaMonnaie session={session} vendeur={vendeur} onTermine={() => setTache(null)} />
    );
  }

  if (vendeur && tache === 'utiliser') {
    return (
      <UtiliserLaMonnaie session={session} vendeur={vendeur} onTermine={() => setTache(null)} />
    );
  }

  if (vendeur && tache === 'dette') {
    return (
      <NoterUneDette session={session} vendeur={vendeur} onTermine={() => setTache(null)} />
    );
  }

  if (vendeur && tache === 'corriger') {
    return <Corriger session={session} vendeur={vendeur} onRetour={() => setTache(null)} />;
  }

  if (vendeur && tache === 'historique') {
    return (
      <HistoriqueVendeur session={session} vendeur={vendeur} onRetour={() => setTache(null)} />
    );
  }

  // My own position with each counterparty: what they hold for me, and what I
  // owe them. Both cells of the right-hand column of the matrix land here.
  if (client && tache === 'carnets') {
    return (
      <MaMonnaie
        session={session}
        client={client}
        onVerifier={() => setTache('verifier')}
        onHistorique={() => setTache('histoclient')}
        onRetour={() => setTache(null)}
      />
    );
  }

  // The QR a keeper scans. Reached from the home screen because it is shown at a
  // counter with somebody waiting, which is the wrong moment to go looking.
  if (tache === 'moncode') {
    return <MonCode session={session} onRetour={() => setTache(null)} />;
  }

  // My movements as the party BEING kept for, across every carnet. Reached from
  // Mes carnets, so each history sits beside the side of the book it describes.
  if (client && tache === 'histoclient') {
    return (
      <HistoriqueClient session={session} client={client} onRetour={() => setTache(null)} />
    );
  }

  if (client && tache === 'verifier') {
    return <AVerifier session={session} client={client} onTermine={() => setTache(null)} />;
  }

  // ---- destinations ------------------------------------------------------
  // The name shown at the top comes from the vendors row, which every account
  // has since 0042. An account created before it falls back to the customer
  // display name, then to the phone number — a screen with no title is worse
  // than one titled by a number the reader recognises.
  const nom = vendeur?.businessName ?? '';

  return (
    <>
      {/* PERSISTENT, not a one-time notice. Set the moment a code is typed on
          somebody else's phone, which happens while the app is in use — so a
          banner shown only at login waits for a sign-out that may never come.
          Two causes, two sentences: one is a warning that the code has been
          seen, the other is housekeeping about a four-digit code from before
          every code was six. */}
      {client?.pinChangeRequired ? (
        <div className="ecran" style={{ minHeight: 'auto', paddingBottom: 0 }}>
          <Message ton="erreur">
            {client.pinChangeReason === 'legacy_length'
              ? 'Les codes ont maintenant 6 chiffres. Changez le vôtre depuis « Compte ».'
              : 'Votre code a été saisi sur le téléphone de quelqu’un d’autre. Changez-le depuis « Compte ».'}
          </Message>
        </div>
      ) : null}

      {/* keyed on the tab so the entry animation replays per destination.
          Without the key React reuses the node and the screen swaps with no
          transition at all. */}
      <div key={onglet}>
        {onglet === 'accueil' ? (
          <Accueil
            session={session}
            actorUserId={vendeur?.authUserId ?? client?.authUserId ?? ''}
            nom={nom}
            quartier={vendeur?.quartier ?? null}
            onGarder={() => demarrer('garder')}
            onUtiliser={() => demarrer('utiliser')}
            onNoterDette={() => demarrer('dette')}
            onJeGarde={() => setOnglet('jegarde')}
            onOnMeDoit={() => setOnglet('onmedoit')}
            onMesCarnets={() => setTache('carnets')}
            onHistorique={() => setTache('historique')}
            onMonCode={() => setTache('moncode')}
            onCorriger={() => setTache('corriger')}
            onVerifier={() => setTache('verifier')}
          />
        ) : onglet === 'jegarde' ? (
          vendeur ? <MesClients session={session} vendeur={vendeur} /> : <MoitieAbsente />
        ) : onglet === 'onmedoit' ? (
          vendeur ? <MesDettes session={session} vendeur={vendeur} /> : <MoitieAbsente />
        ) : (
          <Compte
            session={session}
            vendeur={vendeur}
            client={client}
            estAdmin={estAdmin}
            onAdmin={onAdmin}
            onChangerCode={() => setTache('code')}
            onDeconnexion={onDeconnexion}
          />
        )}
      </div>

      <Navigation
        onglets={ONGLETS}
        actif={onglet}
        onChoisir={(c) => { setTache(null); setOnglet(c); }}
      />
    </>
  );
}

/**
 * An account created before 0042 has only one of its two halves.
 *
 * It says so rather than showing an empty list, because an empty list is a
 * claim — "you have nobody here" — and this is not that. The missing half is
 * created the next time the account signs in.
 */
function MoitieAbsente() {
  return (
    <div className="ecran ecran--avec-nav vue">
      <div className="ecran__corps">
        <Message ton="info">
          Cette partie de votre carnet n’est pas encore ouverte. Déconnectez-vous
          et reconnectez-vous une fois pour l’activer.
        </Message>
      </div>
    </div>
  );
}
