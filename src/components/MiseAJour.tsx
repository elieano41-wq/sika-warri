import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * The update banner.
 *
 * The problem it fixes: the service worker caches the app shell, so a deployed
 * build is invisible until the cache is cleared by hand. That is bad for testing
 * and much worse in the field — a vendor could run a version with a known bug
 * for weeks and nobody would know which build they held.
 *
 * Deliberately NOT automatic. A silent reload mid-transaction would be the worst
 * possible moment: a vendor halfway through recording change, or a customer with
 * a 180-second confirmation window open, would lose what they were doing. So the
 * new version waits, visibly, and the person decides when to take it.
 *
 * The banner sits at the top rather than over the primary action, so it never
 * covers the button someone is reaching for.
 */
export function MiseAJour() {
  const [pret, setPret] = useState(false);
  const [horsLigne, setHorsLigne] = useState(false);
  const [appliquer, setAppliquer] = useState<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const update = registerSW({
      immediate: true,
      onNeedRefresh() {
        // A new build is cached and waiting. Nothing changes until asked.
        setPret(true);
      },
      onOfflineReady() {
        // Worth saying once: the app now opens with no network, which is the
        // whole point of installing it.
        setHorsLigne(true);
        window.setTimeout(() => setHorsLigne(false), 6000);
      },
    });

    setAppliquer(() => () => update(true));
  }, []);

  if (pret) {
    return (
      <div className="banniere banniere--maj" role="status">
        <span>Nouvelle version disponible</span>
        <button
          type="button"
          className="banniere__action"
          onClick={() => appliquer?.()}
        >
          Mettre à jour
        </button>
      </div>
    );
  }

  if (horsLigne) {
    return (
      <div className="banniere banniere--info" role="status">
        <span>Sika Warri fonctionne maintenant sans réseau</span>
      </div>
    );
  }

  return null;
}
