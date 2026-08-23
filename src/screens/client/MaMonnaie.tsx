import { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, CustomerProfile, EntryRow } from '../../lib/api';
import {
  Entete, Message, Montant, BoutonSecondaire, BoutonDiscret,
} from '../../components/ui';
import { Vide, IconeCarnetVide } from '../../components/Vide';
import { DeuxRegistres, PuceAge } from '../../components/Dette';
import { informationalTotal, type ShopBalance } from '../../lib/balances';
import { formatCfa } from '../../lib/format';
// One source for how a movement is described, shared with the vendor's screens.
// It was written twice before, which was two chances to drift.
import {
  libelleMouvement, signeMouvement, dateCourte, dateEtHeure,
} from '../../lib/mouvements';

/**
 * Ma monnaie — one carte card per shop holding this customer's change.
 *
 * ACCEPTANCE TEST 8 IS THIS SCREEN. Standing rule 1: a balance exists for a
 * (customer, vendor) pair. There is no global balance and none may be presented
 * as spendable.
 *
 * The spec permits an informational total, but only carrying the sentence
 * "Répartie chez N commerçants — utilisable dans chaque boutique séparément".
 * This screen cannot render the figure without it: informationalTotal() returns
 * the amount and its caption as one object, so they cannot be separated by
 * accident (see src/lib/balances.ts).
 *
 * Why that matters more than it sounds: a screen reading "Votre monnaie:
 * 4 300 F" would be a claim that Sika Warri holds a single spendable balance.
 * It does not hold anything, and the money is four separate debts owed by four
 * different shopkeepers.
 */
export function MaMonnaie({
  session,
  client,
  onVerifier,
}: {
  session: Session;
  client: CustomerProfile;
  /** Opens the review queue. Owned by the shell, because it is a task. */
  onVerifier: () => void;
}) {
  // The total and the shop count, straight from the server. Never derived from
  // `shops` above, which is a bounded page.
  const [resume, setResume] = useState<api.CustomerSummary | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState<ShopBalance | null>(null);
  // Per shop: change held AND debt owed, as two figures. Loaded alongside the
  // change list rather than replacing it, because the informational total below
  // is about change only and must stay that way.
  const [positions, setPositions] = useState<api.ShopPositionRow[] | null>(null);
  const [aVerifier, setAVerifier] = useState(0);
  const [histoire, setHistoire] = useState<EntryRow[] | null>(null);

  const charger = useCallback(async () => {
    try {
      // Three questions, three calls, and only one of them may be trusted as a
      // total: positions is a bounded PAGE of shops, the summary is the
      // aggregate behind the informational figure, and the queue is what has
      // been recorded in this customer's name without their answer.
      const [agg, pos, file] = await Promise.all([
        api.myShopSummary(session.accessToken, client.authUserId),
        api.customerPositions(session.accessToken, client.authUserId),
        api.myReviewQueue(session.accessToken, client.authUserId),
      ]);

      setResume(agg);
      setPositions(pos);
      setAVerifier(file.length);
      setErreur(null);
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }, [session.accessToken, client.authUserId]);

  /**
   * Refresh on a timer, and whenever the phone comes back to the foreground.
   *
   * Loading once on mount was wrong: a customer standing at a counter watching
   * their phone while the vendor records change would see nothing happen. There
   * is no push channel yet (Web Push is Phase 2), so the screen has to ask.
   *
   * Eight seconds rather than the confirmation screen's two-and-a-half: a
   * balance appearing a few seconds late costs nothing, where a payment request
   * expiring in 180 seconds does. The visibility listener covers the common
   * case of the phone being pocketed and pulled out again.
   */
  useEffect(() => {
    charger();
    const minuteur = window.setInterval(charger, 8000);
    const auRetour = () => { if (document.visibilityState === 'visible') charger(); };
    document.addEventListener('visibilitychange', auRetour);

    return () => {
      window.clearInterval(minuteur);
      document.removeEventListener('visibilitychange', auRetour);
    };
  }, [charger]);

  async function ouvrir(shop: ShopBalance) {
    setOuvert(shop);
    setHistoire(null);
    try {
      setHistoire(
        await api.myShopHistory(session.accessToken, client.authUserId, shop.vendorId)
      );
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }

  // ---- one shop's history -----------------------------------------------
  if (ouvert) {
    return (
      <div className="ecran vue--tache">
        <Entete
          sousTitre={ouvert.shopName}
          action={<BoutonDiscret onClick={() => setOuvert(null)}>Retour</BoutonDiscret>}
        />
        <div className="ecran__corps">
          <article className="carte">
            <div>
              <div className="carte__titre">{ouvert.shopName}</div>
              {ouvert.quartier ? <div className="carte__sous">{ouvert.quartier}</div> : null}
            </div>
            <div className="carte__etiquette">Votre monnaie chez ce commerçant</div>
            <Montant value={ouvert.amountCfa} taille="geant" />
          </article>

          <p className="discret">
            Vous pouvez utiliser cette monnaie dans cette boutique, ou demander
            à ce commerçant de vous rembourser en espèces.
          </p>

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
                    <div style={{ fontWeight: 500 }}>{libelleMouvement(e)}</div>
                    <div className="discret">
                      {dateEtHeure(e.created_at)} · reçu {e.receipt_code}
                      {e.confirmation_method === 'vendor_device'
                        ? ' · code saisi chez le commerçant'
                        : ''}
                      {e.confirmation_method === 'vendor_correction'
                        ? ' · correction du commerçant'
                        : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span
                      className="montant montant--ligne"
                      style={{
                        color: e.direction === 'credit' ? 'var(--or-sika)' : 'var(--craie)',
                      }}
                    >
                      {signeMouvement(e)}
                      {formatCfa(e.amount_cfa)}
                    </span>
                    <div className="discret">reste {formatCfa(e.running_balance)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="ecran__pied pile">
          <BoutonSecondaire onClick={() => setOuvert(null)}>
            Voir toutes mes boutiques
          </BoutonSecondaire>
        </div>
      </div>
    );
  }

  // ---- all shops ---------------------------------------------------------
  // From the server aggregate, never from the list of cards above.
  const total = resume
    ? informationalTotal({ totalCfa: resume.total_cfa, shopCount: resume.shop_count })
    : null;

  return (
    <div className="ecran ecran--avec-nav vue">
      <Entete sousTitre="Votre monnaie chez les commerçants" />

      <div className="ecran__corps">
        <h1>Ma monnaie</h1>
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {/* The pre-loaded-claims defence, surfaced wherever the customer is. A
            claim never becomes fact by being ignored, but it should not be easy
            to ignore either. */}
        {aVerifier > 0 ? (
          <button
            type="button"
            className="banniere banniere--maj"
            onClick={onVerifier}
            style={{ width: '100%', border: 'none', cursor: 'pointer' }}
          >
            <span>
              {aVerifier} chose{aVerifier === 1 ? '' : 's'} enregistrée
              {aVerifier === 1 ? '' : 's'} à votre nom à vérifier
            </span>
            <span className="banniere__action">Voir</span>
          </button>
        ) : null}

        {positions === null ? (
          <p className="discret">Chargement…</p>
        ) : positions.length === 0 ? (
          <Vide titre="Pas encore de monnaie" icone={IconeCarnetVide}>
            Quand un commerçant garde votre monnaie au lieu de vous la rendre,
            la boutique apparaît ici avec le montant qu’elle vous doit.
          </Vide>
        ) : (
          <>
            {positions.map((p) => (
              <button
                key={p.vendor_id}
                type="button"
                onClick={() =>
                  ouvrir({
                    vendorId: p.vendor_id,
                    shopName: p.business_name,
                    quartier: p.quartier,
                    amountCfa: p.change_cfa,
                    lastActivityAt: p.last_activity_at,
                  })
                }
                className="carte carte--cliquable"
                style={{ textAlign: 'left', width: '100%', cursor: 'pointer' }}
              >
                <div>
                  <div className="carte__titre">{p.business_name}</div>
                  {p.quartier ? <div className="carte__sous">{p.quartier}</div> : null}
                </div>
                <div className="carte__etiquette">
                  {p.last_activity_at
                    ? `Dernier mouvement ${dateCourte(p.last_activity_at)}`
                    : ' '}
                </div>

                {/* TWO REGISTERS, NEVER MERGED. A shop where the customer holds
                    500 F and owes 2 000 F shows both numbers, because both are
                    true. -1 500 F would be a third thing that is false, and it
                    would recreate the negative balance rule 2 forbids. */}
                {p.debt_cfa > 0 ? (
                  <DeuxRegistres
                    vue="client"
                    monnaieCfa={p.change_cfa}
                    detteCfa={p.debt_cfa}
                    taille="grand"
                  />
                ) : (
                  <Montant value={p.change_cfa} taille="grand" />
                )}

                {p.debt_cfa > 0 && p.debt_oldest_days > 0 ? (
                  <div style={{ marginTop: 'var(--espace-2)' }}>
                    <PuceAge jours={p.debt_oldest_days} />
                  </div>
                ) : null}

                {p.debt_declared_cfa > 0 ? (
                  <div className="discret">
                    Dont {formatCfa(p.debt_declared_cfa)} que vous n’avez pas confirmés
                  </div>
                ) : null}
                {p.open_claim ? (
                  <div className="discret" style={{ color: 'var(--alerte)' }}>
                    Votre réclamation de paiement est en attente
                  </div>
                ) : null}

                <div className="discret">Toucher pour voir le détail</div>
              </button>
            ))}

            {/*
              INFORMATION ONLY. The caption is inseparable from the figure —
              informationalTotal() returns both together, and it returns null
              for a single shop, where repeating the same number under a
              "spread across" caption would imply a pool that does not exist.
            */}
            {total ? (
              <div
                className="message message--info"
                style={{ borderLeftColor: 'var(--sauge)' }}
              >
                <div className="discret" style={{ marginBottom: 'var(--espace-1)' }}>
                  Total enregistré, à titre d'information
                </div>
                <Montant value={total.amountCfa} taille="ligne" />
                <div className="discret" style={{ marginTop: 'var(--espace-2)' }}>
                  {total.caption}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="ecran__pied pile">
        <p className="discret centre">
          Sika Warri enregistre seulement. Chaque montant reste chez le
          commerçant concerné.
        </p>
      </div>
    </div>
  );
}
