import { useState } from 'react';
import { Clavier, Cadran, Entete, Message, BoutonPrimaire, BoutonDiscret } from './ui';
import { QrScanner } from './QrScanner';
import { formatPhoneLocal } from '../lib/format';
import { normaliseMsisdn } from '../../supabase/functions/_shared/identity';
import { ClientsRecents } from './ClientsRecents';
import type * as api from '../lib/api';

/**
 * Identifying a customer: scan, or type. Two equal options.
 *
 * NOT a fallback hierarchy. Some vendors will prefer typing and some scanning,
 * and a customer without a smartphone has no QR code at all — so neither way is
 * the "real" one. They sit side by side, the same size, and the vendor's last
 * choice is remembered for the rest of the session so a vendor who always types
 * is not asked twice.
 *
 * A scanned code is treated exactly like typed digits: normalised, validated,
 * and carrying no authority. It identifies; it does not authorise.
 */

const CLE_PREFERENCE = 'sika.saisie.preference';

type Mode = 'choix' | 'scan' | 'clavier';

function preferenceEnregistree(): Mode | null {
  try {
    const v = localStorage.getItem(CLE_PREFERENCE);
    return v === 'scan' || v === 'clavier' ? v : null;
  } catch {
    return null;
  }
}

function retenirPreference(m: Mode) {
  try { localStorage.setItem(CLE_PREFERENCE, m); } catch { /* not important */ }
}

export function SaisieClient({
  titre,
  sousTitre,
  erreur,
  occupe,
  onNumero,
  onRetour,
  recents,
}: {
  titre: string;
  sousTitre?: string;
  erreur?: string | null;
  occupe?: boolean;
  /** Receives a normalised msisdn, never raw keystrokes. */
  onNumero: (msisdn: string) => void;
  onRetour: () => void;
  /**
   * The shortlist, when the caller wants one. Omitted, this behaves exactly as
   * before — typing is never removed, because a new customer has no shortlist
   * entry and that is the case where the full number is the only way in.
   */
  recents?: {
    session: api.Session;
    vendorId: string;
    actorUserId: string;
    onChoisir: (c: api.RecentCustomerRow) => void;
  };
}) {
  const [mode, setMode] = useState<Mode>(() => preferenceEnregistree() ?? 'choix');
  const [numero, setNumero] = useState('');

  function choisir(m: Mode) {
    retenirPreference(m);
    setMode(m);
  }

  function valider() {
    // Normalised here so both paths hand the caller the same shape. The lookup
    // is an exact match on the stored E.164 form, and passing local digits was
    // a real bug once already.
    try {
      onNumero(normaliseMsisdn(numero));
    } catch {
      // The button is disabled below until 10 digits, so this is unreachable in
      // practice; swallowing beats crashing on an unexpected input.
    }
  }

  return (
    <div className="ecran">
      <Entete
        sousTitre={sousTitre}
        action={<BoutonDiscret onClick={onRetour}>Retour</BoutonDiscret>}
      />

      <div className="ecran__corps">
        <h1>{titre}</h1>

        {mode === 'choix' && (
          <>
            <p className="discret">Comment voulez-vous trouver le client ?</p>
            <div className="choix">
              <button type="button" className="choix__option" onClick={() => choisir('clavier')}>
                <span className="choix__icone" aria-hidden="true">⌨</span>
                Taper le numéro
              </button>
              <button type="button" className="choix__option" onClick={() => choisir('scan')}>
                <span className="choix__icone" aria-hidden="true">▣</span>
                Scanner son code
              </button>
            </div>
            <p className="discret">
              Le client trouve son code dans son application, sous « Mon code ».
              S'il n'a pas de téléphone, tapez son numéro.
            </p>
          </>
        )}

        {mode === 'scan' && (
          <QrScanner
            onNumero={onNumero}
            // Refusing the camera or scanning a biscuit packet lands here, and
            // the preference flips so the vendor is not sent back to a camera
            // that does not work on their phone.
            onAbandon={() => choisir('clavier')}
          />
        )}

        {mode === 'clavier' && recents ? (
          <ClientsRecents
            session={recents.session}
            vendorId={recents.vendorId}
            actorUserId={recents.actorUserId}
            onChoisir={recents.onChoisir}
          />
        ) : null}

        {mode === 'clavier' && (
          <>
            <Cadran etiquette="Téléphone du client">
              <span className="montant montant--grand" style={{ color: 'var(--craie)' }}>
                {numero ? formatPhoneLocal(numero) : '—'}
              </span>
            </Cadran>

            {erreur ? <Message ton="erreur">{erreur}</Message> : null}

            <Clavier
              onDigit={(d) => { if (numero.length < 10) setNumero(numero + d); }}
              onEffacer={() => setNumero(numero.slice(0, -1))}
              onToutEffacer={() => setNumero('')}
            />
          </>
        )}

        {mode === 'scan' && erreur ? <Message ton="erreur">{erreur}</Message> : null}
      </div>

      <div className="ecran__pied pile">
        {mode === 'clavier' && (
          <>
            <BoutonPrimaire onClick={valider} disabled={numero.length !== 10 || Boolean(occupe)}>
              {occupe ? 'Recherche…' : 'Continuer'}
            </BoutonPrimaire>
            <BoutonDiscret onClick={() => choisir('scan')}>Scanner son code</BoutonDiscret>
          </>
        )}
        {mode === 'scan' && (
          <BoutonDiscret onClick={() => setMode('choix')}>Changer de méthode</BoutonDiscret>
        )}
      </div>
    </div>
  );
}
