import { useState } from 'react';
import * as api from '../lib/api';
import type { Role } from '../lib/api';
import {
  Clavier, PinPoints, Entete, Message, Cadran, BoutonPrimaire, BoutonDiscret,
} from '../components/ui';
import { formatPhoneLocal } from '../lib/format';
import { reglesPour, pinValide, pinProbleme, pinLengthFor, NE_PARTAGEZ_JAMAIS } from '../lib/pinRules';

/**
 * "J'ai oublié mon code" — setting a new PIN after somebody vouched.
 *
 * There is no SMS, so there is no automated proof that this phone belongs to
 * this person. The proof is a human one: a vendor recognised the customer in
 * person and requested the reset, and the claim is short-lived and single-use.
 *
 * This screen runs with NO session, because the whole situation is being locked
 * out. So it asks for the number first, checks whether a claim is open, and only
 * then lets a new code be chosen. It never reveals whether a number is
 * registered when no claim exists — the answer is the same either way: go and
 * ask a vendor.
 */
type Etape = 'numero' | 'attente' | 'code' | 'fait';

export function ResetPin({ onTermine }: { onTermine: () => void }) {
  const [etape, setEtape] = useState<Etape>('numero');
  const [numero, setNumero] = useState('');
  const [role, setRole] = useState<Role>('customer');
  const [vouchedBy, setVouchedBy] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const longueurPin = pinLengthFor(role);

  async function verifier() {
    setErreur(null);
    setOccupe(true);
    try {
      const r = await api.checkReset(numero);
      if (!r) {
        setEtape('attente');
        return;
      }
      setRole(r.role);
      setVouchedBy(r.vouchedBy);
      setPin('');
      setEtape('code');
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  async function enregistrer() {
    setErreur(null);
    setOccupe(true);
    try {
      await api.claimReset(numero, pin, role);
      setEtape('fait');
    } catch (e) {
      setPin('');
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  // ---- ask for the number ------------------------------------------------
  if (etape === 'numero') {
    return (
      <div className="ecran">
        <Entete sousTitre="Code oublié" />
        <div className="ecran__corps">
          <h1>Code oublié</h1>
          <p className="discret">
            Votre numéro, pour vérifier si un commerçant a demandé la
            réinitialisation de votre code.
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
          <BoutonPrimaire onClick={verifier} disabled={numero.length !== 10 || occupe}>
            {occupe ? 'Vérification…' : 'Continuer'}
          </BoutonPrimaire>
          <BoutonDiscret onClick={onTermine}>Retour</BoutonDiscret>
        </div>
      </div>
    );
  }

  // ---- nothing open ------------------------------------------------------
  if (etape === 'attente') {
    return (
      <div className="ecran">
        <Entete sousTitre="Code oublié" />
        <div className="ecran__corps">
          <h1>Demandez à un commerçant</h1>
          <Message ton="info">
            Aucune réinitialisation en cours pour ce numéro.
          </Message>
          <p>
            Allez voir un commerçant chez qui vous avez de la monnaie. Il peut
            demander la réinitialisation de votre code depuis son application.
            Vous choisirez ensuite votre nouveau code ici, sur votre téléphone.
          </p>
          {/* Said plainly, because a customer being asked for their code by a
              vendor is the thing this whole design exists to prevent. */}
          <Message ton="info">
            Le commerçant ne choisit pas votre code. Il demande seulement la
            réinitialisation. Ne lui donnez jamais votre code.
          </Message>
        </div>
        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={verifier} disabled={occupe}>
            {occupe ? 'Vérification…' : 'Vérifier à nouveau'}
          </BoutonPrimaire>
          <BoutonDiscret onClick={onTermine}>Retour</BoutonDiscret>
        </div>
      </div>
    );
  }

  // ---- choose a new code -------------------------------------------------
  if (etape === 'code') {
    const complet = pin.length === longueurPin;
    const probleme = complet ? pinProbleme(pin, role) : null;
    const bon = complet && pinValide(pin, role);

    return (
      <div className="ecran">
        <Entete sousTitre="Nouveau code" />
        <div className="ecran__corps">
          <h1>Votre nouveau code</h1>
          {vouchedBy ? (
            <Message ton="info">
              Réinitialisation demandée par <strong>{vouchedBy}</strong>.
              Si ce n'est pas le commerçant que vous avez vu, arrêtez ici.
            </Message>
          ) : null}

          <ul className="pile" style={{ listStyle: 'none', gap: 'var(--espace-2)' }}>
            {reglesPour(role).map((r) => {
              const ok = r.ok(pin, role);
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
      </div>
      <div className="ecran__pied pile">
        <BoutonPrimaire onClick={onTermine}>Se connecter</BoutonPrimaire>
      </div>
    </div>
  );
}
