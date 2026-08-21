import { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, VendorProfile, VendorSummary } from '../../lib/api';
import {
  Entete, Message, Montant, BoutonPrimaire, BoutonSecondaire, BoutonDiscret, Version,
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
  onClients,
  onDeconnexion,
  onAdmin,
}: {
  session: Session;
  vendeur: VendorProfile;
  onGarder: () => void;
  onUtiliser: () => void;
  onClients: () => void;
  onDeconnexion: () => void;
  /** Present only when the SERVER confirmed this session is an admin. */
  onAdmin?: () => void;
}) {
  const [resume, setResume] = useState<VendorSummary | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      setResume(await api.vendorSummary(session.accessToken, vendeur.id, vendeur.authUserId));
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
    <div className="ecran">
      <Entete
        sousTitre={`${vendeur.businessName} · ${vendeur.quartier}`}
        action={<BoutonDiscret onClick={onDeconnexion}>Quitter</BoutonDiscret>}
      />

      <div className="ecran__corps">
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {/* What the vendor owes, in the carnet. The one figure that matters
            before any action is taken. */}
        <article className="carnet">
          <div className="carnet__etiquette">Monnaie que vous gardez</div>
          {resume === null ? (
            <>
              <span className="montant montant--geant" style={{ color: 'var(--sauge)' }}>
                —
              </span>
              <div className="discret">Chargement…</div>
            </>
          ) : (
            <>
              <Montant value={resume.circulation_cfa} taille="geant" />
              <div className="carnet__quartier">
                {resume.customers_owed === 0
                  ? 'Aucun client concerné'
                  : `${resume.customers_owed} client${resume.customers_owed === 1 ? '' : 's'} concerné${resume.customers_owed === 1 ? '' : 's'}`}
              </div>
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
          <BoutonSecondaire onClick={onClients}>Mes clients</BoutonSecondaire>
          {onAdmin ? (
            <BoutonSecondaire onClick={onAdmin}>Panneau support</BoutonSecondaire>
          ) : null}
        </div>
      </div>

      <div className="ecran__pied pile">
        <p className="discret centre">
          Sika Warri enregistre seulement. La monnaie reste chez vous et
          constitue une dette envers votre client.
        </p>
        <Version />
      </div>
    </div>
  );
}
