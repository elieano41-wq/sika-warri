import type { ReactNode } from 'react';
import { formatCfaDigits, formatCountdown, ESPACE } from '../lib/format';

// ---------------------------------------------------------------------------
// Montant
// ---------------------------------------------------------------------------

/**
 * An amount, always in tabular mono with a space-grouped figure and the F
 * suffix. The suffix is its own element at half size: at 4.5rem the F would
 * otherwise dominate the digits, which are the part being read.
 */
export function Montant({
  value,
  taille = 'ligne',
  className = '',
}: {
  value: number;
  taille?: 'geant' | 'grand' | 'ligne';
  className?: string;
}) {
  return (
    <span className={`montant montant--${taille} ${className}`}>
      {formatCfaDigits(value)}
      {/*
        The separator is a real non-breaking space in the TEXT, not a CSS
        margin. A margin looks identical but leaves the text content as
        "1 500F", which is what a screen reader announces and what lands on the
        clipboard. The spec's format is "2 500 F"; the space has to be there.
      */}
      <span className="montant--suffixe">{ESPACE}F</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Clavier
// ---------------------------------------------------------------------------

const TOUCHES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * A built-in numeric keypad, not an <input type="number">.
 *
 * The Android soft keyboard covers half a small screen, offers a decimal
 * separator this product has no use for (integer FCFA only), and hides the
 * figure being typed — which is the one thing that must stay visible. Keys are
 * 68px so they can be hit with a thumb while the other hand is counting coins.
 */
export function Clavier({
  onDigit,
  onEffacer,
  onToutEffacer,
}: {
  onDigit: (d: string) => void;
  onEffacer: () => void;
  onToutEffacer: () => void;
}) {
  return (
    <div className="clavier" role="group" aria-label="Clavier numérique">
      {TOUCHES.map((t) => (
        <button
          key={t}
          type="button"
          className="clavier__touche"
          onClick={() => onDigit(t)}
          aria-label={t}
        >
          {t}
        </button>
      ))}
      <button
        type="button"
        className="clavier__touche clavier__touche--action"
        onClick={onToutEffacer}
        aria-label="Tout effacer"
      >
        C
      </button>
      <button
        type="button"
        className="clavier__touche"
        onClick={() => onDigit('0')}
        aria-label="0"
      >
        0
      </button>
      <button
        type="button"
        className="clavier__touche clavier__touche--action"
        onClick={onEffacer}
        aria-label="Effacer un chiffre"
      >
        ⌫
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * A card: a shop, a figure, and whatever belongs under them.
 *
 * PLAIN, NOT PAPER. This was styled after the cahier a vendor already keeps — a
 * gold margin rule and a ruled-paper texture. That went: a ledger which has to
 * be trusted with money should not look like a school exercise book, and
 * skeuomorphism ages badly next to the real thing it imitates.
 *
 * What holds it together instead is restraint. One accent colour, reserved for
 * amounts, the primary action, and the single most important card on a screen
 * (`principale`). Separation by hairline rather than shadow, because a shadow is
 * invisible in direct sunlight. No gradients and no blur, because both cost GPU
 * on a cheap Android and neither says anything.
 */
export function Carte({
  boutique,
  quartier,
  montant,
  etiquette,
  children,
  principale = false,
}: {
  boutique: string;
  quartier?: string | null;
  montant: number;
  etiquette?: string;
  children?: ReactNode;
  /**
   * The one card that answers the screen's question. At most ONE per screen —
   * used twice it means nothing, which is why it is opt-in rather than default.
   */
  principale?: boolean;
}) {
  return (
    <article className={`carte${principale ? ' carte--principale' : ''}`}>
      <div>
        <div className="carte__titre">{boutique}</div>
        {quartier ? <div className="carte__sous">{quartier}</div> : null}
      </div>
      {etiquette ? <div className="carte__etiquette">{etiquette}</div> : null}
      <Montant value={montant} taille="grand" />
      {children}
    </article>
  );
}

// ---------------------------------------------------------------------------
// PIN
// ---------------------------------------------------------------------------

/**
 * Dots rather than digits or asterisks. A customer can see how many digits
 * they have entered at a glance, without reading, and nobody standing beside
 * them learns the length of a partially typed PIN from across a stall.
 */
export function PinPoints({ longueur, remplis }: { longueur: number; remplis: number }) {
  return (
    <div className="pin" role="img" aria-label={`${remplis} chiffre(s) sur ${longueur}`}>
      {Array.from({ length: longueur }, (_, i) => (
        <span key={i} className={`pin__point ${i < remplis ? 'pin__point--plein' : ''}`} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

export function Entete({ sousTitre, action }: { sousTitre?: string; action?: ReactNode }) {
  return (
    <header className="entete">
      <div>
        <div className="entete__marque">Sika Warri</div>
        {sousTitre ? <div className="entete__boutique">{sousTitre}</div> : null}
      </div>
      {action}
    </header>
  );
}

export function Message({
  ton,
  children,
}: {
  ton: 'erreur' | 'succes' | 'info';
  children: ReactNode;
}) {
  return (
    <div
      className={`message message--${ton}`}
      role={ton === 'erreur' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

export function Cadran({
  etiquette,
  children,
}: {
  etiquette: string;
  children: ReactNode;
}) {
  return (
    <div className="cadran">
      <div className="cadran__etiquette">{etiquette}</div>
      {children}
    </div>
  );
}

export function Compteur({ secondes }: { secondes: number }) {
  return (
    <span className="compte-a-rebours" aria-live="off">
      {formatCountdown(secondes)}
    </span>
  );
}

export function BoutonPrimaire({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" className="bouton bouton--primaire" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function BoutonSecondaire({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" className="bouton bouton--secondaire" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function BoutonDiscret({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="bouton bouton--discret" onClick={onClick}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Build marker
// ---------------------------------------------------------------------------

/**
 * Which build is this.
 *
 * Deliberately visible rather than hidden behind a settings screen: when
 * something looks wrong in a market, the question "which version are you
 * holding?" has to be answerable by reading the screen, not by navigating it.
 * Small and in the sauge grey so it never competes with an amount.
 */
export function Version() {
  return (
    <p className="discret centre" style={{ fontFamily: 'var(--police-chiffre)', opacity: 0.75 }}>
      build {__BUILD_SHA__} · {__BUILD_DATE__}
    </p>
  );
}
