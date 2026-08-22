import { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, VendorProfile, VendorMovementRow } from '../../lib/api';
import { Entete, Message, BoutonDiscret } from '../../components/ui';
import { Vide, IconeCarnetVide } from '../../components/Vide';
import { formatCfa, formatPhoneLocal } from '../../lib/format';
import { libelleMouvement, signeMouvement, parJour, dateEtHeure } from '../../lib/mouvements';

/**
 * Historique — every movement this vendor has recorded, newest first.
 *
 * The question it answers is "what happened today", which the per-customer view
 * could not: that one needs you to already know which customer to open. A vendor
 * closing up wants the day, not a customer.
 *
 * NO TOTAL AT THE BOTTOM. There is a real temptation to sum the column and call
 * it "today's takings", and it would be wrong twice over. It would mix credits
 * and debits, which are movements in opposite directions and not takings at all;
 * and this list is a bounded page, so the figure would drift from the home
 * screen's the moment there were more than a hundred movements. The figures that
 * ARE totals live on Accueil, aggregated in SQL. This screen is a record.
 *
 * Grouped by day because people remember days.
 */
export function Historique({
  session,
  vendeur,
  onRetour,
}: {
  session: Session;
  vendeur: VendorProfile;
  /**
   * Present when this is reached from Accueil rather than from a tab. It keeps
   * the tab bar — unlike a task, nothing here is half-recorded — but it still
   * needs a way back to where you came from.
   */
  onRetour?: () => void;
}) {
  const [lignes, setLignes] = useState<VendorMovementRow[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const rows = await api.vendorHistory(
        session.accessToken,
        vendeur.authUserId,
        vendeur.id
      );
      setLignes(rows);
      setErreur(null);
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }, [session.accessToken, vendeur.authUserId, vendeur.id]);

  useEffect(() => {
    charger();
  }, [charger]);

  const total = lignes?.[0]?.total_count ?? lignes?.length ?? 0;
  const tronque = lignes !== null && total > lignes.length;

  return (
    <div className="ecran ecran--avec-nav vue">
      <Entete
        sousTitre="Tout ce que vous avez enregistré"
        action={onRetour ? <BoutonDiscret onClick={onRetour}>Retour</BoutonDiscret> : undefined}
      />

      <div className="ecran__corps">
        <h1>Historique</h1>
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {lignes === null ? (
          // Not "aucun mouvement" — we have not asked yet. Saying "none" here
          // would be a claim we cannot support.
          <p className="discret">Chargement…</p>
        ) : lignes.length === 0 ? (
          <Vide titre="Rien pour le moment" icone={IconeCarnetVide}>
            Chaque fois que vous gardez la monnaie d’un client ou qu’il l’utilise,
            le mouvement apparaît ici avec son numéro de reçu.
          </Vide>
        ) : (
          <>
            {tronque ? (
              <Message ton="info">
                Les {lignes.length} mouvements les plus récents sur {total}.
              </Message>
            ) : null}

            {parJour(lignes).map((groupe) => (
              <section key={groupe.jour} className="pile">
                <h2 className="jour">{groupe.etiquette}</h2>
                <ul className="pile" style={{ listStyle: 'none' }}>
                  {groupe.lignes.map((e) => (
                    <li key={e.id} className="ligne-histoire">
                      <div>
                        <div style={{ fontWeight: 500 }}>{libelleMouvement(e)}</div>
                        <div className="discret">
                          {e.customer_label ?? formatPhoneLocal(e.customer_phone)}
                        </div>
                        <div className="discret">
                          {dateEtHeure(e.created_at)} · reçu {e.receipt_code}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span
                          className="montant montant--ligne"
                          style={{
                            color:
                              e.direction === 'credit' ? 'var(--or-sika)' : 'var(--craie)',
                          }}
                        >
                          {signeMouvement(e)}
                          {formatCfa(e.amount_cfa)}
                        </span>
                        {e.confirmation_method === 'vendor_device' ? (
                          // Recorded on the vendor's own phone, so the customer
                          // typed their code on someone else's device. Marked
                          // because amendment I says a degraded confirmation must
                          // never look like a normal one.
                          <div className="discret">code saisi ici</div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
