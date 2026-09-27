import { lstat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Hono } from 'hono';
import type { GameExclusionResponse, GameJournalResponse, GameListItem, GameRecord, GameReview, GameThoughtsResponse } from '@gambit/shared';
import type { ServerContext } from '../context.ts';
import { gameExclusionRequestSchema, gameIdSchema, gameThoughtsRequestSchema, gamesQuerySchema, newGameRecordSchema } from '../schemas.ts';
import { themeTitle } from '../services/progress.ts';
import { AUTOMATION_HEADER, isAutomationRequest } from '../security.ts';
import { resolveDataFile } from '../storage/files.ts';
import { GAME_BODY_LIMIT, SMALL_BODY_LIMIT, jsonBody, limitBody, queryParams } from './validation.ts';

/** A journal is tens of kilobytes; anything this big is not ours to send. */
export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

/**
 * The journal of ONE game, path-safe: the file base comes from the database (never from the request), must lie under
 * data/games and resolve inside DATA_DIR, and the file must be a plain file (no symlink out of the data folder).
 */
async function readJournal(ctx: ServerContext, gameId: string): Promise<GameJournalResponse | 'not-found' | 'too-large'> {
  const fileBase = ctx.repo.getGameFileBase(gameId);
  if (fileBase === null || !fileBase.startsWith('games/')) return 'not-found';
  let path: string;
  try {
    path = resolveDataFile(ctx.paths.dataDir, `${fileBase}.md`);
  } catch {
    return 'not-found';
  }
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return 'not-found';
    if (stat.size > MAX_JOURNAL_BYTES) return 'too-large';
    return { gameId, fileName: basename(path), markdown: await readFile(path, 'utf8') };
  } catch {
    return 'not-found';
  }
}

/**
 * `GET /games/:id/review` answers the contract's `GameReview` plus three ADDITIVE fields (the
 * contract is frozen, a client typed as `GameReview` simply ignores them): what the review
 * recommends, so the review screen can offer «Порешать задачи на эту тему»
 * (`/puzzles/next?theme=<suggestedTheme>`). Empty / null while the review is pending or failed.
 */
export interface GameReviewWithAdvice extends GameReview {
  keyTakeaways: string[];
  /** lichess theme key accepted by `GET /puzzles/next?theme=` */
  suggestedTheme: string | null;
  /** kid-friendly Russian title of `suggestedTheme` */
  suggestedThemeTitle: string | null;
}

export function gamesRoutes(ctx: ServerContext) {
  return new Hono()
    .post('/', limitBody(GAME_BODY_LIMIT), jsonBody(newGameRecordSchema), async (c) => {
      const record: GameRecord = c.req.valid('json');
      if (Date.parse(record.endedAt) < Date.parse(record.startedAt)) return c.json({ error: 'invalid-body', issues: [{ path: 'endedAt', message: 'endedAt is before startedAt' }] }, 400);
      const saved = await ctx.games.save(record, { templateReviewOnly: isAutomationRequest(c.req.header(AUTOMATION_HEADER)) });
      return c.json({ id: saved.id }, saved.created ? 201 : 200);
    })
    .get('/', queryParams(gamesQuerySchema), (c) => {
      const { limit, offset } = c.req.valid('query');
      return c.json<GameListItem[]>(ctx.repo.listGames(limit ?? 50, { offset: offset ?? 0 }));
    })
    .get('/:id', (c) => {
      const id = gameIdSchema.safeParse(c.req.param('id'));
      const record = id.success ? ctx.repo.getGame(id.data) : undefined;
      if (record === undefined) return c.json({ error: 'not-found' }, 404);
      return c.json<GameRecord>(record);
    })
    .get('/:id/review', (c) => {
      const id = gameIdSchema.safeParse(c.req.param('id'));
      const stored = id.success ? ctx.repo.getReview(id.data) : undefined;
      if (stored === undefined) return c.json({ error: 'not-found' }, 404);
      // a review that is still pending after a restart gets picked up again
      if (stored.status === 'pending' && ctx.config.autoReview) ctx.reviews.enqueue(stored.gameId, { templateOnly: isAutomationRequest(c.req.header(AUTOMATION_HEADER)) });
      const theme = stored.suggestedTheme !== null && stored.suggestedTheme !== '' ? stored.suggestedTheme : null;
      const review: GameReviewWithAdvice = {
        gameId: stored.gameId,
        status: stored.status,
        provider: stored.provider,
        markdown: stored.markdown,
        keyTakeaways: stored.keyTakeaways,
        suggestedTheme: theme,
        suggestedThemeTitle: theme !== null ? themeTitle(ctx.content.themeTitlesRu, theme) : null,
      };
      return c.json<GameReviewWithAdvice>(review);
    })
    .get('/:id/journal', async (c) => {
      const id = gameIdSchema.safeParse(c.req.param('id'));
      const journal = id.success ? await readJournal(ctx, id.data) : 'not-found';
      if (journal === 'not-found') return c.json({ error: 'not-found' }, 404);
      if (journal === 'too-large') return c.json({ error: 'too-large' }, 413);
      return c.json<GameJournalResponse>(journal);
    })
    // parent only (the parent gate of the progress screen): «играл взрослый / проверка» — the game leaves the progress
    .put('/:id/excluded', limitBody(SMALL_BODY_LIMIT), jsonBody(gameExclusionRequestSchema), async (c) => {
      const id = gameIdSchema.safeParse(c.req.param('id'));
      const result = id.success ? await ctx.games.setExcluded(id.data, c.req.valid('json').excluded) : undefined;
      if (!id.success || result === undefined) return c.json({ error: 'not-found' }, 404);
      return c.json<GameExclusionResponse>({ id: id.data, excluded: result.excluded, profile: result.profile });
    })
    // the child's thoughts after the game that arrive once the record is saved (the talk after the game, the diary)
    .post('/:id/thoughts', limitBody(SMALL_BODY_LIMIT), jsonBody(gameThoughtsRequestSchema), async (c) => {
      const id = gameIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'not-found' }, 404);
      const result = await ctx.games.addThoughts(id.data, c.req.valid('json').thoughts);
      if (result.status === 'not-found') return c.json({ error: 'not-found' }, 404);
      if (result.status === 'too-old') return c.json({ error: 'too-old' }, 409);
      return c.json<GameThoughtsResponse>({ gameId: id.data, added: result.added, total: result.total });
    });
}
