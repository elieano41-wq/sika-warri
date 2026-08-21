import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],

    // Every file shares one Postgres database and truncates in beforeEach.
    // Running files in parallel would have them wipe each other's fixtures
    // mid-assertion, producing failures that look like logic bugs.
    fileParallelism: false,

    // The concurrency suite deliberately blocks on a lock and sleeps.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['verbose'],
  },
});
