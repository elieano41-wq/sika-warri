import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, CustomerProfile, PendingRequest } from '../../lib/api';
import {
  Clavier, PinPoints, Entete, Message, Cadran, Montant, Compteur,
  BoutonSecondaire, BoutonDiscret,
} from '../../components/ui';

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
}: {
  session: Session;
  client: CustomerProfile;
  onDeconnexion: () => void;
}) {
  const [demandes, setDemandes] = useState<PendingRequest[]>([]);
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [fait, setFait] = useState<{ montant: number; restant: number | null } | null>(null);
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

  async function chiffre(d: string) {
    if (!demande || occupe) return;
    setErreur(null);
    if (pin.length >= 4) return;

    const suivant = pin + d;
    setPin(suivant);

    if (suivant.length === 4) {
      setOccupe(true);
      try {
        const r = await api.confirmDebit(session.accessToken, demande.id, suivant);
        setFait({ montant: r.amountCfa, restant: r.remainingCfa });
        setPin('');
      } catch (e) {
        setPin('');
        setErreur((e as api.ApiError).message);
      } finally {
        setOccupe(false);
      }
    }
  }

  // ---- after confirming ---------------------------------------------------
  if (fait) {
    return (
      <div className="ecran">
        <Entete sousTitre="Client" />
        <div className="ecran__corps">
          <h1>C'est confirmé</h1>
          <Cadran etiquette="Montant utilisé">
            <Montant value={fait.montant} taille="geant" />
          </Cadran>
          {fait.restant !== null ? (
            <p className="discret centre">
              Il vous reste <Montant value={fait.restant} /> chez ce commerçant.
            </p>
          ) : null}
        </div>
        <div className="ecran__pied pile">
          <BoutonSecondaire
            onClick={() => {
              setFait(null);
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
                ? 'Quand un commerçant vous demandera de confirmer, la demande apparaîtra ici.'
                : 'Chargement…'}
            </p>
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
        <h1>Confirmer ?</h1>

        {/* Le carnet: the shop asking, named, with the amount large. */}
        <article className="carnet">
          <div>
            <div className="carnet__boutique">{demande.businessName}</div>
            <div className="carnet__quartier">
              vous demande de confirmer
            </div>
          </div>
          <div className="carnet__etiquette">Montant à utiliser</div>
          <Montant value={demande.amountCfa} taille="geant" />
          <p className="discret">
            Votre monnaie chez ce commerçant : <Montant value={demande.currentBalance} />
            {' → '}
            <Montant value={demande.resultingBalance} />
          </p>
          <p className="discret">
            Expire dans <Compteur secondes={demande.secondsLeft} />
          </p>
        </article>

        <Cadran etiquette="Votre code à 4 chiffres">
          <PinPoints longueur={4} remplis={pin.length} />
        </Cadran>

        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        <Clavier
          onDigit={chiffre}
          onEffacer={() => setPin(pin.slice(0, -1))}
          onToutEffacer={() => setPin('')}
        />
      </div>

      <div className="ecran__pied pile">
        <p className="discret centre">
          Saisissez votre code sur votre propre téléphone. Ne le donnez jamais au
          commerçant.
        </p>
      </div>
    </div>
  );
}
