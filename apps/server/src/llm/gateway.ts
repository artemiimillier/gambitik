/**
 * LLM gateway: one entry point, `generateJson(task, prompt, jsonSchema)`, in front of the provider
 * chain  codex (ChatGPT subscription, preferred) → openrouter (text key) →
 * openai-api (only with a key) → template (always works). A codex usage limit opens its circuit
 * breaker, so the chain falls through to OpenRouter instantly until the limit resets.
 *
 *  - every call runs through a concurrency-1 queue (no bursts against the subscription limits);
 *  - a provider whose usage limit is exhausted is skipped until its reset time (circuit breaker);
 *    auth / spawn problems and repeated failures open the breaker for a few minutes;
 *  - every answer is validated by the caller's `validate`; invalid output counts as a failure
 *    and the next provider is tried.
 *
 * In-game calls (the smart strategist) run on their own `interactive` lane — a second concurrency-1
 * queue, so a 60 s game review never makes the child wait — with the SAME circuit breakers, per-task
 * models, and a hard `deadline`: every provider gets only the time that is left (or less, see
 * `providerTimeoutMs`), and when too little is left the chain jumps straight to the template.
 */
import type { LlmProviderSetting } from '../config.ts';
import { maskSecrets } from '../sanitize.ts';
import { JobQueue } from './queue.ts';
import { LlmProviderError } from './types.ts';
import type { JsonSchema, LlmErrorKind, LlmProvider, LlmTask, ProviderId, ReasoningEffort } from './types.ts';

/** `background` = reviews (the default queue); `interactive` = in-game strategist calls. */
export type GatewayLane = 'background' | 'interactive';

export interface GenerateOptions<T> {
  /** throws when the provider output is not acceptable */
  validate: (data: unknown) => T;
  schemaName: string;
  timeoutMs: number;
  /** restrict / reorder the provider chain for this call (e.g. in-game calls skip slow codex) */
  providers?: readonly ProviderId[];
  /** do not wait behind a running job: answer from the `template` provider right away */
  skipQueueWhenBusy?: boolean;
  /**
   * A different prompt for some providers. Used for privacy tiers: the codex path (consumer ChatGPT
   * account) always gets the base prompt, API providers may get an opted-in richer one.
   */
  promptOverrides?: Partial<Record<ProviderId, string>>;
  /** per-task model for some providers (e.g. the strategist's gpt-5.6-sol); absent = the provider's own model */
  models?: Partial<Record<ProviderId, string>>;
  /** per-task output budget passed to the providers */
  maxOutputTokens?: number;
  /** per-task reasoning effort for the API providers (absent = their default 'low') */
  reasoningEffort?: ReasoningEffort;
  /** a different effort for some providers (the strategist gives Sol 'low' only where it fits the deadline) */
  reasoningEffortFor?: Partial<Record<ProviderId, ReasoningEffort>>;
  /** which queue the call waits in (default `background`) */
  lane?: GatewayLane;
  /**
   * Absolute time (the gateway's `now()` clock) by which the whole chain must be done. Each LLM
   * provider gets at most the time left; with less than MIN_ATTEMPT_MS left only the template runs.
   * A provider that ignores its timeout is abandoned when it runs out (hard race).
   */
  deadline?: number;
  /** caps the time of a single provider (e.g. codex must leave room for OpenRouter) */
  providerTimeoutMs?: Partial<Record<ProviderId, number>>;
  /**
   * the least time before the deadline a provider needs to be started at all (default MIN_ATTEMPT_MS): a paid API that
   * cannot finish in what is left is not called — the next provider (in the end the free template) answers instead
   */
  minAttemptMs?: Partial<Record<ProviderId, number>>;
  /** told about every LLM attempt (not the template): its provider, outcome and time — e.g. to remember a slow codex */
  onAttempt?: (attempt: LlmAttemptReport) => void;
  /** false = no second attempt on flaky / invalid output (in-game calls: the next provider instead) */
  retry?: boolean;
  /** checked before every LLM attempt: true = the answer is no longer wanted (a newer request superseded it) → template only, nothing billed */
  abandonIf?: () => boolean;
  /** when set, every successful answer is logged as `[llm] <label>: <provider> answered in <ms> ms` */
  label?: string;
}

export interface GenerateResult<T> {
  data: T;
  provider: ProviderId;
}

export interface LlmAttemptReport {
  provider: ProviderId;
  /** null = it answered and the answer passed `validate` */
  errorKind: LlmErrorKind | null;
  ms: number;
  /**
   * the time this attempt was granted: its cap, or less when the deadline was near (e.g. the call waited in the lane's
   * queue) — a timeout of a shortened attempt says nothing about the provider's speed
   */
  timeoutMs: number;
  /** the reasoning effort it was asked with (absent = the provider's default) */
  effort?: ReasoningEffort;
}

export interface BreakerState {
  openUntil: number;
  consecutiveFailures: number;
  lastErrorKind: string | null;
}

export interface GatewayOptions {
  /** in chain order; a `template` provider must be included for the zero-API baseline */
  providers: readonly LlmProvider[];
  queue?: JobQueue;
  now?: () => number;
  log?: (message: string) => void;
}

const HOUR_MS = 3_600_000;
const AUTH_COOLDOWN_MS = 10 * 60_000;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const FAILURES_TO_OPEN = 3;
/** below this much time before the deadline an LLM provider is not even started (the template answers) */
export const MIN_ATTEMPT_MS = 400;
/** how long past its own timeout a provider may take before the gateway abandons it (deadline calls only) */
const HARD_RACE_GRACE_MS = 250;

/** Rejects with a `timeout` LlmProviderError when `pending` has not settled within `ms` (the call itself is not cancelled). */
function raceTimeout<T>(pending: Promise<T>, id: ProviderId, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmProviderError(id, 'timeout', `${id} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer));
}

/** Provider ids for an `LLM_PROVIDER` setting; `template` always closes the chain. */
export function providerChain(setting: LlmProviderSetting): ProviderId[] {
  switch (setting) {
    case 'codex':
      return ['codex', 'template'];
    case 'openrouter':
      return ['openrouter', 'template'];
    case 'openai-api':
      return ['openai-api', 'template'];
    case 'template':
      return ['template'];
    case 'auto':
      return ['codex', 'openrouter', 'openai-api', 'template'];
  }
}

export class LlmGateway {
  /** the background lane (game reviews) */
  readonly queue: JobQueue;
  /** the interactive lane (in-game strategist calls) — never waits behind a review */
  readonly interactiveQueue: JobQueue;
  private readonly providers: readonly LlmProvider[];
  /** the provider as a whole (limits, auth, a broken install) + the failures of background jobs */
  private readonly breakers = new Map<ProviderId, BreakerState>();
  /**
   * In-game failures that say nothing about the provider as a whole — too slow for an 8 s budget, a bad
   * choice — pause it for in-game calls only: a codex that needs 7 s must not lose the (free) reviews.
   */
  private readonly interactiveBreakers = new Map<ProviderId, BreakerState>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: GatewayOptions) {
    this.providers = options.providers;
    this.queue = options.queue ?? new JobQueue();
    this.interactiveQueue = new JobQueue();
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /** the configured chain (ids, in order) */
  providerIds(): ProviderId[] {
    return this.providers.map((p) => p.id);
  }

  /** Resolves when both lanes are idle. */
  async onIdle(): Promise<void> {
    await this.queue.onIdle();
    await this.interactiveQueue.onIdle();
  }

  breakerState(id: ProviderId, lane: GatewayLane = 'background'): BreakerState {
    const map = lane === 'interactive' ? this.interactiveBreakers : this.breakers;
    return map.get(id) ?? { openUntil: 0, consecutiveFailures: 0, lastErrorKind: null };
  }

  /** configured and not tripped (for in-game calls: neither the provider nor its in-game breaker) */
  isAvailable(id: ProviderId, lane: GatewayLane = 'background'): boolean {
    const provider = this.providers.find((p) => p.id === id);
    if (provider === undefined || !provider.isConfigured() || this.breakerState(id).openUntil > this.now()) return false;
    return lane !== 'interactive' || this.breakerState(id, 'interactive').openUntil <= this.now();
  }

  /** true when something better than the template could answer right now */
  hasLlm(ids: readonly ProviderId[] = ['codex', 'openrouter', 'openai-api'], lane: GatewayLane = 'background'): boolean {
    return ids.some((id) => id !== 'template' && this.isAvailable(id, lane));
  }

  generateJson<T>(task: LlmTask, prompt: string, jsonSchema: JsonSchema, options: GenerateOptions<T>): Promise<GenerateResult<T>> {
    const queue = options.lane === 'interactive' ? this.interactiveQueue : this.queue;
    if (options.skipQueueWhenBusy === true && queue.busy) {
      return this.run(task, prompt, jsonSchema, { ...options, providers: ['template'] });
    }
    return queue.enqueue(() => this.run(task, prompt, jsonSchema, options));
  }

  dispose(): void {
    for (const provider of this.providers) provider.dispose?.();
  }

  private chain(ids: readonly ProviderId[] | undefined): LlmProvider[] {
    if (ids === undefined) return [...this.providers];
    const chain: LlmProvider[] = [];
    for (const id of ids) {
      const provider = this.providers.find((p) => p.id === id);
      if (provider !== undefined) chain.push(provider);
    }
    return chain;
  }

  /** The timeout of one attempt, or null when the deadline leaves no room for this (LLM) provider. */
  private attemptTimeoutMs(id: ProviderId, options: Pick<GenerateOptions<unknown>, 'timeoutMs' | 'deadline' | 'providerTimeoutMs' | 'abandonIf' | 'minAttemptMs'>): number | null {
    const cap = options.providerTimeoutMs?.[id] ?? options.timeoutMs;
    if (id === 'template') return cap;
    if (options.abandonIf?.() === true) return null;
    if (options.deadline === undefined) return cap;
    const left = options.deadline - this.now();
    if (left < Math.max(MIN_ATTEMPT_MS, options.minAttemptMs?.[id] ?? 0)) return null;
    return Math.max(1, Math.min(cap, left));
  }

  private async run<T>(task: LlmTask, prompt: string, jsonSchema: JsonSchema, options: GenerateOptions<T>): Promise<GenerateResult<T>> {
    let lastError: unknown = null;
    const maxAttempts = options.retry === false ? 1 : 2;
    const lane: GatewayLane = options.lane ?? 'background';
    for (const provider of this.chain(options.providers)) {
      if (!this.isAvailable(provider.id, lane)) continue;
      // one retry for flaky output, none for timeouts / limits / auth
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const timeoutMs = this.attemptTimeoutMs(provider.id, options);
        if (timeoutMs === null) break; // too close to the deadline: straight on to the template
        const startedAt = this.now();
        const effort = options.reasoningEffortFor?.[provider.id] ?? options.reasoningEffort;
        try {
          const providerPrompt = options.promptOverrides?.[provider.id] ?? prompt;
          const model = options.models?.[provider.id];
          const pending = provider.generate({
            task,
            prompt: providerPrompt,
            jsonSchema,
            schemaName: options.schemaName,
            timeoutMs,
            ...(model !== undefined ? { model } : {}),
            ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
            ...(effort !== undefined ? { reasoningEffort: effort } : {}),
          });
          const raw = options.deadline === undefined || provider.id === 'template' ? await pending : await raceTimeout(pending, provider.id, timeoutMs + HARD_RACE_GRACE_MS);
          let data: T;
          try {
            data = options.validate(raw);
          } catch (error) {
            throw new LlmProviderError(provider.id, 'bad_output', `output failed validation: ${error instanceof Error ? error.message.slice(0, 300) : 'invalid'}`);
          }
          this.recordSuccess(provider.id, lane);
          if (options.label !== undefined) this.log(`[llm] ${options.label}: ${provider.id} answered in ${Math.max(0, this.now() - startedAt)} ms`);
          this.report(options, { provider: provider.id, errorKind: null, ms: Math.max(0, this.now() - startedAt), timeoutMs, ...(effort !== undefined ? { effort } : {}) });
          return { data, provider: provider.id };
        } catch (error) {
          lastError = error;
          const kind = error instanceof LlmProviderError ? error.kind : 'failed';
          this.report(options, { provider: provider.id, errorKind: kind, ms: Math.max(0, this.now() - startedAt), timeoutMs, ...(effort !== undefined ? { effort } : {}) });
          const took = options.label !== undefined ? ` after ${Math.max(0, this.now() - startedAt)} ms` : '';
          this.log(`[llm] ${options.label !== undefined ? `${options.label}: ` : ''}${provider.id} failed (${kind}, attempt ${attempt})${took}: ${maskSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
          this.recordFailure(provider.id, error, lane);
          const retryable = (kind === 'bad_output' || kind === 'failed') && provider.id !== 'template';
          if (!retryable || attempt === maxAttempts || !this.isAvailable(provider.id, lane)) break;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('no LLM provider is available');
  }

  /** `onAttempt` for LLM providers only; a throwing listener never breaks the chain */
  private report(options: Pick<GenerateOptions<unknown>, 'onAttempt'>, attempt: LlmAttemptReport): void {
    if (attempt.provider === 'template' || options.onAttempt === undefined) return;
    try {
      options.onAttempt(attempt);
    } catch {
      // the listener's problem, not the chain's
    }
  }

  private recordSuccess(id: ProviderId, lane: GatewayLane): void {
    const fresh: BreakerState = { openUntil: 0, consecutiveFailures: 0, lastErrorKind: null };
    this.breakers.set(id, fresh);
    if (lane === 'interactive') this.interactiveBreakers.set(id, { ...fresh });
  }

  private recordFailure(id: ProviderId, error: unknown, lane: GatewayLane): void {
    if (id === 'template') return; // the baseline is never switched off
    const now = this.now();
    const kind = error instanceof LlmProviderError ? error.kind : 'failed';
    // limits, auth and a broken install concern the provider as a whole; slowness / bad answers in a game only the game
    const providerWide = kind === 'usage_limit' || kind === 'auth' || kind === 'spawn' || kind === 'unsafe';
    const scope: GatewayLane = lane === 'interactive' && !providerWide ? 'interactive' : 'background';
    const state = { ...this.breakerState(id, scope) };
    state.lastErrorKind = kind;
    state.consecutiveFailures += 1;
    if (kind === 'usage_limit') {
      const retryAt = error instanceof LlmProviderError && error.retryAt !== null ? error.retryAt.getTime() : 0;
      state.openUntil = retryAt > now ? retryAt : now + HOUR_MS;
      this.log(`[llm] ${id}: usage limit reached — provider paused until ${new Date(state.openUntil).toISOString()}`);
    } else if (kind === 'auth' || kind === 'spawn' || kind === 'unsafe') {
      state.openUntil = now + AUTH_COOLDOWN_MS;
      if (kind === 'auth' && id === 'codex') this.log('[llm] codex is not logged in — run `codex login` in a terminal to use the ChatGPT subscription');
    } else if (state.consecutiveFailures >= FAILURES_TO_OPEN) {
      state.openUntil = now + FAILURE_COOLDOWN_MS;
      state.consecutiveFailures = 0;
      if (scope === 'interactive') this.log(`[llm] ${id}: ${FAILURES_TO_OPEN} in-game failures in a row — skipped for in-game calls for ${FAILURE_COOLDOWN_MS / 60_000} min (reviews unaffected)`);
    }
    (scope === 'interactive' ? this.interactiveBreakers : this.breakers).set(id, state);
  }
}
