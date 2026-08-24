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
              {resume.aVerifier} chose{resume.aVerifier === 1 ? '' : 's'} enregistrée
              {resume.aVerifier === 1 ? '' : 's'} à votre nom à vérifier
            </span>
            <span className="banniere__action">Voir</span>
          </button>
        ) : null}

        {/* THE FIRST SCREEN SOMEBODY EVER OPENS.
            Four zeros are accurate and useless: they look like an app that has
            been used and come up empty, not one waiting to be started. */}
        {vide ? (
          <article className="carte">
            <div className="carte__etiquette">Bienvenue</div>
            <p style={{ fontSize: 'var(--texte-grand)' }}>
              Votre carnet est vide. Commencez quand vous gardez la monnaie de
              quelqu’un, ou quand quelqu’un vous doit quelque chose.
            </p>
            <p className="discret">
              Vous notez, l’autre confirme sur son téléphone. Sika Warri ne garde
              pas d’argent — elle note seulement qui doit quoi.
            </p>
          </article>
        ) : null}

        {resume === null ? (
          <section className="bloc-chiffres">
            <div className="carte__etiquette">Vos carnets</div>
            <span className="montant montant--geant" style={{ color: 'var(--sauge)' }}>—</span>
            <div className="discret">Chargement…</div>
          </section>
        ) : vide ? null : (
          <section className="matrice" aria-label="Vos quatre registres">
            {/* Column headings, once. Each cell then needs only its own noun,
                which is what keeps four figures readable at a glance. */}
            <div className="matrice__entete matrice__entete--dette">Je dois</div>
            <div className="matrice__entete">On me doit</div>

            {/* ---- change ---------------------------------------------- */}
            <Cellule
              etiquette="Monnaie que je garde"
              cfa={resume.gardeCfa}
              note={
                resume.gardePersonnes === 0
                  ? null
                  : `${resume.gardePersonnes} personne${resume.gardePersonnes === 1 ? '' : 's'}`
              }
              ton="dette"
              onClick={onJeGarde}
            />
            <Cellule
              etiquette="Gardé pour moi"
              cfa={resume.gardePourMoiCfa}
              /* NOT a spendable figure. Rule 1: change is only usable where it
                 was kept, so the honest thing this cell can do is name the
                 number of carnets and hand the reader to the list. */
              note={
                resume.gardePourMoiCarnets === 0
                  ? null
                  : `dans ${resume.gardePourMoiCarnets} carnet${resume.gardePourMoiCarnets === 1 ? '' : 's'} · pas cumulable`
              }
              ton="avoir"
              onClick={onMesCarnets}
            />

            {/* ---- debt ------------------------------------------------- */}
            <Cellule
              etiquette="Dettes que je dois"
              cfa={resume.jeDoisCfa}
              note={
                resume.jeDoisCreanciers === 0
                  ? null
                  : `à ${resume.jeDoisCreanciers} personne${resume.jeDoisCreanciers === 1 ? '' : 's'}`
              }
              ton="dette"
              onClick={onMesCarnets}
            />
            <Cellule
              etiquette="Dettes qu’on me doit"
              cfa={resume.onMeDoitCfa}
              note={
                resume.onMeDoitDebiteurs === 0
                  ? null
                  : `${resume.onMeDoitDebiteurs} personne${resume.onMeDoitDebiteurs === 1 ? '' : 's'}`
              }
              ton="avoir"
              onClick={onOnMeDoit}
            />
          </section>
        )}

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

        {/* THE THREE ACTIONS, AT EQUAL WEIGHT. None of them carries a fill —
            gold belongs to the amounts. Recording a debt is as ordinary a
            counter act as keeping change, and it is now available to every
            account rather than only to whoever picked "commerçant" at signup. */}
        <div className="actions-accueil">
          <BoutonSecondaire onClick={onGarder}>Garder la monnaie</BoutonSecondaire>
          <BoutonSecondaire onClick={onUtiliser}>Utiliser la monnaie</BoutonSecondaire>
          <BoutonSecondaire onClick={onNoterDette}>Noter une dette</BoutonSecondaire>
          <BoutonDiscret onClick={onHistorique}>Historique</BoutonDiscret>
        </div>

        {/* Today's activity used to live here. It moved out to the history
            screen: with four registers above it there is no longer room for a
            fifth block before the actions, and an action below the fold is not
            equal in weight to one above it. */}
        <BoutonDiscret onClick={onCorriger}>Corriger une écriture</BoutonDiscret>
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

/**
 * One cell of the matrix.
 *
 * A button, because every figure here has a list behind it and a figure you
 * cannot open is a figure you cannot check. Zero renders nothing at all: the
 * cell collapses rather than printing 0 F, so an account using one register is
 * not shown three empty ones.
 */
function Cellule({
  etiquette,
  cfa,
  note,
  ton,
  onClick,
}: {
  etiquette: string;
  cfa: number;
  note: string | null;
  ton: 'dette' | 'avoir';
  onClick: () => void;
}) {
  if (cfa === 0) return <div className="matrice__vide" aria-hidden="true" />;

  return (
    <button type="button" className={`matrice__cell matrice__cell--${ton}`} onClick={onClick}>
      <span className="matrice__etiquette">{etiquette}</span>
      <Montant value={cfa} taille="grand" />
      {note ? <span className="matrice__note">{note}</span> : null}
    </button>
  );
}
