import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, CustomerProfile, PendingRequest } from '../../lib/api';
// The shared vocabulary. A vendor recording an entry and a customer confirming
// it must read the same words for it, so no screen decides what 'refund' means.
import { estRemboursement } from '../../lib/dette';
import {
  Clavier, PinPoints, Entete, Message, Cadran, Montant, Compteur,
  BoutonPrimaire, BoutonSecondaire, BoutonDiscret,
} from '../../components/ui';
import { PIN_LENGTH, PIN_MIN_ACCEPTE } from '../../lib/pinRules';

/**
 * The customer's confirmation screen. Amendment H, step 3.
 *
 * This runs on the CUSTOMER's own phone. Their PIN is typed here and travels
 * only from this device to the server. It is never shown to the vendor, never
 * typed on the vendor's device, and never observable by it — which is what makes
 * the confirmation mean anything. A vendor who has seen a PIN can debit whenever
 * they like; a vendor who never sees it cannot.
 *
 * The screen shows the shop's name, the amount, and what will be left, because
 * nobody should authorise a payment described only as a number.
 */
export function Confirmation({
  session,
  client,
  onDeconnexion,
  onTermine,
}: {
  session: Session;
  client: CustomerProfile;
  onDeconnexion: () => void;
  /**
   * Tells the shell this screen is finished.
   *
   * The shell used to decide by polling: no pending request, no screen. That
   * unmounted the receipt about two seconds after the customer confirmed, so
   * they never saw what they had just agreed to. The screen owns the exit now.
   */
  onTermine?: () => void;
}) {
  const [demandes, setDemandes] = useState<PendingRequest[]>([]);
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  // `kind` is carried through so the receipt names what happened. A customer
  // rereading their history needs to tell a purchase from cash they were handed.
  const [fait, setFait] = useState<
    { montant: number; restant: number | null; kind: string } | null
  >(null);
  const [chargeUnFois, setChargeUneFois] = useState(false);

  const minuteur = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.pendingForMe(session.accessToken, client.authUserId);
      setDemandes(r);
    } catch {
      // Silent: a failed poll on a phone with patchy signal is normal and must
      // not clear a request the customer is mid-way through confirming.
    } finally {
      setChargeUneFois(true);
    }
  }, [session.accessToken, client.authUserId]);

  // Polling while the app is open. Web Push is Phase 2 — until then the app
  // being open IS the notification, so the interval is short enough that a
  // customer holding out their phone sees the request appear.
  useEffect(() => {
    if (fait) return;
    refresh();
    minuteur.current = window.setInterval(refresh, 2000);
    return () => {
      if (minuteur.current) window.clearInterval(minuteur.current);
    };
  }, [refresh, fait]);

  const demande = demandes[0] ?? null;

  /**
   * Nothing to show, so hand the screen back.
   *
   * The shell latches this screen open once a request appears, because
   * otherwise consuming the request unmounts the receipt about two seconds
   * after the customer confirms and they never see what they agreed to. The
   * latch has to be released by the screen — here, once there is no pending
   * request AND no receipt: a request that expired unanswered, or a receipt the
   * customer has dismissed. Stranding them on "Aucune demande" would be the
   * mirror of the bug the latch fixes.
   */
  useEffect(() => {
    if (chargeUnFois && !demande && !fait) onTermine?.();
  }, [chargeUnFois, demande, fait, onTermine]);


  async function envoyer(code: string) {
    if (!demande || occupe || code.length < PIN_MIN_ACCEPTE) return;
    setOccupe(true);
    try {
      const r = await api.confirmDebit(session.accessToken, demande.id, code);
      setFait({ montant: r.amountCfa, restant: r.remainingCfa, kind: demande.kind });
      setPin('');
    } catch (e) {
      setPin('');
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  async function chiffre(d: string) {
    if (!demande || occupe) return;
    setErreur(null);
    if (pin.length >= PIN_LENGTH) return;

    const suivant = pin + d;
    setPin(suivant);

    // Auto-submit on the SIXTH digit. A code shorter than six belongs to an
    // account that predates the single length; it is submitted with the button
    // below, because auto-submitting at four would fire mid-typing for everyone
    // whose code is six — and refusing four outright would lock somebody out of
    // confirming a debit against their own balance.
    if (suivant.length === PIN_LENGTH) await envoyer(suivant);
  }

  // ---- after confirming ---------------------------------------------------
  if (fait) {
    return (
      <div className="ecran">
        <Entete sousTitre="Client" />
        <div className="ecran__corps">
          <h1>C'est confirmé</h1>
          <Cadran etiquette={fait && estRemboursement(fait) ? 'Rendu en espèces' : 'Montant utilisé'}>
            <Montant value={fait.montant} taille="geant" />
          </Cadran>
          {fait.restant !== null ? (
            <p className="discret centre">
              Il vous reste <Montant value={fait.restant} /> sur ce carnet.
            </p>
          ) : null}
        </div>
        <div className="ecran__pied pile">
          <BoutonSecondaire
            onClick={() => {
              setFait(null);
              onTermine?.();
              refresh();
            }}
          >
            Retour
          </BoutonSecondaire>
        </div>
      </div>
    );
  }

  // ---- nothing waiting ----------------------------------------------------
  if (!demande) {
    return (
      <div className="ecran">
        <Entete
          sousTitre="Client"
          action={<BoutonDiscret onClick={onDeconnexion}>Quitter</BoutonDiscret>}
        />
        <div className="ecran__corps" style={{ justifyContent: 'center' }}>
          <div className="centre pile">
            <h1>Aucune demande</h1>
            <p className="discret">
              {chargeUnFois
                ? 'Quand on vous demandera de confirmer, la demande apparaîtra ici.'
                : 'Chargement…'}
            </p>
            {chargeUnFois ? (
              <BoutonSecondaire onClick={() => onTermine?.()}>
                Retour à ma monnaie
              </BoutonSecondaire>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // ---- a request is waiting ----------------------------------------------
  return (
    <div className="ecran">
      <Entete sousTitre="Client" />

      <div className="ecran__corps">
        {/* WHAT is being confirmed, not just how much. A purchase and a cash
            refund are the same amount in the same direction and mean opposite
            things — in one the customer receives goods, in the other they must
            receive banknotes before agreeing. A customer who confirms a refund
            without the money in their hand has no recourse afterwards, so the
            distinction has to be on the screen where they decide. */}
        <h1>
          {estRemboursement(demande)
            ? 'On vous rend cette somme en espèces ?'
            : 'Confirmer ?'}
        </h1>

        {estRemboursement(demande) ? (
          <Message ton="info">
            Ne confirmez qu’après avoir reçu l’argent en main.
          </Message>
        ) : null}

        {/* Le carte: the shop asking, named, with the amount large. */}
        <article className="carte">
          <div>
            <div className="carte__titre">{demande.businessName}</div>
            <div className="carte__sous">
              vous demande de confirmer
            </div>
          </div>
          <div className="carte__etiquette">Montant à utiliser</div>
          <Montant value={demande.amountCfa} taille="geant" />
          <p className="discret">
            Votre monnaie sur ce carnet : <Montant value={demande.currentBalance} />
            {' → '}
            <Montant value={demande.resultingBalance} />
          </p>
          <p className="discret">
            Expire dans <Compteur secondes={demande.secondsLeft} />
          </p>
        </article>

        <Cadran etiquette={`Votre code à ${PIN_LENGTH} chiffres`}>
          <PinPoints longueur={PIN_LENGTH} remplis={pin.length} />
        </Cadran>

        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        <Clavier
          onDigit={chiffre}
          onEffacer={() => setPin(pin.slice(0, -1))}
          onToutEffacer={() => setPin('')}
        />

        {/* For a code shorter than six, from an account created before the
            lengths were unified. Invisible to everyone else: a six-digit code
            auto-submits and never reaches this. */}
        {pin.length >= PIN_MIN_ACCEPTE && pin.length < PIN_LENGTH ? (
          <BoutonPrimaire onClick={() => envoyer(pin)} disabled={occupe}>
            {occupe ? 'Vérification…' : 'Je confirme'}
          </BoutonPrimaire>
        ) : null}
      </div>

      <div className="ecran__pied pile">
        <p className="discret centre">
          Saisissez votre code sur votre propre téléphone. Ne le donnez jamais à
          personne.
        </p>
      </div>
    </div>
  );
}
