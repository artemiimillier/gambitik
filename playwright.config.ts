/**
 * End-to-end tests: the real dev stack (`pnpm dev` = Hono server on 8787 + Vite on 5173) driven by Chromium.
 *
 * Safety: the e2e server NEVER touches the real data or subscriptions —
 *  - DATA_DIR points at a fresh temp directory (assertions about written PGN / markdown files read it),
 *  - LLM_PROVIDER=template and CODEX_BIN=off: no `codex exec`, no OpenAI text calls,
 *  - OPENAI_API_KEY is blanked (an env var beats the value from `.env`), so no realtime voice session is minted,
 *  - GAMBIT_CLIP_GEN=0, HIGGSFIELD_BIN=off, VOICE_OVERLAY_DIR=off: no phrase is ever recorded with the paid Higgsfield
 *    voice, the CLI is not even looked for, and the real recorded overlay is neither read nor written
 *    («Дозапись голоса»; global-setup refuses a server whose health says otherwise).
 * `reuseExistingServer` is off on purpose: an already running dev server would use the real data directory.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The config is evaluated in the runner AND in every worker; workers inherit the runner's environment,
// so the directory is created exactly once per run.
// Only the PATH is chosen here; the server creates the directory when it starts. A run that aborts early
// (ports busy, config error) therefore leaves nothing behind; global-teardown removes the directory of a real run.
const dataDir = process.env.GAMBIT_E2E_DATA_DIR ?? join(tmpdir(), `gambit-e2e-${process.pid}-${Date.now().toString(36)}`);
process.env.GAMBIT_E2E_DATA_DIR = dataDir;

/**
 * `GAMBIT_WEB_PORT=5174 GAMBIT_API_PORT=8788 pnpm e2e` runs the stack on other ports (the real server may hold
 * 8787 — never stop it for a test). The dev server and Vite read the same variables; unset = 5173 / 8787.
 */
function portFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 1024 && value <= 65_535 ? value : fallback;
}
const webPort = portFromEnv('GAMBIT_WEB_PORT', 5173);
const apiPort = portFromEnv('GAMBIT_API_PORT', 8787);

/** `GAMBIT_E2E_VIEWPORT=1280x800 pnpm e2e` re-runs the suite on the small laptop size (screenshots go to a sub-folder). */
function viewportFromEnv(): { width: number; height: number } {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.GAMBIT_E2E_VIEWPORT ?? '');
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1440, height: 900 };
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // e2e/prod/ is the production smoke test: `pnpm e2e:prod` (playwright.prod.config.ts); e2e/accounts/ the public site
  // with sign-in: `pnpm e2e:accounts` (playwright.accounts.config.ts)
  testIgnore: ['**/prod/**', '**/accounts/**'],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // one student profile on one server: the specs run in file order, one at a time
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: `http://localhost:${webPort}`,
    ...devices['Desktop Chrome'],
    viewport: viewportFromEnv(),
    locale: 'ru-RU',
    // never a sound on a development Mac (the app is also silent by itself under navigator.webdriver)
    launchOptions: { args: ['--mute-audio'] },
    // a click that cannot land (covered / disabled target) fails in 15 s with a clear log, not as a 3-minute test timeout
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    url: `http://localhost:${webPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      GAMBIT_WEB_PORT: String(webPort),
      GAMBIT_API_PORT: String(apiPort),
      DATA_DIR: dataDir,
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
