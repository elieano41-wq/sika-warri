import { useState } from 'react';
import * as api from '../lib/api';
import type { Session, VendorProfile } from '../lib/api';
import {
  Entete, Message, BoutonPrimaire, BoutonDiscret, CaseAcceptation,
} from '../components/ui';

/** The verbatim text from spec section 6. Must not be paraphrased. */
const TEXTE_CONDITIONS =
  "Sika Warri est un service d'enregistrement. Sika Warri ne détient, ne reçoit " +
  'et ne transfère aucun fonds. La monnaie enregistrée reste physiquement chez ' +
  'le commerçant et constitue une dette commerciale de ce commerçant envers son ' +
  'client. Elle est utilisable uniquement auprès de ce même commerçant. Le ' +
  'client peut à tout moment demander le remboursement en espèces auprès du ' +
  'commerçant concerné.';

/**
 * Conditions — the disclosure, asked of an account that has never seen it.
 *
 * ============================================================================
 * WHO REACHES THIS AND WHY IT EXISTS.
 *
 * Before one account replaced two, the disclosure was collected from vendors
 * only: the registration flow never showed the text to a customer. Migration
 * 0043 gives every existing account a keeper half, which means accounts that
 * have never read this can now, in principle, hold somebody else's money.
 *
 * SQL refuses that outright — a credit or a debt claim from an unacknowledged
 * account raises SW033 — so this screen is the door in that wall. It is shown
 * BEFORE the first keeper action rather than after the refusal, because being
 * stopped mid-transaction in front of a waiting customer and then asked to read
 * six lines of legal text is the worst possible moment to ask.
 *
 * WHAT IS DELIBERATELY THE SAME as at registration: the text is verbatim and
 * identical, the box starts unticked, and the button stays disabled until it is
 * ticked. A pre-ticked box is not consent, and a shorter version of the text
 * would be a second wording to keep in step with the first.
 * ============================================================================
 */
export function Conditions({
  session,
  vendeur,
  onAccepte,
  onAnnuler,
}: {
  session: Session;
  vendeur: VendorProfile;
  /** Called once the acknowledgement is stored, with the moment it happened. */
  onAccepte: () => void;
  onAnnuler: () => void;
}) {
  const [coche, setCoche] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function accepter() {
    setErreur(null);
    setOccupe(true);
    try {
      await api.acceptTerms(session.accessToken, vendeur.authUserId);
      onAccepte();
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  return (
    <div className="ecran vue vue--tache">
      <Entete sousTitre="Avant de garder l’argent de quelqu’un" />

      <div className="ecran__corps">
        <h1>Ce que fait Sika Warri</h1>

        <p className="discret">
          Vous êtes sur le point de garder de l’argent qui n’est pas à vous, ou
          de noter que quelqu’un vous doit quelque chose. Lisez ceci d’abord.
        </p>

        {/* The verbatim disclosure, in a well rather than a card: it is the
            subject of the screen, not one item among several. */}
        <div className="cadran" style={{ textAlign: 'left' }}>
          <p>{TEXTE_CONDITIONS}</p>
        </div>

        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {/* Unticked, always. A pre-ticked box is not an acknowledgement, and
            this one is stored with a timestamp and a version. Same component
            registration uses, so the two cannot drift. */}
        <CaseAcceptation coche={coche} onBascule={() => setCoche(!coche)}>
          J’ai lu et j’accepte
        </CaseAcceptation>
      </div>

      <div className="ecran__pied pile">
        <BoutonPrimaire onClick={accepter} disabled={!coche || occupe}>
          {occupe ? 'Enregistrement…' : 'Accepter et continuer'}
        </BoutonPrimaire>
        <BoutonDiscret onClick={onAnnuler}>Plus tard</BoutonDiscret>
      </div>
    </div>
  );
}
