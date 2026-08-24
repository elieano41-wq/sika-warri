import { useState } from 'react';
import * as api from '../lib/api';
import type { Role } from '../lib/api';
import {
  Clavier, PinPoints, Entete, Message, Cadran, BoutonPrimaire, BoutonDiscret,
} from '../components/ui';
import { formatPhoneLocal } from '../lib/format';
import { reglesPour, pinValide, pinProbleme, pinLengthFor, NE_PARTAGEZ_JAMAIS } from '../lib/pinRules';

/**
 * "J'ai oublié mon code" — the support-desk recovery flow.
 *
 * There is no SMS, so nothing here can prove the caller owns this number. The
 * proof is a telephone conversation with the operator, who challenges them
 * against their own transaction history before issuing anything.
 *
 * Vendors used to be able to vouch for a customer. That is gone: a vouching
 * vendor could claim the reset themselves and take over the account, which
 * defeats amendment H, and a cooling-off period only delayed it.
 *
 * The screen NEVER says whether a number is registered. The message after
 * requesting is identical either way, so this cannot be used to find out who
 * has an account.
 */
type Etape = 'numero' | 'demande' | 'code' | 'pin' | 'fait';

/** Shown to the person so they know who to call. */
const NUMERO_SUPPORT = '07 00 00 00 00';

export function ResetPin({ onTermine }: { onTermine: () => void }) {
  const [etape, setEtape] = useState<Etape>('numero');
  const [numero, setNumero] = useState('');
  const [code, setCode] = useState('');
  const [role, setRole] = useState<Role>('customer');
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const longueurPin = pinLengthFor();

  async function demander() {
    setErreur(null);
    setOccupe(true);
    try {
      const r = await api.requestSupportReset(numero);
      setMessage(r.message);
      setEtape('demande');
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  async function verifierCode() {
    setErreur(null);
    setOccupe(true);
    try {
      const r = await api.checkTempCode(numero, code);
      setRole(r.role);
      setPin('');
      setEtape('pin');
    } catch (e) {
      setCode('');
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  async function enregistrer() {
    setErreur(null);
    setOccupe(true);
    try {
      await api.redeemTempCode(numero, code, pin);
      setEtape('fait');
    } catch (e) {
      setPin('');
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  // ---- the number --------------------------------------------------------
  if (etape === 'numero') {
    return (
      <div className="ecran">
        <Entete sousTitre="Code oublié" />
        <div className="ecran__corps">
          <h1>Code oublié</h1>
          <p className="discret">
            Entrez votre numéro. Le support Sika Warri vous appellera pour
            vérifier votre identité avant de vous donner un code temporaire.
          </p>
          <Cadran etiquette="Numéro de téléphone">
            <span className="montant montant--grand" style={{ color: 'var(--craie)' }}>
              {numero ? formatPhoneLocal(numero) : '—'}
            </span>
          </Cadran>
          {erreur ? <Message ton="erreur">{erreur}</Message> : null}
          <Clavier
            onDigit={(d) => { setErreur(null); if (numero.length < 10) setNumero(numero + d); }}
            onEffacer={() => setNumero(numero.slice(0, -1))}
            onToutEffacer={() => setNumero('')}
          />
        </div>
        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={demander} disabled={numero.length !== 10 || occupe}>
            {occupe ? 'Envoi…' : 'Demander un code'}
          </BoutonPrimaire>
          <BoutonDiscret onClick={() => setEtape('code')}>
            J'ai déjà un code temporaire
          </BoutonDiscret>
          <BoutonDiscret onClick={onTermine}>Retour</BoutonDiscret>
        </div>
      </div>
    );
  }

  // ---- requested ---------------------------------------------------------
  if (etape === 'demande') {
    return (
      <div className="ecran">
        <Entete sousTitre="Code oublié" />
        <div className="ecran__corps">
          <h1>Appelez le support</h1>
          {/* Identical wording whether or not the number is registered. */}
          <Message ton="info">{message}</Message>

          <Cadran etiquette="Numéro du support">
            <span className="montant montant--grand">{NUMERO_SUPPORT}</span>
          </Cadran>

          <p className="discret">
            Le support vous posera des questions sur votre compte pour vérifier
            que c'est bien vous. Gardez votre téléphone à portée de main.
          </p>
          <Message ton="info">
            Le support ne vous demandera JAMAIS votre ancien code. Il vous donnera
            un code temporaire, et vous choisirez vous-même votre nouveau code.
          </Message>
        </div>
        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={() => setEtape('code')}>
            J'ai reçu mon code temporaire
          </BoutonPrimaire>
          <BoutonDiscret onClick={onTermine}>Retour</BoutonDiscret>
        </div>
      </div>
    );
  }

  // ---- the temporary code ------------------------------------------------
  if (etape === 'code') {
    return (
      <div className="ecran">
        <Entete sousTitre="Code temporaire" />
        <div className="ecran__corps">
          <h1>Code temporaire</h1>
          <p className="discret">
            Les 6 chiffres que le support vous a donnés au téléphone.
            {numero ? ` · ${formatPhoneLocal(numero)}` : ''}
          </p>

          <Cadran etiquette="Code à 6 chiffres">
            <PinPoints longueur={6} remplis={code.length} />
          </Cadran>

          {erreur ? <Message ton="erreur">{erreur}</Message> : null}

          <Clavier
            onDigit={(d) => { setErreur(null); if (code.length < 6) setCode(code + d); }}
            onEffacer={() => setCode(code.slice(0, -1))}
            onToutEffacer={() => setCode('')}
          />
        </div>
        <div className="ecran__pied pile">
          <BoutonPrimaire
            onClick={verifierCode}
            disabled={code.length !== 6 || numero.length !== 10 || occupe}
          >
            {occupe ? 'Vérification…' : 'Continuer'}
          </BoutonPrimaire>
          {numero.length !== 10 ? (
            <BoutonDiscret onClick={() => setEtape('numero')}>
              Entrer mon numéro d'abord
            </BoutonDiscret>
          ) : (
            <BoutonDiscret onClick={onTermine}>Retour</BoutonDiscret>
          )}
        </div>
      </div>
    );
  }

  // ---- the new PIN -------------------------------------------------------
  if (etape === 'pin') {
    const complet = pin.length === longueurPin;
    const probleme = complet ? pinProbleme(pin) : null;
    const bon = complet && pinValide(pin);

    return (
      <div className="ecran">
        <Entete sousTitre="Nouveau code" />
        <div className="ecran__corps">
          <h1>Votre nouveau code</h1>
          <p className="discret">
            Choisissez-le vous-même. Personne d'autre ne le connaît.
          </p>

          <ul className="pile" style={{ listStyle: 'none', gap: 'var(--espace-2)' }}>
            {reglesPour().map((r) => {
              const ok = r.ok(pin);
              return (
                <li
                  key={r.texte}
                  style={{
                    display: 'flex', gap: 'var(--espace-3)',
                    color: ok ? 'var(--craie)' : 'var(--sauge)',
                    fontSize: 'var(--texte-petit)',
                  }}
                >
                  <span aria-hidden="true" style={{ color: ok ? 'var(--or-sika)' : 'var(--sauge)' }}>
                    {ok ? '✓' : '•'}
                  </span>
                  {r.texte}
                </li>
              );
            })}
          </ul>

          <Cadran etiquette={`Code à ${longueurPin} chiffres`}>
            <PinPoints longueur={longueurPin} remplis={pin.length} />
          </Cadran>

          {probleme ? <Message ton="erreur">{probleme}</Message> : null}
          {erreur ? <Message ton="erreur">{erreur}</Message> : null}
          <Message ton="info">{NE_PARTAGEZ_JAMAIS}</Message>

          <Clavier
            onDigit={(d) => { setErreur(null); if (pin.length < longueurPin) setPin(pin + d); }}
            onEffacer={() => setPin(pin.slice(0, -1))}
            onToutEffacer={() => setPin('')}
          />
        </div>
        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={enregistrer} disabled={!bon || occupe}>
            {occupe ? 'Enregistrement…' : 'Enregistrer mon code'}
          </BoutonPrimaire>
        </div>
      </div>
    );
  }

  // ---- done --------------------------------------------------------------
  return (
    <div className="ecran">
      <Entete sousTitre="Code changé" />
      <div className="ecran__corps">
        <h1>C'est fait</h1>
        <p>Connectez-vous avec votre nouveau code.</p>
        <p className="discret">
          Cette réinitialisation reste inscrite dans votre historique.
        </p>
      </div>
      <div className="ecran__pied pile">
        <BoutonPrimaire onClick={onTermine}>Se connecter</BoutonPrimaire>
      </div>
    </div>
  );
}
