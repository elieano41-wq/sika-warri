import { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import type { Session, ResetRequest, AdminVendor } from '../../lib/api';
import {
  Entete, Message, Montant, BoutonPrimaire, BoutonSecondaire, BoutonDiscret, Version,
} from '../../components/ui';
import { formatPhoneLocal } from '../../lib/format';

/**
 * The operator's panel.
 *
 * Two jobs: work the reset queue while on a phone call, and keep an eye on
 * vendors. Both are gated in SQL by is_admin() — this screen merely fails to
 * load for anyone else, and hiding it would not be access control.
 *
 * The reset queue is laid out for the call itself. Everything needed to
 * challenge an identity is on the card, unfolded, before the button that issues
 * anything: name, quartier, registration date, what they hold and with whom,
 * and the last three movements. A challenge that requires navigating is a
 * challenge that gets skipped under pressure.
 */
type Onglet = 'resets' | 'vendeurs';

export function Admin({
  session,
  onQuitter,
}: {
  session: Session;
  onQuitter: () => void;
}) {
  const [onglet, setOnglet] = useState<Onglet>('resets');
  const [demandes, setDemandes] = useState<ResetRequest[] | null>(null);
  const [vendeurs, setVendeurs] = useState<AdminVendor[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  // The issued code, shown once. Never re-fetchable.
  const [codeEmis, setCodeEmis] = useState<{ code: string; expiresAt: string } | null>(null);

  const charger = useCallback(async () => {
    setErreur(null);
    try {
      if (onglet === 'resets') setDemandes(await api.adminResetQueue(session.accessToken));
      else setVendeurs(await api.adminVendorList(session.accessToken));
    } catch (e) {
      setErreur((e as api.ApiError).message);
    }
  }, [onglet, session.accessToken]);

  useEffect(() => { charger(); }, [charger]);

  async function emettre(requestId: string) {
    setOccupe(true);
    setErreur(null);
    try {
      const r = await api.adminIssueReset(session.accessToken, requestId);
      setCodeEmis({ code: r.code, expiresAt: r.expiresAt });
      await charger();
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  async function rejeter(requestId: string) {
    setOccupe(true);
    try {
      await api.adminRejectReset(session.accessToken, requestId);
      await charger();
    } catch (e) {
      setErreur((e as api.ApiError).message);
    } finally {
      setOccupe(false);
    }
  }

  // ---- the issued code, shown exactly once -------------------------------
  if (codeEmis) {
    return (
      <div className="ecran">
        <Entete sousTitre="Support" />
        <div className="ecran__corps">
          <h1>Lisez ce code</h1>
          <Cadre code={codeEmis.code} />
          <Message ton="erreur">
            Ce code ne sera plus jamais affiché. Il expire à{' '}
            {new Date(codeEmis.expiresAt).toLocaleTimeString('fr-FR', {
              hour: '2-digit', minute: '2-digit',
            })}
            .
          </Message>
          <p className="discret">
            Dites-lui d'ouvrir « J'ai oublié mon code », d'entrer son numéro puis
            ce code, et de choisir lui-même son nouveau code. Ne lui demandez
            jamais son ancien code.
          </p>
        </div>
        <div className="ecran__pied pile">
          <BoutonPrimaire onClick={() => setCodeEmis(null)}>
            J'ai lu le code au téléphone
          </BoutonPrimaire>
        </div>
      </div>
    );
  }

  return (
    <div className="ecran">
      <Entete
        sousTitre="Support Sika Warri"
        action={<BoutonDiscret onClick={onQuitter}>Quitter</BoutonDiscret>}
      />

      <div className="ecran__corps">
        <div className="choix">
          <button
            type="button"
            className={`bouton ${onglet === 'resets' ? 'bouton--primaire' : 'bouton--secondaire'}`}
            style={{ fontSize: 'var(--texte-base)', minHeight: 'var(--cible-min)' }}
            onClick={() => setOnglet('resets')}
          >
            Réinitialisations
          </button>
          <button
            type="button"
            className={`bouton ${onglet === 'vendeurs' ? 'bouton--primaire' : 'bouton--secondaire'}`}
            style={{ fontSize: 'var(--texte-base)', minHeight: 'var(--cible-min)' }}
            onClick={() => setOnglet('vendeurs')}
          >
            Commerçants
          </button>
        </div>

        {erreur ? <Message ton="erreur">{erreur}</Message> : null}

        {onglet === 'resets' && (
          <>
            <h1>Demandes de code</h1>
            {demandes === null ? (
              <p className="discret">Chargement…</p>
            ) : demandes.length === 0 ? (
              <Message ton="info">Aucune demande en attente.</Message>
            ) : (
              demandes.map((d) => (
                <article key={d.request_id} className="carnet">
                  <div>
                    <div className="carnet__boutique">
                      {d.nom ?? 'Compte inconnu'}
                    </div>
                    <div className="carnet__quartier">
                      {formatPhoneLocal(d.phone)}
                      {d.quartier ? ` · ${d.quartier}` : ''}
                    </div>
                  </div>

                  {!d.account_exists ? (
                    // No account for this number. Nothing to issue, and the
                    // caller should be told nothing beyond that.
                    <Message ton="erreur">
                      Aucun compte pour ce numéro. Ne donnez aucun code.
                    </Message>
                  ) : (
                    <>
                      <div className="carnet__etiquette">
                        {d.role === 'vendor' ? 'Commerçant' : 'Client'} · inscrit le{' '}
                        {d.registered_at
                          ? new Date(d.registered_at).toLocaleDateString('fr-FR')
                          : '—'}
                      </div>

                      {/* The challenge material, unfolded. */}
                      <div className="pile" style={{ gap: 'var(--espace-2)' }}>
                        <div className="discret">
                          {d.role === 'vendor' ? 'Son activité' : 'Sa monnaie'} :{' '}
                          {d.contexte ?? '—'}
                        </div>
                        <div className="discret">Trois derniers mouvements :</div>
                        <ul style={{ listStyle: 'none' }} className="pile">
                          {(d.derniers ?? []).length === 0 ? (
                            <li className="discret">aucun mouvement</li>
                          ) : (
                            (d.derniers ?? []).map((l, i) => (
                              <li
                                key={i}
                                className="montant"
                                style={{ fontSize: 'var(--texte-base)' }}
                              >
                                {l}
                              </li>
                            ))
                          )}
                        </ul>
                      </div>

                      {d.prior_resets > 0 ? (
                        <Message ton="erreur">
                          Ce numéro a déjà eu {d.prior_resets} réinitialisation(s).
                          Posez plus de questions.
                        </Message>
                      ) : null}

                      <p className="discret">
                        Demandez un détail de ces mouvements AVANT d'émettre.
                      </p>
                    </>
                  )}

                  <div className="pile" style={{ gap: 'var(--espace-3)' }}>
                    {d.account_exists ? (
                      <BoutonPrimaire onClick={() => emettre(d.request_id)} disabled={occupe}>
                        {occupe ? 'Émission…' : 'Émettre un code temporaire'}
                      </BoutonPrimaire>
                    ) : null}
                    <BoutonSecondaire onClick={() => rejeter(d.request_id)} disabled={occupe}>
                      Rejeter
                    </BoutonSecondaire>
                  </div>
                </article>
              ))
            )}
          </>
        )}

        {onglet === 'vendeurs' && (
          <>
            <h1>Commerçants</h1>
            {vendeurs === null ? (
              <p className="discret">Chargement…</p>
            ) : vendeurs.length === 0 ? (
              <Message ton="info">Aucun commerçant inscrit.</Message>
            ) : (
              vendeurs.map((v) => (
                <article key={v.vendor_id} className="carnet">
                  <div>
                    <div className="carnet__boutique">{v.business_name}</div>
                    <div className="carnet__quartier">
                      {v.quartier} · {formatPhoneLocal(v.phone)}
                    </div>
                  </div>

                  <div className="carnet__etiquette">
                    {v.phone_verified_at
                      ? `Vérifié (${v.verification_method === 'in_person' ? 'en personne' : 'SMS'})`
                      : 'NON VÉRIFIÉ'}
                    {v.is_active ? '' : ' · DÉSACTIVÉ'}
                    {' · inscrit le '}
                    {new Date(v.joined_at).toLocaleDateString('fr-FR')}
                  </div>

                  <Montant value={v.circulation_cfa} taille="grand" />
                  <div className="discret">
                    {v.customers_owed} client(s) · {v.entry_count} écriture(s)
                  </div>

                  {/* The fraud signal, inline. On its own screen it would not
                      get looked at. */}
                  <div className="discret">
                    Débits : {v.debits} · sur son appareil : {v.vendor_device_debits}
                    {v.vendor_device_pct !== null ? ` (${v.vendor_device_pct} %)` : ''}
                    {v.vendor_corrections > 0 ? ` · corrections : ${v.vendor_corrections}` : ''}
                  </div>
                  {v.vendor_device_pct !== null && v.vendor_device_pct >= 50 && v.debits >= 5 ? (
                    // A signal, not a verdict: a vendor serving customers without
                    // smartphones looks exactly like one harvesting PINs.
                    <Message ton="erreur">
                      Beaucoup de codes saisis sur son appareil. À regarder.
                    </Message>
                  ) : null}

                  <div className="pile" style={{ gap: 'var(--espace-3)' }}>
                    {!v.phone_verified_at ? (
                      <BoutonPrimaire
                        onClick={async () => {
                          setOccupe(true);
                          try {
                            await api.adminVerifyPhone(
                              session.accessToken, 'vendor', v.vendor_id, 'in_person'
                            );
                            await charger();
                          } catch (e) {
                            setErreur((e as api.ApiError).message);
                          } finally {
                            setOccupe(false);
                          }
                        }}
                        disabled={occupe}
                      >
                        Vérifié en personne
                      </BoutonPrimaire>
                    ) : null}
                    <BoutonSecondaire
                      onClick={async () => {
                        setOccupe(true);
                        try {
                          await api.adminSetVendorActive(
                            session.accessToken, v.vendor_id, !v.is_active
                          );
                          await charger();
                        } catch (e) {
                          setErreur((e as api.ApiError).message);
                        } finally {
                          setOccupe(false);
                        }
                      }}
                      disabled={occupe}
                    >
                      {v.is_active ? 'Désactiver' : 'Réactiver'}
                    </BoutonSecondaire>
                  </div>
                </article>
              ))
            )}
          </>
        )}
      </div>

      <div className="ecran__pied pile">
        <BoutonSecondaire onClick={charger}>Rafraîchir</BoutonSecondaire>
        <Version />
      </div>
    </div>
  );
}

/** The temporary code, big enough to read down a phone line without squinting. */
function Cadre({ code }: { code: string }) {
  return (
    <div className="cadran">
      <div className="cadran__etiquette">Code temporaire</div>
      <span className="montant montant--geant">{code}</span>
    </div>
  );
}
