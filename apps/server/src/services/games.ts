/**
 * Saving a finished game: database row (+ pending review) → profile update → PGN / journal /
 * profile.md / progress.json → background review. Idempotent by game id: a client retry never
 * counts a game twice.
 *
 * The parent's side of the history: a game played by an adult is marked «играл взрослый / проверка» and
 * «Начать прогресс заново» archives the games that count — nothing is ever deleted, the profile is recounted from
 * the games that still count. The child's thoughts that arrive after the record was saved (the talk after the game,
 * the diary) are appended to one of the latest games.
 */
import type { GameExclusion, GameRecord, GameThought, StudentProfile } from '@gambit/shared';
import type { ContentBundle } from '../content.ts';
import { allocateGameFileBase } from '../storage/files.ts';
import type { Repo, StageMeta } from '../storage/repo.ts';
import type { DataFileWriter } from '../storage/writer.ts';
import { RECENT_GAMES_WINDOW, applyGameToProfile, recountProfile, withConceptsOf } from './profile.ts';
import { themeTitle } from './progress.ts';
import type { ReviewService } from './reviews.ts';
import type { StudentService } from './student.ts';

/** Thoughts are accepted for this many newest games only (the talk after the game, not a history editor). */
export const THOUGHT_GAMES_WINDOW = 3;
/** A post-game talk is short; beyond this a game takes no more thoughts. */
export const MAX_THOUGHTS_PER_GAME = 60;

export interface GameServiceOptions {
  dataDir: string;
  repo: Repo;
  content: ContentBundle;
  student: StudentService;
  writer: DataFileWriter;
  reviews: ReviewService;
  autoReview: boolean;
}

export type AddThoughtsResult = { status: 'ok'; added: number; total: number } | { status: 'not-found' } | { status: 'too-old' };

/** One line of plain text: the journal quotes it inline. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export class GameService {
  private readonly options: GameServiceOptions;

  constructor(options: GameServiceOptions) {
    this.options = options;
  }

  async save(record: GameRecord, opts: { templateReviewOnly?: boolean } = {}): Promise<{ id: string; created: boolean }> {
    const { repo, content, student, writer, reviews } = this.options;
    if (repo.hasGame(record.id)) return { id: record.id, created: false };

    const nowIso = new Date().toISOString();
    repo.tx(() => {
      const fileBase = allocateGameFileBase(this.options.dataDir, record.startedAt, record.personaId, (base) => repo.isFileBaseTaken(base));
      repo.insertGame(record, fileBase, nowIso);
      const stored = student.getProfile();
      // a profile from before `conceptsIntroduced`: the cards of the games that count so far (this one included) once
      const before = stored.conceptsIntroduced === undefined ? { ...stored, conceptsIntroduced: withConceptsOf([], repo.countedGamesOldestFirst()) } : stored;
      const stageMeta = repo.loadStageMeta();
      // games marked «играл взрослый» or archived never shape the child's weaknesses, strengths or stage
      const after = applyGameToProfile(before, record, repo.recentCountedGames(RECENT_GAMES_WINDOW), {
        personaOrder: content.personaOrder,
        curriculum: content.curriculum,
        motifTitleRu: content.motifTitleRu,
        themeTitleRu: (theme) => themeTitle(content.themeTitlesRu, theme),
        gamesAtStageStart: stageMeta.gamesAtStageStart,
      });
      if (after.stage !== before.stage) repo.saveStageMeta({ gamesAtStageStart: after.totals.games, stageStartedAt: nowIso });
      student.saveProfile(after);
    });

    await writer.writeGameFiles(record);
    await writer.writeStudentFiles();
    if (this.options.autoReview) reviews.enqueue(record.id, { templateOnly: opts.templateReviewOnly === true });
    return { id: record.id, created: true };
  }

  /**
   * When the current stage began. A meta written before `stageStartedAt` existed gets it once, from the games that
   * count BEFORE a game is marked / unmarked: the moment the `gamesAtStageStart`-th of them was saved.
   */
  private stageStart(): Required<StageMeta> {
    const { repo } = this.options;
    const meta = repo.loadStageMeta();
    if (meta.stageStartedAt !== undefined) return { gamesAtStageStart: meta.gamesAtStageStart, stageStartedAt: meta.stageStartedAt };
    // (fewer games count than the meta says: the stage began after all of them — no game is on it yet)
    const stageStartedAt = meta.gamesAtStageStart > 0 ? (repo.countedGameSavedAt(meta.gamesAtStageStart) ?? new Date().toISOString()) : '';
    const full = { gamesAtStageStart: meta.gamesAtStageStart, stageStartedAt };
    repo.saveStageMeta(full);
    return full;
  }

  /**
   * The profile recounted from the games that count now. The stage is kept (never lowered automatically); the games
   * «before this stage» are the counting games saved before it began — marking and unmarking a game moves a game in or
   * out of «on this stage» only when it was played on it.
   */
  private recount(stageStartedAt: string): StudentProfile {
    const { repo, content, student } = this.options;
    const next = recountProfile(student.getProfile(), repo.countedGamesOldestFirst(), {
      personaOrder: content.personaOrder,
      motifTitleRu: content.motifTitleRu,
      themeTitleRu: (theme) => themeTitle(content.themeTitlesRu, theme),
    });
    const before = Math.min(repo.countCountedGamesSavedUpTo(stageStartedAt), next.totals.games);
    repo.saveStageMeta({ gamesAtStageStart: before, stageStartedAt });
    student.saveProfile(next);
    return next;
  }

  /** Marks / unmarks a game «играл взрослый / проверка» and recounts the profile. undefined = no such game. */
  async setExcluded(id: string, excluded: GameExclusion | null): Promise<{ excluded: GameExclusion | null; profile: StudentProfile } | undefined> {
    const { repo, writer } = this.options;
    const record = repo.getGame(id);
    if (record === undefined) return undefined;
    const profile = repo.tx(() => {
      const { stageStartedAt } = this.stageStart();
      repo.setExcluded(id, excluded);
      return this.recount(stageStartedAt);
    });
    await writer.writeGameFiles(record);
    await writer.writeStudentFiles();
    return { excluded, profile };
  }

  /** «Начать прогресс заново»: the games that count now are archived (their files stay), the profile starts from zero games. */
  async resetProgress(): Promise<{ archivedGames: number; profile: StudentProfile }> {
    const { repo, writer } = this.options;
    const { ids, profile } = repo.tx(() => {
      const { stageStartedAt } = this.stageStart();
      const archived = repo.archiveCountedGames();
      return { ids: archived, profile: this.recount(stageStartedAt) };
    });
    for (const id of ids) {
      const record = repo.getGame(id);
      if (record !== undefined) await writer.writeGameFiles(record);
    }
    await writer.writeStudentFiles();
    return { archivedGames: ids.length, profile };
  }

  /**
   * Appends the child's thoughts to one of the newest games (idempotent by thought id) and rewrites its journal.
   * A game takes at most MAX_THOUGHTS_PER_GAME thoughts; the ones beyond are not stored.
   */
  async addThoughts(id: string, thoughts: readonly GameThought[]): Promise<AddThoughtsResult> {
    const { repo, writer } = this.options;
    const record = repo.getGame(id);
    if (record === undefined) return { status: 'not-found' };
    if (!repo.latestGameIds(THOUGHT_GAMES_WINDOW).includes(id)) return { status: 'too-old' };

    const known = new Set(repo.listThoughts(id).map((thought) => thought.id));
    const fresh: GameThought[] = [];
    for (const thought of thoughts) {
      if (known.has(thought.id)) continue;
      known.add(thought.id);
      const text = oneLine(thought.text);
      const question = thought.question !== undefined ? oneLine(thought.question) : '';
      if (text === '') continue;
      fresh.push({ id: thought.id, source: thought.source, text, at: thought.at, ...(question !== '' ? { question } : {}) });
    }
    const room = Math.max(0, MAX_THOUGHTS_PER_GAME - repo.countThoughts(id));
    const added = fresh.length > 0 && room > 0 ? repo.insertThoughts(id, fresh.slice(0, room), new Date().toISOString()) : 0;
    if (added > 0) await writer.writeGameFiles(record);
    return { status: 'ok', added, total: repo.countThoughts(id) };
  }
}
