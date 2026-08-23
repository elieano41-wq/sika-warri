import type { Session } from '../../lib/api';
import { Entete, Message } from '../../components/ui';
import { QrCode } from '../../components/QrCode';
import { formatPhoneLocal } from '../../lib/format';

/**
 * Mon code — the QR the customer shows across the counter.
 *
 * Promoted from a sub-view of Ma monnaie to a destination of its own, because
 * this is the screen someone opens while a vendor is waiting. Two taps to reach
 * it was one too many with a queue behind you.
 *
 * THE CODE CARRIES NO AUTHORITY. It contains the phone number and nothing else:
 * no token, no signature, no session. Anyone who photographs it learns a number
 * they could equally have been told out loud, and nothing can be taken with it —
 * a debit still needs the customer's own code typed on the customer's own phone.
 * That is said on the screen too, in as many words, because a customer who
 * believes the code is dangerous will not use it, and a customer who believes it
 * is a payment instrument might hand the phone over.
 *
 * The number appears in plain text beside it. Cheap cameras in bad light fail,
 * and the fallback has to be readable aloud.
 */
export function MonCode({ session }: { session: Session }) {
  return (
    <div className="ecran ecran--avec-nav vue">
      <Entete sousTitre="Montrez-le" />

      <div className="ecran__corps">
        <h1>Mon code</h1>
        <QrCode msisdn={session.msisdn} />

        <p className="centre montant montant--ligne">
          {formatPhoneLocal(session.msisdn)}
        </p>
        <p className="discret centre">
          Si le code ne se lit pas, ce numéro peut être tapé à la main.
        </p>

        <Message ton="info">
          Ce code ne permet pas de prendre votre monnaie. Rien ne peut être
          utilisé sans votre code à 4 chiffres, saisi sur votre téléphone.
        </Message>
      </div>
    </div>
  );
}
