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


/**
 * The service-worker registration helper injected by vite-plugin-pwa.
 *
 * Declared here rather than via the plugin's own reference types: those resolve
 * inconsistently under "moduleResolution: bundler", and a build that works while
 * the typecheck fails is a trap for whoever touches this next.
 */
declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean;
    /** A new build is cached and waiting. */
    onNeedRefresh?: () => void;
    /** The app shell is cached and will now open with no network. */
    onOfflineReady?: () => void;
    onRegisteredSW?: (url: string, registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: unknown) => void;
  }

  /** Returns a function that activates the waiting worker and reloads. */
  export function registerSW(
    options?: RegisterSWOptions
  ): (reloadPage?: boolean) => Promise<void>;
}
