import { useEffect, useState } from 'react';
import * as api from './lib/api';
import type { Session, VendorProfile, CustomerProfile } from './lib/api';
import { Bienvenue } from './screens/Bienvenue';
import { Connexion } from './screens/Connexion';
import { Inscription } from './screens/Inscription';
import { ResetPin } from './screens/ResetPin';
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
    connexion(s, null);
  }

  function connexion(s: Session, notice: string | null) {
    setErreur(null);
    setAvis(notice);
    setSession(s);
    enregistrerSession(s);
    setVue('accueil');
  }

  function deconnexion() {
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
    />
  );
}
