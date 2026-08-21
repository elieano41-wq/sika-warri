import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
