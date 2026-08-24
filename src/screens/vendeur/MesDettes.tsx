import { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import { useIdempotence } from '../../lib/idempotence';
import type { Session, VendorProfile, DebtorRow, DebtEntryRow } from '../../lib/api';
import {
  Entete, Message, Montant, BoutonPrimaire, BoutonSecondaire, BoutonDiscret, Cadran,
} from '../../components/ui';
import { Vide, IconeAucunClient } from '../../components/Vide';
import { EtatDetteBadge, PuceAge, Tranches } from '../../components/Dette';
import { libelleDette } from '../../lib/dette';
import { formatCfa, formatPhoneLocal } from '../../lib/format';
import { dateEtHeure } from '../../lib/mouvements';

/**
 * Mes dettes — who owes this vendor, and how long they have owed it.
 *
 * AGE IS THE POINT. A 500 F change credit from three months ago is fine; a 500 F
 * debt from three months ago is probably never getting paid, and a vendor
 * looking at one "on vous doit 47 000 F" figure cannot tell which kind of 47 000
 * they have. So the list sorts by age as well as amount — two different jobs:
 * "who owes me most" when deciding who to chase, "what has gone stale" when
 * deciding what to write off.
 *
 * THE HEADLINE FIGURE COMES FROM THE SERVER, not from this list. The list is a
 * bounded page; summing it would understate what the vendor is owed past the
 * page size and disagree with the home screen while neither reported an error.
 */

type Tri = 'amount' | 'age';

export function MesDettes({
  session,
  vendeur,
}: {
  session: Session;
  vendeur: VendorProfile;
}) {
  const [debiteurs, setDebiteurs] = useState<DebtorRow[] | null>(null);
  // ONE KEY PER TRANSACTION, not per attempt. A retry after a lost
  // response must be recognised as a replay, or a dropped connection at a
  // market stall writes the entry twice. See lib/idempotence.ts.
  const { cle: cleIdem, terminer: idemFait } = useIdempotence();
  const [resume, setResume] = useState<api.VendorDebtSummary | null>(null);
  const [tri, setTri] = useState<Tri>('amount');
  const [ouvert, setOuvert] = useState<DebtorRow | null>(null);
  const [histoire, setHistoire] = useState<DebtEntryRow[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [reglement, setReglement] = useState<number>(0);

  const charger = useCallback(async () => {
    try {
      const [liste, agg] = await Promise.all([
        api.vendorDebtors(session.accessToken, vendeur.id, vendeur.authUserId, 200, tri),
        api.vendorDebtSummary(session.accessToken, vendeur.id, vendeur.authUserId),
      ]);
      setDebiteurs(liste);
      setResume(agg);
      setErreur(null);
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }, [session.accessToken, vendeur.id, vendeur.authUserId, tri]);

  useEffect(() => { charger(); }, [charger]);

  async function ouvrir(d: DebtorRow) {
    setOuvert(d);
    setHistoire(null);
    setReglement(0);
    try {
      setHistoire(
        await api.vendorDebtHistory(
          session.accessToken, vendeur.id, d.customer_id, vendeur.authUserId
        )
      );
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }

  async function encaisser() {
    if (!ouvert || reglement <= 0) return;
    setOccupe(true);
    try {
      await api.settleDebt(session.accessToken, {
        vendorId: vendeur.id,
        customerId: ouvert.customer_id,
        actorUserId: vendeur.authUserId,
        amountCfa: reglement,
        idempotencyKey: cleIdem(),
      });
      idemFait();
      await charger();
      await ouvrir({ ...ouvert, debt_cfa: ouvert.debt_cfa - reglement });
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  // ---- one debtor --------------------------------------------------------
  if (ouvert) {
    const nom = ouvert.your_label ?? formatPhoneLocal(ouvert.phone);
    return (
      <div className="ecran vue--tache">
        <Entete
          sousTitre={nom}
          action={<BoutonDiscret onClick={() => setOuvert(null)}>Retour</BoutonDiscret>}
        />
        <div className="ecran__corps">
          {erreur ? <Message ton="erreur">{erreur}</Message> : null}

          <Cadran etiquette="Vous doit">
            <Montant value={ouvert.debt_cfa} taille="geant" />
          </Cadran>

          <div className="centre">
            <PuceAge jours={ouvert.oldest_days} />
          </div>

          {ouvert.open_claim ? (
            <Message ton="erreur">
              Ce client déclare avoir payé une somme qui n’est pas enregistrée.
              Vérifiez, puis enregistrez le paiement ou rejetez la réclamation.
            </Message>
          ) : null}

          {ouvert.disputed_cfa > 0 ? (
            <Message ton="erreur">
              {formatCfa(ouvert.disputed_cfa)} sont contestés par le client.
            </Message>
          ) : null}

          {ouvert.declared_cfa > 0 ? (
            <Message ton="info">
              {formatCfa(ouvert.declared_cfa)} reposent sur votre seule déclaration.
              Le client ne les a pas confirmés.
            </Message>
          ) : null}

          <h2>Ancienneté</h2>
          <Tranches t={ouvert} />

          <h2>Encaisser un paiement</h2>
          <p className="discret">
            Le client vous a payé en espèces ? Enregistrez-le maintenant — il le
            verra sur son téléphone.
          </p>
          <div className="pile" style={{ gap: 'var(--espace-2)' }}>
            {[500, 1000, 2000, ouvert.debt_cfa].filter(
              (m, i, a) => m > 0 && m <= ouvert.debt_cfa && a.indexOf(m) === i
            ).map((m) => (
              <BoutonSecondaire key={m} onClick={() => setReglement(m)}>
                {m === ouvert.debt_cfa ? `Tout régler — ${formatCfa(m)}` : formatCfa(m)}
              </BoutonSecondaire>
            ))}
          </div>
          {reglement > 0 ? (
            <BoutonPrimaire onClick={encaisser} disabled={occupe}>
              Enregistrer {formatCfa(reglement)} reçus
            </BoutonPrimaire>
          ) : null}

          <h2>Détail</h2>
          {histoire === null ? (
            <p className="discret">Chargement…</p>
          ) : histoire.length === 0 ? (
            <p className="discret">Aucun mouvement.</p>
          ) : (
            <ul className="pile" style={{ listStyle: 'none' }}>
              {histoire.map((e) => (
                <li key={e.id} className="ligne-histoire">
                  <div>
                    <div style={{ fontWeight: 500 }}>{libelleDette(e)}</div>
                    <div className="discret">{dateEtHeure(e.created_at)}</div>
                    {e.direction === 'owed' ? <EtatDetteBadge etat={e.state} /> : null}
                    {e.dispute_reason ? (
                      <div className="discret">« {e.dispute_reason} »</div>
                    ) : null}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span
                      className="montant montant--ligne"
                      style={{
                        color: e.direction === 'owed' ? 'var(--alerte)' : 'var(--craie)',
                      }}
                    >
                      {e.direction === 'owed' ? '+' : '−'}
                      {formatCfa(e.amount_cfa)}
                    </span>
                    <div className="discret">reste {formatCfa(e.running_debt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="ecran__pied pile">
          <BoutonSecondaire onClick={() => setOuvert(null)}>
            Tous mes débiteurs
          </BoutonSecondaire>
        </div>
      </div>
    );
  }

  // ---- the list ----------------------------------------------------------
  const tronque =
    debiteurs !== null &&
    debiteurs.length > 0 &&
    (debiteurs[0]?.total_count ?? 0) > debiteurs.length;

  return (
    <div className="ecran ecran--avec-nav vue">
      <Entete sousTitre={vendeur.businessName} />

      <div className="ecran__corps">
        <h1>Les juru</h1>
        {/* "Juru" names the DEBT, never the person. The symmetric coinage
            (jurutigi, "le propriétaire de la dette") is widely heard for the
            CREDITOR, so on a debtor list it would point the wrong way — and
            confusing creditor with debtor is the one mistake this app cannot
            make. The debt gets the word; the direction stays in the heading. */}
        <p className="discret">
          Juru : la dette. Ici, ce qu’on vous doit.
        </p>
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {/* The headline figures, from the server aggregate. Total AND the share
            over 30 days, side by side — one number cannot tell a vendor whether
            their book is healthy. */}
        {/* The one figure this screen exists to answer: what is owed. */}
        <article className="carte carte--principale">
          <div className="carte__etiquette">On vous doit</div>
          {resume === null ? (
            <>
              <span className="montant montant--geant" style={{ color: 'var(--sauge)' }}>—</span>
              <div className="discret">Chargement…</div>
            </>
          ) : (
            <>
              <Montant value={resume.debt_cfa} taille="geant" />
              <div className="carte__sous">
                {resume.debtors === 0
                  ? 'Personne ne vous doit rien'
                  : `${resume.debtors} personne${resume.debtors === 1 ? '' : 's'}`}
              </div>
              {resume.over_30_cfa > 0 ? (
                <div className="discret" style={{ color: 'var(--alerte)' }}>
                  Dont {formatCfa(resume.over_30_cfa)} depuis plus de 30 jours
                </div>
              ) : null}
              {resume.declared_cfa > 0 ? (
                <div className="discret">
                  {formatCfa(resume.declared_cfa)} non confirmés
                </div>
              ) : null}
              {resume.open_claims > 0 ? (
                <div className="discret" style={{ color: 'var(--alerte)' }}>
                  {resume.open_claims} réclamation
                  {resume.open_claims === 1 ? '' : 's'} de paiement à vérifier
                </div>
              ) : null}
            </>
          )}
        </article>

        {debiteurs !== null && debiteurs.length > 1 ? (
          <div className="pile" style={{ gap: 'var(--espace-2)' }}>
            <div className="discret">Trier par</div>
            <div style={{ display: 'flex', gap: 'var(--espace-2)' }}>
              <BoutonSecondaire onClick={() => setTri('amount')}>
                {tri === 'amount' ? '● ' : ''}Montant
              </BoutonSecondaire>
              <BoutonSecondaire onClick={() => setTri('age')}>
                {tri === 'age' ? '● ' : ''}Ancienneté
              </BoutonSecondaire>
            </div>
          </div>
        ) : null}

        {tronque ? (
          <Message ton="info">
            Les {debiteurs?.length} premiers sur {debiteurs?.[0]?.total_count}.
          </Message>
        ) : null}

        {debiteurs === null ? (
          <p className="discret">Chargement…</p>
        ) : debiteurs.length === 0 ? (
          <Vide titre="Personne ne vous doit rien" icone={IconeAucunClient}>
            Quand vous notez une dette, le client apparaît ici avec le montant et
            depuis combien de temps il vous doit.
          </Vide>
        ) : (
          <ul className="pile" style={{ listStyle: 'none' }}>
            {debiteurs.map((d) => (
              <li key={d.customer_id}>
                <button
                  type="button"
                  onClick={() => ouvrir(d)}
                  className="ligne-client"
                  style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 'var(--texte-grand)' }}>
                      {d.your_label ?? formatPhoneLocal(d.phone)}
                    </div>
                    <div className="discret">
                      {formatPhoneLocal(d.phone)}
                      {d.is_registered ? '' : ' · sans compte'}
                    </div>
                    <div>
                      <PuceAge jours={d.oldest_days} />
                    </div>
                    {d.disputed_cfa > 0 ? (
                      <div className="discret" style={{ color: 'var(--alerte)' }}>
                        {formatCfa(d.disputed_cfa)} contestés
                      </div>
                    ) : d.declared_cfa > 0 ? (
                      <div className="discret">
                        {formatCfa(d.declared_cfa)} non confirmés
                      </div>
                    ) : null}
                    {d.open_claim ? (
                      <div className="discret" style={{ color: 'var(--alerte)' }}>
                        Réclamation de paiement
                      </div>
                    ) : null}
                  </div>
                  <Montant value={d.debt_cfa} taille="ligne" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
