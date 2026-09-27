/**
 * The «Записи» contract on the wire (docs/voice-clips/SPEC.md §3.6): `CoachEvent.clip` round-trips through the coach
 * event schema; line ids stay plain ids, never text; slots carry only SAN + FEN.
 */
import { describe, expect, it } from 'vitest';
import type { CoachEvent } from '@gambit/shared';
import { clipUtteranceSchema, coachEventSchema } from './schemas.ts';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const event = (clip: unknown): unknown => ({ id: 'teachTurn-1', kind: 'teachTurn', priority: 1, text: 'Мой совет — конь на эф три.', bubbleText: 'Мой совет — Кf3.', pose: 'talk', pauseClock: true, clip });

describe('clip utterance schema', () => {
  it('accepts a twin utterance and keeps it on the event', () => {
    const clip: NonNullable<CoachEvent['clip']> = {
      sentences: [
        { items: [{ line: 'teach.head.advice' }, { slot: 'nom', san: 'Nf3', fen: FEN }, { line: 'reason.attack', piece: 'n' }], prio: 100, end: '!' },
        { items: [{ line: 'ask.find', g: 'f' }], prio: 60, end: '?' },
      ],
      bark: 'cheer',
      generic: 'generic.teachTurn.turn',
      moment: 'turn',
    };
    const parsed = coachEventSchema.parse(event(clip));
    expect(parsed.clip).toEqual(clip);
    expect(coachEventSchema.parse(event(undefined)).clip).toBeUndefined();
  });

  it('refuses Russian text as a line id, a bad slot form, a non-SAN move, too many items', () => {
    const base = { sentences: [{ items: [{ line: 'teach.head.advice' }], prio: 100, end: '.' }], generic: 'generic.teachTurn' };
    expect(clipUtteranceSchema.safeParse(base).success).toBe(true);
    expect(clipUtteranceSchema.safeParse({ ...base, generic: 'Смотри на доску!' }).success).toBe(false);
    expect(clipUtteranceSchema.safeParse({ ...base, sentences: [{ items: [{ line: 'Мой совет' }], prio: 100, end: '.' }] }).success).toBe(false);
    expect(clipUtteranceSchema.safeParse({ ...base, sentences: [{ items: [{ slot: 'acc', san: 'Nf3', fen: FEN }], prio: 100, end: '.' }] }).success).toBe(false);
    expect(clipUtteranceSchema.safeParse({ ...base, sentences: [{ items: [{ slot: 'nom', san: 'конь на эф три', fen: FEN }], prio: 100, end: '.' }] }).success).toBe(false);
    const four = [{ line: 'a' }, { line: 'b' }, { line: 'c' }, { line: 'd' }];
    expect(clipUtteranceSchema.safeParse({ ...base, sentences: [{ items: four, prio: 100, end: '.' }] }).success).toBe(false);
    expect(coachEventSchema.safeParse(event({ ...base, generic: '' })).success).toBe(false);
  });
});
