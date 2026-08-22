import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

/**
 * Identify the build, so a vendor standing in a market can say which one they
 * are holding.
 *
 * Tries git first, then Cloudflare's own commit variable for a Pages-side
 * build, then falls back to a marker that is obviously not a release. It never
 * throws: a missing SHA must not be able to break a deploy.
 */
function buildId(): string {
  const fromCloudflare = process.env.CF_PAGES_COMMIT_SHA;
  if (fromCloudflare) return fromCloudflare.slice(0, 7);

  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'inconnu';
  }
}

/**
 * Was the working tree dirty when this build ran?
 *
 * Vite writes a temporary vite.config.ts.timestamp-*.mjs into the project root
 * in order to load this very file, so a naive porcelain check sees an untracked
 * file and reports EVERY build as dirty — including one made from a clean
 * commit. That turns the marker's "+" into noise, and a warning that is always
 * on tells you nothing. Vite's own scratch file is therefore excluded.
 */
function buildDirty(): boolean {
  try {
    const lignes = execSync('git status --porcelain', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !/vite\.config\.[cm]?tsx?\.timestamp-/.test(l));

    return lignes.length > 0;
  } catch {
    return false;
  }
}

export default defineConfig({
  define: {
    // Marked dirty when the working tree had uncommitted changes at build time,
    // so a hand-built deploy is never mistaken for the commit it claims to be.
    __BUILD_SHA__: JSON.stringify(buildId() + (buildDirty() ? '+' : '')),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  plugins: [
    react(),
    VitePWA({
      // prompt, not autoUpdate. autoUpdate reloads the page as soon as a new
      // build is cached, which could happen while a vendor is mid-transaction
      // or a customer has a 180-second confirmation open. The banner lets them
      // choose the moment.
      registerType: 'prompt',
      // The app shell must open with no network (spec section 8).
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        runtimeCaching: [
          {
            // Google Fonts, cached first-hit so the app stays legible offline.
            // Without this the display face falls back and the amounts change
            // size, which is exactly the jitter tabular figures exist to stop.
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'polices',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        // Never cache API traffic. A stale balance is worse than no balance.
        navigateFallbackDenylist: [/^\/functions\//, /^\/rest\//],
      },
      manifest: {
        name: 'Sika Warri',
        short_name: 'Sika Warri',
        description: 'La monnaie gardée chez votre commerçant.',
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        background_color: '#0B2E22',
        theme_color: '#0B2E22',
        icons: [
          { src: '/icone-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icone-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: { target: 'es2020' },
});
