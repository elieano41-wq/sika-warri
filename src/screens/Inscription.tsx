import { useState } from 'react';
import * as api from '../lib/api';
import type { Session } from '../lib/api';
import {
  Clavier, PinPoints, Entete, Message, Cadran, BoutonPrimaire, BoutonSecondaire, BoutonDiscret,
} from '../components/ui';
import { Installer } from '../components/Installer';
import { formatPhoneLocal } from '../lib/format';
import {
  reglesPour, pourquoiPour, pinValide, pinProbleme, pinLengthFor, NE_PARTAGEZ_JAMAIS,
} from '../lib/pinRules';

/**
 * Inscription — someone signs themselves up, on their own phone, unaided.
 *
 * The target is a shopkeeper who has never installed an app, in under two
 * minutes, with nobody looking over their shoulder. That drives every decision
 * here:
 *
 *   - Phone, name, PIN. Nothing else. No email, no address, no password
 *     confirmation field.
 *   - One question per screen, each with one large input.
 *   - The PIN rules are shown and checked live BEFORE the code is submitted.
 *     Being refused after typing teaches nothing and reads as a broken app.
 *   - The disclosure is a real decision, not a pre-ticked box.
 */

/** The verbatim text from spec section 6. Must not be paraphrased. */
const TEXTE_CONDITIONS =
  "Sika Warri est un service d'enregistrement. Sika Warri ne détient, ne reçoit " +
  'et ne transfère aucun fonds. La monnaie enregistrée reste physiquement chez ' +
  'le commerçant et constitue une dette commerciale de ce commerçant envers son ' +
  'client. Elle est utilisable uniquement auprès de ce même commerçant. Le ' +
  'client peut à tout moment demander le remboursement en espèces auprès du ' +
  'commerçant concerné.';

/**
 * No 'role' step any more.
 *
 * It asked which of two accounts you were before it knew anything about you,
 * and both answers were wrong for somebody: a tailor owed 6 000 F is not a
 * "commerçant", and picking "client" left them unable to write the debt down at
 * all. There is one kind of account, so there is no question to ask.
 */
type Etape = 'numero' | 'nom' | 'quartier' | 'conditions' | 'code' | 'fait';

export function Inscription({
  onInscrit,
  onRetour,
}: {
  onInscrit: (s: Session) => void;
  onRetour: () => void;
}) {
  const [etape, setEtape] = useState<Etape>('numero');
  const [numero, setNumero] = useState('');
  const [nom, setNom] = useState('');
  const [quartier, setQuartier] = useState('');
  const [accepte, setAccepte] = useState(false);
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  // One length, one rule set, for everyone.
  const longueurPin = pinLengthFor();
  const regles = reglesPour();

  async function creer() {
    setErreur(null);
    setOccupe(true);
    try {
      await api.register({
        phone: numero,
        pin,
        name: nom,
        // Optional now. Sent only when given, so an empty field stores null
        // rather than a space nobody chose.
        ...(quartier.trim() ? { quartier: quartier.trim() } : {}),
        termsAccepted: accepte,
      });

      // Log them straight in. Asking someone to re-enter the code they just
      // chose, on the screen after choosing it, is the kind of step that loses
      // people at the last moment.
      const r = await api.login(numero, pin);

      // Hold the session rather than handing it over immediately. Navigating
      // away now would skip past the install prompt, which is the one moment
      // someone is willing to add this to their home screen.
      setSession(r.session);
      setEtape('fait');
    } catch (e) {
      const err = e as api.ApiError;
      setErreur(err.message);
      setPin('');
      setEtape('code');
    } finally {
      setOccupe(false);
    }
  }

  // ---- phone ------------------------------------------------------------
  if (etape === 'numero') {
    return (
      <div className="ecran">
        <Entete sousTitre="Créer un compte" />
        <div className="ecran__corps">
          <h1>Votre numéro</h1>
          <p className="discret">
            C'est votre identité sur Sika Warri. Utilisez le numéro que vos
            clients connaissent.
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
          <BoutonPrimaire onClick={() => setEtape('nom')} disabled={numero.length !== 10}>
            Continuer
          </BoutonPrimaire>
          <BoutonDiscret onClick={onRetour}>Retour</BoutonDiscret>
        </div>
      </div>
    );
  }

  // ---- name -------------------------------------------------------------
  if (etape === 'nom') {
    // Everyone walks the same path now: name, quartier, terms, code. The
    // disclosure is no longer vendor-only, because every account can now be
    // holding somebody else's money — which is the whole thing it discloses.
    const suivant: Etape = 'quartier';
    return (
      <div className="ecran">
        <Entete sousTitre="Créer un compte" />
        <div className="ecran__corps">
          <h1>Votre nom</h1>
          <p className="discret">
            C’est le nom que les autres verront sur leur téléphone.
          </p>
          <label className="champ">
            <span className="champ__etiquette">
              Exemple : Chez Awa, Atelier Koffi, Awa

            </span>
            <input
              className="champ__saisie"
              style={{ fontFamily: 'var(--police-texte)' }}
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              autoCapitalize="words"
              autoComplete="name"
              maxLength={60}
              inputMode="text"
            />
          </label>
        </div>
        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={() => setEtape(suivant)} disabled={nom.trim().length < 2}>
            Continuer
          </BoutonPrimaire>
          <BoutonDiscret onClick={() => setEtape('numero')}>Retour</BoutonDiscret>
        </div>
      </div>
    );
  }

  // ---- quartier, optional -----------------------------------------------
  if (etape === 'quartier') {
    return (
      <div className="ecran">
        <Entete sousTitre={nom} />
        <div className="ecran__corps">
          <h1>Votre quartier</h1>
          <p className="discret">
            Où l’on vous trouve. Facultatif — vous pouvez passer.
          </p>
          <label className="champ">
            <span className="champ__etiquette">Exemple : Yopougon</span>
            <input
              className="champ__saisie"
              style={{ fontFamily: 'var(--police-texte)' }}
              value={quartier}
              onChange={(e) => setQuartier(e.target.value)}
              autoCapitalize="words"
              maxLength={60}
              inputMode="text"
            />
          </label>
        </div>
        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={() => setEtape('conditions')}>
            Continuer
          </BoutonPrimaire>
          <BoutonDiscret onClick={() => setEtape('nom')}>Retour</BoutonDiscret>
        </div>
      </div>
    );
  }

  // ---- terms, for everyone ---------------------------------------------
  if (etape === 'conditions') {
    return (
      <div className="ecran">
        <Entete sousTitre={nom} />
        <div className="ecran__corps">
          <h1>À lire avant de continuer</h1>

          {/* Verbatim, per section 6. Shown in full — not behind a link, and
              not summarised. It is the whole basis of the arrangement. */}
          <div
            className="message message--info"
            style={{ fontSize: 'var(--texte-base)', lineHeight: 1.5 }}
          >
            {TEXTE_CONDITIONS}
          </div>

          <p className="discret">
            En clair : l'argent ne quitte jamais votre caisse. Sika Warri écrit
            seulement ce que vous devez à chaque client, et ce client peut vous
            demander son remboursement en espèces à tout moment.
          </p>

          {/* A real tap, never pre-ticked. The acknowledgement is stored with a
              timestamp, so it has to be a decision this person actually made. */}
          <button
            type="button"
            onClick={() => setAccepte(!accepte)}
            aria-pressed={accepte}
            className="bouton bouton--secondaire"
            style={{
              minHeight: 'var(--cible-primaire)',
              justifyContent: 'flex-start',
              gap: 'var(--espace-4)',
              textAlign: 'left',
              borderColor: accepte ? 'var(--or-sika)' : 'var(--trait)',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '1.75rem', height: '1.75rem', flexShrink: 0,
                borderRadius: '6px',
                border: `2px solid ${accepte ? 'var(--or-sika)' : 'var(--sauge)'}`,
                background: accepte ? 'var(--or-sika)' : 'transparent',
                color: 'var(--vert-nuit-creux)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700,
              }}
            >
              {accepte ? '✓' : ''}
            </span>
            <span style={{ fontSize: 'var(--texte-base)', fontWeight: 500 }}>
              J'ai lu et j'accepte
            </span>
          </button>
        </div>

        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={() => setEtape('code')} disabled={!accepte}>
            Continuer
          </BoutonPrimaire>
          <BoutonDiscret onClick={() => setEtape('quartier')}>Retour</BoutonDiscret>
        </div>
      </div>
    );
  }

  // ---- PIN --------------------------------------------------------------
  if (etape === 'code') {
    const complet = pin.length === longueurPin;
    const probleme = complet ? pinProbleme(pin) : null;
    const bon = complet && pinValide(pin);

    return (
      <div className="ecran">
        <Entete sousTitre={nom} />
        <div className="ecran__corps">
          <h1>Choisissez votre code</h1>
          <p className="discret">{pourquoiPour()}</p>

          {/* The rules, BEFORE typing and updating as they type. */}
          <ul className="pile" style={{ listStyle: 'none', gap: 'var(--espace-2)' }}>
            {regles.map((r) => {
              const satisfait = r.ok(pin);
              return (
                <li
                  key={r.texte}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 'var(--espace-3)',
                    color: satisfait ? 'var(--craie)' : 'var(--sauge)',
                    fontSize: 'var(--texte-petit)',
                  }}
                >
                  <span aria-hidden="true" style={{ color: satisfait ? 'var(--or-sika)' : 'var(--sauge)' }}>
                    {satisfait ? '✓' : '•'}
                  </span>
                  {r.texte}
                </li>
              );
            })}
          </ul>

          <Cadran etiquette={`Votre code à ${longueurPin} chiffres`}>
            <PinPoints longueur={longueurPin} remplis={pin.length} />
          </Cadran>

          {probleme ? <Message ton="erreur">{probleme}</Message> : null}
          {erreur ? <Message ton="erreur">{erreur}</Message> : null}

          <Message ton="info">{NE_PARTAGEZ_JAMAIS}</Message>

          <Clavier
            onDigit={(d) => {
              setErreur(null);
              if (pin.length < longueurPin) setPin(pin + d);
            }}
            onEffacer={() => setPin(pin.slice(0, -1))}
            onToutEffacer={() => setPin('')}
          />
        </div>

        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={creer} disabled={!bon || occupe}>
            {occupe ? 'Création…' : 'Créer mon compte'}
          </BoutonPrimaire>
          <BoutonDiscret onClick={() => setEtape('conditions')}>
            Retour
          </BoutonDiscret>
        </div>
      </div>
    );
  }

  // ---- done -------------------------------------------------------------
  return (
    <div className="ecran">
      <Entete sousTitre={nom} />
      <div className="ecran__corps">
        <h1>C'est fait</h1>
        <p className="discret">
          Votre compte est créé avec le numéro {formatPhoneLocal(numero)}. Notez
          ce numéro et votre code : ils vous serviront à chaque connexion.
        </p>

        {/* Offered here, at the one moment someone is willing to do it. */}
        <Installer />
      </div>
      <div className="ecran__pied pile">
        <BoutonPrimaire onClick={() => session && onInscrit(session)} disabled={!session}>
          Commencer
        </BoutonPrimaire>
      </div>
    </div>
  );
}
