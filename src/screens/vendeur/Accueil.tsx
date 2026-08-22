import { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, VendorProfile, VendorSummary } from '../../lib/api';
import { DeuxRegistres } from '../../components/Dette';
import { formatCfa } from '../../lib/format';
import {
  Entete, Message, Montant, BoutonPrimaire, BoutonSecondaire,
} from '../../components/ui';

/**
 * Accueil — what the vendor sees on opening the app.
 *
 * Spec section 5 asks for monnaie en circulation, the number of customers
 * concerned, today's activity, and one big primary action. The screen only had
 * buttons, so a shopkeeper had to tap into another screen to learn what they
 * owed. That is the wrong order: what you owe is the first thing, and it should
 * be readable across a stall without touching the phone.
 *
 * The figure is the vendor's own liability in their own till — a real single
 * number, unlike a customer's change pooled across shops, which rule 1 forbids
 * presenting as one sum.
 */
export function AccueilVendeur({
  session,
  vendeur,
  onGarder,
  onUtiliser,
  onNoterDette,
  onHistorique,
}: {
  session: Session;
  vendeur: VendorProfile;
  /* Only the two TASKS are passed in. Mes clients, Historique, Compte and the
     admin panel are destinations now and reached from the tab bar, so this
     screen no longer needs to know they exist. */
  onGarder: () => void;
  onUtiliser: () => void;
  onNoterDette: () => void;
  onHistorique: () => void;
}) {
  const [resume, setResume] = useState<VendorSummary | null>(null);
  // What the vendor is OWED, from its own aggregate. Kept in separate state from
  // the change summary so the two can never be added together by accident.
  const [dettes, setDettes] = useState<api.VendorDebtSummary | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const [m, d] = await Promise.all([
        api.vendorSummary(session.accessToken, vendeur.id, vendeur.authUserId),
        api.vendorDebtSummary(session.accessToken, vendeur.id, vendeur.authUserId),
      ]);
      setResume(m);
      setDettes(d);
      setErreur(null);
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }, [session.accessToken, vendeur.id, vendeur.authUserId]);

  // Refreshed on return to the screen and on returning to the foreground, so a
  // vendor coming back from recording change sees the new figure rather than a
  // stale one.
  useEffect(() => {
    charger();
    const auRetour = () => { if (document.visibilityState === 'visible') charger(); };
    document.addEventListener('visibilitychange', auRetour);
    return () => document.removeEventListener('visibilitychange', auRetour);
  }, [charger]);

  const activiteDuJour =
    resume !== null &&
    (resume.today_credit_count > 0 || resume.today_debit_count > 0);

  return (
    <div className="ecran ecran--avec-nav vue">
      <Entete sousTitre={`${vendeur.businessName} · ${vendeur.quartier}`} />

      <div className="ecran__corps">
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {/* TWO FIGURES, NEVER MERGED.

            What the vendor HOLDS for customers is a liability; what they are
            OWED is an asset. A single net number would be meaningless — it would
            add money in the till to money that may never arrive — and it would
            hide the one thing that matters, which is how much of what they are
            owed has gone stale. */}
        <article className="carnet">
          {resume === null || dettes === null ? (
            <>
              <div className="carnet__etiquette">Monnaie que vous gardez</div>
              <span className="montant montant--geant" style={{ color: 'var(--sauge)' }}>
                —
              </span>
              <div className="discret">Chargement…</div>
            </>
          ) : (
            <>
              <DeuxRegistres
                monnaieCfa={resume.circulation_cfa}
                detteCfa={dettes.debt_cfa}
                taille="grand"
                noteMonnaie={
                  resume.customers_owed === 0
                    ? 'Aucun client'
                    : `${resume.customers_owed} client${resume.customers_owed === 1 ? '' : 's'}`
                }
                noteDette={
                  dettes.debtors === 0
                    ? 'Personne'
                    : `${dettes.debtors} client${dettes.debtors === 1 ? '' : 's'}`
                }
              />

              {/* The share worth worrying about, beside the total rather than
                  inside it. A 47 000 F book that is all recent is healthy; the
                  same figure at 90 days is not, and one number cannot say. */}
              {dettes.over_30_cfa > 0 ? (
                <p className="discret" style={{ color: 'var(--alerte)' }}>
                  {formatCfa(dettes.over_30_cfa)} vous sont dus depuis plus de 30 jours.
                </p>
              ) : null}

              {dettes.open_claims > 0 ? (
                <p className="discret" style={{ color: 'var(--alerte)' }}>
                  {dettes.open_claims} client
                  {dettes.open_claims === 1 ? '' : 's'} déclare
                  {dettes.open_claims === 1 ? '' : 'nt'} avoir payé sans que ce
                  soit enregistré.
                </p>
              ) : null}
            </>
          )}
        </article>

        {/* Today, so a vendor can reconcile against their till at closing. */}
        {resume !== null ? (
          <div className="cadran" style={{ alignItems: 'stretch' }}>
            <div className="cadran__etiquette">Aujourd'hui</div>
            {activiteDuJour ? (
              <div className="pile" style={{ gap: 'var(--espace-2)' }}>
                <div className="ligne-resume">
                  <span>
                    Gardée · {resume.today_credit_count} fois
                  </span>
                  <Montant value={resume.today_credit_cfa} taille="ligne" />
                </div>
                <div className="ligne-resume">
                  <span>
                    Utilisée · {resume.today_debit_count} fois
                  </span>
                  <Montant value={resume.today_debit_cfa} taille="ligne" />
                </div>
              </div>
            ) : (
              <p className="discret">Aucun mouvement aujourd'hui.</p>
            )}
          </div>
        ) : null}

        <div className="pile" style={{ gap: 'var(--espace-4)' }}>
          <BoutonPrimaire onClick={onGarder}>Garder la monnaie</BoutonPrimaire>
          <BoutonSecondaire onClick={onUtiliser}>Utiliser la monnaie</BoutonSecondaire>
          {/* Same weight as the other two: writing down a debt is an everyday
              act at a counter, and a vendor who has to hunt for it will reach
              for the paper carnet instead. */}
          <BoutonSecondaire onClick={onNoterDette}>Noter une dette</BoutonSecondaire>
          <BoutonSecondaire onClick={onHistorique}>Historique</BoutonSecondaire>
        </div>
      </div>

      <div className="ecran__pied pile">
        <p className="discret centre">
          Sika Warri enregistre seulement. La monnaie reste chez vous et
          constitue une dette envers votre client.
        </p>
      </div>
    </div>
  );
}
