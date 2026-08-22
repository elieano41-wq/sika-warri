// The words and the arithmetic of the debt register, in one place.
//
// THE DISTINCTION THIS FILE EXISTS TO KEEP VISIBLE.
//
//   CONFIRMÉE — the customer agreed on their own device. A record.
//   DÉCLARÉE  — the vendor entered it, nobody has answered. A CLAIM.
//   CONTESTÉE — the customer said no. The figure stands, the disagreement shows.
//
// Written once and imported everywhere, because a distinction that is worded
// differently on two screens is a distinction the reader stops trusting. And
// this one carries the whole fraud model: a fabricated debt earns the vendor
// money, so "who says this is true" is the most important thing on the screen.
//
// NOTHING HERE COMBINES CHANGE AND DEBT. There is no function taking both. 500 F
// held and 2 000 F owed are two facts; −1 500 F is a third thing that is false.

export type EtatDette = 'confirmed' | 'declared' | 'disputed';
export type EtatReglement = 'confirmed' | 'acknowledged' | 'declared' | 'disputed';

export interface Etiquette {
  /** The word itself. Short enough to sit beside an amount. */
  mot: string;
  /** One line saying what it means, for the first time someone sees it. */
  explication: string;
  /** Maps to a CSS modifier; never the only carrier of the distinction. */
  ton: 'confirme' | 'declare' | 'contest';
}

/**
 * How a debt entry is labelled.
 *
 * The wording is deliberately about WHO SAYS SO rather than about status. "En
 * attente" would suggest a process that will complete on its own; nothing here
 * completes on its own, and a déclarée debt can sit unanswered forever.
 */
export function etiquetteDette(etat: EtatDette): Etiquette {
  switch (etat) {
    case 'confirmed':
      return {
        mot: 'Confirmée',
        explication: 'Le client a confirmé sur son téléphone.',
        ton: 'confirme',
      };
    case 'disputed':
      return {
        mot: 'Contestée',
        explication: 'Le client ne reconnaît pas cette dette.',
        ton: 'contest',
      };
    default:
      return {
        mot: 'Déclarée',
        // Says out loud that this is one party's word. A vendor reading it
        // should understand their own exposure; a customer reading it should
        // understand they can answer.
        explication: 'Enregistrée par le commerçant. Le client ne l’a pas encore confirmée.',
        ton: 'declare',
      };
  }
}

/** How a settlement is labelled. Different verbs: nobody "accepts" a payment. */
export function etiquetteReglement(etat: EtatReglement): Etiquette {
  switch (etat) {
    case 'confirmed':
    case 'acknowledged':
      return {
        mot: 'Reconnu',
        explication: 'Les deux parties ont enregistré ce paiement.',
        ton: 'confirme',
      };
    case 'disputed':
      return {
        mot: 'Contesté',
        explication: 'Le client ne reconnaît pas ce paiement.',
        ton: 'contest',
      };
    default:
      return {
        mot: 'Enregistré',
        explication: 'Enregistré par le commerçant.',
        ton: 'declare',
      };
  }
}

/** What a debt movement is called. Never "crédit", never "prêt". */
export function libelleDette(m: { direction: 'owed' | 'repaid'; kind: string }): string {
  if (m.kind === 'debt') return 'Dette enregistrée';
  if (m.kind === 'settlement') return 'Paiement reçu';
  if (m.kind === 'cancellation') return 'Dette annulée par le commerçant';
  if (m.kind === 'compensation') return 'Réglée avec la monnaie gardée';
  if (m.kind === 'reversal') {
    return m.direction === 'repaid' ? 'Correction en faveur du client' : 'Correction';
  }
  return m.kind;
}

// ---------------------------------------------------------------------------
// Ageing
// ---------------------------------------------------------------------------

export interface Tranches {
  bucket_0_7: number;
  bucket_8_30: number;
  bucket_31_90: number;
  bucket_90: number;
}

export interface Tranche {
  cle: keyof Tranches;
  etiquette: string;
  montant: number;
}

/**
 * The four buckets, in order, with the empty ones dropped.
 *
 * Dropped rather than shown as zero because a row of "0 F" against three labels
 * is noise, and the one bucket that has money in it is the whole message.
 */
export function tranches(t: Tranches): Tranche[] {
  return (
    [
      { cle: 'bucket_0_7', etiquette: '0–7 jours', montant: t.bucket_0_7 },
      { cle: 'bucket_8_30', etiquette: '8–30 jours', montant: t.bucket_8_30 },
      { cle: 'bucket_31_90', etiquette: '31–90 jours', montant: t.bucket_31_90 },
      { cle: 'bucket_90', etiquette: 'Plus de 90 jours', montant: t.bucket_90 },
    ] as Tranche[]
  ).filter((x) => x.montant > 0);
}

/**
 * How old, in words a person uses.
 *
 * "Depuis 47 jours" is precise and hard to feel. "Depuis plus d'un mois" is what
 * someone says out loud, and it is the phrasing that makes a vendor act.
 */
export function ageEnMots(jours: number): string {
  if (jours <= 0) return "Aujourd'hui";
  if (jours === 1) return 'Depuis hier';
  if (jours <= 7) return `Depuis ${jours} jours`;
  if (jours <= 14) return 'Depuis plus d’une semaine';
  if (jours <= 31) return 'Depuis plus de deux semaines';
  if (jours <= 62) return 'Depuis plus d’un mois';
  if (jours <= 93) return 'Depuis plus de deux mois';
  if (jours <= 186) return 'Depuis plus de trois mois';
  if (jours <= 366) return 'Depuis plus de six mois';
  return 'Depuis plus d’un an';
}

/**
 * Whether a debt is old enough to be worth flagging on a card.
 *
 * 30 days is the threshold the summary uses, so the screens and the SQL agree
 * on what "old" means.
 */
export function estAncienne(jours: number): boolean {
  return jours > 30;
}
