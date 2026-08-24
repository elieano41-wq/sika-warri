import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { Session, AccountSummary } from '../lib/api';
import { formatCfa } from '../lib/format';
import {
  Entete, Message, Montant, BoutonSecondaire, BoutonDiscret,
} from '../components/ui';

/**
 * Accueil — one screen, four registers, for one kind of account.
 *
 * ============================================================================
 * WHY THERE ARE FOUR AND NOT TWO. There used to be two kinds of account, and
 * each saw half of this. A "vendor" saw change they were holding and debts owed
 * to them; a "customer" saw change held for them and debts they owed. One
 * account sees all four, because one person can be on either side of any
 * carnet — the tailor who keeps a note of what a neighbour owes is also
 * somebody else's customer.
 *
 *                        I OWE                    OWED TO ME
 *      change     monnaie que je garde      gardé pour moi
 *      debt       dettes que je dois        dettes qu'on me doit
 *
 * WHY NONE OF THEM ARE ADDED TOGETHER. Rule 2 and the two-register rule, and
 * they bite in two different places here.
 *
 * Left column: both cells are money I owe, and they still do not add up. Change
 * I am holding is cash in my till that I hand back on demand; a debt I owe is
 * money I have to find. Summing them would produce a figure I could neither
 * pay nor plan against.
 *
 * Right column, top cell: this one cannot even be a total in principle. 500 F
 * at Awa's and 500 F at Koffi's is not 1 000 F, because rule 1 says change is
 * only spendable where it was kept. So that cell carries a figure but sends the
 * reader to the list, and says so.
 *
 * The other three ARE legitimate single figures, because each is one fact about
 * the reader: money in my till, money I have to find, money owed to me.
 * ============================================================================
 *
 * Empty cells are not rendered. Most accounts use one or two of the four —
 * somebody who only keeps a debt book has one number, and printing three zeros
 * beside it would suggest the app is mostly not for them.
 */
export function Accueil({
  session,
  actorUserId,
  nom,
  quartier,
  onGarder,
  onUtiliser,
  onNoterDette,
  onJeGarde,
  onOnMeDoit,
  onMesCarnets,
  onHistorique,
  onCorriger,
  onVerifier,
}: {
  session: Session;
  actorUserId: string;
  nom: string;
  quartier?: string | null;
  /* tasks */
  onGarder: () => void;
  onUtiliser: () => void;
  onNoterDette: () => void;
  /* the four cells, each landing on the list behind it */
  onJeGarde: () => void;
  onOnMeDoit: () => void;
  onMesCarnets: () => void;
  /* elsewhere */
  onHistorique: () => void;
  onCorriger: () => void;
  onVerifier: () => void;
}) {
  const [resume, setResume] = useState<AccountSummary | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      setResume(await api.accountSummary(session.accessToken, actorUserId));
      setErreur(null);
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }, [session.accessToken, actorUserId]);

  // Refreshed on return to the screen and on returning to the foreground, so
  // somebody coming back from recording an entry sees the new figure.
  useEffect(() => {
    charger();
    const auRetour = () => { if (document.visibilityState === 'visible') charger(); };
    document.addEventListener('visibilitychange', auRetour);
    return () => document.removeEventListener('visibilitychange', auRetour);
  }, [charger]);

  const vide =
    resume !== null &&
    resume.gardeCfa === 0 && resume.jeDoisCfa === 0 &&
    resume.gardePourMoiCfa === 0 && resume.onMeDoitCfa === 0;

  return (
    <div className="ecran ecran--avec-nav vue">
      <Entete sousTitre={quartier ? `${nom} · ${quartier}` : nom} />

      <div className="ecran__corps">
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {/* Anything asserted about me that I have not answered comes FIRST.
            It is the only thing on this screen resting on somebody else's word,
            and the only one with a deadline attached. */}
        {resume !== null && resume.aVerifier > 0 ? (
          <button type="button" className="banniere banniere--verif" onClick={onVerifier}>
            <span>
              {resume.aVerifier} chose{resume.aVerifier === 1 ? '' : 's'} à vérifier
            </span>
            <span className="banniere__action">Voir</span>
          </button>
        ) : null}

        {/* THE FIRST SCREEN SOMEBODY EVER OPENS.
            Four zeros are accurate and useless: they look like an app that has
            been used and come up empty, not one waiting to be started. */}
        {/* Two lines, no card.
            The first version was a paragraph inside a raised surface, and it
            pushed the three buttons off the first screen somebody ever opens —
            so the one screen whose entire job is "start here" was the one
            screen you had to scroll to start on. Somebody who just signed up
            does not need the product explained again; they need to see what
            they can do. The buttons say it. */}
        {vide ? (
          <div className="accueil-vide">
            <p style={{ fontSize: 'var(--texte-grand)' }}>Votre carnet est vide.</p>
            <p className="discret">
              Vous notez, l’autre confirme sur son téléphone.
            </p>
          </div>
        ) : null}

        {resume === null ? (
          <section className="bloc-chiffres">
            <div className="carte__etiquette">Vos carnets</div>
            <span className="montant montant--geant" style={{ color: 'var(--sauge)' }}>—</span>
            <div className="discret">Chargement…</div>
          </section>
        ) : vide ? null : (
          <Matrice
            cellules={[
              {
                ligne: 'monnaie', colonne: 'jedois', etiquette: 'Monnaie',
                cfa: resume.gardeCfa,
                note: resume.gardePersonnes === 0 ? null
                  : `${resume.gardePersonnes} personne${resume.gardePersonnes === 1 ? '' : 's'}`,
                onClick: onJeGarde,
              },
              {
                ligne: 'monnaie', colonne: 'onmedoit', etiquette: 'Monnaie',
                cfa: resume.gardePourMoiCfa,
                note: resume.gardePourMoiCarnets === 0 ? null
                  : `dans ${resume.gardePourMoiCarnets} carnet${resume.gardePourMoiCarnets === 1 ? '' : 's'}`,
                onClick: onMesCarnets,
              },
              {
                ligne: 'dettes', colonne: 'jedois', etiquette: 'Dettes',
                cfa: resume.jeDoisCfa,
                note: resume.jeDoisCreanciers === 0 ? null
                  : `à ${resume.jeDoisCreanciers} personne${resume.jeDoisCreanciers === 1 ? '' : 's'}`,
                onClick: onMesCarnets,
              },
              {
                ligne: 'dettes', colonne: 'onmedoit', etiquette: 'Dettes',
                cfa: resume.onMeDoitCfa,
                note: resume.onMeDoitDebiteurs === 0 ? null
                  : `${resume.onMeDoitDebiteurs} personne${resume.onMeDoitDebiteurs === 1 ? '' : 's'}`,
                onClick: onOnMeDoit,
              },
            ]}
          />
        )}

        {/* THE THREE ACTIONS, AT EQUAL WEIGHT. None of them carries a fill —
            gold belongs to the amounts. Recording a debt is as ordinary a
            counter act as keeping change, and it is now available to every
            account rather than only to whoever picked "commerçant" at signup. */}
        <div className="actions-accueil">
          <BoutonSecondaire onClick={onGarder}>Garder la monnaie</BoutonSecondaire>
          <BoutonSecondaire onClick={onUtiliser}>Utiliser la monnaie</BoutonSecondaire>
          <BoutonSecondaire onClick={onNoterDette}>Noter une dette</BoutonSecondaire>
          {/* Today's activity used to live above these. It moved to the history
              screen: with up to four registers above them there is no room for a
              fifth block first, and an action below the fold is not equal in
              weight to one above it whatever it is painted like. */}
          <BoutonDiscret onClick={onHistorique}>Historique</BoutonDiscret>
          <BoutonDiscret onClick={onCorriger}>Corriger une écriture</BoutonDiscret>
        </div>
        {/* CONTEXT, BELOW THE ACTIONS.
            All three of these are things to know, not things to do, and above
            the buttons they pushed the three actions off a 360x740 screen in
            the one case where all four registers are live. Somebody opening the
            app at a counter came to record something; the ageing of their book
            is the next question, not the first. */}
        {/* Rule 1, said once, where it applies — and only when that cell is on
            screen. Inside the cell it was a wrapped "· pas cumulable" fragment
            that read as a technical aside; as its own line it is a sentence. */}
        {resume !== null && resume.gardePourMoiCfa > 0 ? (
          <p className="discret">
            Cette monnaie n’est utilisable que là où elle est gardée.
          </p>
        ) : null}

        {/* The share worth worrying about, beside the total rather than inside
            it. A 47 000 F book that is all recent is healthy; the same figure at
            90 days is not, and one number cannot say which. */}
        {resume !== null && resume.onMeDoitVieuxCfa > 0 ? (
          <p className="discret" style={{ color: 'var(--alerte)' }}>
            {formatCfa(resume.onMeDoitVieuxCfa)} vous sont dus depuis plus de 30 jours.
          </p>
        ) : null}

        {resume !== null && resume.reclamationsOuvertes > 0 ? (
          <p className="discret" style={{ color: 'var(--alerte)' }}>
            {resume.reclamationsOuvertes} personne
            {resume.reclamationsOuvertes === 1 ? '' : 's'} déclare
            {resume.reclamationsOuvertes === 1 ? '' : 'nt'} avoir payé sans que ce
            soit enregistré.
          </p>
        ) : null}

      </div>

      <div className="ecran__pied pile">
        <p className="discret centre">
          Sika Warri enregistre seulement. Ce que vous gardez reste chez vous et
          reste dû à la personne concernée.
        </p>
      </div>
    </div>
  );
}

type Ligne = 'monnaie' | 'dettes';
type Colonne = 'jedois' | 'onmedoit';

interface Cellule {
  ligne: Ligne;
  colonne: Colonne;
  etiquette: string;
  cfa: number;
  note: string | null;
  onClick: () => void;
}

const NOM_COLONNE: Record<Colonne, string> = {
  jedois: 'Je dois',
  onmedoit: 'On me doit',
};

/**
 * The whole sentence, for when there is no column heading to lean on.
 *
 * In the grid a cell says "Dettes" and the column above it says which
 * direction; in a list there is no column, so the label has to carry both.
 */
function libelleComplet(c: Cellule): string {
  if (c.ligne === 'dettes') {
    return c.colonne === 'onmedoit' ? 'Dettes qu’on me doit' : 'Dettes que je dois';
  }
  return c.colonne === 'onmedoit' ? 'Monnaie gardée pour moi' : 'Monnaie que je garde';
}

/**
 * The matrix, at whatever shape the data actually has.
 *
 * ============================================================================
 * WHY THIS IS NOT A FIXED 2x2. Because a fixed 2x2 was wrong, and the case it
 * was most wrong for is the one this whole change exists to serve.
 *
 * Somebody who only keeps a note of what people owe them — a tailor, somebody
 * who lent to a neighbour — has ONE of the four figures. Rendered on a fixed
 * grid, they got a column headed "Je dois" with nothing under it, an empty row
 * reserved above their one number, and that number floating in the middle of the
 * screen at a height determined by cells that did not exist. A grid that
 * announces two columns and fills one is worse than a list: it reads as an app
 * with something missing.
 *
 * So an empty ROW is not rendered and an empty COLUMN is not rendered, heading
 * and all. The same component is a 1x1, a 1x2, a 2x1 or a 2x2 depending on what
 * the account actually holds, and every shape is tight.
 * ============================================================================
 *
 * The rule between the columns is drawn per row rather than behind the grid, so
 * it appears only where there are genuinely two columns to divide.
 */
function Matrice({ cellules }: { cellules: Cellule[] }) {
  const vivantes = cellules.filter((c) => c.cfa > 0);

  const colonnes = (['jedois', 'onmedoit'] as Colonne[])
    .filter((col) => vivantes.some((c) => c.colonne === col));
  const lignes = (['monnaie', 'dettes'] as Ligne[])
    .filter((l) => vivantes.some((c) => c.ligne === l));

  if (colonnes.length === 0) return null;

  // ---- IS THERE ANYTHING TO COMPARE? -----------------------------------
  // A matrix earns its two columns by putting a pair side by side. If no row has
  // both cells filled there is no pair, and the grid degenerates: one figure
  // beside a hole, at a vertical position decided by a cell that does not exist,
  // under a column heading with nothing under it.
  //
  // That covers one cell, two cells on a diagonal, and two in the same column —
  // between them, most accounts. All of them read better as a short list with
  // full labels, so that is what they get. The grid appears when it has
  // something to say.
  const compare = lignes.some(
    (l) => colonnes.length === 2 && colonnes.every((col) => vivantes.some((c) => c.ligne === l && c.colonne === col))
  );

  if (!compare) {
    return (
      <section className="liste-registres" aria-label="Vos registres">
        {vivantes.map((c) => (
          <button
            key={`${c.ligne}-${c.colonne}`}
            type="button"
            className={`matrice__cell matrice__cell--${c.colonne}`}
            onClick={c.onClick}
          >
            <span className="matrice__colonne">{libelleComplet(c)}</span>
            <Montant value={c.cfa} taille={vivantes.length === 1 ? 'geant' : 'grand'} />
            {c.note ? <span className="matrice__note">{c.note}</span> : null}
          </button>
        ))}
      </section>
    );
  }

  return (
    <section className={`matrice matrice--${colonnes.length}`} aria-label="Vos registres">
      <div className="matrice__tete">
        {colonnes.map((col) => (
          <span key={col} className="matrice__colonne">{NOM_COLONNE[col]}</span>
        ))}
      </div>

      {lignes.map((l) => (
        <div key={l} className="matrice__ligne">
          {colonnes.map((col) => {
            const c = vivantes.find((x) => x.ligne === l && x.colonne === col);
            // A hole INSIDE a live row is real information — this row has a
            // figure on one side and not the other — so the slot is kept and
            // left blank rather than closed up, which would misalign the row.
            if (!c) return <div key={col} className="matrice__creux" aria-hidden="true" />;
            return (
              <button
                key={col}
                type="button"
                className={`matrice__cell matrice__cell--${col}`}
                onClick={c.onClick}
              >
                <span className="matrice__etiquette">{c.etiquette}</span>
                <Montant value={c.cfa} taille="grand" />
                {c.note ? <span className="matrice__note">{c.note}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </section>
  );
}
