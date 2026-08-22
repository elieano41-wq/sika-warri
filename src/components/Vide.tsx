import type { ReactNode } from 'react';

/**
 * An empty state.
 *
 * The rule these follow: say what will appear here, and say what makes it
 * appear. "Aucune donnée" tells someone the app is working and they are not,
 * which for a vendor on their first day is both discouraging and useless. Every
 * caller below names the next action in plain words.
 *
 * Distinct from a loading state and from an error, which is the bug this
 * replaces in several places: a screen that renders "0 F" while a request is in
 * flight has told the vendor something false. Callers pass null while loading
 * and this component only ever means "we asked, and there is nothing".
 */
export function Vide({
  titre,
  children,
  icone,
  action,
}: {
  titre: string;
  children: ReactNode;
  icone?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="vide">
      {icone}
      <p className="vide__titre">{titre}</p>
      <p className="vide__corps">{children}</p>
      {action}
    </div>
  );
}

const commun = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** An open, empty carnet. */
export const IconeCarnetVide = (
  <svg {...commun}>
    <path d="M4 4.5h7v15H4zM13 4.5h7v15h-7z" />
    <path d="M11 4.5v15" />
  </svg>
);

/** A shopfront with nobody in it. */
export const IconeAucunClient = (
  <svg {...commun}>
    <circle cx="12" cy="9" r="3.4" />
    <path d="M5.5 20c0-3.2 2.9-5.4 6.5-5.4s6.5 2.2 6.5 5.4" />
    <path d="M3 3l18 18" />
  </svg>
);
