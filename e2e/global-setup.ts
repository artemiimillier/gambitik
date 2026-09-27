/**
 * Waits for the API behind the Vite proxy and refuses to run against an unsafe server:
 * the e2e stack must have no OpenAI key and no codex CLI, and must not record new phrases with the paid Higgsfield
 * voice («Дозапись голоса»: GAMBIT_CLIP_GEN off — see playwright.config.ts).
 */
import type { FullConfig } from '@playwright/test';

export interface SafetyHealth {
  ok: boolean;
  llm: { codexCli: boolean; codexLoggedIn: boolean; openaiKey: boolean };
  voice: { realtime: boolean };
  puzzles: { count: number };
  /** absent = a server that does not report it: refused as well (this repository's server always reports it) */
  clipGen?: { state: 'off' | 'ready' | 'paused'; reason?: string };
}

/**
 * Why the server under test is unsafe for an automated run, or null. Pure (unit-tested in
 * apps/server/src/voiceGen/guards.test.ts): a paid provider, or clip recording in any state but 'off'.
 */
export function healthSafetyProblem(health: SafetyHealth): string | null {
  if (health.llm.openaiKey || health.llm.codexCli || health.voice.realtime) return 'e2e safety check failed: the server under test has an OpenAI key or the codex CLI enabled';
  if (health.clipGen?.state !== 'off') {
    return `e2e safety check failed: the server under test may record new phrases with the paid Higgsfield voice (clipGen: ${health.clipGen === undefined ? 'not reported' : health.clipGen.state}) — run it with GAMBIT_CLIP_GEN=0`;
  }
  return null;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:5173';
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) {
        const health = (await response.json()) as SafetyHealth;
        const problem = healthSafetyProblem(health);
        if (problem !== null) throw new Error(problem);
        if (health.puzzles.count === 0) throw new Error('e2e: the server has no puzzles (kb/puzzles-starter.json missing?)');
        return;
      }
      lastError = new Error(`GET /api/health → ${response.status}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('e2e')) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the API did not come up behind ${baseURL}: ${String(lastError)}`);
}
