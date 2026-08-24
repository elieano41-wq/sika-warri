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
import { Navigation, IconeBoutique, IconeClients, IconeMonnaie, IconeCompte } from './components/Navigation';
import type { Session } from './lib/api';

type Cas = 'tout' | 'seulement-dettes' | 'seulement-monnaie' | 'vide';

const CAS: Record<Cas, Record<string, number>> = {
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

let actuel: Cas = (new URLSearchParams(location.search).get('cas') as Cas) ?? 'tout';

// Stub only the one call this screen makes. Anything else still fails loudly,
// so a screen that quietly started fetching something new would be visible.
const vrai = window.fetch;
window.fetch = (async (url: any, init: any) => {
  if (String(url).includes('account_summary')) {
    return new Response(JSON.stringify([CAS[actuel]]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return vrai(url, init);
}) as typeof window.fetch;

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
      </div>

      <Navigation onglets={ONGLETS} actif="accueil" onChoisir={rien} />
    </>
  );
}

createRoot(document.getElementById('racine')!).render(<Apercu />);
