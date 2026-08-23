import { BoutonPrimaire, BoutonSecondaire, Version } from '../components/ui';

/**
 * Bienvenue — what a first-time visitor sees.
 *
 * The name, one line saying what it is, two doors. Nothing else.
 *
 * WHAT WAS CUT AND WHY. A headline ("Votre monnaie ne se perd plus"), a
 * paragraph explaining the mechanism, and a mocked-up card showing 1 500 F at a
 * shop called Chez Awa. All of it was written to persuade, and none of it
 * survived the question "what does someone standing here actually need?". They
 * need to know what the thing is and which button is theirs. A product that
 * explains itself at length before asking for a name reads as a product that
 * expects to be doubted.
 *
 * The demo card went for a second reason: it was a fabricated balance at a
 * fabricated shop, presented in the same visual language as a real one. The
 * first thing a first-time visitor saw was a number that was not true.
 *
 * Not shown to anyone with a session — a returning user goes straight to work.
 */
export function Bienvenue({
  onConnexion,
  onInscription,
}: {
  onConnexion: () => void;
  onInscription: () => void;
}) {
  return (
    <div className="ecran ecran--accueil">
      <div className="ecran__corps accueil">
        <h1 className="accueil__marque">Sika Warri</h1>
        {/* One line. It has to be true for both sides of every pair, so it
            names the two registers and claims nothing about who owes whom. */}
        <p className="accueil__ligne">
          Un carnet pour la monnaie gardée et les dettes.
        </p>
      </div>

      <div className="ecran__pied pile">
        {/* Equal weight, on purpose. Someone hearing about this from a
            neighbour needs the second door to be as findable as the first. */}
        <BoutonPrimaire onClick={onInscription}>Créer un compte</BoutonPrimaire>
        <BoutonSecondaire onClick={onConnexion}>J’ai déjà un compte</BoutonSecondaire>
        <Version />
      </div>
    </div>
  );
}
