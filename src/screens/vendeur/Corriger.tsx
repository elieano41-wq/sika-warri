import { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, VendorProfile, RecentEntryRow } from '../../lib/api';
import {
  Entete, Message, Montant, BoutonPrimaire, BoutonSecondaire, BoutonDiscret,
  Cadran, Compteur,
} from '../../components/ui';
import { Vide, IconeCarnetVide } from '../../components/Vide';
import { useIdempotence } from '../../lib/idempotence';
import { formatCfa, formatPhoneLocal } from '../../lib/format';
import { libelleMouvement, dateEtHeure } from '../../lib/mouvements';

/**
 * Corriger une erreur — the vendor undoes their own typo.
 *
 * ============================================================================
 * THE MOST LIKELY THING TO GO WRONG ON DAY ONE. A vendor types 5000 instead of
 * 500 with a customer standing there. Migration 0013 built the 15-minute
 * unilateral window for exactly this and nothing ever surfaced it, so the only
 * routes out were the two-device handshake — which needs the customer to still
 * be present and to agree — or the support desk.
 * ============================================================================
 *
 * IT REVERSES, IT DOES NOT DELETE. Rule 3. Both entries stay visible in both
 * parties' history, and the screen says so before the vendor commits rather
 * than after. A vendor who believes they deleted something will eventually be
 * surprised by their own history, and a customer who sees an entry vanish has
 * every reason to distrust the whole ledger.
 *
 * WHY THE WINDOW IS SAFE WITHOUT THE CUSTOMER. Two guards, both in SQL:
 *   - 15 minutes, so it covers the moment of the mistake and not a change of
 *     mind next week;
 *   - the reversal must be the EXACT amount, so if the customer has already
 *     spent any of a credit the balance no longer covers it and the write is
 *     refused. A vendor cannot claw back change that has been used.
 *
 * The second guard is why this screen asks the server whether each entry is
 * correctable rather than working it out from a timestamp: a button that fails
 * in front of a customer is worse than no button.
 */
export function Corriger({
  session,
  vendeur,
  onRetour,
}: {
  session: Session;
  vendeur: VendorProfile;
  onRetour: () => void;
}) {
  const [entrees, setEntrees] = useState<RecentEntryRow[] | null>(null);
  const { cle: cleIdem, terminer: idemFait } = useIdempotence();
  const [confirme, setConfirme] = useState<RecentEntryRow | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [fait, setFait] = useState<{ montant: number; nouveau: number } | null>(null);

  const charger = useCallback(async () => {
    try {
      setEntrees(
        await api.vendorRecentEntries(session.accessToken, vendeur.id, vendeur.authUserId)
      );
      setErreur(null);
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }, [session.accessToken, vendeur.id, vendeur.authUserId]);

  useEffect(() => { charger(); }, [charger]);

  // The window closes while the screen is open. Refreshing keeps the countdown
  // honest and takes the button away at the moment it stops working, rather
  // than leaving one that fails when tapped.
  useEffect(() => {
    const t = window.setInterval(charger, 15000);
    return () => window.clearInterval(t);
  }, [charger]);

  async function corriger(e: RecentEntryRow) {
    setOccupe(true);
    setErreur(null);
    try {
      await api.correctOwnEntry(session.accessToken, {
        entryId: e.id,
        actorUserId: vendeur.authUserId,
        idempotencyKey: cleIdem(),
      });
      idemFait();
      const nouveau = await api.balanceWith(session.accessToken, vendeur.id, e.customer_id);
      setFait({ montant: e.amount_cfa, nouveau });
      setConfirme(null);
      await charger();
    } catch (err) {
      setErreur((err as api.ApiError).message);
      setConfirme(null);
    } finally {
      setOccupe(false);
    }
  }

  // ---- done --------------------------------------------------------------
  if (fait) {
    return (
      <div className="ecran vue--tache">
        <Entete sousTitre="Corrigé" />
        <div className="ecran__corps">
          <Message ton="succes">
            La correction est enregistrée. L’écriture d’origine et la correction
            restent toutes les deux visibles.
          </Message>
          <Cadran etiquette="Ce client a maintenant chez vous">
            <Montant value={fait.nouveau} taille="geant" />
          </Cadran>
        </div>
        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={() => setFait(null)}>
            Corriger autre chose
          </BoutonPrimaire>
          <BoutonSecondaire onClick={onRetour}>Terminé</BoutonSecondaire>
        </div>
      </div>
    );
  }

  // ---- confirm -----------------------------------------------------------
  if (confirme) {
    const nom = confirme.customer_label ?? formatPhoneLocal(confirme.customer_phone);
    return (
      <div className="ecran vue--tache">
        <Entete sousTitre="Confirmer la correction" />
        <div className="ecran__corps">
          <Cadran etiquette={`${libelleMouvement(confirme)} — ${nom}`}>
            <Montant value={confirme.amount_cfa} taille="geant" />
          </Cadran>

          {/* Said before committing, not after. A vendor who believes they
              deleted something will be surprised by their own history later,
              and a customer who sees an entry vanish has reason to distrust the
              whole ledger. */}
          <Message ton="info">
            Cette écriture ne sera pas supprimée. Une correction du même montant
            sera ajoutée en face, et les deux resteront visibles — pour vous et
            pour le client.
          </Message>

          <p className="discret">
            Le client verra la correction dans son historique.
          </p>
        </div>
        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={() => corriger(confirme)} disabled={occupe}>
            Oui, corriger {formatCfa(confirme.amount_cfa)}
          </BoutonPrimaire>
          <BoutonSecondaire onClick={() => setConfirme(null)}>
            Annuler
          </BoutonSecondaire>
        </div>
      </div>
    );
  }

  // ---- the list ----------------------------------------------------------
  return (
    <div className="ecran ecran--avec-nav vue">
      <Entete
        sousTitre="Vos dernières écritures"
        action={<BoutonDiscret onClick={onRetour}>Retour</BoutonDiscret>}
      />

      <div className="ecran__corps">
        <h1>Corriger une erreur</h1>
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        <p className="discret">
          Vous pouvez corriger seul une écriture pendant 15 minutes, tant que le
          client n’a pas utilisé la monnaie. Après, il faut son accord.
        </p>

        {entrees === null ? (
          <p className="discret">Chargement…</p>
        ) : entrees.length === 0 ? (
          <Vide titre="Rien à corriger" icone={IconeCarnetVide}>
            Vos écritures apparaîtront ici. Vous pourrez corriger une erreur
            pendant les 15 minutes qui suivent.
          </Vide>
        ) : (
          <ul className="pile" style={{ listStyle: 'none' }}>
            {entrees.map((e) => (
              <li key={e.id} className="ligne-histoire">
                <div>
                  <div style={{ fontWeight: 500 }}>{libelleMouvement(e)}</div>
                  <div className="discret">
                    {e.customer_label ?? formatPhoneLocal(e.customer_phone)}
                  </div>
                  <div className="discret">
                    {dateEtHeure(e.created_at)} · reçu {e.receipt_code}
                  </div>

                  {/* WHY NOT, when not. A greyed-out button teaches nothing and
                      a vendor will tap it repeatedly; the reason tells them what
                      to do instead. */}
                  {e.blocked_reason === 'expired' ? (
                    <div className="discret">
                      Plus de 15 minutes. Demandez au client de confirmer une
                      correction depuis « Utiliser la monnaie ».
                    </div>
                  ) : e.blocked_reason === 'spent' ? (
                    <div className="discret">
                      Le client a déjà utilisé cette monnaie. Il doit confirmer
                      la correction sur son téléphone.
                    </div>
                  ) : e.blocked_reason === 'reversed' ? (
                    <div className="discret">Déjà corrigée.</div>
                  ) : null}
                </div>

                <div style={{ textAlign: 'right' }}>
                  <span
                    className="montant montant--ligne"
                    style={{
                      color: e.direction === 'credit' ? 'var(--or-sika)' : 'var(--craie)',
                    }}
                  >
                    {e.direction === 'credit' ? '+' : '−'}
                    {formatCfa(e.amount_cfa)}
                  </span>

                  {e.correctable ? (
                    <div className="pile" style={{ gap: 'var(--espace-1)' }}>
                      <div className="discret">
                        <Compteur secondes={e.seconds_left} />
                      </div>
                      <BoutonSecondaire onClick={() => setConfirme(e)}>
                        Corriger
                      </BoutonSecondaire>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
