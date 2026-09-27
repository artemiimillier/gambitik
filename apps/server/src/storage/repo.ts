/**
 * Repositories over the app database. Rows are parsed back through the zod schemas at the
 * boundary, so a corrupted row surfaces as an error here instead of leaking to a client.
 */
import type { GameExclusion, GameListItem, GameRecord, GameReview, GameThought, PersonaId, ProgressPoint, PuzzleAttempt, ReviewStatus, StudentProfile } from '@gambit/shared';
import { gameRecordSchema, studentProfileSchema } from '../schemas.ts';
import { kvGet, kvGetJson, kvSetJson } from './db.ts';
import type { Db } from './db.ts';

export interface StoredReview extends GameReview {
  keyTakeaways: string[];
  suggestedTheme: string | null;
  updatedAt: string;
}

export interface StageMeta {
  /** totals.games at the moment the current stage began (= the counting games saved up to `stageStartedAt`) */
  gamesAtStageStart: number;
  /**
   * When the current stage began (ISO; '' = before any game): the games SAVED up to it (`created_at` ≤ it) were played
   * on the earlier stages. Marking / unmarking a game recounts `gamesAtStageStart` from it. Absent in a meta written
   * before the field existed.
   */
  stageStartedAt?: string;
}

export interface RatingPoint {
  date: string;
  rating: number;
}

const KV_PROFILE = 'student-profile';
const KV_STAGE_META = 'stage-meta';
const KV_RATING_HISTORY = 'puzzle-rating-history';
const KV_VOICE_USAGE = 'voice-usage';
const KV_PUZZLE_REPETITION = 'puzzle-repetition';
const KV_STRATEGY_HISTORY = 'strategy-history';
const RATING_HISTORY_LIMIT = 1000;

interface GameListRow {
  id: string;
  started_at: string;
  persona_id: string;
  time_control_id: string;
  child_color: string;
  result: string;
  accuracy: number;
  blunders: number;
  review_status: string | null;
  judged_moves?: number | null;
  excluded?: string | null;
}

/**
 * `GET /games` rows: the contract GameListItem plus the additive `judgedMoves`. A game the engine
 * could not look at is stored with accuracy 0 (the contract field is a number) — clients must show «не считалась»
 * instead of «0 %» when judgedMoves is 0.
 */
export type GameListItemWithJudged = GameListItem & { judgedMoves: number };

interface ReviewRow {
  game_id: string;
  status: string;
  provider: string;
  markdown: string;
  takeaways_json: string;
  suggested_theme: string | null;
  updated_at: string;
}

function parseStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function toReviewStatus(value: string | null): ReviewStatus {
  return value === 'ready' || value === 'template' || value === 'failed' ? value : 'pending';
}

function toProvider(value: string): GameReview['provider'] {
  return value === 'codex' || value === 'openrouter' || value === 'openai-api' ? value : 'template';
}

export function toExclusion(value: string | null | undefined): GameExclusion | null {
  return value === 'adult' || value === 'archived' ? value : null;
}

/** A thought of the child appended after the game was saved (`POST /games/:id/thoughts`). */
export interface StoredThought extends GameThought {
  createdAt: string;
}

interface ThoughtRow {
  item_id: string;
  source: string;
  question: string | null;
  text: string;
  said_at: string;
  created_at: string;
}

export interface ListGamesOptions {
  offset?: number;
  /** only the games that count in the child's progress (not marked «играл взрослый», not archived) */
  countedOnly?: boolean;
}

export class Repo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ───────────── games ─────────────

  hasGame(id: string): boolean {
    return this.db.get('SELECT 1 AS present FROM game WHERE id = ?', id) !== undefined;
  }

  insertGame(record: GameRecord, fileBase: string, nowIso: string, excluded: GameExclusion | null = null): void {
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO game (id, started_at, ended_at, persona_id, time_control_id, child_color, result, termination,
                           accuracy, blunders, exam_mode, record_json, file_base, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.id,
        new Date(record.startedAt).toISOString(),
        new Date(record.endedAt).toISOString(),
        record.personaId,
        record.timeControlId,
        record.childColor,
        record.result,
        record.termination,
        record.summary.accuracy,
        record.summary.counts.blunder,
        record.examMode ? 1 : 0,
        JSON.stringify(record),
        fileBase,
        nowIso,
      );
      // (a separate statement: the column exists from schema version 3 on — older test databases still take a game)
      if (excluded !== null) this.db.run('UPDATE game SET excluded = ? WHERE id = ?', excluded, record.id);
      this.db.run(`INSERT INTO review (game_id, status, provider, markdown, updated_at) VALUES (?, 'pending', 'template', '', ?)`, record.id, nowIso);
    });
  }

  getGame(id: string): GameRecord | undefined {
    const row = this.db.get<{ record_json: string }>('SELECT record_json FROM game WHERE id = ?', id);
    if (row === undefined) return undefined;
    return gameRecordSchema.parse(JSON.parse(row.record_json));
  }

  getGameFileBase(id: string): string | null {
    return this.db.get<{ file_base: string | null }>('SELECT file_base FROM game WHERE id = ?', id)?.file_base ?? null;
  }

  /** Every game that has files, oldest first. */
  gameFileBases(): { id: string; fileBase: string }[] {
    return this.db
      .all<{ id: string; file_base: string }>('SELECT id, file_base FROM game WHERE file_base IS NOT NULL ORDER BY started_at ASC, created_at ASC')
      .map((row) => ({ id: row.id, fileBase: row.file_base }));
  }

  isFileBaseTaken(fileBase: string): boolean {
    return this.db.get('SELECT 1 AS present FROM game WHERE file_base = ?', fileBase) !== undefined;
  }

  /** Newest first; every game unless `countedOnly`. `excluded` says why a game does not count in the progress. */
  listGames(limit: number, options: ListGamesOptions = {}): GameListItemWithJudged[] {
    const rows = this.db.all<GameListRow>(
      `SELECT g.id, g.started_at, g.persona_id, g.time_control_id, g.child_color, g.result, g.accuracy, g.blunders,
              json_array_length(g.record_json, '$.judgements') AS judged_moves,
              r.status AS review_status, g.excluded
         FROM game g LEFT JOIN review r ON r.game_id = g.id
        WHERE (? = 0 OR g.excluded IS NULL)
        ORDER BY g.started_at DESC, g.created_at DESC
        LIMIT ? OFFSET ?`,
      options.countedOnly === true ? 1 : 0,
      limit,
      Math.max(0, Math.floor(options.offset ?? 0)),
    );
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      personaId: row.persona_id as PersonaId,
      timeControlId: row.time_control_id as GameListItem['timeControlId'],
      childColor: row.child_color === 'b' ? 'b' : 'w',
      result: row.result as GameListItem['result'],
      accuracy: row.accuracy,
      blunders: row.blunders,
      reviewStatus: toReviewStatus(row.review_status),
      judgedMoves: Number(row.judged_moves ?? 0),
      excluded: toExclusion(row.excluded),
    }));
  }

  private parseRecords(rows: readonly { record_json: string }[]): GameRecord[] {
    const games: GameRecord[] = [];
    for (const row of rows) {
      const parsed = gameRecordSchema.safeParse(JSON.parse(row.record_json));
      if (parsed.success) games.push(parsed.data);
    }
    return games;
  }

  /** Most recent full records that count in the child's progress, newest first. */
  recentCountedGames(limit: number): GameRecord[] {
    return this.parseRecords(this.db.all<{ record_json: string }>('SELECT record_json FROM game WHERE excluded IS NULL ORDER BY started_at DESC, created_at DESC LIMIT ?', limit));
  }

  /** Every full record that counts in the child's progress, OLDEST first (recounting the profile). */
  countedGamesOldestFirst(): GameRecord[] {
    return this.parseRecords(this.db.all<{ record_json: string }>('SELECT record_json FROM game WHERE excluded IS NULL ORDER BY started_at ASC, created_at ASC'));
  }

  getExcluded(id: string): GameExclusion | null {
    return toExclusion(this.db.get<{ excluded: string | null }>('SELECT excluded FROM game WHERE id = ?', id)?.excluded);
  }

  /** false when there is no such game */
  setExcluded(id: string, excluded: GameExclusion | null): boolean {
    return this.db.run('UPDATE game SET excluded = ? WHERE id = ?', excluded, id).changes > 0;
  }

  /** «Начать прогресс заново»: every game that counts now is archived (nothing is deleted). Returns their ids. */
  archiveCountedGames(): string[] {
    return this.db.tx(() => {
      const ids = this.db.all<{ id: string }>('SELECT id FROM game WHERE excluded IS NULL').map((row) => row.id);
      this.db.run(`UPDATE game SET excluded = 'archived' WHERE excluded IS NULL`);
      return ids;
    });
  }

  /** How many games that count were saved up to `iso` (`created_at` ≤ it): the games played before the stage began. */
  countCountedGamesSavedUpTo(iso: string): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM game WHERE excluded IS NULL AND created_at <= ?', iso)?.n ?? 0);
  }

  /** When the n-th (1-based, oldest first) game that counts was saved; null when there are fewer. */
  countedGameSavedAt(n: number): string | null {
    if (n < 1) return null;
    return this.db.get<{ created_at: string }>('SELECT created_at FROM game WHERE excluded IS NULL ORDER BY created_at ASC LIMIT 1 OFFSET ?', n - 1)?.created_at ?? null;
  }

  countExcludedGames(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM game WHERE excluded IS NOT NULL')?.n ?? 0);
  }

  /** Ids of the newest games (any), newest first. */
  latestGameIds(limit: number): string[] {
    return this.db.all<{ id: string }>('SELECT id FROM game ORDER BY started_at DESC, created_at DESC LIMIT ?', limit).map((row) => row.id);
  }

  /**
   * Chronological (oldest first) points for the progress charts. Games without a single judged move (the engine did
   * not start) are left out: their stored accuracy 0 / blunders 0 are «unknown», not measurements.
   */
  progressPoints(limit: number): ProgressPoint[] {
    const rows = this.db.all<GameListRow>(
      `SELECT id, started_at, persona_id, time_control_id, child_color, result, accuracy, blunders, NULL AS review_status
         FROM game WHERE json_array_length(record_json, '$.judgements') > 0 AND excluded IS NULL
        ORDER BY started_at DESC, created_at DESC LIMIT ?`,
      limit,
    );
    return rows.reverse().map((row) => ({
      date: row.started_at,
      gameId: row.id,
      accuracy: row.accuracy,
      blunders: row.blunders,
      personaId: row.persona_id as PersonaId,
      result: row.result as ProgressPoint['result'],
    }));
  }

  countGames(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM game')?.n ?? 0);
  }

  // ───────────── reviews ─────────────

  getReview(gameId: string): StoredReview | undefined {
    const row = this.db.get<ReviewRow>('SELECT * FROM review WHERE game_id = ?', gameId);
    if (row === undefined) return undefined;
    return {
      gameId: row.game_id,
      status: toReviewStatus(row.status),
      provider: toProvider(row.provider),
      markdown: row.markdown,
      keyTakeaways: parseStringArray(row.takeaways_json),
      suggestedTheme: row.suggested_theme,
      updatedAt: row.updated_at,
    };
  }

  saveReview(review: Omit<StoredReview, 'updatedAt'>, nowIso: string): void {
    this.db.run(
      `INSERT INTO review (game_id, status, provider, markdown, takeaways_json, suggested_theme, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id) DO UPDATE SET status = excluded.status, provider = excluded.provider, markdown = excluded.markdown,
         takeaways_json = excluded.takeaways_json, suggested_theme = excluded.suggested_theme, updated_at = excluded.updated_at`,
      review.gameId,
      review.status,
      review.provider,
      review.markdown,
      JSON.stringify(review.keyTakeaways),
      review.suggestedTheme,
      nowIso,
    );
  }

  pendingReviewGameIds(): string[] {
    return this.db.all<{ game_id: string }>(`SELECT game_id FROM review WHERE status = 'pending' ORDER BY updated_at ASC`).map((row) => row.game_id);
  }

  /** Latest finished reviews of the games that count (for the coach notes of profile.md), newest first. */
  recentReviews(limit: number): (StoredReview & { startedAt: string; personaId: PersonaId })[] {
    const rows = this.db.all<ReviewRow & { started_at: string; persona_id: string }>(
      `SELECT r.*, g.started_at, g.persona_id FROM review r JOIN game g ON g.id = r.game_id
        WHERE r.status IN ('ready', 'template') AND g.excluded IS NULL ORDER BY g.started_at DESC LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({
      gameId: row.game_id,
      status: toReviewStatus(row.status),
      provider: toProvider(row.provider),
      markdown: row.markdown,
      keyTakeaways: parseStringArray(row.takeaways_json),
      suggestedTheme: row.suggested_theme,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      personaId: row.persona_id as PersonaId,
    }));
  }

  // ───────────── the child's thoughts after a game ─────────────

  /** Stores the new thoughts of a game; an id that is already there is skipped. Returns how many were added. */
  insertThoughts(gameId: string, thoughts: readonly GameThought[], nowIso: string): number {
    return this.db.tx(() => {
      let added = 0;
      for (const thought of thoughts) {
        added += this.db.run(
          `INSERT INTO game_thought (game_id, item_id, source, question, text, said_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (game_id, item_id) DO NOTHING`,
          gameId,
          thought.id,
          thought.source,
          thought.question ?? null,
          thought.text,
          new Date(thought.at).toISOString(),
          nowIso,
        ).changes;
      }
      return added;
    });
  }

  countThoughts(gameId: string): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM game_thought WHERE game_id = ?', gameId)?.n ?? 0);
  }

  /** In the order they were said. */
  listThoughts(gameId: string): StoredThought[] {
    return this.db
      .all<ThoughtRow>('SELECT item_id, source, question, text, said_at, created_at FROM game_thought WHERE game_id = ? ORDER BY said_at ASC, created_at ASC, item_id ASC', gameId)
      .map((row) => ({
        id: row.item_id,
        source: row.source === 'typed' ? 'typed' : 'voice',
        ...(row.question !== null ? { question: row.question } : {}),
        text: row.text,
        at: row.said_at,
        createdAt: row.created_at,
      }));
  }

  // ───────────── puzzle attempts ─────────────

  insertAttempt(attempt: PuzzleAttempt, nowIso: string): void {
    this.db.run(
      `INSERT INTO puzzle_attempt (puzzle_id, solved, ms_spent, hints_used, themes, puzzle_rating, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      attempt.puzzleId,
      attempt.solved ? 1 : 0,
      Math.round(attempt.msSpent),
      attempt.hintsUsed,
      attempt.themes.join(' '),
      Math.round(attempt.puzzleRating),
      nowIso,
    );
  }

  hasAttempt(puzzleId: string): boolean {
    return this.db.get('SELECT 1 AS present FROM puzzle_attempt WHERE puzzle_id = ? LIMIT 1', puzzleId) !== undefined;
  }

  /** Distinct ids of the most recently attempted puzzles. */
  recentPuzzleIds(limit: number): string[] {
    const rows = this.db.all<{ puzzle_id: string }>('SELECT puzzle_id FROM puzzle_attempt ORDER BY id DESC LIMIT ?', limit);
    return [...new Set(rows.map((row) => row.puzzle_id))];
  }

  // ───────────── kv: profile, stage meta, rating history ─────────────

  /**
   * The stored profile exactly as it is in the kv table (not validated). `undefined` ONLY when there
   * is no profile yet: text that is not even JSON comes back wrapped, so the caller backs it up
   * instead of silently replacing it with defaults.
   */
  loadProfileRaw(): unknown {
    const text = kvGet(this.db, KV_PROFILE);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { unparsableProfileText: text };
    }
  }

  loadProfile(): StudentProfile | undefined {
    const parsed = studentProfileSchema.safeParse(this.loadProfileRaw());
    return parsed.success ? parsed.data : undefined;
  }

  /** Keeps an unreadable profile for manual recovery instead of silently overwriting it. */
  backupProfile(raw: unknown, nowIso: string): void {
    kvSetJson(this.db, `${KV_PROFILE}.backup.${nowIso}`, raw);
  }

  saveProfile(profile: StudentProfile): void {
    kvSetJson(this.db, KV_PROFILE, profile);
  }

  loadStageMeta(): StageMeta {
    const raw = kvGetJson(this.db, KV_STAGE_META);
    if (typeof raw === 'object' && raw !== null && 'gamesAtStageStart' in raw && typeof raw.gamesAtStageStart === 'number') {
      const startedAt = 'stageStartedAt' in raw && typeof raw.stageStartedAt === 'string' ? raw.stageStartedAt : undefined;
      return { gamesAtStageStart: raw.gamesAtStageStart, ...(startedAt !== undefined ? { stageStartedAt: startedAt } : {}) };
    }
    return { gamesAtStageStart: 0 };
  }

  saveStageMeta(meta: StageMeta): void {
    kvSetJson(this.db, KV_STAGE_META, meta);
  }

  loadRatingHistory(): RatingPoint[] {
    const raw = kvGetJson(this.db, KV_RATING_HISTORY);
    if (!Array.isArray(raw)) return [];
    const points: RatingPoint[] = [];
    for (const item of raw as unknown[]) {
      if (typeof item === 'object' && item !== null && 'date' in item && 'rating' in item && typeof item.date === 'string' && typeof item.rating === 'number') {
        points.push({ date: item.date, rating: item.rating });
      }
    }
    return points;
  }

  appendRatingPoint(point: RatingPoint): void {
    const history = this.loadRatingHistory();
    history.push(point);
    kvSetJson(this.db, KV_RATING_HISTORY, history.slice(-RATING_HISTORY_LIMIT));
  }

  // ───────────── kv: voice usage log ─────────────

  /** Raw stored value (validated by VoiceUsageService). */
  loadVoiceUsageRaw(): unknown {
    return kvGetJson(this.db, KV_VOICE_USAGE);
  }

  saveVoiceUsage(value: unknown): void {
    kvSetJson(this.db, KV_VOICE_USAGE, value);
  }

  // ───────────── kv: spaced repetition of failed puzzles ─────────────

  /** Raw stored value (validated by MistakeRepetition). */
  loadPuzzleRepetitionRaw(): unknown {
    return kvGetJson(this.db, KV_PUZZLE_REPETITION);
  }

  savePuzzleRepetition(value: unknown): void {
    kvSetJson(this.db, KV_PUZZLE_REPETITION, value);
  }

  // ───────────── kv: strategies served to the student («Учитель», variety between games) ─────────────

  /** Raw stored value (validated by StrategyHistory). */
  loadStrategyHistoryRaw(): unknown {
    return kvGetJson(this.db, KV_STRATEGY_HISTORY);
  }

  saveStrategyHistory(value: unknown): void {
    kvSetJson(this.db, KV_STRATEGY_HISTORY, value);
  }

  tx<T>(fn: () => T): T {
    return this.db.tx(fn);
  }
}
