import { Hono } from 'hono';
import type { Puzzle, PuzzleAttempt, ThemeSkill } from '@gambit/shared';
import { stageFor } from '../content.ts';
import type { ServerContext } from '../context.ts';
import { puzzleAttemptSchema, puzzlesNextQuerySchema } from '../schemas.ts';
import { RECENT_EXCLUDE_LIMIT, applyAttemptToProfile, selectNextPuzzles } from '../services/puzzles.ts';
import { DUE_SHARE } from '../services/repetition.ts';
import { SMALL_BODY_LIMIT, jsonBody, limitBody, queryParams } from './validation.ts';

export const DEFAULT_PUZZLE_COUNT = 5;

export function puzzlesRoutes(ctx: ServerContext) {
  return new Hono()
    .get('/next', queryParams(puzzlesNextQuerySchema), (c) => {
      const query = c.req.valid('query');
      const profile = ctx.student.getProfile();
      const theme = query.theme !== undefined && query.theme !== '' ? query.theme : undefined;
      const count = query.count ?? DEFAULT_PUZZLE_COUNT;
      // spaced repetition: the child's own failed puzzles come back when they are due — at most a
      // third of the batch, and inside a themed session only the ones of that theme
      const due: Puzzle[] = [];
      for (const id of ctx.repetition.due(new Date(), count)) {
        if (due.length >= Math.floor(count * DUE_SHARE)) break;
        const puzzle = ctx.puzzles.getById(id);
        if (puzzle !== undefined && (theme === undefined || puzzle.themes.includes(theme))) due.push(puzzle);
      }
      const dueIds = due.map((p) => p.id);
      const fresh = selectNextPuzzles(ctx.puzzles, profile, {
        theme,
        count: count - due.length,
        preferredThemes: stageFor(ctx.content.curriculum, profile.stage).puzzleThemes,
        recentIds: [...dueIds, ...ctx.repo.recentPuzzleIds(RECENT_EXCLUDE_LIMIT)],
      }).filter((p) => !dueIds.includes(p.id));
      const puzzles = [...due, ...fresh].sort((a, b) => a.rating - b.rating);
      return c.json<Puzzle[]>(puzzles);
    })
    .post('/attempt', limitBody(SMALL_BODY_LIMIT), jsonBody(puzzleAttemptSchema), (c) => {
      const body: PuzzleAttempt = c.req.valid('json');
      // rating and themes of a known puzzle come from our own data, not from the client
      const known = ctx.puzzles.getById(body.puzzleId);
      const attempt: PuzzleAttempt = known === undefined ? body : { ...body, puzzleRating: known.rating, themes: known.themes };
      const now = new Date();
      const outcome = ctx.repo.tx(() => {
        const rated = !ctx.repo.hasAttempt(attempt.puzzleId);
        const result = applyAttemptToProfile(ctx.student.getProfile(), attempt, { rated, now });
        ctx.repo.insertAttempt(attempt, now.toISOString());
        ctx.repetition.recordAttempt(attempt.puzzleId, attempt, now);
        ctx.student.saveProfile(result.profile);
        if (rated) ctx.repo.appendRatingPoint({ date: now.toISOString(), rating: result.puzzleRating.rating });
        return result;
      });
      void ctx.writer.writeStudentFiles();
      return c.json<{ puzzleRating: ThemeSkill }>({ puzzleRating: outcome.puzzleRating });
    });
}
