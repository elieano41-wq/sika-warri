// The shape of the app: destinations, tasks, and which of them may show the bar.
//
// THE RULE, and the bug that produced it. Destinations get a fixed bottom tab
// bar. Tasks — recording change, spending it, confirming a debit, changing a code
// — do not, because a vendor who taps away from a half-recorded entry has lost
// it, and a customer with 180 seconds on the clock has less time than they think.
//
// The first version got this right for the vendor's two tasks and wrong for
// changing a code, which Compte rendered itself. The bar stayed on screen, laid
// over the footer, and swallowed the tap on "Annuler" — the UI harness retried
// that click 54 times before timing out. The fix was structural: every task now
// belongs to a shell, because the shell is the only thing that can take the bar
// away. These tests keep it that way.
//
// The other half is the mirror image and just as easy to get wrong: a destination
// WITHOUT the padding class has its last card trapped under the bar.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const fichiers = walk(SRC).filter((f) => f.endsWith('.tsx'));

function lire(rel: string): string {
  return readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/** The two shells: the only components allowed to render the bar. */
const COQUILLES = [
  'App.tsx',
  path.join('screens', 'client', 'EspaceClient.tsx'),
];

/** Destinations. Reached from the bar, so each must leave room for it. */
const DESTINATIONS = [
  path.join('screens', 'vendeur', 'Accueil.tsx'),
  path.join('screens', 'vendeur', 'MesClients.tsx'),
  path.join('screens', 'vendeur', 'Historique.tsx'),
  path.join('screens', 'client', 'MaMonnaie.tsx'),
  path.join('screens', 'client', 'Historique.tsx'),
  path.join('screens', 'client', 'MonCode.tsx'),
  path.join('screens', 'Compte.tsx'),
];

/** Tasks. They take the whole screen and the bar is gone while they run. */
const TACHES = [
  path.join('screens', 'vendeur', 'GarderLaMonnaie.tsx'),
  path.join('screens', 'vendeur', 'UtiliserLaMonnaie.tsx'),
  path.join('screens', 'client', 'Confirmation.tsx'),
];

describe('only a shell renders the tab bar', () => {
  it('nothing else imports Navigation', () => {
    const coupables = fichiers
      .filter((f) => {
        const rel = path.relative(SRC, f);
        return !COQUILLES.includes(rel);
      })
      .filter((f) => /<Navigation/.test(code(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))))
      .map((f) => path.relative(SRC, f));

    expect(coupables).toEqual([]);
  });

  it('both shells actually render it, so the list is not stale', () => {
    for (const c of COQUILLES) {
      expect(code(lire(c)), `${c} renders no bar`).toMatch(/<Navigation/);
    }
  });
});

describe('a task is owned by a shell, never rendered inside a destination', () => {
  it('Compte asks the shell to start the code change', () => {
    // The specific regression. Compte used to hold a `changer` flag and render
    // ChangerCode itself, which left the bar over the task's own footer.
    const src = code(lire(path.join('screens', 'Compte.tsx')));
    expect(src).toMatch(/onChangerCode/);
    // The Compte component itself holds no view state at all now.
    expect(src).not.toMatch(/const \[changer,/);
  });

  it('both shells own the code-change task', () => {
    for (const c of COQUILLES) {
      expect(code(lire(c)), `${c} cannot start a code change`).toMatch(/<ChangerCode/);
    }
  });

  it('no task screen leaves room for a bar that is not there', () => {
    // ecran--avec-nav on a task would add dead padding to a full-screen flow and
    // suggest the bar belongs there.
    for (const t of [...TACHES, path.join('screens', 'Compte.tsx')]) {
      const src = lire(t);
      const tacheDansLeFichier = /vue--tache/.test(src);
      if (!tacheDansLeFichier) continue;
      // A file holding both a destination and a task (Compte) is allowed; what
      // must not happen is the two classes on ONE element.
      expect(src, `${t} puts nav padding on a task`).not.toMatch(
        /ecran--avec-nav[^"]*vue--tache|vue--tache[^"]*ecran--avec-nav/
      );
    }
  });
});

describe('every destination leaves room for the bar', () => {
  it.each(DESTINATIONS)('%s uses ecran--avec-nav', (rel) => {
    // Without it the last card sits under a fixed 56px bar and cannot be read
    // or tapped — the mirror image of the bug above.
    expect(code(lire(rel))).toMatch(/ecran--avec-nav/);
  });

  it.each(DESTINATIONS)('%s does not sign the user out on its own', (rel) => {
    // Signing out lived on whichever screen had room for it. It belongs in one
    // place now.
    if (rel === path.join('screens', 'Compte.tsx')) return;
    expect(code(lire(rel))).not.toMatch(/onDeconnexion/);
  });
});

describe('the bar has three or four destinations per role', () => {
  it('the vendor has at most four', () => {
    const src = lire('App.tsx');
    const bloc = /ONGLETS_VENDEUR[\s\S]*?\];/.exec(src);
    expect(bloc).not.toBeNull();
    const n = (bloc![0].match(/cle:/g) ?? []).length;
    // Five items at 320px leave under the 56px target once labels are inset. A
    // fifth destination is a sign something belongs inside another one.
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(4);
  });

  it('the customer has at most four', () => {
    const src = lire(path.join('screens', 'client', 'EspaceClient.tsx'));
    const bloc = /const ONGLETS[\s\S]*?\];/.exec(src);
    expect(bloc).not.toBeNull();
    const n = (bloc![0].match(/cle:/g) ?? []).length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(4);
  });

  it('the selected tab is not signalled by colour alone', () => {
    // In direct sunlight on a cheap screen, colour is the first thing to go. The
    // stylesheet selects on aria-current, which is also what a screen reader
    // announces, so the visual and the announced state cannot drift apart.
    const nav = code(lire(path.join('components', 'Navigation.tsx')));
    expect(nav).toMatch(/aria-current/);

    const css = readFileSync(path.join(SRC, 'styles', 'base.css'), 'utf8').replace(/\r\n/g, '\n');
    const regle = /\.nav__item\[aria-current='page'\]\s*\{([^}]*)\}/.exec(css);
    expect(regle, 'no rule for the current tab').not.toBeNull();
    // Weight as well as colour.
    expect(regle![1]).toMatch(/font-weight/);
  });
});

describe('the role-wide histories carry no cross-vendor arithmetic', () => {
  // ACCEPTANCE TEST 8 on the screens most likely to break it. A running balance
  // down a list that mixes vendors accumulates into a pooled total one row at a
  // time, where it reads as arithmetic instead of a claim about who owes what.
  const HISTOIRES = [
    path.join('screens', 'vendeur', 'Historique.tsx'),
    path.join('screens', 'client', 'Historique.tsx'),
  ];

  it.each(HISTOIRES)('%s shows no running balance', (rel) => {
    const src = code(lire(rel));
    expect(src).not.toMatch(/running_balance/);
    expect(src).not.toMatch(/\.reduce\s*\(/);
  });

  it('the API type for a role-wide movement has no running balance field', () => {
    const api = code(readFileSync(path.join(SRC, 'lib', 'api.ts'), 'utf8').replace(/\r\n/g, '\n'));
    const bloc = /export interface MovementRow \{([\s\S]*?)\}/.exec(api);
    expect(bloc, 'MovementRow is gone').not.toBeNull();
    expect(bloc![1]).not.toMatch(/running_balance/);
    // It does carry the true count, so a truncated page is visibly truncated.
    expect(bloc![1]).toMatch(/total_count/);
  });

  it('the customer history names the shop on every row', () => {
    // An amount without the shop it sits at is a figure the customer cannot use,
    // and it is the detail that keeps the list from reading as one pot.
    const src = code(lire(path.join('screens', 'client', 'Historique.tsx')));
    expect(src).toMatch(/business_name/);
  });
});

describe('empty states say what will appear and what makes it appear', () => {
  it('no screen ships a bare "aucune donnée"', () => {
    // The banned shape: a message that tells someone the app works and they do
    // not. Every empty state names the next action instead.
    for (const f of fichiers) {
      const src = code(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
      expect(src, `${path.relative(SRC, f)}`).not.toMatch(/aucune\s+donn[ée]e/i);
      expect(src, `${path.relative(SRC, f)}`).not.toMatch(/liste\s+vide/i);
    }
  });

  it('every list screen has a real empty state, not a bare sentence', () => {
    const AVEC_LISTE = [
      path.join('screens', 'vendeur', 'MesClients.tsx'),
      path.join('screens', 'vendeur', 'Historique.tsx'),
      path.join('screens', 'client', 'MaMonnaie.tsx'),
      path.join('screens', 'client', 'Historique.tsx'),
    ];
    for (const rel of AVEC_LISTE) {
      expect(code(lire(rel)), `${rel} has no <Vide>`).toMatch(/<Vide/);
    }
  });

  it('an empty state is never shown while still loading', () => {
    // The distinction that matters: "we asked and there is nothing" is not the
    // same claim as "we have not asked yet". Every one of these screens holds
    // null while in flight and only renders <Vide> once it holds an array.
    for (const rel of [
      path.join('screens', 'vendeur', 'Historique.tsx'),
      path.join('screens', 'client', 'Historique.tsx'),
    ]) {
      const src = code(lire(rel));
      expect(src).toMatch(/=== null \?/);
      expect(src).toMatch(/Chargement/);
    }
  });
});

describe('movement wording lives in one place', () => {
  it('no screen writes its own label for a ledger kind', () => {
    // It was written twice before — once for the vendor, once for the customer —
    // which is two chances to drift. A vendor and a customer looking at the same
    // entry must read the same words for it, or they cannot discuss it.
    // Matches a MAPPING from a kind to words — `e.kind === 'change'` — not the
    // kind values a screen legitimately sends when recording an entry.
    const coupables = fichiers
      .filter((f) => /kind === '/.test(code(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))))
      .map((f) => path.relative(SRC, f));

    expect(coupables).toEqual([]);
  });

  it('the shared module is what they use', () => {
    for (const rel of [
      path.join('screens', 'vendeur', 'Historique.tsx'),
      path.join('screens', 'client', 'Historique.tsx'),
      path.join('screens', 'client', 'MaMonnaie.tsx'),
    ]) {
      expect(code(lire(rel)), `${rel}`).toMatch(/libelleMouvement/);
    }
  });
});
