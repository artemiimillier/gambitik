/**
 * Production smoke test: `pnpm build` (done by the webServer command) + `pnpm start` — ONE process on
 * http://127.0.0.1:8787 serving the built SPA and the API. Same safety rules as playwright.config.ts:
 * temp DATA_DIR, template reviews only, no codex CLI, no OpenAI key, no recording of new phrases (GAMBIT_CLIP_GEN=0,
 * no Higgsfield CLI, no overlay). There is no global setup here: the smoke spec asserts the same health.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Only the PATH is chosen here; the server creates the directory when it starts. A run that aborts early
// (ports busy, config error) therefore leaves nothing behind; global-teardown removes the directory of a real run.
const dataDir = process.env.GAMBIT_E2E_DATA_DIR ?? join(tmpdir(), `gambit-e2e-${process.pid}-${Date.now().toString(36)}`);
process.env.GAMBIT_E2E_DATA_DIR = dataDir;

/** `GAMBIT_API_PORT=8788 pnpm e2e:prod` — another port when the real server holds 8787 (never stop it for a test). */
const apiPortValue = Number(process.env.GAMBIT_API_PORT);
const apiPort = Number.isInteger(apiPortValue) && apiPortValue >= 1024 && apiPortValue <= 65_535 ? apiPortValue : 8787;

export default defineConfig({
  testDir: './e2e/prod',
  testMatch: '**/*.spec.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: `http://127.0.0.1:${apiPort}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    locale: 'ru-RU',
    // never a sound on a development Mac (the app is also silent by itself under navigator.webdriver)
    launchOptions: { args: ['--mute-audio'] },
    // a click that cannot land (covered / disabled target) fails in 15 s with a clear log, not as a 3-minute test timeout
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm start',
    url: `http://127.0.0.1:${apiPort}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
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
