/**
 * «Дозапись голоса» on the wire: a recording request carries ids only (strict at every level, so no text — and never
 * the child's name — can reach the TTS through it), the parent's settings are strict, and `saySentences` rides on the
 * coach event.
 */
import { describe, expect, it } from 'vitest';
import type { ClipGenRequest } from '@gambit/shared';
import { clipGenRequestSchema, clipGenSettingsSchema, coachEventSchema, lessonSaySentenceSchema } from './schemas.ts';

const LEAD = { pool: 'v3.lead.advice', n: 1, piece: 'n' } as const;
const TAIL = { pool: 'v3.idea.mate', n: 1 } as const;

describe('clip generation request schema', () => {
  it('accepts ids: a whole / lone lead, a lead + tail, the quiz options', () => {
    const body: ClipGenRequest = {
      sentences: [
        { parts: [TAIL] },
        { parts: [LEAD, TAIL] },
        { quiz: { kind: 'oppIdea', options: [{ say: { pool: 'v3.quiz.cat.attack', n: 1 } }, { piece: 'n' }, { piece: 'b' }] } },
      ],
      kind: 'teachTurn',
    };
    expect(clipGenRequestSchema.parse(body)).toEqual(body);
  });

  it('refuses text, names, extra fields and impossible shapes', () => {
    const ok = { sentences: [{ parts: [TAIL] }] };
    expect(clipGenRequestSchema.safeParse(ok).success).toBe(true);
    expect(clipGenRequestSchema.safeParse({ ...ok, text: 'Привет!' }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: [{ parts: [TAIL], text: 'Раз.' }] }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: [{ parts: [{ ...TAIL, text: 'Раз.' }] }] }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: [{ parts: [{ ...TAIL, name: 'Маша' }] }] }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: [{ parts: [{ pool: 'Смотри на доску', n: 1 }] }] }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: [] }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: [{ parts: [] }] }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: [{ parts: [LEAD, TAIL, TAIL] }] }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: Array.from({ length: 7 }, () => ({ parts: [TAIL] })) }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: [{ parts: [TAIL], quiz: { kind: 'why', options: [] } }] }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: [{ quiz: { kind: 'oppIdea', options: [{ piece: 'n' }, { piece: 'b' }] } }] }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ sentences: [{ quiz: { kind: 'oppIdea', options: [{ piece: 'x' }, { piece: 'b' }, { piece: 'r' }] } }] }).success).toBe(false);
    expect(clipGenRequestSchema.safeParse({ ...ok, kind: 'shout' }).success).toBe(false);
  });
});

describe('a whole catalogue sentence (`line`) in a request', () => {
  it('accepts ids only: the line, the wording number, the variant', () => {
    const body: ClipGenRequest = {
      sentences: [{ line: { id: 'greet.hello.day', n: 1 } }, { line: { id: 'greet.win', n: 1, g: 'f' } }, { line: { id: 'ask.opp.hanging', n: 1, piece: 'q' } }],
      kind: 'greeting',
    };
    expect(clipGenRequestSchema.parse(body)).toEqual(body);
  });

  it('refuses text, a name, extra fields at either level and impossible shapes', () => {
    const bad: unknown[] = [
      { line: { id: 'greet.hello.day', n: 1, text: 'Привет, Маша!' } },
      { line: { id: 'greet.hello.day', n: 1 }, text: 'Привет!' },
      { line: { id: 'greet.hello.day', n: 1, name: 'Маша' } },
      { line: { id: 'Привет, Маша', n: 1 } },
      { line: { id: 'greet.hello.day', n: 0 } },
      { line: { id: 'greet.hello.day', n: 1.5 } },
      { line: { id: 'greet.hello.day', n: 1, piece: 'x' } },
      { line: { id: 'greet.hello.day', n: 1, g: 'x' } },
      { line: { id: 'greet.hello.day' } },
      { line: { id: 'greet.hello.day', n: 1 }, parts: [{ pool: 'v3.whole.castle', n: 16 }] },
    ];
    for (const sentence of bad) expect(clipGenRequestSchema.safeParse({ sentences: [sentence] }).success, JSON.stringify(sentence)).toBe(false);
  });
});

describe('clip generation settings schema', () => {
  it('is strict: a switch and a whole number of milli-credits', () => {
    expect(clipGenSettingsSchema.parse({ enabled: true, dailyCapMilli: 10_000 })).toEqual({ enabled: true, dailyCapMilli: 10_000 });
    expect(clipGenSettingsSchema.safeParse({ enabled: true, dailyCapMilli: 1.5 }).success).toBe(false);
    expect(clipGenSettingsSchema.safeParse({ enabled: true, dailyCapMilli: -1 }).success).toBe(false);
    expect(clipGenSettingsSchema.safeParse({ enabled: true, dailyCapMilli: 30_001 }).success).toBe(false);
    expect(clipGenSettingsSchema.safeParse({ enabled: true, dailyCapMilli: 3000, budget: 1e9 }).success).toBe(false);
  });
});

describe('saySentences on the coach event', () => {
  const event = {
    id: 'teachTurn-v3-1',
    kind: 'teachTurn',
    priority: 1,
    text: 'Давай сходим конём — и это мат! Нападает, конём или слоном?',
    bubbleText: 'Давай сходим конём — и это мат! Нападает, конём или слоном?',
    pose: 'talk',
    pauseClock: true,
    say: [LEAD, TAIL, { pool: 'v3.quiz.cat.attack', n: 1 }],
    saySentences: [
      { text: 'Давай сходим конём — и это мат!', parts: [0, 1] },
      { text: 'Нападает, конём или слоном?', parts: [], quiz: { kind: 'oppIdea', options: [{ say: 2 }, { piece: 'n' }, { piece: 'b' }] } },
    ],
  };

  it('round-trips', () => {
    expect(coachEventSchema.parse(event).saySentences).toEqual(event.saySentences);
    const { saySentences: _drop, ...old } = event;
    expect(coachEventSchema.parse(old).saySentences).toBeUndefined();
  });

  it('keeps sentence ids in range and strict', () => {
    expect(lessonSaySentenceSchema.safeParse({ text: 'Раз.', parts: [12] }).success).toBe(false);
    expect(lessonSaySentenceSchema.safeParse({ text: 'Раз.', parts: [0, 1, 2] }).success).toBe(false);
    expect(lessonSaySentenceSchema.safeParse({ text: 'Раз.', parts: [0], extra: 1 }).success).toBe(false);
    expect(lessonSaySentenceSchema.safeParse({ text: '', parts: [0] }).success).toBe(false);
  });
});
