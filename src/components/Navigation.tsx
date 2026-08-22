import type { ReactNode } from 'react';

/**
 * The bottom bar.
 *
 * WHY A BAR AT ALL. Before this, every screen was reached from the home screen
 * and returned to it — so seeing your clients after recording change meant
 * going back first, and there was no way to tell where you were. A persistent
 * bar means the app has places rather than a sequence of forms.
 *
 * WHY FOUR ITEMS AT MOST. At 320px, five items leave 64px each including
 * padding, which is under the 56px target once the label is inset. Four fit with
 * room, and a fifth destination is a sign something belongs inside another one.
 *
 * WHAT IS NOT HERE. Recording change, spending it, and confirming a debit are
 * tasks, not destinations: they start, they end, and they must not offer a
 * tab-switch halfway through — a vendor who taps away from a half-recorded
 * entry has lost it, and a customer with 180 seconds to confirm has less time
 * than they think. App.tsx hides the bar for those, which is why this component
 * takes no notion of a "current task".
 *
 * ICONS AND LABELS TOGETHER. Neither alone: an icon is ambiguous to a first-time
 * user and a label alone is slower to find at a glance. The selected state is
 * carried by weight, colour AND a gold rule, because colour is the first thing
 * to disappear in direct sunlight on a cheap screen.
 */

export interface Onglet<T extends string> {
  cle: T;
  etiquette: string;
  icone: ReactNode;
}

export function Navigation<T extends string>({
  onglets,
  actif,
  onChoisir,
}: {
  onglets: Array<Onglet<T>>;
  actif: T;
  onChoisir: (cle: T) => void;
}) {
  return (
    <nav className="nav" aria-label="Navigation principale">
      <div className="nav__inner">
        {onglets.map((o) => (
          <button
            key={o.cle}
            type="button"
            className="nav__item"
            // aria-current is what a screen reader announces AND what the
            // stylesheet selects on, so the visual and the announced state
            // cannot drift apart.
            aria-current={o.cle === actif ? 'page' : undefined}
            onClick={() => onChoisir(o.cle)}
          >
            {o.icone}
            <span className="nav__etiquette">{o.etiquette}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

/* --------------------------------------------------------------------------
   Icons

   Inline, stroked, 26px. No icon library: one would be a dependency and a
   download for a dozen glyphs, on connections where the whole bundle matters.
   currentColor throughout, so the selected state needs no separate asset.
   -------------------------------------------------------------------------- */

const commun = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** A shopfront. The vendor's home. */
export const IconeBoutique = (
  <svg {...commun}>
    <path d="M3 9.5 5 4h14l2 5.5" />
    <path d="M4 9.5h16V20H4z" />
    <path d="M9.5 20v-5h5v5" />
  </svg>
);

/** Coins. The customer's change. */
export const IconeMonnaie = (
  <svg {...commun}>
    <ellipse cx="12" cy="6.5" rx="7" ry="3" />
    <path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
    <path d="M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
  </svg>
);

/** People. The vendor's clients. */
export const IconeClients = (
  <svg {...commun}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
    <path d="M16.5 5.2a3.2 3.2 0 0 1 0 5.6" />
    <path d="M18 14.9c1.8.7 3 2.3 3 4.1" />
  </svg>
);

/** A ruled page. History. */
export const IconeHistorique = (
  <svg {...commun}>
    <path d="M5 3.5h14v17H5z" />
    <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
  </svg>
);

/** A QR frame. The customer's code. */
export const IconeCode = (
  <svg {...commun}>
    <path d="M4 8.5V4h4.5M15.5 4H20v4.5M20 15.5V20h-4.5M8.5 20H4v-4.5" />
    <path d="M9 9h6v6H9z" />
  </svg>
);

/** A person in a frame. The account. */
export const IconeCompte = (
  <svg {...commun}>
    <circle cx="12" cy="9" r="3.4" />
    <path d="M5.5 20c0-3.2 2.9-5.4 6.5-5.4s6.5 2.2 6.5 5.4" />
    <circle cx="12" cy="12" r="9.2" />
  </svg>
);
