import { useEffect, useState } from 'react';
import * as api from '../../lib/api';
import { useIdempotence } from '../../lib/idempotence';
import type { Session, VendorProfile } from '../../lib/api';
import {
  Entete, Message, Montant, Clavier, BoutonPrimaire, BoutonSecondaire,
  BoutonDiscret, Cadran, Compteur,
} from '../../components/ui';
import { EtatDetteBadge } from '../../components/Dette';
import { SaisieClient } from '../../components/SaisieClient';
import { appendDigit, formatCfa, formatPhoneLocal } from '../../lib/format';

/**
 * Noter une dette — the vendor writes down what a customer owes.
 *
 * ============================================================================
 * IT MUST BE AS FAST AS GARDER LA MONNAIE. If it takes more taps, vendors keep
 * using paper and we have built nothing. So it is the same rhythm — number,
 * name if new, amount, done — and the same components, on purpose: a vendor who
 * has learned one flow has learned both.
 * ============================================================================
 *
 * THE ONE PLACE IT DIVERGES, and it is the whole feature:
 *
 *   * A REGISTERED customer standing here is offered the handshake. The vendor
 *     hands over the phone, the customer types their own code, and the debt is
 *     CONFIRMÉE. Nothing else on this screen can produce that state.
 *   * An UNREGISTERED customer, or one who has already left, gets a DÉCLARÉE
 *     entry: the vendor's word, recorded as the vendor's word.
 *
 * There is no third path and no vendor-device fallback. Amendment I lets a
 * customer type their code on the vendor's phone to spend change they already
 * hold; allowing it here would let a vendor mint a debt from nothing, which is
 * the most dangerous action this product could offer. The API has no parameter
 * for it and the database has no value for it.
 *
 * The screen says which of the two happened, in as many words, every time.
 */

type Etape = 'numero' | 'nom' | 'montant' | 'attente' | 'fait';

export function NoterUneDette({
  session,
  vendeur,
  onTermine,
}: {
  session: Session;
  vendeur: VendorProfile;
  onTermine: () => void;
}) {
  const [etape, setEtape] = useState<Etape>('numero');
  const [enLigne, setEnLigne] = useState(navigator.onLine);
  // ONE KEY PER TRANSACTION, not per attempt. A retry after a lost
  // response must be recognised as a replay, or a dropped connection at a
  // market stall writes the entry twice. See lib/idempotence.ts.
  const { cle: cleIdem, terminer: idemFait } = useIdempotence();
  const [numero, setNumero] = useState('');
  const [montant, setMontant] = useState(0);
  const [clientId, setClientId] = useState<string | null>(null);
  const [etiquette, setEtiquette] = useState<string | null>(null);
  const [inscrit, setInscrit] = useState(false);
  const [dejaDu, setDejaDu] = useState(0);
  const [nomSaisi, setNomSaisi] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [attente, setAttente] = useState<{ id: string; secondes: number } | null>(null);
  const [resultat, setResultat] = useState<{ confirmee: boolean; total: number } | null>(null);

  // The vendor's OWN cap, not a constant. It is configurable per vendor, so a
  // hardcoded 10 000 made this warning wrong for anyone set differently — and
  // wrong in the worse direction, letting them reach the amount step before the
  // server refused it in front of a customer.
  const plafond = vendeur.maxDebtPerCustomer;

  // Rule 7. Recording a debt needs the server: the cap and the running total
  // both live there, so offline a vendor could write a claim that breaches a
  // ceiling the whole design rests on and not find out until later.
  useEffect(() => {
    const enHaut = () => setEnLigne(true);
    const enBas = () => setEnLigne(false);
    window.addEventListener('online', enHaut);
    window.addEventListener('offline', enBas);
    return () => {
      window.removeEventListener('online', enHaut);
      window.removeEventListener('offline', enBas);
    };
  }, []);

  async function trouver(msisdn: string, label?: string) {
    setErreur(null);
    setOccupe(true);
    try {
      // Creates the row if the number is new. That is the unregistered path and
      // it is required: a vendor must be able to write down a debt for someone
      // with no account, exactly as they would on paper.
      const rows = (await api.ensureCustomerForDebt(
        session.accessToken,
        vendeur.id,
        vendeur.authUserId,
        msisdn,
        label ?? null
      ));

      setClientId(rows.customerId);
      setInscrit(rows.isRegistered);
      setEtiquette(rows.yourLabel);
      setNumero(msisdn);

      const du = await api.debtWith(
        session.accessToken, vendeur.id, rows.customerId, vendeur.authUserId
      );
      setDejaDu(du);

      // A phone number is useless at a counter. Ask once, never again.
      if (!rows.yourLabel) {
        setNomSaisi('');
        setEtape('nom');
      } else {
        setEtape('montant');
      }
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  /** The handshake: the customer confirms on their own phone. */
  async function proposer() {
    if (!clientId || montant <= 0) return;
    setErreur(null);
    setOccupe(true);
    try {
      const p = await api.proposeDebt(session.accessToken, {
        vendorId: vendeur.id,
        customerId: clientId,
        actorUserId: vendeur.authUserId,
        amountCfa: montant,
        idempotencyKey: cleIdem(),
      });
      // The proposal exists server-side now. Retrying the PROPOSAL is what the
      // key protected; the confirmation that follows is keyed by the pending id.
      idemFait();
      setAttente({ id: p.id, secondes: 180 });
      setEtape('attente');
      surveiller(p.id);
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  /**
   * Watch for the customer's answer.
   *
   * Polled rather than pushed: Web Push is Phase 2, and the vendor is holding
   * the phone out across a counter, so two seconds is the difference between
   * "it worked" and "is this thing broken".
   */
  function surveiller(pendingId: string) {
    const debut = Date.now();
    // Whether we have actually HEARD from the server during this wait. Without
    // it, a run of failed polls is indistinguishable from a customer who did
    // nothing — and the app would blame the customer for the network.
    let vuLeServeur = false;

    const minuteur = window.setInterval(async () => {
      const restant = 180 - Math.floor((Date.now() - debut) / 1000);
      setAttente({ id: pendingId, secondes: Math.max(0, restant) });

      if (restant <= 0) {
        window.clearInterval(minuteur);
        setAttente(null);
        setEtape('montant');
        // ONLY CLAIM WHAT WE KNOW. The old message said "le client n'a pas
        // confirmé à temps", which the app cannot know: the countdown is local,
        // so a bad connection produced the same words as a refusal. If the polls
        // were failing, say that instead — the vendor's next move is different.
        setErreur(
          vuLeServeur
            ? "Le client n'a pas confirmé à temps. Recommencez, ou notez la dette sans confirmation."
            : "Connexion perdue pendant l'attente. Vérifiez dans « Mes dettes » si la dette a été enregistrée avant de recommencer."
        );
        return;
      }

      try {
        const du = await api.debtWith(
          session.accessToken, vendeur.id, clientId!, vendeur.authUserId
        );
        vuLeServeur = true;
        if (du >= dejaDu + montant) {
          window.clearInterval(minuteur);
          setResultat({ confirmee: true, total: du });
          setAttente(null);
          setEtape('fait');
        }
      } catch {
        // A failed poll is not a failed transaction. Keep waiting rather than
        // telling the vendor something went wrong when it may not have.
      }
    }, 2000);
  }

  /** The vendor's word, recorded as the vendor's word. */
  async function declarer() {
    if (!clientId || montant <= 0) return;
    setErreur(null);
    setOccupe(true);
    try {
      await api.declareDebt(session.accessToken, {
        vendorId: vendeur.id,
        customerId: clientId,
        actorUserId: vendeur.authUserId,
        amountCfa: montant,
        idempotencyKey: cleIdem(),
      });
      const du = await api.debtWith(
        session.accessToken, vendeur.id, clientId, vendeur.authUserId
      );
      idemFait();
      setResultat({ confirmee: false, total: du });
      setEtape('fait');
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  function recommencer() {
    setEtape('numero');
    setNumero('');
    setMontant(0);
    setClientId(null);
    setEtiquette(null);
    setInscrit(false);
    setDejaDu(0);
    setResultat(null);
    setAttente(null);
    setErreur(null);
  }

  const total = dejaDu + montant;
  // Shown BEFORE the vendor commits. A refusal mid-transaction, in front of a
  // customer, is the thing to avoid.
  const depasse = total > plafond;

  if (!enLigne) {
    return (
      <div className="ecran vue--tache">
        <Entete
          sousTitre={vendeur.businessName}
          action={<BoutonDiscret onClick={onTermine}>Retour</BoutonDiscret>}
        />
        <div className="ecran__corps">
          <Message ton="erreur">Connexion requise pour noter une dette</Message>
          <p className="discret">
            Sans réseau, impossible de vérifier ce que ce client vous doit déjà.
            Notez-le sur papier et enregistrez-le dès que la connexion revient.
          </p>
        </div>
        <div className="ecran__pied">
          <BoutonSecondaire onClick={onTermine}>Retour</BoutonSecondaire>
        </div>
      </div>
    );
  }

  // ---- who ---------------------------------------------------------------
  if (etape === 'numero') {
    return (
      <SaisieClient
        recents={{
          session,
          vendorId: vendeur.id,
          actorUserId: vendeur.authUserId,
          onChoisir: (c) => {
            setNumero(c.phone);
            setClientId(c.customer_id);
            setEtiquette(c.your_label);
            setInscrit(c.is_registered);
            setDejaDu(c.debt_cfa);
            setEtape('montant');
          },
        }}
        titre="Noter une dette"
        sousTitre="Le numéro du client"
        erreur={erreur}
        occupe={occupe}
        onNumero={(m) => trouver(m)}
        onRetour={onTermine}
      />
    );
  }

  const nom = etiquette ?? formatPhoneLocal(numero);

  return (
    <div className="ecran vue--tache">
      <Entete
        sousTitre={etape === 'fait' ? 'Dette notée' : nom}
        action={
          etape === 'attente' ? undefined : (
            <BoutonDiscret onClick={onTermine}>Quitter</BoutonDiscret>
          )
        }
      />

      <div className="ecran__corps">
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {/* ---- name a new customer ---------------------------------------- */}
        {etape === 'nom' && (
          <>
            <h1>Qui est ce client ?</h1>
            <p className="discret">
              Un nom que vous reconnaîtrez. Vous seul le voyez — ni la personne
              concernée ni les autres carnets.
            </p>
            <input
              className="champ__saisie"
              value={nomSaisi}
              onChange={(e) => setNomSaisi(e.target.value)}
              placeholder="Aya du marché"
              autoFocus
            />
            <BoutonPrimaire
              onClick={() => trouver(numero, nomSaisi)}
              disabled={nomSaisi.trim().length === 0 || occupe}
            >
              Continuer
            </BoutonPrimaire>
          </>
        )}

        {/* ---- amount ------------------------------------------------------ */}
        {etape === 'montant' && (
          <>
            <Cadran etiquette="Montant de la dette">
              <Montant value={montant} taille="geant" />
            </Cadran>

            {dejaDu > 0 ? (
              <p className="discret centre">
                {nom} vous doit déjà {formatCfa(dejaDu)}. Total : {formatCfa(total)}.
              </p>
            ) : null}

            {depasse ? (
              <Message ton="erreur">
                Vous ne pouvez pas dépasser {formatCfa(plafond)} de dette pour un
                même client.
              </Message>
            ) : null}

            <Clavier
              onDigit={(d) => setMontant(appendDigit(montant, d))}
              onEffacer={() => setMontant(Math.floor(montant / 10))}
              onToutEffacer={() => setMontant(0)}
            />
          </>
        )}

        {/* ---- waiting for the customer ------------------------------------ */}
        {etape === 'attente' && attente && (
          <>
            <h1>Donnez le téléphone au client</h1>
            <Cadran etiquette="Le client doit confirmer">
              <Montant value={montant} taille="geant" />
            </Cadran>
            <p className="centre">
              <Compteur secondes={attente.secondes} />
            </p>
            <Message ton="info">
              {nom} doit ouvrir Sika Warri sur SON téléphone et confirmer avec son
              code. Vous ne pouvez pas le faire à sa place.
            </Message>
            <BoutonSecondaire
              onClick={() => {
                api
                  .cancelPendingDebt(session.accessToken, attente.id, vendeur.authUserId)
                  .catch(() => {});
                setAttente(null);
                setEtape('montant');
              }}
            >
              Annuler
            </BoutonSecondaire>
          </>
        )}

        {/* ---- done -------------------------------------------------------- */}
        {etape === 'fait' && resultat && (
          <>
            <Cadran etiquette={`${nom} vous doit maintenant`}>
              <Montant value={resultat.total} taille="geant" />
            </Cadran>

            <div className="centre">
              <EtatDetteBadge etat={resultat.confirmee ? 'confirmed' : 'declared'} avecNote />
            </div>

            {!resultat.confirmee ? (
              <Message ton="info">
                {inscrit
                  ? "Le client pourra confirmer ou contester cette dette depuis son téléphone."
                  : "Ce client n'a pas encore de compte. Quand il s'inscrira avec ce numéro, il verra cette dette et pourra la confirmer ou la contester."}
              </Message>
            ) : null}
          </>
        )}
      </div>

      <div className="ecran__pied pile">
        {etape === 'montant' && (
          <>
            {/* The handshake first, and visibly the main action, because a
                confirmed debt is worth more to the vendor than a declared one:
                it is the difference between a record and a claim. */}
            {inscrit ? (
              <BoutonPrimaire onClick={proposer} disabled={montant <= 0 || depasse || occupe}>
                Demander la confirmation du client
              </BoutonPrimaire>
            ) : null}
            <BoutonSecondaire onClick={declarer} disabled={montant <= 0 || depasse || occupe}>
              {inscrit ? 'Noter sans confirmation' : 'Noter la dette'}
            </BoutonSecondaire>
            {inscrit ? (
              <p className="discret centre">
                Sans confirmation, la dette reste une déclaration de votre part.
              </p>
            ) : null}
          </>
        )}

        {etape === 'fait' && (
          <>
            <BoutonPrimaire onClick={recommencer}>Noter une autre dette</BoutonPrimaire>
            <BoutonSecondaire onClick={onTermine}>Terminé</BoutonSecondaire>
          </>
        )}
      </div>
    </div>
  );
}
