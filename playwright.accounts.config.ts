/**
 * The public site with accounts (GAMBIT_ACCOUNTS=1): `pnpm build` + `pnpm start` — one process on
 * http://127.0.0.1:8791 with sign-up (a test invite code), a throw-away DATA_DIR and the same safety rules as
 * playwright.config.ts: template texts only, no codex, no OpenAI / OpenRouter key, no recording of new phrases
 * (GAMBIT_CLIP_GEN=0, no Higgsfield CLI, no overlay). `pnpm e2e:accounts`.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const dataDir = process.env.GAMBIT_E2E_DATA_DIR ?? join(tmpdir(), `gambit-e2e-accounts-${process.pid}-${Date.now().toString(36)}`);
process.env.GAMBIT_E2E_DATA_DIR = dataDir;

const apiPortValue = Number(process.env.GAMBIT_API_PORT);
const apiPort = Number.isInteger(apiPortValue) && apiPortValue >= 1024 && apiPortValue <= 65_535 ? apiPortValue : 8791;

/** the test's invite code (the real one is a secret, set on the server only) */
export const E2E_INVITE = 'e2e-invite-2026';

export default defineConfig({
  testDir: './e2e/accounts',
  testMatch: '**/*.spec.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  // its own folder: Playwright empties the output folder first, and test-results/ holds other runs (the voice library's)
  outputDir: './test-results/e2e-accounts',
  use: {
    baseURL: `http://127.0.0.1:${apiPort}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
    launchOptions: { args: ['--mute-audio'] },
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm start',
    url: `http://127.0.0.1:${apiPort}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      GAMBIT_API_PORT: String(apiPort),
      DATA_DIR: dataDir,
      GAMBIT_ACCOUNTS: '1',
      GAMBIT_INVITE_CODE: E2E_INVITE,
      // `pnpm start` reads .env: whatever it says, this server is local, keyless and without runtime AI
      GAMBIT_RUNTIME_AI: '0',
      GAMBIT_BIND_HOST: '127.0.0.1',
      GAMBIT_PUBLIC_HOSTS: '',
      LLM_PROVIDER: 'template',
      CODEX_BIN: 'off',
      OPENAI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      GAMBIT_CLIP_GEN: '0',
      HIGGSFIELD_BIN: 'off',
      VOICE_OVERLAY_DIR: 'off',
    },
  },
});
