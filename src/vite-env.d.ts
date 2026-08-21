/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected at build time by vite.config.ts. */
declare const __BUILD_SHA__: string;
declare const __BUILD_DATE__: string;
