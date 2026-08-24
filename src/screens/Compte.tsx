import { useState } from 'react';
import * as api from '../lib/api';
import type { Session, VendorProfile, CustomerProfile } from '../lib/api';
import {
  Entete, Message, Clavier, PinPoints, BoutonPrimaire, BoutonSecondaire,
} from '../components/ui';
import { Installer } from '../components/Installer';
import { formatCfa, formatPhoneLocal } from '../lib/format';
import { PIN_LENGTH } from '../lib/pinRules';

/**
 * The support number, from the build environment.
 *
 * Configuration rather than copy, because it differs per deployment and must
 * never be guessed. Unset, the block does not render at all — an invented
 * number would send someone to a stranger at the worst possible moment.
 */
const SUPPORT_TEL = (import.meta.env.VITE_SUPPORT_TEL ?? '').trim();

/**
 * Compte — who you are, and the two things you can change about it.
 *
 * WHY THIS EXISTS. Signing out lived on whichever screen happened to have room
 * for it, the build marker was only on the welcome screen, and changing a code
 * had no screen at all — even though login can come back with
 * pinChangeRequired: true and tell someone to do exactly that. So the app told
 * people to change their code and gave them nowhere to do it.
 *
 * WHAT IS DELIBERATELY ABSENT. No "delete my account" and no editing of the shop
 * name or phone number. Both would need a support conversation, because a phone
 * number is the identity here and a shop name is what customers recognise. A
 * button that silently rewrites either is worse than no button. Nothing here can
 * touch the ledger.
 */
export function Compte({
  session,
  vendeur,
  client,
  estAdmin,
  onAdmin,
  onChangerCode,
  onDeconnexion,
}: {
  session: Session;
  vendeur?: VendorProfile | null;
  client?: CustomerProfile | null;
  estAdmin: boolean;
  onAdmin?: () => void;
  /**
   * Asks the SHELL to start the code-change task.
   *
   * Not rendered here. A task rendered inside a tab keeps the fixed tab bar
   * laid over its footer, so the last button on the screen cannot be pressed —
   * which is what happened, and what the harness caught by retrying a click on
   * "Annuler" until it timed out. Every task belongs to the shell, because the
   * shell is what hides the bar.
   */
  onChangerCode: () => void;
  onDeconnexion: () => void;
}) {
  return (
    <div className="ecran ecran--avec-nav vue">
      <Entete sousTitre="Votre compte" />

      <div className="ecran__corps">
        <h1>Compte</h1>
        {vendeur ? (
          <section className="carte">
            <div className="carte__titre">{vendeur.businessName}</div>
            <div className="carte__sous">{vendeur.quartier}</div>
            <p className="discret">
              Vous pouvez garder jusqu’à {formatCfa(vendeur.maxBalancePerCustomer)} par
              client.
            </p>
          </section>
        ) : null}

        {client ? (
          <section className="carte">
            <div className="carte__titre">
              {formatPhoneLocal(session.msisdn)}
            </div>
            <p className="discret">
              C’est votre numéro qui vous identifie. Votre monnaie reste sur chaque
              carnet, là où elle a été gardée.
            </p>
          </section>
        ) : null}

        <BoutonSecondaire onClick={onChangerCode}>
          Changer mon code
        </BoutonSecondaire>

        {/* WHAT AN ORDINARY USER GETS: a number, and nothing about admin.
            A greyed-out entry or a "Compte support : Non" line answers a
            question nobody asked and tells everyone there is a door. */}
        {!estAdmin && SUPPORT_TEL ? (
          <section className="carte">
            <span className="carte__etiquette">Besoin d’aide</span>
            <a className="lien-tel" href={`tel:${SUPPORT_TEL.replace(/\s+/g, '')}`}>
              {SUPPORT_TEL}
            </a>
            <p className="discret">Contacter le support</p>
          </section>
        ) : null}

        {/* ADMINS ONLY, and everything diagnostic lives inside it: the status in
            plain words, the build, and the way in. The status is re-asked of
            the server on every load, not carried from login — that flag went
            stale on reload and hid this from an account that held the grant all
            along. Every action behind the panel is gated again in SQL, so a
            forged flag shows a button that then fails. */}
        {estAdmin ? (
          <section className="carte">
            <span className="carte__etiquette">Compte support</span>
            <p style={{ fontSize: 'var(--texte-grand)', fontWeight: 600 }}>Oui</p>
            <p className="discret" style={{ fontFamily: 'var(--police-chiffre)' }}>
              Version {__BUILD_SHA__} · {__BUILD_DATE__}
            </p>
            {onAdmin ? (
              <BoutonSecondaire onClick={onAdmin}>Panneau support</BoutonSecondaire>
            ) : null}
          </section>
        ) : null}

        <Installer />

        {/* Each side reads its own sentence. Rule 10 either way: Sika Warri
            holds nothing. The vendor's version says the money stayed with
            them, the customer's says where theirs is. */}
        <Message ton="info">
          {vendeur
            ? 'Sika Warri ne garde pas d’argent. Ce que vous gardez reste chez vous ; l’application note seulement qui a quoi.'
            : 'Sika Warri ne garde pas votre argent. Elle note seulement ce que chacun vous doit.'}
        </Message>
      </div>

      <div className="ecran__pied pile">
        <BoutonSecondaire onClick={onDeconnexion}>Quitter</BoutonSecondaire>
      </div>
    </div>
  );
}

/**
 * Changing a code.
 *
 * Three steps on one screen would mean three PIN fields visible at once, which
 * on a 320px phone means none of them is comfortable. So it is one field at a
 * time, and the current code first — a session alone must not be enough to
 * change it, or a borrowed unlocked phone is enough to lock the owner out.
 *
 * Length differs by role and that is not a detail: vendors have six digits
 * because a vendor's code protects everyone's change, customers four because
 * theirs protects only their own.
 */
export function ChangerCode({
  session,
  onTermine,
  onAnnuler,
}: {
  session: Session;
  onTermine: () => void;
  onAnnuler: () => void;
}) {
  // The NEW code is always six. The current one is whatever it is — an account
  // from before the lengths were unified still has four, and the "actuel" step
  // has to let those four be entered and submitted.
  const longueur = PIN_LENGTH;
  const MIN_ACTUEL = 4;

  const [etape, setEtape] = useState<'actuel' | 'nouveau' | 'confirmer'>('actuel');
  const [actuel, setActuel] = useState('');
  const [nouveau, setNouveau] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [fait, setFait] = useState(false);

  const courant =
    etape === 'actuel' ? actuel : etape === 'nouveau' ? nouveau : confirmation;
  const poser =
    etape === 'actuel' ? setActuel : etape === 'nouveau' ? setNouveau : setConfirmation;

  function chiffre(d: string) {
    setErreur(null);
    if (courant.length >= longueur) return;
    poser(courant + d);
  }

  async function suivant() {
    setErreur(null);

    if (etape === 'actuel') {
      setEtape('nouveau');
      return;
    }

    if (etape === 'nouveau') {
      if (nouveau === actuel) {
        // Caught here rather than at the server so the person is not made to
        // type a third field before being told.
        setErreur('Choisissez un code différent de l’ancien.');
        return;
      }
      setEtape('confirmer');
      return;
    }

    if (confirmation !== nouveau) {
      setErreur('Les deux codes ne sont pas les mêmes.');
      setConfirmation('');
      return;
    }

    setOccupe(true);
    try {
      await api.changePin(session.accessToken, actuel, nouveau);
      setFait(true);
    } catch (e) {
      // The server owns the real rules — sequential digits, repeated digits, a
      // wrong current code — and its message is already in French. Restating
      // them here would be a second copy to keep in step.
      setErreur((e as api.ApiError).message);
      setEtape('actuel');
      setActuel('');
      setNouveau('');
      setConfirmation('');
    } finally {
      setOccupe(false);
    }
  }

  if (fait) {
    return (
      <div className="ecran vue">
        <Entete sousTitre="Code changé" />
        <div className="ecran__corps">
          <Message ton="succes">
            Votre nouveau code est enregistré. Utilisez-le la prochaine fois que vous
            entrez.
          </Message>
        </div>
        <div className="ecran__pied">
          <BoutonPrimaire onClick={onTermine}>Terminé</BoutonPrimaire>
        </div>
      </div>
    );
  }

  const titres = {
    actuel: 'Votre code actuel',
    nouveau: 'Votre nouveau code',
    confirmer: 'Encore une fois',
  } as const;

  return (
    <div className="ecran vue--tache">
      <Entete sousTitre={titres[etape]} />

      <div className="ecran__corps centre" style={{ justifyContent: 'center' }}>
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}
        <PinPoints longueur={longueur} remplis={courant.length} />
        {etape === 'confirmer' ? (
          <p className="discret centre">
            Tapez le même code une deuxième fois, pour être sûr.
          </p>
        ) : null}
      </div>

      <div className="ecran__pied pile">
        <Clavier
          onDigit={chiffre}
          onEffacer={() => poser(courant.slice(0, -1))}
          onToutEffacer={() => poser('')}
        />
        {/* The CURRENT code may be four digits, from before the lengths were
            unified; the new one must be six. Gating both at six would leave a
            legacy account unable to reach the screen that fixes it. */}
        <BoutonPrimaire
          onClick={suivant}
          disabled={
            occupe ||
            (etape === 'actuel'
              ? courant.length < MIN_ACTUEL
              : courant.length !== longueur)
          }
        >
          {etape === 'confirmer' ? 'Changer mon code' : 'Continuer'}
        </BoutonPrimaire>
        <BoutonSecondaire onClick={onAnnuler}>Annuler</BoutonSecondaire>
      </div>
    </div>
  );
}
