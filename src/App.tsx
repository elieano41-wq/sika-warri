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
import { EspaceClient } from './screens/client/EspaceClient';
import { MesClients } from './screens/vendeur/MesClients';
import { AccueilVendeur } from './screens/vendeur/Accueil';
import { Entete, Message, BoutonPrimaire, BoutonSecondaire, BoutonDiscret, Version } from './components/ui';

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

type VueVendeur = 'accueil' | 'garder' | 'utiliser' | 'clients';
type Porte = 'bienvenue' | 'connexion' | 'inscription' | 'oubli';

export default function App() {
  const [session, setSession] = useState<Session | null>(chargerSession);
  const [vendeur, setVendeur] = useState<VendorProfile | null>(null);
  const [client, setClient] = useState<CustomerProfile | null>(null);
  const [vue, setVue] = useState<VueVendeur>('accueil');
  const [avis, setAvis] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(false);
  // First-time visitors land on Bienvenue; anyone with a session skips it.
  const [porte, setPorte] = useState<Porte>('bienvenue');
  // Whether this session is an admin is decided by the SERVER. The client cannot
  // read is_admin, so it probes once: if the queue call succeeds, the entry point
  // appears. A non-admin is simply refused, and hiding a button was never the
  // control anyway.
  const [estAdmin, setEstAdmin] = useState(false);
  const [vueAdmin, setVueAdmin] = useState(false);

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
        if (session.role === 'vendor') {
          const v = await api.myVendor(session.accessToken);
          if (!annule) setVendeur(v);
        } else {
          const c = await api.myCustomer(session.accessToken);
          if (!annule) setClient(c);
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
    setEstAdmin(admin);
    setErreur(null);
    setAvis(notice);
    setSession(s);
    enregistrerSession(s);
    setVue('accueil');
  }

  function deconnexion() {
    setEstAdmin(false);
    setVueAdmin(false);
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

  // ---- customer ----------------------------------------------------------
  if (session.role === 'customer') {
    if (!client) {
      return (
        <div className="ecran">
          <Entete />
          <div className="ecran__corps">
            <Message ton="erreur">{erreur ?? 'Compte client introuvable.'}</Message>
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
        <EspaceClient session={session} client={client} onDeconnexion={deconnexion} />
        {estAdmin ? (
          <div className="ecran" style={{ minHeight: 'auto', paddingTop: 0 }}>
            <BoutonSecondaire onClick={() => setVueAdmin(true)}>
              Panneau support
            </BoutonSecondaire>
          </div>
        ) : null}
      </>
    );
  }

  // ---- vendor ------------------------------------------------------------
  if (!vendeur) {
    return (
      <div className="ecran">
        <Entete />
        <div className="ecran__corps">
          <Message ton="erreur">{erreur ?? 'Compte commerçant introuvable.'}</Message>
          <BoutonSecondaire onClick={deconnexion}>Se reconnecter</BoutonSecondaire>
        </div>
      </div>
    );
  }

  if (vue === 'garder') {
    return (
      <GarderLaMonnaie session={session} vendeur={vendeur} onTermine={() => setVue('accueil')} />
    );
  }

  if (vue === 'utiliser') {
    return (
      <UtiliserLaMonnaie session={session} vendeur={vendeur} onTermine={() => setVue('accueil')} />
    );
  }

  if (vue === 'clients') {
    return (
      <MesClients session={session} vendeur={vendeur} onTermine={() => setVue('accueil')} />
    );
  }

  return (
    <AccueilVendeur
      session={session}
      vendeur={vendeur}
      onGarder={() => setVue('garder')}
      onUtiliser={() => setVue('utiliser')}
      onClients={() => setVue('clients')}
      onDeconnexion={deconnexion}
      onAdmin={estAdmin ? () => setVueAdmin(true) : undefined}
    />
  );
}
