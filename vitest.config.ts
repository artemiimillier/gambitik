import { defineConfig } from 'vitest/config';

// One root config: `pnpm test` discovers colocated *.test.ts(x) in every workspace package.
// Playwright specs (*.spec.ts, e2e/) are intentionally not matched.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'apps/*/src/**/*.test.{ts,tsx}', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'data/**', 'e2e/**'],
    passWithNoTests: false,
    restoreMocks: true,
    // shared CI runners are several times slower than a dev machine: engine-heavy tests need the room
    testTimeout: process.env.CI ? 60_000 : 5_000,
  },
});
