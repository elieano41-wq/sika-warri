import { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, CustomerProfile, CustomerMovementRow } from '../../lib/api';
import { Entete, Message } from '../../components/ui';
import { Vide, IconeCarnetVide } from '../../components/Vide';
import { formatCfa } from '../../lib/format';
import { libelleMouvement, signeMouvement, parJour, dateEtHeure } from '../../lib/mouvements';

/**
 * Historique — the customer's movements at every shop, newest first.
 *
 * ACCEPTANCE TEST 8 APPLIES HERE TOO, and this screen is where it is easiest to
 * break. A list mixing several vendors is fine; a running total down the side of
 * it is not, because that column would accumulate across vendors and present a
 * single pooled figure — the exact claim standing rule 1 forbids, arrived at one
 * row at a time where it would look like arithmetic rather than an assertion.
 *
 * So there is no running balance and no sum. Every row names its shop, and the
 * amount belongs to that shop alone. The figure that IS a total lives on Ma
 * monnaie, comes from customer_summary, and never appears without the sentence
 * saying it is not spendable as one sum.
 *
 * Why the customer needs this at all: to check a vendor's account of what
 * happened. The receipt code on each row is the thing you can say out loud
 * across a counter.
 */
export function Historique({
  session,
  client,
}: {
  session: Session;
  client: CustomerProfile;
}) {
  const [lignes, setLignes] = useState<CustomerMovementRow[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const rows = await api.myHistory(session.accessToken, client.authUserId);
      setLignes(rows);
      setErreur(null);
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }, [session.accessToken, client.authUserId]);

  useEffect(() => {
    charger();
  }, [charger]);

  const total = lignes?.[0]?.total_count ?? lignes?.length ?? 0;
  const tronque = lignes !== null && total > lignes.length;

  return (
    <div className="ecran ecran--avec-nav vue">
      <Entete sousTitre="Vos mouvements chez chaque commerçant" />

      <div className="ecran__corps">
        <h1>Historique</h1>
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {lignes === null ? (
          <p className="discret">Chargement…</p>
        ) : lignes.length === 0 ? (
          <Vide titre="Rien pour le moment" icone={IconeCarnetVide}>
            Quand un commerçant garde votre monnaie, le mouvement apparaît ici
            avec le nom de la boutique et un numéro de reçu.
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
                        {/* The shop is the point. An amount without the shop it
                            sits at would be a figure the customer cannot use. */}
                        <div className="discret">{e.business_name}</div>
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
                          <div className="discret">code saisi chez le commerçant</div>
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
