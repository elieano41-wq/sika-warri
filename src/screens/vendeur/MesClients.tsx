import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, VendorProfile, ClientRow, EntryRow } from '../../lib/api';
import { Vide, IconeAucunClient } from '../../components/Vide';
// One source for how a movement is described, shared with the customer's
// screens. It was written three times before this.
import {
  libelleMouvement, signeMouvement, dateCourte, dateEtHeure,
} from '../../lib/mouvements';
import {
  Entete, Message, Montant, BoutonSecondaire, BoutonDiscret, BoutonPrimaire,
} from '../../components/ui';
import { formatCfa, formatPhoneLocal } from '../../lib/format';
import type { VendorSummary } from '../../lib/api';

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
}: {
  session: Session;
  vendeur: VendorProfile;
}) {
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [resume, setResume] = useState<VendorSummary | null>(null);
  const [recherche, setRecherche] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState<ClientRow | null>(null);
  const [histoire, setHistoire] = useState<EntryRow[] | null>(null);
  const [renommer, setRenommer] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const charger = useCallback(async () => {
    try {
      // Two calls on purpose. The LIST is a page — bounded, and it says so. The
      // TOTAL is computed in SQL over every row and returned as one figure.
      // Summing the page would understate what the vendor owes the moment the
      // page stopped being the whole book, and would disagree with the home
      // screen while neither reported an error.
      const [liste, sommaire] = await Promise.all([
        api.myClients(session.accessToken, vendeur.id, vendeur.authUserId),
        api.vendorSummary(session.accessToken, vendeur.id, vendeur.authUserId),
      ]);
      setClients(liste);
      setResume(sommaire);
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
          <article className="carte">
            <div>
              <div className="carte__titre">
                {ouvert.your_label ?? formatPhoneLocal(ouvert.phone)}
              </div>
              <div className="carte__sous">{formatPhoneLocal(ouvert.phone)}</div>
            </div>
            <div className="carte__etiquette">Sa monnaie chez vous</div>
            <Montant value={ouvert.balance_cfa} taille="geant" />
          </article>

          {/* Naming a customer is what makes this screen usable at a counter.
              The label is private to this vendor (amendment F). */}
          <label className="champ">
            <span className="champ__etiquette">Son nom (pour vous seul)</span>
            <input
              className="champ__saisie"
              style={{ fontFamily: 'var(--police-texte)' }}
              value={renommer ?? ouvert.your_label ?? ''}
              onChange={(e) => setRenommer(e.target.value)}
              maxLength={60}
              autoCapitalize="words"
            />
          </label>
          {renommer !== null && renommer !== (ouvert.your_label ?? '') ? (
            <BoutonPrimaire
              onClick={async () => {
                setOccupe(true);
                try {
                  const nouveau = await api.setCustomerLabel(
                    session.accessToken, vendeur.id, ouvert.customer_id,
                    renommer, vendeur.authUserId
                  );
                  setOuvert({ ...ouvert, your_label: nouveau });
                  setRenommer(null);
                  await charger();
                } catch (e) {
                  setErreur((e as api.ApiError).message);
                } finally {
                  setOccupe(false);
                }
              }}
              disabled={occupe}
            >
              {occupe ? 'Enregistrement…' : 'Enregistrer le nom'}
            </BoutonPrimaire>
          ) : null}

          {/* No vendor-vouched reset. A vouching vendor could claim the reset
              themselves and take over the account, defeating amendment H — the
              cooling-off only delayed that. Every reset now goes through the
              support desk, which verifies identity by telephone. */}
          {ouvert.is_registered ? (
            <Message ton="info">
              Ce sikatigi a oublié son code ? Il doit appeler le support Sika Warri
              lui-même. Vous ne pouvez pas réinitialiser son code, et vous ne
              devez jamais le lui demander.
            </Message>
          ) : null}

          {!ouvert.is_registered ? (
            <Message ton="info">
              Ce sikatigi n'a pas encore de compte. Il ne pourra pas confirmer sur
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
                    <div style={{ fontWeight: 500 }}>{libelleMouvement(e)}</div>
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
            Tous mes sikatigi
          </BoutonSecondaire>
        </div>
      </div>
    );
  }

  // ---- the list ----------------------------------------------------------
  //
  // Taken from the server-side aggregate, never from the page. See charger().
  const enCirculation = resume?.circulation_cfa ?? 0;
  const avecSolde = resume?.customers_owed ?? 0;
  // How many the list is actually showing, versus how many exist.
  const total = clients?.[0]?.total_count ?? clients?.length ?? 0;
  const tronque = clients !== null && clients.length < total;

  return (
    <div className="ecran ecran--avec-nav vue">
      <Entete sousTitre={vendeur.businessName} />

      <div className="ecran__corps">
        <h1>Mes sikatigi</h1>
        {/* GLOSSED, ONCE, WHERE THE WORD LIVES.
            Dioula is the language of the market and not of everybody in it, and
            a screen about somebody's money is the wrong place to make them
            guess. One line, and it also states the rule the word encodes: the
            money is theirs, you are only holding it. */}
        <p className="discret">
          Sikatigi : la personne à qui la monnaie appartient. Vous la gardez,
          elle reste à elle.
        </p>
        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        <div className="cadran">
          <div className="cadran__etiquette">Monnaie en circulation</div>
          {/*
            While loading, show a placeholder rather than 0 F. A vendor glancing
            at this screen mid-load would otherwise read "0 F · 0 clients" as
            owing nothing at all — a wrong answer presented as confidently as a
            right one. An honest "—" is better than a fast lie.
          */}
          {clients === null || resume === null ? (
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
                {avecSolde} personne{avecSolde === 1 ? '' : 's'} concernée
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
          clients && clients.length === 0 ? (
            <Vide titre="Aucun client pour le moment" icone={IconeAucunClient}>
              Dès que vous gardez la monnaie de quelqu’un, son nom apparaît ici
              avec ce que vous lui devez.
            </Vide>
          ) : (
            <Message ton="info">
              Personne ne correspond à cette recherche.
            </Message>
          )
        ) : (
          <>
            {/* A truncated list must look truncated. Silently showing the first
                200 of 1 234 is the failure mode this whole audit was about. */}
            {tronque ? (
              <Message ton="info">
                Les {clients?.length} clients qui vous doivent le plus, sur {total}.
                Utilisez la recherche pour trouver les autres.
              </Message>
            ) : null}
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
          </>
        )}
      </div>
    </div>
  );
}
