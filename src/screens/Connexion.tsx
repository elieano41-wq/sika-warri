import { useState } from 'react';
import * as api from '../lib/api';
import type { Session } from '../lib/api';
import {
  Clavier, PinPoints, Entete, Message, Cadran, BoutonPrimaire, BoutonSecondaire,
  BoutonDiscret, Version,
} from '../components/ui';
import { Installer } from '../components/Installer';
import { formatPhoneLocal } from '../lib/format';
import { PIN_LENGTH } from '../lib/pinRules';

/**
 * Connexion — phone number then PIN, in two steps.
 *
 * Two steps rather than one form because both fields are entered on the same
 * keypad, and a single screen holding two numeric fields on a 320px viewport
 * means neither is legible. One number at a time, each one large.
 */
export function Connexion({
  onConnecte,
  onInscription,
  onCodeOublie,
}: {
  onConnecte: (s: Session, avertissement: string | null, isAdmin: boolean) => void;
  onInscription: () => void;
  onCodeOublie: () => void;
}) {
  const [etape, setEtape] = useState<'numero' | 'code'>('numero');
  const [numero, setNumero] = useState('');
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [avertissement, setAvertissement] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  /**
   * Six is the length, and four is still accepted.
   *
   * An account that registered before there was one PIN length has a 4-digit
   * code, and its credential is derived from those four digits. Refusing them
   * here would not ask anyone to upgrade — it would lock them out of an account
   * holding real money, with "code incorrect" as the only clue. The server takes
   * either and flags the short ones for a change; this screen has to let them
   * be typed and, crucially, SUBMITTED.
   */
  const longueurPin = PIN_LENGTH;
  const MIN_ACCEPTE = 4;
  const soumettable = pin.length >= MIN_ACCEPTE && !occupe;

  function chiffreNumero(d: string) {
    setErreur(null);
    if (numero.length < 10) setNumero(numero + d);
  }

  async function envoyer(code: string) {
    if (code.length < MIN_ACCEPTE || occupe) return;
    setOccupe(true);
    try {
      const r = await api.login(numero, code);
      onConnecte(r.session, r.notice ?? null, r.isAdmin);
    } catch (e) {
      const err = e as api.ApiError;
      setPin('');
      setErreur(err.message);
      // The 4th failed attempt warns that the next one locks the account.
      const warning = (err.extra as any)?.warning;
      setAvertissement(typeof warning === 'string' ? warning : null);
    } finally {
      setOccupe(false);
    }
  }

  async function chiffrePin(d: string) {
    setErreur(null);
    if (pin.length >= longueurPin || occupe) return;

    const suivant = pin + d;
    setPin(suivant);

    // Auto-submit on the SIXTH digit only. One less tap for everyone whose code
    // is six, which is everyone who has ever registered under the current
    // rules. A shorter legacy code is submitted with the button below, because
    // auto-submitting at four would fire mid-typing for everybody else.
    if (suivant.length === longueurPin) await envoyer(suivant);
  }

  return (
    <div className="ecran">
      <Entete sousTitre="Votre monnaie, là où elle est gardée" />

      <div className="ecran__corps">
        {etape === 'numero' ? (
          <>
            <h1>Connexion</h1>

            <Cadran etiquette="Numéro de téléphone">
              <span className="montant montant--grand" style={{ color: 'var(--craie)' }}>
                {numero ? formatPhoneLocal(numero) : '—'}
              </span>
            </Cadran>

            {erreur ? <Message ton="erreur">{erreur}</Message> : null}

            <Clavier
              onDigit={chiffreNumero}
              onEffacer={() => setNumero(numero.slice(0, -1))}
              onToutEffacer={() => setNumero('')}
            />
          </>
        ) : (
          <>
            <h1>Votre code</h1>
            <p className="discret">{formatPhoneLocal(numero)}</p>

            <Cadran etiquette={`Code à ${longueurPin} chiffres`}>
              <PinPoints longueur={longueurPin} remplis={pin.length} />
            </Cadran>

            {erreur ? <Message ton="erreur">{erreur}</Message> : null}
            {avertissement ? <Message ton="info">{avertissement}</Message> : null}

            <Clavier
              onDigit={chiffrePin}
              onEffacer={() => setPin(pin.slice(0, -1))}
              onToutEffacer={() => setPin('')}
            />

            {/* For a code shorter than six. Enabled from four digits, so an
                account created before the lengths were unified can still get
                in — and then be told to change it. Invisible in practice to
                anyone whose code is six: they never reach it. */}
            {pin.length >= MIN_ACCEPTE && pin.length < longueurPin ? (
              <BoutonPrimaire onClick={() => envoyer(pin)} disabled={!soumettable}>
                {occupe ? 'Connexion…' : 'Continuer'}
              </BoutonPrimaire>
            ) : null}
          </>
        )}
      </div>

      <div className="ecran__pied pile">
        {etape === 'numero' ? (
          <BoutonPrimaire onClick={() => setEtape('code')} disabled={numero.length !== 10}>
            Continuer
          </BoutonPrimaire>
        ) : (
          <>
            <BoutonDiscret
              onClick={() => {
                setEtape('numero');
                setPin('');
                setErreur(null);
              }}
            >
              Changer de numéro
            </BoutonDiscret>
            {/* Offered on the PIN screen, where someone discovers they have
                forgotten it — not buried on a settings page they cannot reach
                while locked out. */}
            <BoutonDiscret onClick={onCodeOublie}>J'ai oublié mon code</BoutonDiscret>
          </>
        )}
        {/* The way in for someone who has no account. Prominent on purpose:
            an app you cannot sign up for is an app nobody can use. */}
        <BoutonSecondaire onClick={onInscription}>Créer un compte</BoutonSecondaire>
        <Installer compact />
        <Version />
      </div>
    </div>
  );
}
