// How a ledger movement is described, in one place.
//
// These labels were written twice — once in MesClients, once in MaMonnaie —
// which is two chances to drift. A vendor and a customer looking at the same
// entry must read the same words for it, or they cannot discuss it. So the
// wording lives here and both roles import it.
//
// Note the phrasing throughout: "gardée", "chez le commerçant", "en espèces".
// Nothing here may suggest Sika Warri received, held or returned money — the
// vendor holds the change and the vendor hands it back. See standing rule 10.

export interface Mouvement {
  direction: 'credit' | 'debit';
  kind: string;
}

/**
 * The label for one movement.
 *
 * A reversal is the interesting case: it reads differently depending on which
 * way it went. A credit reversal gives the customer back what a mistaken debit
 * took, so from either side it is a correction in the customer's favour. A debit
 * reversal undoes change that was recorded and should not have been.
 */
export function libelleMouvement(m: Mouvement): string {
  if (m.kind === 'change') return 'Monnaie gardée';
  if (m.kind === 'purchase') return 'Utilisée pour un achat';
  if (m.kind === 'refund') return 'Remboursée en espèces';
  if (m.kind === 'reversal') {
    return m.direction === 'credit'
      ? 'Correction en faveur du client'
      : 'Correction';
  }
  // An unrecognised kind is shown as-is rather than hidden. A movement the app
  // cannot name is still a movement that happened, and the receipt code beside
  // it is enough to ask about it.
  return m.kind;
}

/**
 * Which way the money went, from the reader's own side.
 *
 * The same entry is a plus for one party and a minus for the other only in
 * feeling, not in fact: a credit means the customer holds more change at that
 * shop, whichever screen is showing it. So the sign does not flip by role —
 * flipping it would make the vendor's and the customer's copies of the same
 * receipt disagree.
 */
export function signeMouvement(m: Mouvement): '+' | '−' {
  return m.direction === 'credit' ? '+' : '−';
}

/** Day and month, short. Ivorian French locale, Abidjan is UTC+0. */
export function dateCourte(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'short',
  });
}

/** Day, month and time — for a list where several movements share a day. */
export function dateEtHeure(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })} · ${d.toLocaleTimeString(
    'fr-FR',
    { hour: '2-digit', minute: '2-digit' }
  )}`;
}

/**
 * Group movements into day buckets, newest first.
 *
 * A flat list of eighty rows is hard to read and harder to search by memory.
 * People remember "Tuesday", not row 34.
 */
export function parJour<T extends { created_at: string }>(
  mouvements: T[]
): Array<{ jour: string; etiquette: string; lignes: T[] }> {
  const groupes = new Map<string, T[]>();

  for (const m of mouvements) {
    // Bucket on the local calendar day, not on the ISO string, or entries either
    // side of midnight UTC land in the wrong day for the reader.
    const d = new Date(m.created_at);
    const jour = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
    const existant = groupes.get(jour);
    if (existant) existant.push(m);
    else groupes.set(jour, [m]);
  }

  return [...groupes.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([jour, lignes]) => ({ jour, etiquette: etiquetteJour(jour), lignes }));
}

/** "Aujourd'hui", "Hier", or a written date. */
export function etiquetteJour(jour: string): string {
  const maintenant = new Date();
  const aujourdhui = cle(maintenant);
  const hier = cle(new Date(maintenant.getTime() - 86_400_000));

  if (jour === aujourdhui) return "Aujourd'hui";
  if (jour === hier) return 'Hier';

  const [a, m, j] = jour.split('-').map(Number);
  return new Date(a!, m! - 1, j!).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function cle(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}
