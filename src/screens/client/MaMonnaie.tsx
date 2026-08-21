import { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, CustomerProfile, ShopRow, EntryRow } from '../../lib/api';
import {
  Entete, Message, Montant, BoutonSecondaire, BoutonDiscret, Version,
} from '../../components/ui';
import { perShop, informationalTotal, type ShopBalance } from '../../lib/balances';
import { formatCfa } from '../../lib/format';

/**
 * Ma monnaie — one carnet card per shop holding this customer's change.
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
  onDeconnexion,
}: {
  session: Session;
  client: CustomerProfile;
  onDeconnexion: () => void;
}) {
  const [shops, setShops] = useState<ShopBalance[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState<ShopBalance | null>(null);
  const [histoire, setHistoire] = useState<EntryRow[] | null>(null);

  const charger = useCallback(async () => {
    try {
      const rows: ShopRow[] = await api.myShops(session.accessToken, client.authUserId);
      // Shaping happens in balances.ts, the one file allowed to fold over
      // balances at all.
      setShops(
        perShop(
          rows.map((r) => ({
            vendor_id: r.vendor_id,
            balance_cfa: r.balance_cfa,
            last_activity_at: r.last_activity_at,
            business_name: r.business_name,
            quartier: r.quartier,
          }))
        )
      );
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
      <div className="ecran">
        <Entete
          sousTitre={ouvert.shopName}
          action={<BoutonDiscret onClick={() => setOuvert(null)}>Retour</BoutonDiscret>}
        />
        <div className="ecran__corps">
          <article className="carnet">
            <div>
              <div className="carnet__boutique">{ouvert.shopName}</div>
              {ouvert.quartier ? <div className="carnet__quartier">{ouvert.quartier}</div> : null}
            </div>
            <div className="carnet__etiquette">Votre monnaie chez ce commerçant</div>
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
                    <div style={{ fontWeight: 500 }}>{libelle(e)}</div>
                    <div className="discret">
                      {dateCourte(e.created_at)}
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
                      {e.direction === 'credit' ? '+' : '−'}
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
  const total = shops ? informationalTotal(shops) : null;

  return (
    <div className="ecran">
      <Entete
        sousTitre="Votre monnaie chez les commerçants"
        action={<BoutonDiscret onClick={onDeconnexion}>Quitter</BoutonDiscret>}
      />

      <div className="ecran__corps">
        <h1>Ma monnaie</h1>
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {shops === null ? (
          <p className="discret">Chargement…</p>
        ) : shops.length === 0 ? (
          <Message ton="info">
            Vous n'avez pas encore de monnaie enregistrée. Quand un commerçant
            gardera votre monnaie, elle apparaîtra ici.
          </Message>
        ) : (
          <>
            {shops.map((s) => (
              <button
                key={s.vendorId}
                type="button"
                onClick={() => ouvrir(s)}
                className="carnet carnet--cliquable"
                style={{ textAlign: 'left', width: '100%', cursor: 'pointer' }}
              >
                <div>
                  <div className="carnet__boutique">{s.shopName}</div>
                  {s.quartier ? <div className="carnet__quartier">{s.quartier}</div> : null}
                </div>
                <div className="carnet__etiquette">
                  {s.lastActivityAt ? `Dernier mouvement ${dateCourte(s.lastActivityAt)}` : ' '}
                </div>
                <Montant value={s.amountCfa} taille="grand" />
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
        <Version />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function libelle(e: EntryRow): string {
  if (e.kind === 'change') return 'Monnaie gardée';
  if (e.kind === 'purchase') return 'Utilisée pour un achat';
  if (e.kind === 'refund') return 'Remboursée en espèces';
  if (e.kind === 'reversal') {
    return e.direction === 'credit' ? 'Correction en votre faveur' : 'Correction';
  }
  return e.kind;
}

function dateCourte(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
