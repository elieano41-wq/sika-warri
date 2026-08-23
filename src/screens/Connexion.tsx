import { useState } from 'react';
import * as api from '../lib/api';
import type { Role, Session } from '../lib/api';
import {
  Clavier, PinPoints, Entete, Message, Cadran, BoutonPrimaire, BoutonSecondaire,
  BoutonDiscret, Version,
} from '../components/ui';
import { Installer } from '../components/Installer';
import { formatPhoneLocal } from '../lib/format';

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
  const [role, setRole] = useState<Role>('vendor');
  const [etape, setEtape] = useState<'numero' | 'code'>('numero');
  const [numero, setNumero] = useState('');
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [avertissement, setAvertissement] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const longueurPin = role === 'vendor' ? 6 : 4;

  function changerRole(r: Role) {
    setRole(r);
    setPin('');
    setErreur(null);
    setAvertissement(null);
  }

  function chiffreNumero(d: string) {
    setErreur(null);
    if (numero.length < 10) setNumero(numero + d);
  }

  async function chiffrePin(d: string) {
    setErreur(null);
    if (pin.length >= longueurPin || occupe) return;

    const suivant = pin + d;
    setPin(suivant);

    // Submit automatically on the last digit. One less tap while holding coins,
    // and there is nothing else the screen could be waiting for.
    if (suivant.length === longueurPin) {
      setOccupe(true);
      try {
        const r = await api.login(role, numero, suivant);
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
  }

  return (
    <div className="ecran">
      <Entete sousTitre="Votre monnaie, là où elle est gardée" />

      <div className="ecran__corps">
        {etape === 'numero' ? (
          <>
            <h1>Connexion</h1>

            <div
              className="pile"
              role="group"
              aria-label="Type de compte"
              style={{ flexDirection: 'row', gap: 'var(--espace-3)' }}
            >
              <button
                type="button"
                className={`bouton ${role === 'vendor' ? 'bouton--primaire' : 'bouton--secondaire'}`}
                onClick={() => changerRole('vendor')}
                aria-pressed={role === 'vendor'}
                style={{ fontSize: 'var(--texte-base)', minHeight: 'var(--cible-min)' }}
              >
                Je tiens le carnet
              </button>
              <button
                type="button"
                className={`bouton ${role === 'customer' ? 'bouton--primaire' : 'bouton--secondaire'}`}
                onClick={() => changerRole('customer')}
                aria-pressed={role === 'customer'}
                style={{ fontSize: 'var(--texte-base)', minHeight: 'var(--cible-min)' }}
              >
                Je suis sur le carnet
              </button>
            </div>

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
            <p className="discret">
              {role === 'vendor' ? 'Mon carnet' : 'Sur le carnet'} · {formatPhoneLocal(numero)}
            </p>

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
