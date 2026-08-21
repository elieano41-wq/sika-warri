import { useEffect, useState } from 'react';
import { BoutonSecondaire, BoutonDiscret, Message } from './ui';

/**
 * The install prompt, explained for someone who has never done it.
 *
 * "Add to home screen" is a phrase that means nothing to most people. What they
 * want to know is: will this take up space, will it cost data, and will it look
 * like a real app afterwards. So the copy answers those, and only then offers
 * the button.
 *
 * Two paths, because the platforms differ and pretending otherwise strands
 * half the users:
 *   - Chrome on Android fires beforeinstallprompt, so there is a real button.
 *   - Safari on iOS never fires it, so the only honest option is to describe
 *     the Share-menu steps.
 */

interface PromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const CLE_REFUS = 'sika.install.refuse';

function dejaInstalle(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari reports it here instead.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function estIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function Installer({ compact = false }: { compact?: boolean }) {
  const [evenement, setEvenement] = useState<PromptEvent | null>(null);
  const [installe, setInstalle] = useState(dejaInstalle);
  const [refuse, setRefuse] = useState(() => {
    try { return localStorage.getItem(CLE_REFUS) === '1'; } catch { return false; }
  });
  const [ouvert, setOuvert] = useState(false);

  useEffect(() => {
    function capture(e: Event) {
      // Stop Chrome's own mini-infobar so the explanation below is what the
      // person reads first, rather than a bare "Install?" they will dismiss.
      e.preventDefault();
      setEvenement(e as PromptEvent);
    }
    function installeFait() { setInstalle(true); }

    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', installeFait);
    return () => {
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', installeFait);
    };
  }, []);

  if (installe) return null;

  const possible = evenement !== null || estIOS();
  if (!possible) return null;

  // Dismissed before, and not asking again from a footer. The full card still
  // shows at the end of registration, where it is the natural next step.
  if (refuse && compact) return null;

  async function installer() {
    if (!evenement) return;
    await evenement.prompt();
    const { outcome } = await evenement.userChoice;
    if (outcome === 'accepted') setInstalle(true);
    setEvenement(null);
  }

  function plusTard() {
    setRefuse(true);
    setOuvert(false);
    try { localStorage.setItem(CLE_REFUS, '1'); } catch { /* not important */ }
  }

  if (compact && !ouvert) {
    return (
      <BoutonDiscret onClick={() => setOuvert(true)}>
        Installer Sika Warri sur ce téléphone
      </BoutonDiscret>
    );
  }

  return (
    <div className="pile" style={{ gap: 'var(--espace-3)' }}>
      <Message ton="info">
        <strong style={{ display: 'block', marginBottom: 'var(--espace-2)' }}>
          Mettez Sika Warri sur votre écran d'accueil
        </strong>
        {/* The three questions people actually have, answered before the ask. */}
        Sika Warri apparaîtra avec vos autres applications, avec son icône. Vous
        l'ouvrirez d'un seul geste, sans taper d'adresse.
        <br />
        <br />
        Cela ne télécharge presque rien : moins qu'une photo. Vous pouvez
        l'enlever à tout moment, comme n'importe quelle application, et votre
        monnaie enregistrée n'est pas touchée.
      </Message>

      {evenement ? (
        <BoutonSecondaire onClick={installer}>Ajouter à l'écran d'accueil</BoutonSecondaire>
      ) : (
        // iOS: no programmatic install exists, so describe the actual taps.
        <Message ton="info">
          Sur iPhone : touchez le bouton <strong>Partager</strong> en bas de
          l'écran (un carré avec une flèche vers le haut), puis descendez et
          touchez <strong>Sur l'écran d'accueil</strong>.
        </Message>
      )}

      <BoutonDiscret onClick={plusTard}>Plus tard</BoutonDiscret>
    </div>
  );
}
