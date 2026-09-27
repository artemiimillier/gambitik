/**
 * `<base>.json` next to the PGN and the journal — the machine twin of one game: the record exactly as the browser sent
 * it, whether it counts in the child's progress, the review and the thoughts appended after the game. SQLite stays the
 * operational truth; with this file tools/rebuild-db.ts rebuilds the database without losing a move judgement.
 * A parent reads the `.md`; nobody needs to open this one.
 */
import { z } from 'zod';
import type { GameExclusion, GameRecord, GameThought } from '@gambit/shared';
import { gameExclusionSchema, gameRecordSchema, gameThoughtSchema } from '../schemas.ts';
import type { StoredReview } from './repo.ts';

export const GAME_DATA_SCHEMA = 'game-data/1';

/**
 * A record rebuilt from a journal alone (a game saved before the twins existed, tools/rebuild-db.ts) carries this flag
 * in its `gameStart` event: its moves were never judged again, so the richer journal on disk is never overwritten.
 */
export const REBUILT_FROM_JOURNAL = 'rebuiltFromJournal';

export interface GameDataFile {
  schema: typeof GAME_DATA_SCHEMA;
  gameId: string;
  excluded: GameExclusion | null;
  record: GameRecord;
  review: Omit<StoredReview, 'gameId'> | null;
  thoughts: GameThought[];
}

const reviewSchema = z.object({
  status: z.enum(['pending', 'ready', 'template', 'failed']),
  provider: z.enum(['codex', 'openrouter', 'openai-api', 'template']),
  markdown: z.string().max(200_000),
  keyTakeaways: z.array(z.string().max(2000)).max(20),
  suggestedTheme: z.string().max(60).nullable(),
  updatedAt: z.string().max(40),
});

const gameDataSchema = z.object({
  schema: z.literal(GAME_DATA_SCHEMA),
  gameId: z.string(),
  excluded: gameExclusionSchema.nullable(),
  record: gameRecordSchema,
  review: reviewSchema.nullable(),
  thoughts: z.array(gameThoughtSchema).max(1000),
});

export function renderGameDataFile(input: { record: GameRecord; excluded: GameExclusion | null; review: StoredReview | null; thoughts: readonly GameThought[] }): string {
  const review = input.review === null ? null : { status: input.review.status, provider: input.review.provider, markdown: input.review.markdown, keyTakeaways: input.review.keyTakeaways, suggestedTheme: input.review.suggestedTheme, updatedAt: input.review.updatedAt };
  const thoughts = input.thoughts.map((t) => ({ id: t.id, source: t.source, ...(t.question !== undefined ? { question: t.question } : {}), text: t.text, at: t.at }));
  const file: GameDataFile = { schema: GAME_DATA_SCHEMA, gameId: input.record.id, excluded: input.excluded, record: input.record, review, thoughts };
  return `${JSON.stringify(file)}\n`;
}

/** null when the text is not a valid twin (broken, foreign, from a future version). */
export function parseGameDataFile(text: string): GameDataFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = gameDataSchema.safeParse(raw);
  if (!parsed.success || parsed.data.gameId !== parsed.data.record.id) return null;
  const { review, thoughts, ...rest } = parsed.data;
  return {
    ...rest,
    schema: GAME_DATA_SCHEMA,
    review,
    thoughts: thoughts.map((t) => ({ id: t.id, source: t.source, ...(t.question !== undefined ? { question: t.question } : {}), text: t.text, at: t.at })),
  };
}

export function isRebuiltFromJournal(record: GameRecord): boolean {
  return record.events.some((event) => event.type === 'gameStart' && event.data[REBUILT_FROM_JOURNAL] === true);
}
