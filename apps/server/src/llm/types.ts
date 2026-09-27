import type { CoachEvent, GameRecord, Persona, StudentProfile } from '@gambit/shared';

export type ProviderId = 'codex' | 'openrouter' | 'openai-api' | 'template';

export type JsonSchema = Record<string, unknown>;

/** The smart strategist's choice for one game (strategist/strategist.ts): a library id + the spoken intro. */
export interface StrategyChoice {
  strategyId: string;
  introRu: string;
}

/** The smart strategist's re-plan: one of the engine's candidates + the new plan in kid words. */
export interface ReplanChoice {
  planRu: string;
  preferredUci: string | null;
  whyRu: string;
}

/**
 * What is being generated. The task carries the structured facts so the `template` provider can
 * answer without any LLM; the LLM providers only see `prompt` + `jsonSchema`.
 * `strategy` / `replan` carry the deterministic answer the code already computed (the template).
 */
export type LlmTask =
  | { kind: 'gameReview'; record: GameRecord; persona: Persona; profile: StudentProfile }
  | { kind: 'rephrase'; event: CoachEvent }
  | { kind: 'strategy'; fallback: StrategyChoice }
  | { kind: 'replan'; fallback: ReplanChoice };

export interface LlmRequest {
  task: LlmTask;
  prompt: string;
  jsonSchema: JsonSchema;
  /** a-z, A-Z, 0-9, _ and - only (OpenAI structured-output name) */
  schemaName: string;
  timeoutMs: number;
  /** per-task model (e.g. the strategist's gpt-5.6-sol); absent = the provider's configured model */
  model?: string;
  /** per-task output budget (reasoning included); absent = the provider's default */
  maxOutputTokens?: number;
  /**
   * per-task reasoning effort; absent = 'low'. The strategist uses 'none' (a choice among the code's candidates + one
   * short phrase): gpt-5.6-sol answered in 5.7 s via OpenRouter (8.1–9.5 s with 'low' / 'minimal') and in 7.0 s via
   * codex (9.4 s with 'low'; codex refuses 'minimal' for Sol — it gets 'low' then).
   */
  reasoningEffort?: ReasoningEffort;
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium';

/**
 * `rejected` = the upstream refused this request for good (400 / 403 / 404): never retried.
 * `unsafe` = the provider cannot run in its hardened configuration and refuses to run at all.
 */
export type LlmErrorKind = 'usage_limit' | 'auth' | 'timeout' | 'spawn' | 'bad_output' | 'unknown_feature' | 'rejected' | 'unsafe' | 'failed';

export class LlmProviderError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider: ProviderId;
  /** when the provider may be tried again (usage limits) */
  readonly retryAt: Date | null;

  constructor(provider: ProviderId, kind: LlmErrorKind, message: string, retryAt: Date | null = null) {
    super(message);
    this.name = 'LlmProviderError';
    this.provider = provider;
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

export interface LlmProvider {
  readonly id: ProviderId;
  /** cheap, synchronous: is the provider configured at all (binary found / key present)? */
  isConfigured(): boolean;
  /** Resolves with the parsed JSON value (not yet validated); rejects with LlmProviderError. */
  generate(request: LlmRequest): Promise<unknown>;
  /** kills whatever is still running (server shutdown) */
  dispose?(): void;
}
