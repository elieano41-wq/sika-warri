import { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, CustomerProfile, ReviewRow } from '../../lib/api';
import {
  Entete, Message, Montant, BoutonPrimaire, BoutonSecondaire, BoutonDiscret,
} from '../../components/ui';
import { formatCfa } from '../../lib/format';
import { dateEtHeure } from '../../lib/mouvements';

/**
 * À vérifier — everything recorded in this customer's name that they have never
 * answered.
 *
 * ============================================================================
 * THIS SCREEN IS THE DEFENCE AGAINST PRE-LOADED DEBTS.
 *
 * A vendor can write a claim against any phone number, including numbers
 * belonging to people who have never heard of Sika Warri. That is required — it
 * is how the paper carnet works and what makes the register usable on day one.
 *
 * It is also an attack, unless registering changes nothing. If signing up
 * silently turned those claims into established fact, a vendor could load a list
 * of numbers and wait. So nothing is ever accepted by signup, by default, or by
 * the passage of time: a claim stays a claim until the person it is against says
 * otherwise, here, on their own device.
 * ============================================================================
 *
 * Shown at first login before anything else, and reachable afterwards from Ma
 * monnaie for as long as anything is unanswered.
 *
 * The heading does not say "vérifiez vos dettes" — it says who claims what.
 * The reader has to be able to tell, without being told twice, that these are
 * assertions by other people and not a bill.
 */
export function AVerifier({
  session,
  client,
  onTermine,
}: {
  session: Session;
  client: CustomerProfile;
  onTermine: () => void;
}) {
  const [lignes, setLignes] = useState<ReviewRow[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState<string | null>(null);
  const [motif, setMotif] = useState<{ id: string; texte: string } | null>(null);

  const charger = useCallback(async () => {
    try {
      setLignes(await api.myReviewQueue(session.accessToken, client.authUserId));
      setErreur(null);
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }, [session.accessToken, client.authUserId]);

  useEffect(() => { charger(); }, [charger]);

  async function repondre(
    l: ReviewRow,
    decision: 'accepted' | 'disputed',
    raison: string | null = null
  ) {
    setOccupe(l.entry_id);
    setErreur(null);
    try {
      await api.reviewEntry(session.accessToken, {
        register: l.register,
        entryId: l.entry_id,
        decision,
        actorUserId: client.authUserId,
        reason: raison,
      });
      setMotif(null);
      await charger();
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(null);
    }
  }

  const dettes = (lignes ?? []).filter((l) => l.register === 'debt');
  const monnaies = (lignes ?? []).filter((l) => l.register === 'change');

  return (
    <div className="ecran vue--tache">
      <Entete
        sousTitre="À vérifier"
        action={<BoutonDiscret onClick={onTermine}>Plus tard</BoutonDiscret>}
      />

      <div className="ecran__corps">
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {lignes === null ? (
          <p className="discret">Chargement…</p>
        ) : lignes.length === 0 ? (
          <>
            <h1>Rien à vérifier</h1>
            <p className="discret">
              Personne n’a enregistré quelque chose à votre nom sans votre accord.
            </p>
          </>
        ) : (
          <>
            <h1>Ce que d’autres ont enregistré</h1>
            <Message ton="info">
              Ces personnes déclarent ceci à votre sujet. Rien n’est confirmé
              tant que vous ne l’avez pas dit vous-même. Prenez votre temps —
              vous pouvez répondre plus tard.
            </Message>

            {dettes.length > 0 ? (
              <>
                <h2>Ils déclarent que vous leur devez</h2>
                {dettes.map((l) => (
                  <article key={l.entry_id} className="carte">
                    <div className="carte__titre">{l.business_name}</div>
                    {l.quartier ? (
                      <div className="carte__sous">{l.quartier}</div>
                    ) : null}
                    <Montant value={l.amount_cfa} taille="grand" />
                    <div className="discret">{dateEtHeure(l.created_at)}</div>
                    {l.note ? <div className="discret">« {l.note} »</div> : null}

                    {motif?.id === l.entry_id ? (
                      <div className="pile">
                        <p className="discret">
                          Pourquoi contestez-vous ? Ce sera visible sur le carnet.
                        </p>
                        <input
                          className="champ__saisie"
                          value={motif.texte}
                          onChange={(e) =>
                            setMotif({ id: l.entry_id, texte: e.target.value })
                          }
                          placeholder="Je n'ai rien pris ce jour-là"
                          autoFocus
                        />
                        <BoutonPrimaire
                          onClick={() => repondre(l, 'disputed', motif.texte || null)}
                          disabled={occupe === l.entry_id}
                        >
                          Envoyer la contestation
                        </BoutonPrimaire>
                        <BoutonSecondaire onClick={() => setMotif(null)}>
                          Annuler
                        </BoutonSecondaire>
                      </div>
                    ) : (
                      <div className="pile">
                        {/* Deliberately equal weight. Making "Je reconnais" the
                            primary button would be a nudge toward agreeing with
                            a claim, on the screen whose entire purpose is that
                            agreeing must be a choice. */}
                        <BoutonSecondaire
                          onClick={() => repondre(l, 'accepted')}
                          disabled={occupe === l.entry_id}
                        >
                          Je reconnais cette dette
                        </BoutonSecondaire>
                        <BoutonSecondaire
                          onClick={() => setMotif({ id: l.entry_id, texte: '' })}
                          disabled={occupe === l.entry_id}
                        >
                          Je conteste
                        </BoutonSecondaire>
                      </div>
                    )}
                  </article>
                ))}
              </>
            ) : null}

            {monnaies.length > 0 ? (
              <>
                <h2>Ils déclarent garder votre monnaie</h2>
                <p className="discret">
                  Ceci est en votre faveur : ce sont d’autres qui disent
                  vous devoir de la monnaie.
                </p>
                {monnaies.map((l) => (
                  <article key={l.entry_id} className="carte">
                    <div className="carte__titre">{l.business_name}</div>
                    <Montant value={l.amount_cfa} taille="grand" />
                    <div className="discret">{dateEtHeure(l.created_at)}</div>
                    <div className="pile">
                      <BoutonSecondaire
                        onClick={() => repondre(l, 'accepted')}
                        disabled={occupe === l.entry_id}
                      >
                        C’est juste
                      </BoutonSecondaire>
                      <BoutonSecondaire
                        onClick={() => repondre(l, 'disputed')}
                        disabled={occupe === l.entry_id}
                      >
                        Je ne reconnais pas
                      </BoutonSecondaire>
                    </div>
                  </article>
                ))}
              </>
            ) : null}
          </>
        )}
      </div>

      <div className="ecran__pied pile">
        <p className="discret centre">
          Contester ne supprime rien. L’autre partie est prévenue et le désaccord
          est enregistré.
        </p>
        <BoutonPrimaire onClick={onTermine}>
          {lignes && lignes.length === 0 ? 'Continuer' : 'Terminer plus tard'}
        </BoutonPrimaire>
      </div>
    </div>
  );
}
