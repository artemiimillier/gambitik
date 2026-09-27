/**
 * «Продолжить партию?» — the game in progress survives a closed tab, Cmd+R or a discarded laptop tab
 * (requirement 7: every game, move and thought is kept).
 *
 * The game controller writes a snapshot of the whole journal (moves, clocks, events, judgements, coach counters)
 * to localStorage after every move / journal event. On the next GameScreen mount the child is offered to go on;
 * a snapshot that is declined, too old, or belongs to a game that had already ended becomes an ordinary
 * GameRecord ('abandoned', or the real result) parked in the unsaved-games queue — nothing is ever lost, and a
 * game id reaches the server exactly once (POST /games ignores a second record with the same id).
 *
 * STABLE PATH for the shell: `import('../features/game/resume.ts')` → `hasResumableGame()`, `clearResumableGame()`,
 * `resumableGameInfo()`. This module is light: no engines, no React, no network.
 */
import { Chess } from 'chess.js';
import { PERSONAS, getPersona } from '@gambit/content';
import type { LessonGameState, LessonHistory, TeachMemory } from '@gambit/core';
import { PERSONA_IDS, TIME_CONTROLS, TIME_CONTROL_IDS } from '@gambit/shared';
import type { GameEvent, GameRecord, GameResult, MoveJudgement, ReplanResponse, Termination } from '@gambit/shared';
import type { GameConfig, KeyValueStorage, MoveEntry, OpeningLookup } from './gameTypes.ts';
import { MIN_CHILD_MOVES_TO_SAVE, buildGameRecord, recordCoachStyle } from './record.ts';
import { browserStorage } from './storage.ts';
import { storeUnsavedGame } from './unsavedGames.ts';

export const RESUME_GAME_KEY = 'gambit.resumeGame';
/**
 * 2 (teacher mode): `config.coachStyle` and the teacher's memory (`teach`). Version-1 snapshots are still read — their
 * style is derived from `examMode` (exam, else helper). Additive, still 2 (the smart strategist): `config.strategy` (the strategy of the game) and `teach.strategy` (where the plan stands, the last re-plan).
 * Additive, still 2: `pendingOffer` — the take-back question that was on the screen.
 * Additive, still 2 (the lesson, docs/TEACHING.md §4.6): `lesson.book` — the phrase book's per-game state, for EVERY
 * coach style (read tolerantly by core's `createLessonBook`; an older snapshot without it starts a fresh bag).
 * Additive, still 2: `lesson.history` — the child's cross-game lesson memory as the game has changed it so far (an older
 * snapshot without it continues from localStorage's copy).
 */
export const RESUME_VERSION = 2;
const READABLE_VERSIONS: readonly number[] = [1, RESUME_VERSION];
const CONFIG_STYLES: readonly unknown[] = ['teacher', 'helper', 'exam', 'auto'];
/** Snapshots older than this are not offered — they go to the journal as unfinished games. */
export const RESUME_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** Coach bookkeeping that must survive a reload (budgets are per game, not per page load). */
export interface ResumeCounters {
  offersMade: number;
  /** null = never */
  lastOfferPly: number | null;
  lastPraisePly: number | null;
  threatWarnings: number;
  lastThreatWarningPly: number | null;
  routineAfterPunishSaid: boolean;
  movesShown: number;
  openingIdeaSaid: boolean;
  /** «Вернуть ход» was already used for the move the child is thinking about */
  undoUsedAtPly: number | null;
}

/**
 * «Учитель» + the smart strategist: where the plan stands (the strategy itself lives in `config.strategy`). Optional —
 * snapshots without it continue with no re-plan yet (read tolerantly: a malformed part is ignored).
 */
export interface ResumeStrategyState {
  /** the game is on the strategy's line ('on'), left it ('off'), finished it ('done') or nobody knows ('unknown') */
  lineStatus: 'on' | 'off' | 'done' | 'unknown';
  /** the child's ply of the last re-plan request; null = none yet */
  lastReplanPly: number | null;
  /** the phase the current plan was made for */
  planPhase: 'opening' | 'middlegame' | 'endgame';
  /** the latest accepted re-plan and the key (first four FEN fields) of the position it was made for */
  replan: { answer: ReplanResponse; fenKey: string } | null;
}

export interface ResumableGame {
  /** 1 = before teacher mode (no coach style, no teacher memory) */
  v: 1 | typeof RESUME_VERSION;
  /** wall clock, ISO */
  savedAt: string;
  gameId: string;
  config: GameConfig;
  nickname: string;
  stage: number;
  startedAt: string;
  /** ms since game start on the game's own monotonic clock — new journal events continue from here */
  elapsedMs: number;
  /** main line on the board */
  moves: MoveEntry[];
  events: GameEvent[];
  judgements: MoveJudgement[];
  /** indices into `judgements`: attempts that were taken back */
  takenBack: number[];
  clock: { w: number | null; b: number | null };
  opening: OpeningLookup | null;
  counters: ResumeCounters;
  /** set once the game is over but its record is not delivered yet (tab closed on the result card) */
  ended: { result: GameResult; termination: Termination } | null;
  /** «Учитель»: what the teacher has already said this game (principles, topics, the plan…); absent in v1 */
  teach?: { memory: TeachMemory; strategy?: ResumeStrategyState | null } | null;
  /**
   * «Вернуть ход?» was on the screen: the last move (the child's, `ply` / `uci`) waits for the child's choice, and the
   * clocks from before it restore it on «Верну ход». Absent = no open question. Read tolerantly: a malformed one is
   * ignored and the game goes on (the bot answers).
   */
  pendingOffer?: ResumePendingOffer | null;
  /**
   * The lesson: the phrase book of this game (which wordings were said, its PRNG) and the cross-game memory with what this
   * game has added to it so far (mini-lessons heard, wordings said, habits — localStorage gets them only at the end);
   * absent in older snapshots
   */
  lesson?: { book: LessonGameState; history?: LessonHistory } | null;
}

/** The open take-back question of a snapshot. */
export interface ResumePendingOffer {
  ply: number;
  uci: string;
  childClockBefore: number | null;
  botClockBefore: number | null;
}

export interface ResumableGameInfo {
  gameId: string;
  config: GameConfig;
  personaName: string;
  /** plies on the board */
  moveCount: number;
  savedAt: string;
}

// ───────────────────────── validation ─────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isConfig(value: unknown): value is GameConfig {
  if (!isObject(value)) return false;
  return (
    (PERSONA_IDS as readonly unknown[]).includes(value.personaId) &&
    (TIME_CONTROL_IDS as readonly unknown[]).includes(value.timeControlId) &&
    (value.childColor === 'w' || value.childColor === 'b') &&
    typeof value.examMode === 'boolean' &&
    (value.coachStyle === undefined || CONFIG_STYLES.includes(value.coachStyle))
  );
}

function isClockValue(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/** The stored main line must be a legal game from the start position, and every entry must agree with it. */
function movesAreConsistent(moves: unknown, childColor: GameConfig['childColor']): moves is MoveEntry[] {
  if (!Array.isArray(moves)) return false;
  const chess = new Chess();
  for (const [index, raw] of moves.entries()) {
    if (!isObject(raw) || typeof raw.uci !== 'string' || typeof raw.san !== 'string' || typeof raw.fenAfter !== 'string') return false;
    if (raw.ply !== index + 1 || chess.fen() !== raw.fenBefore) return false;
    const mover = chess.turn();
    if (raw.color !== mover || raw.by !== (mover === childColor ? 'child' : 'bot')) return false;
    try {
      const move = chess.move({ from: raw.uci.slice(0, 2), to: raw.uci.slice(2, 4), promotion: raw.uci.slice(4) || undefined });
      if (move.san !== raw.san || chess.fen() !== raw.fenAfter) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isSnapshot(value: unknown): value is ResumableGame {
  if (!isObject(value) || typeof value.v !== 'number' || !READABLE_VERSIONS.includes(value.v)) return false;
  if (value.teach !== undefined && value.teach !== null && !(isObject(value.teach) && isObject(value.teach.memory))) return false;
  if (typeof value.gameId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.gameId)) return false;
  if (!isConfig(value.config)) return false;
  if (typeof value.savedAt !== 'string' || Number.isNaN(Date.parse(value.savedAt))) return false;
  if (typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt))) return false;
  if (typeof value.nickname !== 'string' || typeof value.stage !== 'number' || typeof value.elapsedMs !== 'number') return false;
  if (!Array.isArray(value.events) || !value.events.every((e) => isObject(e) && typeof e.type === 'string' && typeof e.t === 'number' && isObject(e.data))) return false;
  if (!Array.isArray(value.judgements) || !value.judgements.every((j) => isObject(j) && typeof j.ply === 'number' && typeof j.uci === 'string')) return false;
  if (!Array.isArray(value.takenBack) || !value.takenBack.every((i) => Number.isInteger(i) && i >= 0 && i < (value.judgements as unknown[]).length)) return false;
  if (!isObject(value.clock) || !isClockValue(value.clock.w) || !isClockValue(value.clock.b)) return false;
  if (!isObject(value.counters)) return false;
  if (value.ended !== null && !(isObject(value.ended) && typeof value.ended.result === 'string' && typeof value.ended.termination === 'string')) return false;
  return movesAreConsistent(value.moves, value.config.childColor);
}

// ───────────────────────── storage ─────────────────────────

/** The valid snapshot in `storage`, or null. A broken one is removed (it can never be resumed). */
export function readResumableGame(storage: KeyValueStorage | null | undefined): ResumableGame | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(RESUME_GAME_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isSnapshot(parsed)) return parsed;
  } catch {
    // fall through: unreadable
  }
  try {
    storage.removeItem(RESUME_GAME_KEY);
  } catch {
    // nothing else to do
  }
  return null;
}

export function writeResumableGame(storage: KeyValueStorage | null | undefined, snapshot: ResumableGame): boolean {
  if (!storage) return false;
  try {
    storage.setItem(RESUME_GAME_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false; // quota / blocked storage: the game goes on, the fallback (abandoned record) still works
  }
}

/** Removes the snapshot WITHOUT keeping a record. With `gameId`: only when the stored snapshot is that game. */
export function dropResumableGame(storage: KeyValueStorage | null | undefined, gameId?: string): void {
  if (!storage) return;
  try {
    if (gameId !== undefined) {
      const raw = storage.getItem(RESUME_GAME_KEY);
      if (!raw || !raw.includes(`"gameId":"${gameId}"`)) return;
    }
    storage.removeItem(RESUME_GAME_KEY);
  } catch {
    // storage is decoration here
  }
}

// ───────────────────────── snapshot → record ─────────────────────────

/** The journal form of a snapshot: the real result when the game had ended, otherwise an 'abandoned' game. */
export function recordFromSnapshot(snapshot: ResumableGame): GameRecord | null {
  const childMoves = snapshot.moves.filter((move) => move.by === 'child').length;
  if (childMoves < MIN_CHILD_MOVES_TO_SAVE) return null;
  const result: GameResult = snapshot.ended?.result ?? '*';
  const termination: Termination = snapshot.ended?.termination ?? 'abandoned';
  const events = [...snapshot.events];
  if (!events.some((event) => event.type === 'gameEnd')) {
    const lastT = events[events.length - 1]?.t ?? 0;
    events.push({ t: Math.max(lastT, Math.round(snapshot.elapsedMs)), type: 'gameEnd', ply: snapshot.moves.length, data: { result, termination, outcome: 'unfinished', interrupted: true } });
  }
  const takenBack = new Set(snapshot.takenBack.map((index) => snapshot.judgements[index]).filter((j): j is MoveJudgement => j !== undefined));
  return buildGameRecord({
    id: snapshot.gameId,
    config: snapshot.config,
    persona: getPersona(snapshot.config.personaId) ?? PERSONAS[snapshot.config.personaId],
    timeControl: TIME_CONTROLS[snapshot.config.timeControlId],
    nickname: snapshot.nickname,
    startedAt: new Date(snapshot.startedAt),
    endedAt: new Date(Math.max(Date.parse(snapshot.savedAt), Date.parse(snapshot.startedAt))),
    moves: snapshot.moves,
    result,
    termination,
    opening: snapshot.opening ?? undefined,
    events,
    judgements: snapshot.judgements,
    takenBack,
    stage: snapshot.stage,
    coachStyle: recordCoachStyle(snapshot.config),
  });
}

/**
 * Ends the life of a snapshot: its record (if the game is worth one) is parked in the unsaved-games queue — the
 * shell and the next game start deliver it — and the snapshot is removed. Returns the parked record id, if any.
 */
export function settleResumableGame(storage: KeyValueStorage | null | undefined): string | null {
  const snapshot = readResumableGame(storage);
  if (!snapshot) return null;
  let parkedId: string | null = null;
  try {
    const record = recordFromSnapshot(snapshot);
    if (record && storeUnsavedGame(storage, record)) parkedId = record.id;
    // a record that could not be parked (quota) keeps its snapshot: better an old question than a lost game
    if (record && parkedId === null) return null;
  } catch {
    // a snapshot that cannot become a record is of no use to anybody
  }
  dropResumableGame(storage);
  return parkedId;
}

// ───────────────────────── public API for the shell ─────────────────────────

function isFresh(snapshot: ResumableGame, now: Date): boolean {
  const age = now.getTime() - Date.parse(snapshot.savedAt);
  return age >= -60_000 && age <= RESUME_MAX_AGE_MS;
}

/** The snapshot the child may be offered to continue, or null (a stale / finished one is settled on the way). */
export function resumableGame(storage: KeyValueStorage | null | undefined = browserStorage(), now: Date = new Date()): ResumableGame | null {
  const snapshot = readResumableGame(storage);
  if (!snapshot) return null;
  if (snapshot.ended !== null || snapshot.moves.length === 0 || !isFresh(snapshot, now)) {
    settleResumableGame(storage);
    return null;
  }
  return snapshot;
}

/** True when there is an interrupted game the child can continue («Продолжить партию?»). */
export function hasResumableGame(storage: KeyValueStorage | null | undefined = browserStorage(), now: Date = new Date()): boolean {
  return resumableGame(storage, now) !== null;
}

/** What the Home screen needs to offer the game (and to route to `#/play?…` with the right settings). */
export function resumableGameInfo(storage: KeyValueStorage | null | undefined = browserStorage(), now: Date = new Date()): ResumableGameInfo | null {
  const snapshot = resumableGame(storage, now);
  if (!snapshot) return null;
  const persona = getPersona(snapshot.config.personaId) ?? PERSONAS[snapshot.config.personaId];
  return { gameId: snapshot.gameId, config: snapshot.config, personaName: persona.name, moveCount: snapshot.moves.length, savedAt: snapshot.savedAt };
}

/** «Новая партия»: the interrupted game goes to the journal as unfinished, the question is not asked again. */
export function clearResumableGame(storage: KeyValueStorage | null | undefined = browserStorage()): void {
  settleResumableGame(storage);
}

// ───────────────────────── the lesson: the phrase book across games ─────────────────────────

/**
 * localStorage: the child's cross-game lesson memory (core `LessonHistory`: recently said wordings, mini-lesson levels,
 * praise habits, the takeaways of the last games). Read when a game starts, written once in `finish()` (docs/TEACHING.md
 * §4.6); a game in progress keeps its copy in the resume snapshot (`resumedLessonHistory`). It is only this browser's own
 * storage — automation reads and writes it too (nothing leaves the page).
 */
export const LESSON_BOOK_KEY = 'gambit.lessonBook';
/** The stored history never grows past this (oldest entries go first). */
export const LESSON_BOOK_MAX_CHARS = 16 * 1024;

/** The stored history as parsed JSON (core's `createLessonBook` restores it tolerantly), or null. Never throws. */
export function readLessonHistory(storage: KeyValueStorage | null | undefined): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LESSON_BOOK_KEY);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/**
 * The memory a CONTINUED game goes on with: its snapshot's copy — it holds what this game taught before the reload, which
 * localStorage gets only in `finish()` (and `finishGame` then counts the game once) — unless localStorage is ahead of it
 * (a game finished since, in another tab: a higher `gameSeq`) or the snapshot is older than this field. Never throws.
 */
export function resumedLessonHistory(snapshotHistory: unknown, stored: unknown): unknown {
  if (!isObject(snapshotHistory)) return stored;
  const seq = (history: unknown): number => (isObject(history) && typeof history.gameSeq === 'number' && Number.isFinite(history.gameSeq) ? history.gameSeq : -1);
  return seq(snapshotHistory) >= seq(stored) ? snapshotHistory : stored;
}

/**
 * The history cut to `maxChars` of JSON: first the per-pool lists of recent wordings lose their oldest numbers (they are
 * kept oldest first), then the learner lists (takeaways, habits) keep only their newest entries, then retired
 * mini-lessons go; as a last resort the recent wordings are dropped (the per-game bag still rules — only the variety
 * across games suffers).
 */
export function trimLessonHistory(history: LessonHistory, maxChars: number = LESSON_BOOK_MAX_CHARS): LessonHistory {
  const out = JSON.parse(JSON.stringify(history)) as LessonHistory;
  const fits = (): boolean => JSON.stringify(out).length <= maxChars;
  if (fits()) return out;
  for (const keep of [8, 6, 4, 3, 2, 1]) {
    for (const [pool, list] of Object.entries(out.recent)) out.recent[pool] = list.slice(-keep);
    if (fits()) return out;
  }
  out.takeaways = out.takeaways.slice(-6);
  for (const [reason, games] of Object.entries(out.habits)) out.habits[reason] = games.slice(-6);
  if (fits()) return out;
  for (const [topic, mini] of Object.entries(out.minis)) if (mini.retired === true) delete out.minis[topic];
  if (fits()) return out;
  out.recent = {};
  if (fits()) return out;
  out.habits = {};
  out.habitSaid = {};
  return out;
}

/** Writes the history (trimmed to `LESSON_BOOK_MAX_CHARS`). False: no storage, or the write failed (quota). */
export function writeLessonHistory(storage: KeyValueStorage | null | undefined, history: LessonHistory): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LESSON_BOOK_KEY, JSON.stringify(trimLessonHistory(history)));
    return true;
  } catch {
    return false; // the next game simply remembers less
  }
}
