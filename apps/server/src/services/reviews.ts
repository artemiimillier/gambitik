/**
 * Background game reviews: enqueued after `POST /games`, generated through the LLM gateway
 * (codex → openrouter → openai-api → template), stored in the `review` table, then the journal and
 * the student files are regenerated. The prompt carries moves + engine judgements + the pseudonym;
 * the child's words are sent only with the parent's opt-in, and never to codex (llm/prompts.ts). Status: 'ready' for an LLM review, 'template' for the built-in
 * one, 'failed' only if even the template could not be produced.
 */
import type { ContentBundle } from '../content.ts';
import type { LlmGateway } from '../llm/gateway.ts';
import { buildReviewPrompt } from '../llm/prompts.ts';
import { REVIEW_JSON_SCHEMA, parseReviewOutput } from '../llm/reviewSchema.ts';
import type { ReviewOutput } from '../llm/reviewSchema.ts';
import { suggestThemeFromRecord } from '../llm/providers/template.ts';
import type { Repo } from '../storage/repo.ts';
import type { DataFileWriter } from '../storage/writer.ts';
import { stageFor } from '../content.ts';
import type { StudentService } from './student.ts';

export interface ReviewServiceOptions {
  repo: Repo;
  content: ContentBundle;
  gateway: LlmGateway;
  student: StudentService;
  writer: DataFileWriter;
  timeoutMs: number;
  /** REVIEW_INCLUDE_CHILD_SPEECH=1 — parent opt-in; default false */
  includeChildSpeech?: boolean;
  log: (message: string) => void;
}

export class ReviewService {
  private readonly options: ReviewServiceOptions;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: ReviewServiceOptions) {
    this.options = options;
  }

  /**
   * Fire-and-forget; safe to call twice for the same game.
   * `templateOnly`: the game came from an automated test run — never call a paid / rate-limited LLM for it.
   */
  enqueue(gameId: string, opts: { templateOnly?: boolean } = {}): void {
    if (this.inFlight.has(gameId)) return;
    const job = this.generate(gameId, opts.templateOnly === true)
      .catch((error: unknown) => {
        this.options.log(`[review] ${gameId}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.inFlight.delete(gameId);
      });
    this.inFlight.set(gameId, job);
  }

  /** Reviews that were still pending when the server stopped. */
  resumePending(): void {
    for (const gameId of this.options.repo.pendingReviewGameIds()) this.enqueue(gameId);
  }

  /** Resolves when all review jobs started so far are done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight.values()]);
  }

  private allowedThemes(): Record<string, string> {
    const { content } = this.options;
    const keys = new Set<string>();
    for (const stage of content.curriculum) for (const theme of stage.puzzleThemes) keys.add(theme);
    for (const theme of ['hangingPiece', 'fork', 'pin', 'skewer', 'mateIn1', 'mateIn2', 'mateIn3', 'backRankMate', 'discoveredAttack', 'doubleCheck', 'capturingDefender', 'trappedPiece', 'promotion', 'kingsideAttack', 'opening', 'endgame']) keys.add(theme);
    return Object.fromEntries([...keys].map((key) => [key, content.themeTitlesRu[key] ?? key]));
  }

  private async generate(gameId: string, templateOnly: boolean): Promise<void> {
    const { repo, content, gateway, student, writer } = this.options;
    const record = repo.getGame(gameId);
    if (record === undefined) return;
    const profile = student.getProfile();
    const persona = content.personas[record.personaId];
    const allowedThemes = this.allowedThemes();
    const fallbackTheme = stageFor(content.curriculum, profile.stage).puzzleThemes[0] ?? 'hangingPiece';

    try {
      const promptCtx = { reviewPromptRu: content.reviewPromptRu, motifTitleRu: content.motifTitleRu, allowedThemes };
      // base prompt: never any child speech. The opted-in variant goes to the API providers only —
      // never to codex, whose consumer ChatGPT account has its own retention / training settings.
      const prompt = buildReviewPrompt(record, persona, profile, promptCtx);
      const withSpeech = this.options.includeChildSpeech === true ? buildReviewPrompt(record, persona, profile, promptCtx, { includeChildSpeech: true }) : null;
      const { data, provider } = await gateway.generateJson<ReviewOutput>({ kind: 'gameReview', record, persona, profile }, prompt, REVIEW_JSON_SCHEMA, {
        validate: parseReviewOutput,
        schemaName: 'game_review',
        timeoutMs: this.options.timeoutMs,
        ...(withSpeech !== null ? { promptOverrides: { openrouter: withSpeech, 'openai-api': withSpeech } } : {}),
        ...(templateOnly ? { providers: ['template'] as const } : {}),
      });
      // an LLM may only pick a theme we know; otherwise the engine-derived suggestion wins
      const suggestedTheme = provider === 'template' || allowedThemes[data.suggestedTheme] !== undefined ? data.suggestedTheme : suggestThemeFromRecord(record, fallbackTheme);
      repo.saveReview(
        {
          gameId,
          status: provider === 'template' ? 'template' : 'ready',
          provider,
          markdown: data.markdown,
          keyTakeaways: data.keyTakeaways,
          suggestedTheme,
        },
        new Date().toISOString(),
      );
    } catch (error) {
      repo.saveReview({ gameId, status: 'failed', provider: 'template', markdown: '', keyTakeaways: [], suggestedTheme: null }, new Date().toISOString());
      this.options.log(`[review] ${gameId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await writer.writeGameFiles(record);
    await writer.writeStudentFiles();
  }
}
