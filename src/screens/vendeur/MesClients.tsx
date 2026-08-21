import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, VendorProfile, ClientRow, EntryRow } from '../../lib/api';
import {
  Entete, Message, Montant, BoutonSecondaire, BoutonDiscret,
} from '../../components/ui';
import { formatCfa, formatPhoneLocal } from '../../lib/format';
import { vendorInCirculation } from '../../lib/balances';

/**
 * Mes clients — who this vendor owes.
 *
 * The gap this fills: the only way to reach a customer was typing their number
 * inside "Utiliser la monnaie", so a vendor had no way to see their own book.
 * Knowing what you owe, and to whom, is the first thing a shopkeeper needs —
 * before recording anything else.
 *
 * Sorted by amount, largest first, because that is the order that matters when
 * money is owed. Searchable by number or by the label this vendor gave them.
 */
export function MesClients({
  session,
  vendeur,
  onTermine,
}: {
  session: Session;
  vendeur: VendorProfile;
  onTermine: () => void;
}) {
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [recherche, setRecherche] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState<ClientRow | null>(null);
  const [histoire, setHistoire] = useState<EntryRow[] | null>(null);

  const charger = useCallback(async () => {
    try {
      setClients(await api.myClients(session.accessToken, vendeur.id, vendeur.authUserId));
      setErreur(null);
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }, [session.accessToken, vendeur.id, vendeur.authUserId]);

  useEffect(() => { charger(); }, [charger]);

  const filtres = useMemo(() => {
    if (!clients) return null;
    const q = recherche.replace(/\D+/g, '');
    const texte = recherche.trim().toLowerCase();

    return clients.filter((c) => {
      if (recherche.trim() === '') return true;
      // Digits typed match the number; letters match this vendor's own label.
      if (q.length > 0 && c.phone.includes(q)) return true;
      if (texte.length > 0 && (c.your_label ?? '').toLowerCase().includes(texte)) return true;
      return false;
    });
  }, [clients, recherche]);

  async function ouvrir(c: ClientRow) {
    setOuvert(c);
    setHistoire(null);
    try {
      setHistoire(
        await api.clientHistory(
          session.accessToken, vendeur.id, c.customer_id, vendeur.authUserId
        )
      );
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }

  // ---- one customer ------------------------------------------------------
  if (ouvert) {
    return (
      <div className="ecran">
        <Entete
          sousTitre={vendeur.businessName}
          action={<BoutonDiscret onClick={() => setOuvert(null)}>Retour</BoutonDiscret>}
        />
        <div className="ecran__corps">
          <article className="carnet">
            <div>
              <div className="carnet__boutique">
                {ouvert.your_label ?? formatPhoneLocal(ouvert.phone)}
              </div>
              <div className="carnet__quartier">{formatPhoneLocal(ouvert.phone)}</div>
            </div>
            <div className="carnet__etiquette">Monnaie de ce client chez vous</div>
            <Montant value={ouvert.balance_cfa} taille="geant" />
          </article>

          {!ouvert.is_registered ? (
            <Message ton="info">
              Ce client n'a pas encore de compte. Il ne pourra pas confirmer sur
              son téléphone tant qu'il ne s'est pas inscrit.
            </Message>
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
                    <div style={{ fontWeight: 500 }}>{libelle(e)}</div>
                    <div className="discret">
                      {dateCourte(e.created_at)} · reçu {e.receipt_code}
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
            Tous mes clients
          </BoutonSecondaire>
        </div>
      </div>
    );
  }

  // ---- the list ----------------------------------------------------------
  //
  // The vendor's own total IS meaningful and is not what rule 1 forbids: it is
  // one shopkeeper's own liability in their own shop, not a customer's change
  // pooled across shops. "Monnaie en circulation" is the spec's own wording.
  const { totalCfa: enCirculation, customerCount: avecSolde } =
    vendorInCirculation(clients ?? []);

  return (
    <div className="ecran">
      <Entete
        sousTitre={vendeur.businessName}
        action={<BoutonDiscret onClick={onTermine}>Retour</BoutonDiscret>}
      />

      <div className="ecran__corps">
        <h1>Mes clients</h1>
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        <div className="cadran">
          <div className="cadran__etiquette">Monnaie en circulation</div>
          {/*
            While loading, show a placeholder rather than 0 F. A vendor glancing
            at this screen mid-load would otherwise read "0 F · 0 clients" as
            owing nothing at all — a wrong answer presented as confidently as a
            right one. An honest "—" is better than a fast lie.
          */}
          {clients === null ? (
            <>
              <span className="montant montant--grand" style={{ color: 'var(--sauge)' }}>
                —
              </span>
              <div className="discret">Chargement…</div>
            </>
          ) : (
            <>
              <Montant value={enCirculation} taille="grand" />
              <div className="discret">
                {avecSolde} client{avecSolde === 1 ? '' : 's'} concerné
                {avecSolde === 1 ? '' : 's'}
              </div>
            </>
          )}
        </div>

        <label className="champ">
          <span className="champ__etiquette">Chercher un numéro ou un nom</span>
          <input
            className="champ__saisie"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            inputMode="search"
            autoComplete="off"
            placeholder="07 01 02 …"
          />
        </label>

        {filtres === null ? (
          <p className="discret">Chargement…</p>
        ) : filtres.length === 0 ? (
          <Message ton="info">
            {clients && clients.length === 0
              ? "Vous n'avez encore gardé la monnaie de personne."
              : 'Aucun client ne correspond à cette recherche.'}
          </Message>
        ) : (
          <ul className="pile" style={{ listStyle: 'none' }}>
            {filtres.map((c) => (
              <li key={c.customer_id}>
                <button
                  type="button"
                  onClick={() => ouvrir(c)}
                  className="ligne-client"
                  style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 'var(--texte-grand)' }}>
                      {c.your_label ?? formatPhoneLocal(c.phone)}
                    </div>
                    <div className="discret">
                      {formatPhoneLocal(c.phone)}
                      {c.is_registered ? '' : ' · sans compte'}
                    </div>
                  </div>
                  <Montant value={c.balance_cfa} taille="ligne" />
                </button>
              </li>
            ))}
          </ul>
        )}
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
    return e.direction === 'credit' ? 'Correction en faveur du client' : 'Correction';
  }
  return e.kind;
}

function dateCourte(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
