/**
 * Preview entry. Throwaway, not shipped, not imported by the app.
 *
 * It renders the real Accueil component against the real stylesheet, with the
 * network stubbed at fetch. Everything visual is therefore true: the tokens, the
 * spacing scale, the tabular amounts, the collapse of an empty cell. Only the
 * figures are fabricated.
 *
 * Four scenarios, because the interesting question about a 2x2 is not how it
 * looks full — it is how it looks when three of the four cells are empty, which
 * is the common case and the one a screenshot of seed data never shows.
 */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import './styles/tokens.css';
import './styles/base.css';
import { Accueil } from './screens/Accueil';
import { MesClients } from './screens/vendeur/MesClients';
import { MesDettes } from './screens/vendeur/MesDettes';
import type { VendorProfile } from './lib/api';
import { Navigation, IconeBoutique, IconeClients, IconeMonnaie, IconeCompte } from './components/Navigation';
import type { Session } from './lib/api';

type Cas =
  | 'tout' | 'seulement-dettes' | 'seulement-monnaie' | 'vide'
  // The two list screens, for the poster. Rendered here rather than screenshot
  // from the test project, whose accounts are all called TEST-Boutique — real
  // names are the difference between a product shot and a bug report.
  | 'sikatigi' | 'juru';

const CAS: Partial<Record<Cas, Record<string, number>>> = {
  // A shop that also owes: all four registers live.
  tout: {
    garde_cfa: 12400, garde_personnes: 9,
    je_dois_cfa: 3500, je_dois_creanciers: 2,
    garde_pour_moi_cfa: 1500, garde_pour_moi_carnets: 3,
    on_me_doit_cfa: 47500, on_me_doit_debiteurs: 6,
    on_me_doit_vieux_cfa: 8900, reclamations_ouvertes: 1, a_verifier: 2,
  },
  // The case the old app could not serve at all: somebody who only keeps a note
  // of what people owe them. One cell.
  'seulement-dettes': {
    garde_cfa: 0, garde_personnes: 0,
    je_dois_cfa: 0, je_dois_creanciers: 0,
    garde_pour_moi_cfa: 0, garde_pour_moi_carnets: 0,
    on_me_doit_cfa: 6000, on_me_doit_debiteurs: 1,
    on_me_doit_vieux_cfa: 0, reclamations_ouvertes: 0, a_verifier: 0,
  },
  // The old customer: change held for them, nothing else.
  'seulement-monnaie': {
    garde_cfa: 0, garde_personnes: 0,
    je_dois_cfa: 800, je_dois_creanciers: 1,
    garde_pour_moi_cfa: 1100, garde_pour_moi_carnets: 1,
    on_me_doit_cfa: 0, on_me_doit_debiteurs: 0,
    on_me_doit_vieux_cfa: 0, reclamations_ouvertes: 0, a_verifier: 1,
  },
  vide: {
    garde_cfa: 0, garde_personnes: 0, je_dois_cfa: 0, je_dois_creanciers: 0,
    garde_pour_moi_cfa: 0, garde_pour_moi_carnets: 0, on_me_doit_cfa: 0,
    on_me_doit_debiteurs: 0, on_me_doit_vieux_cfa: 0,
    reclamations_ouvertes: 0, a_verifier: 0,
  },
};

/** Rows for the two lists. Ordinary Abidjan names, ordinary amounts. */
const SIKATIGI = [
  { customer_id: '1', phone: '2250701020304', your_label: 'Konan K.', balance_cfa: 4200,
    last_activity_at: new Date().toISOString(), entry_count: 6, is_registered: true, total_count: 5 },
  { customer_id: '2', phone: '2250506070809', your_label: 'Aya T.', balance_cfa: 3500,
    last_activity_at: new Date(Date.now() - 864e5).toISOString(), entry_count: 4, is_registered: true, total_count: 5 },
  { customer_id: '3', phone: '2250712131415', your_label: 'Le monsieur du taxi', balance_cfa: 2200,
    last_activity_at: new Date(Date.now() - 3 * 864e5).toISOString(), entry_count: 2, is_registered: false, total_count: 5 },
  { customer_id: '4', phone: '2250598765432', your_label: 'Mariam', balance_cfa: 1500,
    last_activity_at: new Date(Date.now() - 5 * 864e5).toISOString(), entry_count: 3, is_registered: true, total_count: 5 },
  { customer_id: '5', phone: '2250101223344', your_label: 'Ibrahim', balance_cfa: 1000,
    last_activity_at: new Date(Date.now() - 8 * 864e5).toISOString(), entry_count: 1, is_registered: true, total_count: 5 },
];

const bucket = (n: number, j: number) => ({
  bucket_0_7: j <= 7 ? n : 0,
  bucket_8_30: j > 7 && j <= 30 ? n : 0,
  bucket_31_90: j > 30 && j <= 90 ? n : 0,
  bucket_90: j > 90 ? n : 0,
  oldest_days: j,
  over_30_cfa: j > 30 ? n : 0,
});

const JURU = [
  { customer_id: '1', phone: '2250701020304', your_label: 'Konan K.', is_registered: true,
    debt_cfa: 18000, confirmed_cfa: 18000, declared_cfa: 0, disputed_cfa: 0, ...bucket(18000, 44),
    last_settled_at: null, open_claim: false, last_activity_at: new Date(Date.now() - 44 * 864e5).toISOString(),
    entry_count: 3, total_count: 6 },
  { customer_id: '2', phone: '2250506070809', your_label: 'Aya T.', is_registered: true,
    debt_cfa: 12500, confirmed_cfa: 6500, declared_cfa: 6000, disputed_cfa: 0, ...bucket(12500, 12),
    last_settled_at: null, open_claim: false, last_activity_at: new Date(Date.now() - 12 * 864e5).toISOString(),
    entry_count: 4, total_count: 6 },
  { customer_id: '3', phone: '2250712131415', your_label: 'Garage Sud', is_registered: true,
    debt_cfa: 9000, confirmed_cfa: 9000, declared_cfa: 0, disputed_cfa: 0, ...bucket(9000, 3),
    last_settled_at: null, open_claim: false, last_activity_at: new Date().toISOString(),
    entry_count: 2, total_count: 6 },
  { customer_id: '4', phone: '2250598765432', your_label: 'Mariam', is_registered: true,
    debt_cfa: 8000, confirmed_cfa: 0, declared_cfa: 8000, disputed_cfa: 0, ...bucket(8000, 20),
    last_settled_at: null, open_claim: true, last_activity_at: new Date(Date.now() - 20 * 864e5).toISOString(),
    entry_count: 1, total_count: 6 },
];

const RESUME_DETTE = {
  debt_cfa: 47500, debtors: 6, confirmed_cfa: 33500, declared_cfa: 14000,
  disputed_cfa: 0, disputed_count: 0, over_30_cfa: 18000, oldest_days: 44,
  settled_count: 4, ageing_count: 2, open_claims: 1,
};

const RESUME_MONNAIE = {
  circulation_cfa: 12400, customers_owed: 9,
  today_credit_cfa: 2300, today_credit_count: 4,
  today_debit_cfa: 1100, today_debit_count: 2,
  last_activity_at: new Date().toISOString(),
};

let actuel: Cas = (new URLSearchParams(location.search).get('cas') as Cas) ?? 'tout';

// Stub only the one call this screen makes. Anything else still fails loudly,
// so a screen that quietly started fetching something new would be visible.
const vrai = window.fetch;
window.fetch = (async (url: any, init: any) => {
  const j = (data: unknown) =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const u = String(url);
  if (u.includes('account_summary')) return j([CAS[actuel] ?? CAS.tout]);
  if (u.includes('vendor_customers')) return j(SIKATIGI);
  if (u.includes('vendor_debtors')) return j(JURU);
  if (u.includes('vendor_debt_summary')) return j([RESUME_DETTE]);
  if (u.includes('vendor_home_summary')) return j([RESUME_MONNAIE]);
  return vrai(url, init);
}) as typeof window.fetch;

const VENDEUR: VendorProfile = {
  id: 'v1',
  authUserId: '00000000-0000-0000-0000-000000000000',
  businessName: 'Chez Awa',
  quartier: 'Yopougon',
  maxBalancePerCustomer: 3000,
  maxDebtPerCustomer: 10000,
  termsAcceptedAt: new Date().toISOString(),
};

const SESSION: Session = {
  accessToken: 'apercu',
  refreshToken: 'apercu',
  msisdn: '2250797999085',
};

const ONGLETS = [
  { cle: 'accueil' as const, etiquette: 'Accueil', icone: IconeBoutique },
  { cle: 'jegarde' as const, etiquette: 'Je garde', icone: IconeClients },
  { cle: 'onmedoit' as const, etiquette: 'On me doit', icone: IconeMonnaie },
  { cle: 'compte' as const, etiquette: 'Compte', icone: IconeCompte },
];

function Apercu() {
  const [cas, setCas] = useState<Cas>(actuel);
  const rien = () => {};

  return (
    <>
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 99, display: 'flex', gap: 4, padding: 4, background: '#000' }}>
        {(Object.keys(CAS) as Cas[]).map((c) => (
          <button
            key={c}
            onClick={() => { actuel = c; setCas(c); }}
            style={{
              flex: 1, fontSize: 10, padding: '4px 2px',
              background: c === cas ? '#C9A227' : '#14503A',
              color: c === cas ? '#071F17' : '#F4F1E8',
            }}
          >
            {c}
          </button>
        ))}
      </div>

      <div key={cas} style={{ paddingTop: 26 }}>
        {cas === 'sikatigi' ? (
          <MesClients session={SESSION} vendeur={VENDEUR} />
        ) : cas === 'juru' ? (
          <MesDettes session={SESSION} vendeur={VENDEUR} />
        ) : (
        <Accueil
          session={SESSION}
          actorUserId="00000000-0000-0000-0000-000000000000"
          nom="Chez Awa"
          quartier="Yopougon"
          onGarder={rien}
          onUtiliser={rien}
          onNoterDette={rien}
          onJeGarde={rien}
          onOnMeDoit={rien}
          onMesCarnets={rien}
          onHistorique={rien}
          onMonCode={rien}
          onCorriger={rien}
          onVerifier={rien}
        />
        )}
      </div>

      <Navigation onglets={ONGLETS} actif="accueil" onChoisir={rien} />
    </>
  );
}

createRoot(document.getElementById('racine')!).render(<Apercu />);
