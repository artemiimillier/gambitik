/**
 * Rebuilds the game index of Гамбитик (the SQLite database) from the files in DATA_DIR — for the day app.sqlite is
 * lost or damaged (journal-9). Reads only; writes one NEW database file and nothing else.
 *
 *   data/games/**\/<base>.json  — the machine twin (storage/gameData.ts): the exact record, review, thoughts, flag
 *   data/games/**\/<base>.md    — the journal: front matter + review block, for games saved before the twins existed
 *   data/games/**\/<base>.pgn   — the moves of such a game
 *   data/student/progress.json  — the student profile (puzzle ratings, stage, pseudonym) and the puzzle rating history
 *
 * A game rebuilt from its journal alone keeps its result, accuracy, mistakes, review and «играл взрослый» flag, but
 * not the per-move judgements: its record is flagged (REBUILT_FROM_JOURNAL) and the server never overwrites that
 * journal. Lost for good: single puzzle attempts, voice minutes, the strategy history — none of them is progress.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PERSONA_IDS, TIME_CONTROL_IDS } from '@gambit/shared';
import type { GameExclusion, GameRecord, GameResult, PersonaId, StudentProfile, Termination, TimeControlId } from '@gambit/shared';
import { loadContent } from '../../apps/server/src/content.ts';
import type { ContentBundle } from '../../apps/server/src/content.ts';
import { gameRecordSchema, studentProfileSchema } from '../../apps/server/src/schemas.ts';
import { defaultProfile, recountProfile } from '../../apps/server/src/services/profile.ts';
import { themeTitle } from '../../apps/server/src/services/progress.ts';
import { migrate, openDb } from '../../apps/server/src/storage/db.ts';
import { REBUILT_FROM_JOURNAL, parseGameDataFile } from '../../apps/server/src/storage/gameData.ts';
import type { GameDataFile } from '../../apps/server/src/storage/gameData.ts';
import { PROVIDER_RU, REVIEW_END, REVIEW_START } from '../../apps/server/src/storage/journal.ts';
import { Repo } from '../../apps/server/src/storage/repo.ts';
import type { StoredReview } from '../../apps/server/src/storage/repo.ts';

export class RebuildRefused extends Error {}

export interface RebuildOptions {
  /** DATA_DIR to read (never written) */
  dataDir: string;
  /** the NEW database file; must not exist */
  out: string;
  now?: () => Date;
  /** test seam: content without the dynamic imports */
  content?: ContentBundle;
}

export interface RebuildSummary {
  games: number;
  /** rebuilt exactly from the machine twin */
  exact: number;
  /** rebuilt from the journal + PGN (no per-move judgements) */
  fromJournal: string[];
  skipped: { file: string; reason: string }[];
  reviews: number;
  thoughts: number;
  excluded: number;
  /** the profile came from data/student/progress.json (else: defaults + the pseudonym of the journals) */
  profileRestored: boolean;
  ratingPoints: number;
}

// ───────────────────────── reading the journal ─────────────────────────

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

/** `takebacks: { offered: 1, accepted: 0 }` — the flow maps our journals write, nothing more. */
function parseFlowMap(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const match of raw.slice(1, -1).matchAll(/([A-Za-z_]+):\s*("(?:[^"\\]|\\.)*"|[^,}]+)/g)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) out[key] = parseScalar(value);
  }
  return out;
}

/** The front matter of a game journal (`schema: game-journal/1`), or null. */
export function parseFrontMatter(markdown: string): Record<string, unknown> | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') return null;
  const out: Record<string, unknown> = {};
  for (const line of lines.slice(1)) {
    if (line === '---') return out.schema === 'game-journal/1' ? out : null;
    const match = /^([A-Za-z_]+):\s?(.*)$/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) continue;
    const value = match[2].trim();
    out[match[1]] = value.startsWith('{') && value.endsWith('}') ? parseFlowMap(value) : parseScalar(value);
  }
  return null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function count(value: unknown): number {
  return Math.max(0, Math.round(num(value)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

const RESULTS: readonly GameResult[] = ['1-0', '0-1', '1/2-1/2', '*'];
const TERMINATIONS: readonly Termination[] = ['checkmate', 'resign', 'timeout', 'stalemate', 'draw', 'abandoned'];
const EXCLUSIONS: readonly GameExclusion[] = ['adult', 'archived'];
const REVIEW_STATUSES = ['pending', 'ready', 'template', 'failed'] as const;

/** The review as the journal shows it: the text, «Главное», the provider — the theme key itself is not in the file. */
export function parseJournalReview(markdown: string, status: StoredReview['status']): Omit<StoredReview, 'gameId' | 'updatedAt'> {
  const empty = { status, provider: 'template' as const, markdown: '', keyTakeaways: [], suggestedTheme: null };
  const start = markdown.indexOf(REVIEW_START);
  const end = markdown.indexOf(REVIEW_END, start);
  if (start < 0 || end < 0 || (status !== 'ready' && status !== 'template')) return empty;
  let block = markdown.slice(start + REVIEW_START.length, end).trim();
  let provider: StoredReview['provider'] = 'template';
  const source = /\n?_Источник разбора: (.+?)\. Оценки ходов[^\n]*_\s*$/.exec(block);
  if (source) {
    const label = source[1] ?? '';
    provider = (Object.entries(PROVIDER_RU).find(([, text]) => text === label)?.[0] as StoredReview['provider'] | undefined) ?? 'template';
    block = block.slice(0, source.index).trimEnd();
  }
  block = block.replace(/\n*\*\*Что потренировать:\*\*[^\n]*$/, '').trimEnd();
  const keyTakeaways: string[] = [];
  const main = block.lastIndexOf('\n### Главное\n');
  if (main >= 0) {
    for (const line of block.slice(main + '\n### Главное\n'.length).split('\n')) {
      if (line.startsWith('- ')) keyTakeaways.push(line.slice(2).replace(/\\\|/g, '|').trim());
    }
    block = block.slice(0, main).trimEnd();
  }
  return { status, provider, markdown: block.trim(), keyTakeaways, suggestedTheme: null };
}

/** A record from the journal and its PGN: everything the header knows; the per-move judgements are gone. */
export function recordFromJournal(markdown: string, pgn: string | null): { record: GameRecord; excluded: GameExclusion | null; review: Omit<StoredReview, 'gameId' | 'updatedAt'> } | string {
  const fm = parseFrontMatter(markdown);
  if (fm === null) return 'no game-journal/1 front matter';
  const startedMs = typeof fm.date === 'string' ? Date.parse(fm.date) : Number.NaN;
  if (!Number.isFinite(startedMs)) return 'no date';
  const minutes = /\n\| Длительность \| (\d+) мин/.exec(markdown);
  const endedMs = startedMs + (minutes ? Number(minutes[1]) * 60_000 : 0);
  const takebacks = typeof fm.takebacks === 'object' && fm.takebacks !== null ? (fm.takebacks as Record<string, unknown>) : {};
  const coachStyle = oneOf(fm.coach_style, ['teacher', 'helper', 'exam'] as const);
  const candidate = {
    id: fm.game_id,
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    personaId: oneOf<PersonaId>(fm.opponent, PERSONA_IDS),
    timeControlId: oneOf<TimeControlId>(fm.time_control, TIME_CONTROL_IDS),
    childColor: fm.child_color === 'black' ? 'b' : fm.child_color === 'white' ? 'w' : null,
    result: oneOf(fm.result, RESULTS),
    termination: oneOf(fm.termination, TERMINATIONS),
    pgn: pgn ?? '',
    events: [{ t: 0, type: 'gameStart', data: { [REBUILT_FROM_JOURNAL]: true } }],
    judgements: [],
    summary: {
      accuracy: Math.min(100, Math.max(0, num(fm.accuracy))),
      acpl: Math.max(0, num(fm.acpl)),
      counts: { best: 0, excellent: 0, good: 0, inaccuracy: count(fm.inaccuracies), mistake: count(fm.mistakes), blunder: count(fm.blunders), missedWin: count(fm.missed_wins) },
      takebacksOffered: count(takebacks.offered),
      takebacksAccepted: count(takebacks.accepted),
      hintsUsed: count(fm.hints_used),
      motifsMissed: [],
      motifsAllowed: [],
      ...(typeof fm.opening === 'string' && fm.opening !== '' ? { openingName: fm.opening.slice(0, 200) } : {}),
      keyMoments: [],
    },
    examMode: fm.exam_mode === true,
    ...(coachStyle !== null ? { coachStyle } : {}),
  };
  const parsed = gameRecordSchema.safeParse(candidate);
  if (!parsed.success) return `the header does not make a valid game (${parsed.error.issues[0]?.path.join('.') ?? '?'})`;
  const status = oneOf(fm.review, REVIEW_STATUSES) ?? 'pending';
  return { record: parsed.data, excluded: oneOf(fm.excluded, EXCLUSIONS), review: parseJournalReview(markdown, status) };
}

// ───────────────────────── the rebuild ─────────────────────────

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

interface FoundGame {
  base: string;
  data: GameDataFile;
  exact: boolean;
}

/** Refuses anything that could touch a live database: an existing file, the data folder's own app.sqlite. */
export function checkTarget(dataDir: string, out: string): void {
  const target = path.resolve(out);
  if (target === path.resolve(dataDir, 'app.sqlite')) throw new RebuildRefused(`${out} — это рабочая база Гамбитика; новую базу нужно собрать в другой файл`);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(`${target}${suffix}`)) throw new RebuildRefused(`${target}${suffix} уже существует — ничего не перезаписываю, укажите новый файл`);
  }
}

export async function rebuildDb(options: RebuildOptions): Promise<RebuildSummary> {
  const dataDir = path.resolve(options.dataDir);
  const out = path.resolve(options.out);
  checkTarget(dataDir, out);
  const gamesDir = path.join(dataDir, 'games');
  if (!existsSync(gamesDir)) throw new RebuildRefused(`в ${dataDir} нет папки games — это не папка данных Гамбитика`);
  const now = options.now ?? (() => new Date());
  const content = options.content ?? (await loadContent());

  const summary: RebuildSummary = { games: 0, exact: 0, fromJournal: [], skipped: [], reviews: 0, thoughts: 0, excluded: 0, profileRestored: false, ratingPoints: 0 };
  const bases = [...new Set(walk(gamesDir).filter((file) => /\.(json|md|pgn)$/.test(file)).map((file) => file.replace(/\.(json|md|pgn)$/, '')))].sort();
  const found: FoundGame[] = [];
  let newestNickname: { at: number; name: string } | null = null;
  for (const base of bases) {
    const rel = path.relative(dataDir, base).split(path.sep).join('/');
    const twin = readText(`${base}.json`);
    const journal = readText(`${base}.md`);
    const front = journal !== null ? parseFrontMatter(journal) : null;
    if (front !== null && typeof front.student === 'string' && typeof front.date === 'string') {
      const at = Date.parse(front.date);
      if (Number.isFinite(at) && (newestNickname === null || at > newestNickname.at)) newestNickname = { at, name: front.student };
    }
    const exact = twin !== null ? parseGameDataFile(twin) : null;
    if (exact !== null) {
      found.push({ base: rel, data: exact, exact: true });
      continue;
    }
    if (journal === null) {
      if (twin !== null) summary.skipped.push({ file: `${rel}.json`, reason: 'файл повреждён, журнала .md рядом нет' });
      continue;
    }
    const rebuilt = recordFromJournal(journal, readText(`${base}.pgn`));
    if (typeof rebuilt === 'string') {
      summary.skipped.push({ file: `${rel}.md`, reason: rebuilt });
      continue;
    }
    const review = rebuilt.review.status === 'pending' && rebuilt.review.markdown === '' ? null : { ...rebuilt.review, updatedAt: now().toISOString() };
    found.push({ base: rel, data: { schema: 'game-data/1', gameId: rebuilt.record.id, excluded: rebuilt.excluded, record: rebuilt.record, review, thoughts: [] }, exact: false });
  }

  // build into a side file, rename at the very end: a failed run leaves nothing behind
  const partial = `${out}.partial-${process.pid}`;
  const db = openDb(partial);
  try {
    migrate(db);
    const repo = new Repo(db);
    const nowIso = now().toISOString();
    const ids = new Set<string>();
    found.sort((a, b) => Date.parse(a.data.record.startedAt) - Date.parse(b.data.record.startedAt) || a.base.localeCompare(b.base));
    for (const game of found) {
      const { record, excluded, review, thoughts } = game.data;
      if (ids.has(record.id)) {
        summary.skipped.push({ file: game.base, reason: `партия ${record.id} уже есть в другом файле` });
        continue;
      }
      ids.add(record.id);
      repo.tx(() => {
        repo.insertGame(record, game.base, nowIso, excluded);
        if (review !== null) repo.saveReview({ gameId: record.id, status: review.status, provider: review.provider, markdown: review.markdown, keyTakeaways: review.keyTakeaways, suggestedTheme: review.suggestedTheme }, review.updatedAt);
        if (thoughts.length > 0) summary.thoughts += repo.insertThoughts(record.id, thoughts, nowIso);
      });
      summary.games += 1;
      if (game.exact) summary.exact += 1;
      else summary.fromJournal.push(game.base);
      if (review !== null && review.status !== 'pending') summary.reviews += 1;
      if (excluded !== null) summary.excluded += 1;
    }

    // the profile: puzzles, stage and pseudonym from progress.json; everything about games recounted from the games
    let profile: StudentProfile = defaultProfile(now());
    const progress = readText(path.join(dataDir, 'student', 'progress.json'));
    let ratingHistory: unknown = null;
    if (progress !== null) {
      try {
        const snapshot = (JSON.parse(progress) as { snapshot?: { profile?: unknown; puzzleRatingHistory?: unknown } }).snapshot;
        const stored = studentProfileSchema.safeParse(snapshot?.profile);
        if (stored.success) {
          profile = stored.data;
          summary.profileRestored = true;
        }
        ratingHistory = snapshot?.puzzleRatingHistory ?? null;
      } catch {
        // a broken progress.json: defaults
      }
    }
    if (!summary.profileRestored && newestNickname !== null && newestNickname.name.trim() !== '' && newestNickname.name.length <= 40) profile = { ...profile, nickname: newestNickname.name };
    if (Array.isArray(ratingHistory)) {
      for (const point of ratingHistory as unknown[]) {
        if (typeof point === 'object' && point !== null && 'date' in point && 'rating' in point && typeof point.date === 'string' && typeof point.rating === 'number') {
          repo.appendRatingPoint({ date: point.date, rating: point.rating });
          summary.ratingPoints += 1;
        }
      }
    }
    const recounted = recountProfile(profile, repo.countedGamesOldestFirst(), {
      personaOrder: content.personaOrder,
      motifTitleRu: content.motifTitleRu,
      themeTitleRu: (theme) => themeTitle(content.themeTitlesRu, theme),
      now: now(),
    });
    repo.saveProfile(recounted);
    // the stage keeps its place; its mastery is measured on the games played from now on
    repo.saveStageMeta({ gamesAtStageStart: recounted.totals.games });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    db.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${partial}${suffix}`, { force: true });
    throw error;
  }
  db.close();
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${partial}${suffix}`, { force: true });
  checkTarget(dataDir, out);
  renameSync(partial, out);
  return summary;
}
