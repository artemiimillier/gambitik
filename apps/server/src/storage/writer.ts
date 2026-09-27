/**
 * Writes the derived files (PGN + journal + machine twin per game, profile.md, progress.json) from the database
 * state. All writes are atomic and serialised; failures are logged, never thrown to a request —
 * SQLite stays the operational truth and the files can always be regenerated (and the database rebuilt from the
 * twins, tools/rebuild-db.ts).
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { GameRecord, StudentProfile } from '@gambit/shared';
import type { ContentBundle } from '../content.ts';
import { buildProgressSnapshot, currentStages, renderProgressJson, themeTitle } from '../services/progress.ts';
import { WriteChain, atomicWriteFile, extractParentNotes, readTextIfExists, resolveDataFile } from './files.ts';
import type { DataPaths } from './files.ts';
import { isRebuiltFromJournal, renderGameDataFile } from './gameData.ts';
import { renderGameJournal, renderPgnFile } from './journal.ts';
import type { JournalReview } from './journal.ts';
import { renderProfileMd } from './profileMd.ts';
import type { Repo, StoredReview } from './repo.ts';

export interface DataFileWriterOptions {
  paths: DataPaths;
  repo: Repo;
  content: ContentBundle;
  getProfile: () => StudentProfile;
  log: (message: string) => void;
}

export class DataFileWriter {
  private readonly chain = new WriteChain();
  private readonly options: DataFileWriterOptions;
  /** the twins of games saved before they existed are written once per server run (see `backfillGameData`) */
  private backfilled = false;

  constructor(options: DataFileWriterOptions) {
    this.options = options;
  }

  /** Resolves when every write requested so far has finished. */
  idle(): Promise<void> {
    return this.chain.idle();
  }

  private toJournalReview(review: StoredReview | undefined): JournalReview | null {
    if (review === undefined) return null;
    const theme = review.suggestedTheme;
    return {
      status: review.status,
      provider: review.provider,
      markdown: review.markdown,
      keyTakeaways: review.keyTakeaways,
      suggestedThemeTitle: theme !== null && theme !== '' ? themeTitle(this.options.content.themeTitlesRu, theme) : null,
    };
  }

  /** (Re)writes `<base>.pgn`, `<base>.md` and the machine twin `<base>.json` of one game. */
  writeGameFiles(record: GameRecord): Promise<void> {
    return this.chain.run(async () => {
      const { repo, content, paths, log } = this.options;
      try {
        const fileBase = repo.getGameFileBase(record.id);
        if (fileBase === null) return;
        const abs = resolveDataFile(paths.dataDir, fileBase);
        const persona = content.personas[record.personaId];
        const nickname = this.options.getProfile().nickname;
        const pgnPath = `${abs}.pgn`;
        const mdPath = `${abs}.md`;
        if ((await readTextIfExists(pgnPath)) === null) await atomicWriteFile(pgnPath, renderPgnFile(record, persona, nickname));
        const previous = await readTextIfExists(mdPath);
        const stored = repo.getReview(record.id);
        const excluded = repo.getExcluded(record.id);
        const thoughts = repo.listThoughts(record.id);
        // a record rebuilt from its journal lost the per-move details: the journal on disk is the richer one, it stays
        if (!(previous !== null && isRebuiltFromJournal(record))) {
          const journal = renderGameJournal({
            record,
            persona,
            nickname,
            review: this.toJournalReview(stored),
            pgnFileName: basename(pgnPath),
            motifTitleRu: content.motifTitleRu,
            parentNotes: extractParentNotes(previous),
            // teacher mode: a new topic is named by its concept card
            conceptTitleRu: (conceptId) => content.conceptCards.find((card) => card.id === conceptId)?.title ?? null,
            excluded,
            thoughts,
          });
          await atomicWriteFile(mdPath, journal);
        }
        await atomicWriteFile(`${abs}.json`, renderGameDataFile({ record, excluded, review: stored ?? null, thoughts }));
      } catch (error) {
        log(`[files] cannot write the journal of game ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** Writes the missing machine twins of games saved by an older version. Never throws. */
  private async backfillGameData(): Promise<void> {
    const { repo, paths, log } = this.options;
    for (const { id, fileBase } of repo.gameFileBases()) {
      try {
        const abs = resolveDataFile(paths.dataDir, fileBase);
        if (existsSync(`${abs}.json`)) continue;
        const record = repo.getGame(id);
        if (record === undefined) continue;
        await atomicWriteFile(`${abs}.json`, renderGameDataFile({ record, excluded: repo.getExcluded(id), review: repo.getReview(id) ?? null, thoughts: repo.listThoughts(id) }));
      } catch (error) {
        log(`[files] cannot write the data file of game ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** (Re)writes data/student/profile.md and data/student/progress.json. */
  writeStudentFiles(): Promise<void> {
    return this.chain.run(async () => {
      const { repo, content, paths, log } = this.options;
      try {
        const profile = this.options.getProfile();
        const { stage, nextStage } = currentStages(content.curriculum, profile.stage);
        // the child's portrait: games played by an adult or archived by «Начать прогресс заново» are not in it
        const lastGames = repo.listGames(10, { countedOnly: true }).map((game) => {
          const base = repo.getGameFileBase(game.id);
          return { ...game, journalPath: base !== null ? `${base}.md` : null };
        });
        const coachNotes = repo.recentReviews(5).map((review) => ({
          startedAt: review.startedAt,
          personaId: review.personaId,
          takeaways: review.keyTakeaways,
          suggestedThemeTitle: review.suggestedTheme !== null && review.suggestedTheme !== '' ? themeTitle(content.themeTitlesRu, review.suggestedTheme) : null,
        }));
        const previous = await readTextIfExists(paths.profileMd);
        await atomicWriteFile(
          paths.profileMd,
          renderProfileMd({
            profile,
            stage,
            nextStage,
            personas: content.personas,
            themeTitleRu: (theme) => themeTitle(content.themeTitlesRu, theme),
            lastGames,
            excludedGames: repo.countExcludedGames(),
            coachNotes,
            parentNotes: extractParentNotes(previous),
          }),
        );
        await atomicWriteFile(paths.progressJson, renderProgressJson(buildProgressSnapshot(repo, profile, content)));
      } catch (error) {
        log(`[files] cannot write the student files: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!this.backfilled) {
        this.backfilled = true;
        await this.backfillGameData();
      }
    });
  }
}
