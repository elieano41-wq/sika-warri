import type { ReactNode } from 'react';
import { Montant } from './ui';
import {
  etiquetteDette, etiquetteReglement, tranches, ageEnMots, estAncienne,
  type EtatDette, type EtatReglement, type Tranches,
} from '../lib/dette';

/**
 * The state of a claim, shown the same way everywhere.
 *
 * CARRIES A SHAPE, NOT JUST A COLOUR. Filled dot for confirmée, hollow for
 * déclarée, a bar for contestée — because colour is the first thing to go in
 * direct sunlight on a cheap screen, and this is the most important word on the
 * card. A vendor reading "déclarée" should understand it is their own word so
 * far; a customer reading it should understand they can answer.
 */
export function EtatDetteBadge({
  etat,
  avecNote = false,
}: {
  etat: EtatDette;
  avecNote?: boolean;
}) {
  const e = etiquetteDette(etat);
  return (
    <>
      <span className={`etat etat--${e.ton}`} title={e.explication}>
        {e.mot}
      </span>
      {avecNote ? <p className="etat__note">{e.explication}</p> : null}
    </>
  );
}

export function EtatReglementBadge({
  etat,
  avecNote = false,
}: {
  etat: EtatReglement;
  avecNote?: boolean;
}) {
  const e = etiquetteReglement(etat);
  return (
    <>
      <span className={`etat etat--${e.ton}`} title={e.explication}>
        {e.mot}
      </span>
      {avecNote ? <p className="etat__note">{e.explication}</p> : null}
    </>
  );
}

/**
 * The two registers, side by side.
 *
 * THE LAYOUT IS THE ARGUMENT. Two boxes, two labels, two figures, a rule between
 * them. There is no third box and no arithmetic joining them, because 500 F held
 * and 2 000 F owed are two true facts and −1 500 F is a false one — it would
 * recreate the negative balance rule 2 forbids and describe a single position
 * where none exists.
 *
 * This component takes two numbers and cannot be given a combined one: there is
 * no prop for it.
 */
export function DeuxRegistres({
  monnaieCfa,
  detteCfa,
  noteMonnaie,
  noteDette,
  taille = 'ligne',
}: {
  monnaieCfa: number;
  detteCfa: number;
  noteMonnaie?: ReactNode;
  noteDette?: ReactNode;
  taille?: 'ligne' | 'grand';
}) {
  return (
    <div className="registres">
      <div className="registre">
        <span className="registre__etiquette">Monnaie gardée</span>
        <Montant value={monnaieCfa} taille={taille} />
        {noteMonnaie ? <span className="registre__note">{noteMonnaie}</span> : null}
      </div>
      <div className="registre registre--dette">
        <span className="registre__etiquette">Dette à payer</span>
        <Montant value={detteCfa} taille={taille} />
        {noteDette ? <span className="registre__note">{noteDette}</span> : null}
      </div>
    </div>
  );
}

/**
 * How old the money is, in words rather than a day count.
 *
 * Shown even at zero days. On a list where age is the whole point, "Aujourd'hui"
 * and a blank space are different claims, and a reader should not have to work
 * out which one an empty row means.
 */
export function PuceAge({ jours }: { jours: number }) {
  if (jours < 0) return null;
  return (
    <span className={`puce-age ${estAncienne(jours) ? 'puce-age--ancienne' : ''}`}>
      {ageEnMots(jours)}
    </span>
  );
}

/**
 * The ageing breakdown.
 *
 * Empty buckets are dropped: a row of "0 F" against three labels is noise, and
 * the bucket with money in it is the whole message.
 */
export function Tranches({ t }: { t: Tranches }) {
  const lignes = tranches(t);
  if (lignes.length === 0) return null;

  return (
    <div className="tranches">
      {lignes.map((l) => (
        <div
          key={l.cle}
          className={`tranche ${
            l.cle === 'bucket_31_90' || l.cle === 'bucket_90' ? 'tranche--ancienne' : ''
          }`}
        >
          <span className="tranche__age">{l.etiquette}</span>
          <Montant value={l.montant} taille="ligne" />
        </div>
      ))}
    </div>
  );
}
