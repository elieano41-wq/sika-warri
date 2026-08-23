import { Entete, BoutonPrimaire, BoutonSecondaire, Version } from '../components/ui';
import { Installer } from '../components/Installer';

/**
 * Bienvenue — what a first-time visitor sees.
 *
 * Previously the app opened straight onto a login form, which asks someone to
 * prove who they are before telling them what the thing is. Anyone arriving from
 * a link had no obvious way to sign up.
 *
 * Two lines explaining the product, then two equally weighted doors. Not shown
 * to anyone with a session — a returning vendor goes straight to their work.
 */
export function Bienvenue({
  onConnexion,
  onInscription,
}: {
  onConnexion: () => void;
  onInscription: () => void;
}) {
  return (
    <div className="ecran">
      <Entete />

      <div className="ecran__corps" style={{ justifyContent: 'center' }}>
        {/* Two lines, plain French, no jargon and no claim that Sika Warri
            holds anything. */}
        <h1 style={{ fontSize: 'var(--titre-l)' }}>
          Votre monnaie ne se perd plus
        </h1>
        <p style={{ fontSize: 'var(--texte-grand)', color: 'var(--craie)' }}>
          Quand un commerçant n'a pas de monnaie, il l'enregistre. Elle reste
          chez lui et vous l'utilisez plus tard, ou il vous rembourse en
          espèces.
        </p>

        {/* The signature card, used here to show what the product looks like
            before asking for anything. */}
        <article className="carte" style={{ marginTop: 'var(--espace-3)' }}>
          <div>
            <div className="carte__titre">Chez Awa</div>
            <div className="carte__sous">Yopougon</div>
          </div>
          <div className="carte__etiquette">Votre monnaie chez ce commerçant</div>
          <span className="montant montant--grand">
            1 500<span className="montant--suffixe"> F</span>
          </span>
        </article>
      </div>

      <div className="ecran__pied pile">
        {/* Equal weight, on purpose. A shopkeeper hearing about this from a
            neighbour needs the second door to be as findable as the first. */}
        <BoutonPrimaire onClick={onInscription}>Créer un compte</BoutonPrimaire>
        <BoutonSecondaire onClick={onConnexion}>J'ai déjà un compte</BoutonSecondaire>
        <Installer compact />
        <Version />
      </div>
    </div>
  );
}
