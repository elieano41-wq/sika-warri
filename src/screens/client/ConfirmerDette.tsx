import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, CustomerProfile } from '../../lib/api';
import {
  Entete, Message, Montant, Clavier, PinPoints, Cadran, Compteur,
  BoutonPrimaire, BoutonSecondaire,
} from '../../components/ui';
import { DeuxRegistres } from '../../components/Dette';
import { formatCfa } from '../../lib/format';

/**
 * A vendor is asking this customer to agree to something. On the customer's own
 * device, with the customer's own code.
 *
 * ============================================================================
 * THIS IS THE SCREEN THE WHOLE FRAUD MODEL RESTS ON.
 *
 * A fabricated debt earns the vendor money, so agreeing to owe money is the
 * highest-risk action in the product. Everything about this screen assumes the
 * vendor is standing there watching:
 *
 *   * the amount is enormous and stated before anything else
 *   * what they would owe IN TOTAL afterwards is shown, not just the increment,
 *     because agreeing to "2 000" when it makes 9 000 is a different decision
 *   * refusing is a real button of equal weight, not a small "cancel"
 *   * the code is typed here and travels to the server; it is never shown to
 *     the vendor and there is no path that lets the vendor type it
 * ============================================================================
 *
 * Two things can arrive here, and they are visually distinct because they are
 * different decisions:
 *
 *   DETTE        — you will owe this shop more money.
 *   COMPENSATION — change you already hold pays down what you already owe. No
 *                  new money either way, which is why it shows three figures.
 */

type Demande =
  | { type: 'dette'; id: string; boutique: string; montant: number; note: string | null;
      detteActuelle: number; detteApres: number; secondes: number }
  | { type: 'compensation'; id: string; boutique: string; montant: number;
      monnaieActuelle: number; detteActuelle: number;
      monnaieApres: number; detteApres: number; secondes: number };

export function ConfirmerDette({
  session,
  client,
  demande,
  onTermine,
}: {
  session: Session;
  client: CustomerProfile;
  demande: Demande;
  onTermine: () => void;
}) {
  const [code, setCode] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [fait, setFait] = useState<string | null>(null);
  const [secondes, setSecondes] = useState(demande.secondes);

  useEffect(() => {
    const t = window.setInterval(() => setSecondes((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(t);
  }, []);

  async function confirmer() {
    if (code.length !== 4) return;
    setOccupe(true);
    setErreur(null);
    try {
      if (demande.type === 'dette') {
        await api.confirmDebt(session.accessToken, demande.id, code);
        setFait('Dette confirmée');
      } else {
        const r = await api.confirmCompensation(session.accessToken, demande.id, code);
        setFait(
          `Réglé. Il vous reste ${formatCfa(r.remainingDebtCfa)} à payer chez ${demande.boutique}.`
        );
      }
    } catch (e) {
      setErreur((e as api.ApiError).message);
      setCode('');
    } finally {
      setOccupe(false);
    }
  }

  async function refuser() {
    setOccupe(true);
    try {
      if (demande.type === 'dette') {
        await api.cancelPendingDebt(session.accessToken, demande.id, client.authUserId);
      } else {
        await api.cancelPendingCompensation(
          session.accessToken, demande.id, client.authUserId
        );
      }
    } catch {
      // Refusing is also achieved by doing nothing until it expires, so a failed
      // cancel is not worth an error message the customer cannot act on.
    } finally {
      onTermine();
    }
  }

  if (fait) {
    return (
      <div className="ecran vue--tache">
        <Entete sousTitre="Confirmé" />
        <div className="ecran__corps">
          <Message ton="succes">{fait}</Message>
        </div>
        <div className="ecran__pied">
          <BoutonPrimaire onClick={onTermine}>Terminé</BoutonPrimaire>
        </div>
      </div>
    );
  }

  const expire = secondes <= 0;

  return (
    <div className="ecran vue--tache">
      <Entete sousTitre={demande.boutique} />

      <div className="ecran__corps">
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {demande.type === 'dette' ? (
          <>
            <h1>{demande.boutique} déclare que vous devez</h1>
            <Cadran etiquette="Montant">
              <Montant value={demande.montant} taille="geant" />
            </Cadran>
            {demande.note ? <p className="discret centre">« {demande.note} »</p> : null}

            {/* The total afterwards, not just the increment. Agreeing to 2 000
                when it makes 9 000 is a different decision, and the vendor
                asking will not always say so. */}
            {demande.detteActuelle > 0 ? (
              <Message ton="info">
                Vous devez déjà {formatCfa(demande.detteActuelle)} à cette
                boutique. En confirmant, vous devrez{' '}
                {formatCfa(demande.detteApres)} au total.
              </Message>
            ) : null}
          </>
        ) : (
          <>
            <h1>Régler avec votre monnaie</h1>
            <Cadran etiquette="Montant à déduire">
              <Montant value={demande.montant} taille="geant" />
            </Cadran>
            <p className="discret centre">
              Votre monnaie gardée chez {demande.boutique} paie une partie de ce
              que vous devez. Aucun argent ne change de main.
            </p>
            <p className="discret">Après cette opération :</p>
            <DeuxRegistres
              vue="client"
              monnaieCfa={demande.monnaieApres}
              detteCfa={demande.detteApres}
            />
          </>
        )}

        {expire ? (
          <Message ton="erreur">
            La demande a expiré. Demandez qu’on recommence.
          </Message>
        ) : (
          <>
            <p className="centre">
              <Compteur secondes={secondes} />
            </p>
            <div className="centre">
              <PinPoints longueur={4} remplis={code.length} />
            </div>
            <p className="discret centre">
              Tapez VOTRE code. Ne le montrez à personne, pas même à qui tient
              le carnet.
            </p>
          </>
        )}
      </div>

      <div className="ecran__pied pile">
        {!expire ? (
          <Clavier
            onDigit={(d) => setCode((c) => (c.length >= 4 ? c : c + d))}
            onEffacer={() => setCode((c) => c.slice(0, -1))}
            onToutEffacer={() => setCode('')}
          />
        ) : null}
        {!expire ? (
          <BoutonPrimaire onClick={confirmer} disabled={code.length !== 4 || occupe}>
            {demande.type === 'dette' ? 'Je confirme cette dette' : 'Je confirme'}
          </BoutonPrimaire>
        ) : null}
        {/* Equal weight, not a small "cancel". Refusing has to be as easy as
            agreeing on the screen where someone is watching you decide. */}
        <BoutonSecondaire onClick={refuser} disabled={occupe}>
          {demande.type === 'dette' ? 'Je refuse' : 'Non merci'}
        </BoutonSecondaire>
      </div>
    </div>
  );
}

/**
 * Poll for anything waiting, and render the first of it.
 *
 * Ordering is a judgement about urgency: a debt proposal and a compensation both
 * have 180 seconds and a vendor standing there, so whichever arrived first is
 * dealt with first.
 */
export function DemandesDette({
  session,
  client,
  onRien,
}: {
  session: Session;
  client: CustomerProfile;
  onRien: () => void;
}) {
  const [demande, setDemande] = useState<Demande | null>(null);
  const minuteur = useRef<number | null>(null);

  const verifier = useCallback(async () => {
    try {
      const [dettes, comps] = await Promise.all([
        api.pendingDebtsForMe(session.accessToken, client.authUserId),
        api.pendingCompensationsForMe(session.accessToken, client.authUserId),
      ]);

      const d = dettes[0];
      const c = comps[0];

      if (d) {
        setDemande({
          type: 'dette', id: d.id, boutique: d.businessName, montant: d.amountCfa,
          note: d.note, detteActuelle: d.currentDebt, detteApres: d.resultingDebt,
          secondes: d.secondsLeft,
        });
        return;
      }
      if (c) {
        setDemande({
          type: 'compensation', id: c.id, boutique: c.businessName,
          montant: c.amountCfa, monnaieActuelle: c.currentChange,
          detteActuelle: c.currentDebt, monnaieApres: c.resultingChange,
          detteApres: c.resultingDebt, secondes: c.secondsLeft,
        });
        return;
      }
      setDemande(null);
      onRien();
    } catch {
      // Patchy signal. Leave whatever is on screen rather than clearing it.
    }
  }, [session.accessToken, client.authUserId, onRien]);

  useEffect(() => {
    verifier();
    minuteur.current = window.setInterval(verifier, 2500);
    return () => {
      if (minuteur.current) window.clearInterval(minuteur.current);
    };
  }, [verifier]);

  if (!demande) return null;

  return (
    <ConfirmerDette
      session={session}
      client={client}
      demande={demande}
      onTermine={() => { setDemande(null); onRien(); }}
    />
  );
}
