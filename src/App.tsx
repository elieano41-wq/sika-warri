import { useEffect, useState } from 'react';
import * as api from './lib/api';
import type { Session, VendorProfile, CustomerProfile } from './lib/api';
import { Bienvenue } from './screens/Bienvenue';
import { Connexion } from './screens/Connexion';
import { Inscription } from './screens/Inscription';
import { ResetPin } from './screens/ResetPin';
import { Admin } from './screens/admin/Admin';
import { GarderLaMonnaie } from './screens/vendeur/GarderLaMonnaie';
import { UtiliserLaMonnaie } from './screens/vendeur/UtiliserLaMonnaie';
import { Espace } from './screens/Espace';
import { MesClients } from './screens/vendeur/MesClients';
import { AccueilVendeur } from './screens/vendeur/Accueil';
import { Historique as HistoriqueVendeur } from './screens/vendeur/Historique';
import { MesDettes } from './screens/vendeur/MesDettes';
import { Corriger } from './screens/vendeur/Corriger';
import { NoterUneDette } from './screens/vendeur/NoterUneDette';
import { Compte, ChangerCode } from './screens/Compte';
import {
  Navigation, IconeBoutique, IconeClients, IconeHistorique, IconeCompte,
  type Onglet,
} from './components/Navigation';
import { Entete, Message, BoutonSecondaire } from './components/ui';

const CLE_SESSION = 'sika.session';

/** Sessions survive a reload: a vendor should not re-enter a PIN all day. */
function chargerSession(): Session | null {
  try {
    const brut = localStorage.getItem(CLE_SESSION);
    return brut ? (JSON.parse(brut) as Session) : null;
  } catch {
    // Private mode, cleared site data, or storage disabled. Not an error —
    // the user simply logs in again.
    return null;
  }
}

function enregistrerSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(CLE_SESSION, JSON.stringify(s));
    else localStorage.removeItem(CLE_SESSION);
  } catch {
    /* nothing to do; the session just will not persist */
  }
}

/**
 * The vendor's four destinations, and separately the tasks.
 *
 * A task is not a destination: recording change and spending it begin, end, and
 * must not offer a tab-switch halfway through, because a vendor who taps away
 * from a half-recorded entry has lost it. So they live in `tache` and the tab bar
 * disappears while one is open. Accueil is where both are started, which is why
 * there is no fifth tab for them.
 */
type OngletVendeur = 'accueil' | 'clients' | 'dettes' | 'compte';

/**
 * A destination without a tab, reached from Accueil.
 *
 * Distinct from a Tache: a task is a transaction that must not be abandoned
 * halfway, so the bar disappears for it. This is just a screen further in, and
 * the bar stays.
 */
type SousVue = null | 'historique' | 'corriger';
type Tache = null | 'garder' | 'utiliser' | 'code' | 'dette';

const ONGLETS_VENDEUR: Array<Onglet<OngletVendeur>> = [
  { cle: 'accueil', etiquette: 'Accueil', icone: IconeBoutique },
  { cle: 'clients', etiquette: 'Mes clients', icone: IconeClients },
  { cle: 'dettes', etiquette: 'Dettes', icone: IconeHistorique },
  { cle: 'compte', etiquette: 'Compte', icone: IconeCompte },
];
type Porte = 'bienvenue' | 'connexion' | 'inscription' | 'oubli';

export default function App() {
  const [session, setSession] = useState<Session | null>(chargerSession);
  const [vendeur, setVendeur] = useState<VendorProfile | null>(null);
  const [client, setClient] = useState<CustomerProfile | null>(null);
  const [onglet, setOnglet] = useState<OngletVendeur>('accueil');
  const [tache, setTache] = useState<Tache>(null);
  const [sousVue, setSousVue] = useState<SousVue>(null);
  const [avis, setAvis] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(false);
  // First-time visitors land on Bienvenue; anyone with a session skips it.
  const [porte, setPorte] = useState<Porte>('bienvenue');
  // Whether this session is an admin is decided by the SERVER, and asked ON LOAD
  // rather than carried from the login response.
  //
  // It used to be set once at login and held here. A grant made while someone
  // was logged in stayed invisible until they happened to log out, and a page
  // reload restored the session but reset this to false — so the support panel
  // was missing for an account that had held the grant the whole time, with
  // "log out and back in" as the undiscoverable workaround.
  //
  // Hiding the button was never the control: every admin action is gated again
  // in SQL, so a wrong answer here changes what is visible and nothing else.
  const [estAdmin, setEstAdmin] = useState(false);
  const [vueAdmin, setVueAdmin] = useState(false);

  // Hand the live session to the API layer so an expired access token renews
  // itself instead of surfacing as "Une erreur est survenue, réessayez" an hour
  // into the day. Declared BEFORE the profile effect so the plumbing is in
  // place by the time the first request goes out — effects run in order.
  useEffect(() => {
    api.brancherSession(session, (renouvelee) => {
      setSession(renouvelee);
      enregistrerSession(renouvelee);
    });
  }, [session]);

  // Resolve the profile behind the session. A stored token that no longer
  // works logs the user out rather than leaving a half-loaded screen.
  useEffect(() => {
    if (!session) {
      setVendeur(null);
      setClient(null);
      return;
    }

    let annule = false;
    setChargement(true);

    (async () => {
      try {
        // BOTH halves, and neither is fatal on its own. One account has a
        // vendors row and a customers row since 0042; an account created before
        // it has only one, and it must still be able to open its own app.
        // Fetched in parallel and settled rather than awaited in sequence, so a
        // missing half costs nothing and a slow one does not gate the other.
        const [rv, rc] = await Promise.allSettled([
          api.myVendor(session.accessToken),
          api.myCustomer(session.accessToken),
        ]);
        if (annule) return;

        const v = rv.status === 'fulfilled' ? rv.value : null;
        const c = rc.status === 'fulfilled' ? rc.value : null;

        if (!v && !c) {
          // Neither half. Either the token is dead or this is not an account,
          // and the two are told apart by the status underneath.
          // Both rejected, so both carry a reason. Narrowed explicitly rather
          // than asserted: the vendors side is reported first because its
          // failure is the one that means "no account at all".
          if (rv.status === 'rejected') throw rv.reason;
          if (rc.status === 'rejected') throw rc.reason;
          throw new api.ApiError('NO_PROFILE', 'Compte introuvable', 404);
        }

        setVendeur(v);
        setClient(c);

        // Asked here rather than at login, so a reload and a fresh grant both
        // pick it up without anyone signing out.
        const idActeur = v?.authUserId ?? c?.authUserId;
        if (idActeur) {
          setEstAdmin(await api.amIAdmin(session.accessToken, idActeur));
        }
      } catch (e) {
        if (annule) return;
        const err = e as api.ApiError;
        if (err.status === 401 || err.status === 403) {
          deconnexion();
          setErreur('Session expirée. Reconnectez-vous.');
        } else {
          setErreur(err.message);
        }
      } finally {
        if (!annule) setChargement(false);
      }
    })();

    return () => { annule = true; };
  }, [session]);

  function inscrit(s: Session) {
    setPorte('bienvenue');
    // A brand-new account is never an admin.
    connexion(s, null, false);
  }

  function connexion(s: Session, notice: string | null, admin = false) {
    // Seeded from the login response so the button is there immediately, then
    // confirmed by the load effect. Both agree; the effect is what survives a
    // reload.
    setEstAdmin(admin);
    setErreur(null);
    setAvis(notice);
    setSession(s);
    enregistrerSession(s);
    setOnglet('accueil');
    setTache(null);
    setSousVue(null);
  }

  function deconnexion() {
    setEstAdmin(false);
    setVueAdmin(false);
    setTache(null);
    setSousVue(null);
    setSession(null);
    setVendeur(null);
    setClient(null);
    setAvis(null);
    enregistrerSession(null);
  }

  if (!session && porte === 'bienvenue') {
    return (
      <Bienvenue
        onConnexion={() => setPorte('connexion')}
        onInscription={() => setPorte('inscription')}
      />
    );
  }

  if (!session && porte === 'oubli') {
    return <ResetPin onTermine={() => setPorte('connexion')} />;
  }

  if (!session && porte === 'inscription') {
    return <Inscription onInscrit={inscrit} onRetour={() => setPorte('bienvenue')} />;
  }

  if (!session) {
    return (
      <>
        {erreur ? (
          <div className="ecran" style={{ minHeight: 'auto', paddingBottom: 0 }}>
            <Message ton="erreur">{erreur}</Message>
          </div>
        ) : null}
        <Connexion
          onConnecte={connexion}
          onInscription={() => setPorte('inscription')}
          onCodeOublie={() => setPorte('oubli')}
        />
      </>
    );
  }

  if (chargement && !vendeur && !client) {
    return (
      <div className="ecran">
        <Entete />
        <div className="ecran__corps centre" style={{ justifyContent: 'center' }}>
          <p className="discret">Chargement…</p>
        </div>
      </div>
    );
  }

  if (vueAdmin && estAdmin) {
    return <Admin session={session} onQuitter={() => setVueAdmin(false)} />;
  }

  // ---- ONE SHELL ---------------------------------------------------------
  // There is no longer a branch here. Which side of a carnet somebody is on is
  // a property of that carnet, not of their account, so there is nothing for
  // this router to choose between.
  if (!vendeur && !client) {
    return (
      <div className="ecran">
        <Entete />
        <div className="ecran__corps">
          <Message ton="erreur">{erreur ?? 'Compte introuvable.'}</Message>
          <BoutonSecondaire onClick={deconnexion}>Se reconnecter</BoutonSecondaire>
        </div>
      </div>
    );
  }

  return (
    <>
      {avis ? (
        <div className="ecran" style={{ minHeight: 'auto', paddingBottom: 0 }}>
          <Message ton="info">{avis}</Message>
        </div>
      ) : null}
      <Espace
        session={session}
        vendeur={vendeur}
        client={client}
        estAdmin={estAdmin}
        onAdmin={estAdmin ? () => setVueAdmin(true) : undefined}
        onDeconnexion={deconnexion}
      />
    </>
  );
}
