import { useEffect, useRef, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, VendorProfile } from '../../lib/api';
import {
  Clavier, Entete, Message, Cadran, Montant, Compteur,
  BoutonPrimaire, BoutonSecondaire, BoutonDiscret,
} from '../../components/ui';
import { appendDigit, removeDigit, formatPhoneLocal } from '../../lib/format';
import { SaisieClient } from '../../components/SaisieClient';

/**
 * Utiliser la monnaie — the vendor proposes a debit; the customer confirms on
 * THEIR OWN phone.
 *
 * The vendor never sees or types the customer's PIN. That is the whole point of
 * the two-device handshake: a PIN the vendor has seen proves nothing about
 * consent to any particular transaction, because they could reuse it whenever
 * they liked.
 *
 * Blocked offline (standing rule 7). An available balance cannot be verified
 * without the server, and guessing would create double-spend.
 */
type Etape = 'numero' | 'montant' | 'attente' | 'fait';

export function UtiliserLaMonnaie({
  session,
  vendeur,
  onTermine,
}: {
  session: Session;
  vendeur: VendorProfile;
  onTermine: () => void;
}) {
  const [etape, setEtape] = useState<Etape>('numero');
  const [numero, setNumero] = useState('');
  const [montant, setMontant] = useState(0);
  const [clientId, setClientId] = useState<string | null>(null);
  const [dispo, setDispo] = useState<number | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [secondes, setSecondes] = useState(0);
  const [restant, setRestant] = useState<number | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [enLigne, setEnLigne] = useState(navigator.onLine);

  const minuteur = useRef<number | null>(null);

  useEffect(() => {
    const on = () => setEnLigne(true);
    const off = () => setEnLigne(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Poll for the customer's confirmation, and count the proposal down.
  useEffect(() => {
    if (etape !== 'attente' || !pendingId) return;

    let arrete = false;

    async function verifier() {
      try {
        const p = await api.watchPending(session.accessToken, pendingId!);
        if (arrete || !p) return;

        if (p.consumedEntryId) {
          const balance = clientId
            ? await api.balanceWith(session.accessToken, vendeur.id, clientId)
            : null;
          setRestant(balance);
          setEtape('fait');
          return;
        }

        if (p.cancelledAt) {
          setErreur('Demande annulée.');
          setEtape('montant');
          return;
        }

        const reste = Math.max(
          0,
          Math.ceil((new Date(p.expiresAt).getTime() - Date.now()) / 1000)
        );
        setSecondes(reste);

        if (reste === 0) {
          setErreur('Demande expirée. Recommencez.');
          setEtape('montant');
        }
      } catch {
        // A failed poll is not a failed transaction. Keep polling; the vendor
        // sees the countdown continue rather than a spurious error.
      }
    }

    verifier();
    minuteur.current = window.setInterval(verifier, 1500);
    return () => {
      arrete = true;
      if (minuteur.current) window.clearInterval(minuteur.current);
    };
  }, [etape, pendingId, session.accessToken, vendeur.id, clientId]);

  async function chercherClient(msisdn: string) {
    setNumero(msisdn);
    setErreur(null);
    setOccupe(true);
    try {
      const r = await api.lookupCustomer(
        session.accessToken, vendeur.id, vendeur.authUserId, msisdn
      );
      if (!r.exists || !r.customerId) {
        setErreur("Ce client n'a pas de monnaie chez vous.");
        return;
      }
      const balance = await api.balanceWith(session.accessToken, vendeur.id, r.customerId);
      if (balance <= 0) {
        setErreur("Ce client n'a pas de monnaie chez vous.");
        return;
      }
      setClientId(r.customerId);
      setDispo(balance);
      setEtape('montant');
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  async function proposer() {
    setErreur(null);
    setOccupe(true);
    try {
      const p = await api.initiateDebit(session.accessToken, {
        customerPhone: numero,
        amountCfa: montant,
        kind: 'purchase',
        idempotencyKey: crypto.randomUUID(),
      });
      setPendingId(p.pendingId);
      setSecondes(
        Math.max(0, Math.ceil((new Date(p.expiresAt).getTime() - Date.now()) / 1000))
      );
      setEtape('attente');
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  async function annuler() {
    if (!pendingId) return;
    try {
      await api.cancelPending(session.accessToken, pendingId, vendeur.authUserId);
    } catch {
      // Cancelling is a convenience; the proposal expires on its own in any
      // case, so a failure here must not trap the vendor on this screen.
    }
    setPendingId(null);
    setEtape('montant');
  }

  const trop = dispo !== null && montant > dispo;

  // Rule 7. The message is the exact wording from spec section 8.
  if (!enLigne) {
    return (
      <div className="ecran">
        <Entete sousTitre={vendeur.businessName} action={<BoutonDiscret onClick={onTermine}>Retour</BoutonDiscret>} />
        <div className="ecran__corps">
          <Message ton="erreur">Connexion requise pour utiliser la monnaie</Message>
          <p className="discret">
            La monnaie gardée peut être enregistrée sans réseau, mais pas
            utilisée : sans connexion, impossible de vérifier ce qui reste.
          </p>
        </div>
      </div>
    );
  }

  if (etape === 'numero') {
    return (
      <SaisieClient
        titre="Utiliser la monnaie"
        sousTitre={vendeur.businessName}
        erreur={erreur}
        occupe={occupe}
        onNumero={chercherClient}
        onRetour={onTermine}
      />
    );
  }

  return (
    <div className="ecran">
      <Entete
        sousTitre={vendeur.businessName}
        action={<BoutonDiscret onClick={onTermine}>Retour</BoutonDiscret>}
      />

      <div className="ecran__corps">
        {etape === 'montant' && (
          <>
            <h1>Montant à utiliser</h1>
            <p className="discret">
              Monnaie du client chez vous : <Montant value={dispo ?? 0} />
            </p>
            <Cadran etiquette="À utiliser maintenant">
              <Montant value={montant} taille="geant" />
            </Cadran>
            {trop ? (
              <Message ton="erreur">
                Le client n'a que <Montant value={dispo ?? 0} /> chez vous.
              </Message>
            ) : null}
            {erreur ? <Message ton="erreur">{erreur}</Message> : null}
            <Clavier
              onDigit={(d) => { setErreur(null); setMontant(appendDigit(montant, d)); }}
              onEffacer={() => setMontant(removeDigit(montant))}
              onToutEffacer={() => setMontant(0)}
            />
          </>
        )}

        {etape === 'attente' && (
          <>
            <h1>En attente du client</h1>
            <Cadran etiquette="Le client confirme sur son téléphone">
              <Montant value={montant} taille="geant" />
              <p className="discret">
                Temps restant <Compteur secondes={secondes} />
              </p>
            </Cadran>
            <Message ton="info">
              Le client saisit son code sur son propre téléphone. Ne demandez
              jamais son code.
            </Message>
          </>
        )}

        {etape === 'fait' && (
          <>
            <h1>Confirmé</h1>
            <article className="carnet">
              <div>
                <div className="carnet__boutique">{vendeur.businessName}</div>
                <div className="carnet__quartier">{formatPhoneLocal(numero)}</div>
              </div>
              <div className="carnet__etiquette">Utilisé</div>
              <Montant value={montant} taille="geant" />
            </article>
            {restant !== null ? (
              <p className="discret centre">
                Monnaie restante du client chez vous : <Montant value={restant} />
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="ecran__pied pile">
        {etape === 'montant' && (
          <>
            <BoutonPrimaire onClick={proposer} disabled={montant <= 0 || trop || occupe}>
              {occupe ? 'Envoi…' : 'Demander la confirmation'}
            </BoutonPrimaire>
            <BoutonDiscret onClick={() => setEtape('numero')}>Changer de client</BoutonDiscret>
          </>
        )}
        {etape === 'attente' && <BoutonSecondaire onClick={annuler}>Annuler la demande</BoutonSecondaire>}
        {etape === 'fait' && <BoutonPrimaire onClick={onTermine}>Terminer</BoutonPrimaire>}
      </div>
    </div>
  );
}
