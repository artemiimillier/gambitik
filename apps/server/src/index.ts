/**
 * @gambit/server — local-only API + (in production) static host of the SPA.
 *
 * Runs directly on Node 26 (`node src/index.ts`, native type stripping): erasable syntax only,
 * relative imports with the .ts extension, workspace packages consumed as TypeScript source.
 * Binds to 127.0.0.1 by default; see security.ts for the Host / Origin rules. A container behind a TLS proxy binds
 * GAMBIT_BIND_HOST=0.0.0.0 and trusts only the names in GAMBIT_PUBLIC_HOSTS (config.ts, deploy/docker-ssh).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { listenLine, loadConfig } from './config.ts';
import { createServerContext } from './context.ts';
import { createAccountsRuntime } from './accounts/runtime.ts';

export { createApp } from './app.ts';
export type { AppType } from './app.ts';
export { loadConfig } from './config.ts';
export type { ServerConfig } from './config.ts';
export { createServerContext } from './context.ts';
export type { ContextOverrides, ServerContext } from './context.ts';
export type { GameReviewWithAdvice } from './routes/games.ts';
export type { VoiceUsageProvider, VoiceUsageSummary } from './services/voiceUsage.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await createServerContext(config);
  // GAMBIT_ACCOUNTS=1 (the public site): sign-in, one data folder per child (./accounts)
  const accounts = config.accounts.enabled ? createAccountsRuntime(config, ctx) : null;
  const app = createApp(ctx, accounts);

  const server = serve({ fetch: app.fetch, hostname: config.hostname, port: config.port }, (info) => {
    const spa = existsSync(join(config.webDistDir, 'index.html')) ? 'API + built SPA' : 'API only (no apps/web/dist — run `pnpm build`, or use `pnpm dev`)';
    ctx.log(`[server] ${listenLine(config, info.port)} — ${spa}`);
    for (const warning of config.networkWarnings) ctx.log(`[server] ${warning}`);
    // GAMBIT_RUNTIME_AI (docs/TEACHING.md §4.4): off = no generative model in the child's game, whatever the keys
    ctx.log(
      config.runtimeAi
        ? '[server] runtime AI: on (GAMBIT_RUNTIME_AI=1) — the LLM strategist / reviews and the OpenAI voice may be used'
        : '[server] runtime AI: off — template texts only, no codex, no OpenAI voice (GAMBIT_RUNTIME_AI=1 turns it on)',
    );
    const preferredVoice = config.voicePreferred === 'clips' ? 'recorded clips' : config.voicePreferred === 'live' ? config.voiceLiveModel : config.voiceModel;
    ctx.log(
      `[server] data: ${config.dataDir} · puzzles: ${ctx.puzzles.count()} (${ctx.puzzles.kind}) · LLM: ${config.llmProvider} (openrouter key: ${config.openrouterApiKey !== null ? 'yes' : 'no'}) · ` +
        `voice key: ${config.openaiApiKey !== null ? `yes${config.runtimeAi ? '' : ', unused'}` : 'no'} (preferred: ${preferredVoice})`,
    );
    if (config.reviewIncludeChildSpeech) ctx.log('[server] REVIEW_INCLUDE_CHILD_SPEECH=1 — redacted child utterances are sent to the review API providers (never to codex)');
    const fromContent = ctx.content.sources.content.length > 0 ? ctx.content.sources.content.join(', ') : 'built-in fallbacks only';
    ctx.log(`[server] content: ${fromContent}${ctx.content.templateReview === null ? ' · template review: built-in' : ''}`);
    const chain = ctx.gateway.providerIds();
    const step = {
      codex: chain.includes('codex') && config.codexBin !== null ? `codex ${config.codexStrategyModel}` : null,
      openrouter: chain.includes('openrouter') && config.openrouterApiKey !== null ? `openrouter ${config.openrouterStrategyModel}` : null,
      openaiApi: chain.includes('openai-api') && config.openaiApiKey !== null ? `openai-api ${config.openaiStrategyModel}` : null,
    };
    const chainOf = (steps: (string | null)[]): string => [...steps, 'template'].filter((s): s is string => s !== null).join(' → ');
    // the strategy asks the owner's subscription first (≤ STRATEGY_CODEX_MS, then the fast APIs; STRATEGY_CODEX_FIRST=0:
    // the fast APIs first); re-plans are background work (codex first)
    const strategySteps = config.strategyCodexFirst ? [step.codex, step.openrouter, step.openaiApi] : [step.openrouter, step.openaiApi, step.codex];
    const library = `library: ${ctx.content.strategyLibrary.cards.length} strategies (${ctx.content.strategyLibrary.source})`;
    ctx.log(
      config.runtimeAi
        ? `[server] strategist («Учитель»): strategy ${chainOf(strategySteps)}${config.strategyCodexFirst && step.codex !== null ? ` (codex ≤ ${config.strategyCodexMs} ms)` : ''} · re-plans ${chainOf([step.codex, step.openrouter, step.openaiApi])} · ${library}`
        : `[server] strategist («Учитель»): template only (runtime AI off) · ${library}`,
    );
    // «Дозапись голоса» (GAMBIT_CLIP_GEN): the state, then the jobs of the overlay ledger left by the last run
    const clip = ctx.clipGen.health();
    ctx.log(
      clip.state === 'off'
        ? `[server] recording new phrases: off (GAMBIT_CLIP_GEN)${clip.overlay ? ' · recorded phrases are served from the overlay' : ''}`
        : `[server] recording new phrases: ${clip.state}${clip.reason !== undefined ? ` (${clip.reason})` : ''} · daily max ${config.clipGen.dailyMaxMilli / 1000}, budget ${config.clipGen.budgetMilli / 1000} credits`,
    );
    if (accounts !== null) {
      ctx.log(
        `[server] accounts: on — ${accounts.store.count()} account(s), data in ${join(config.dataDir, 'users')} · sign-up ${config.accounts.openRegistration ? `open to everyone (proof of work ${config.accounts.powBits} bits)` : config.accounts.inviteCode !== null ? 'open with the invite code' : 'by the families\' codes only (no GAMBIT_INVITE_CODE)'} · ` +
          `cookie ${config.accounts.cookieSecure ? 'Secure' : 'not Secure (http)'} · client address ${config.accounts.trustProxy ? 'X-Real-IP of the proxy' : 'the socket'}`,
      );
    }
    ctx.clipGen.start();
    // reviews that were still pending when the server last stopped
    if (config.autoReview) ctx.reviews.resumePending();
    // warm the (cached) codex status so the first /api/health is instant — never while runtime AI is off (no spawn)
    if (config.runtimeAi) void ctx.codex.status();
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[server] Port ${config.port} is already in use — is another Гамбитик server running?`);
    } else {
      console.error('[server] Failed to start:', error.message);
    }
    process.exit(1);
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const closeAll = async (): Promise<void> => {
      await accounts?.close().catch(() => undefined);
      await ctx.close();
    };
    server.close(() => {
      void closeAll().finally(() => process.exit(0));
    });
    // Do not hang on keep-alive connections or a running LLM job.
    setTimeout(() => {
      void closeAll().finally(() => process.exit(0));
    }, 1_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Start only when executed directly (`node src/index.ts`), not when imported by tests.
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[server] Failed to start:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
