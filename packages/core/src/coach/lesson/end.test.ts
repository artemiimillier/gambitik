/**
 * The takeaway of a game (docs/TEACHING.md §2.9): the outcome's order of keys, a mistake «decided the game» only by
 * the loss that really happened, the quiz key only for a kind answered well, the rotation between games.
 */
import { describe, expect, it } from 'vitest';
import { getStrategy } from '@gambit/content';
import { judgement, queenBlunder } from '../test-fixtures.ts';
import { emptyLessonHistory } from './book.ts';
import {
  FOUND_TACTIC_VARIANTS,
  foundLesson,
  foundTakeaway,
  gameOutcome,
  mistakeTakeaway,
  playedMistakes,
  quizTakeaway,
  takeawayCandidates,
  takeawayLesson,
  takeawayRotationOk,
  takeawayVariant,
  themeTakeaway,
} from './end.ts';
import type { TakeawayInput } from './end.ts';
import { initialLessonMemory } from './memory.ts';
import type { CoachEvent } from '@gambit/shared';
import { hasSpokenSquare } from '../clips/lint.ts';
import { initialTeachMemory } from '../teacher.ts';
import { profile } from '../test-fixtures.ts';
import { createLessonBook } from './book.ts';
import { REACTION_IMPL } from './reaction.ts';

/** 1.e4 e5 2.Qh5 Nc6 3.Qxe5+?? Nxe5 — the queen is lost and the game goes on. */
const QUEEN_LOST = ['e4', 'e5', 'Qh5', 'Nc6', 'Qxe5+', 'Nxe5', 'd4', 'Nc6', 'Nf3', 'd5'];

function input(over: Partial<TakeawayInput> = {}): TakeawayInput {
  return {
    outcome: 'loss',
    stage: 2,
    childColor: 'w',
    lesson: initialLessonMemory(),
    judgements: [],
    historySan: QUEEN_LOST,
    card: null,
    ...over,
  };
}

describe('gameOutcome', () => {
  it('from the child side', () => {
    expect(gameOutcome('1-0', 'w', 'checkmate')).toBe('win');
    expect(gameOutcome('1-0', 'b', 'resign')).toBe('loss');
    expect(gameOutcome('1/2-1/2', 'b', 'stalemate')).toBe('draw');
    expect(gameOutcome('*', 'w', 'abandoned')).toBe('unfinished');
    expect(gameOutcome('0-1', 'w', 'abandoned')).toBe('unfinished');
  });
});

describe('the mistake that decided the game', () => {
  it('a lost hanging piece in a lost game → mistake.hanging first', () => {
    const i = input({ judgements: [queenBlunder()] });
    expect(playedMistakes(i)).toEqual([{ ply: 5, concept: 'hanging.undefended', takeaway: 'mistake.hanging', pawns: 9, mated: false }]);
    expect(takeawayCandidates(i)[0]).toBe('mistake.hanging');
  });

  it('the concept said in the game wins over the one recognised at the end', () => {
    const lesson = { ...initialLessonMemory(), mistakes: [{ turn: 3, ply: 5, concept: 'ignoredDanger', uci: 'h5e5', lossPawns: 8, mated: false }] };
    expect(takeawayCandidates(input({ judgements: [queenBlunder()], lesson }))[0]).toBe('mistake.ignoredDanger');
  });

  it('a taken-back attempt is not in the game and decides nothing', () => {
    const history = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6'];
    expect(playedMistakes(input({ judgements: [queenBlunder()], historySan: history }))).toEqual([]);
  });

  it('a mistake the opponent did not punish decides nothing', () => {
    const history = ['e4', 'e5', 'Qh5', 'Nc6', 'Qxe5+', 'Be7', 'Qxg7', 'Bf6'];
    const i = input({ judgements: [queenBlunder()], historySan: history });
    expect(playedMistakes(i)[0]?.pawns).toBe(0);
    expect(mistakeTakeaway('loss', playedMistakes(i))).toBeNull();
  });

  it('in a win a single mistake is no takeaway, a repeated one is', () => {
    const one = [{ ply: 5, concept: 'hanging.cheaper', takeaway: 'mistake.hanging', pawns: 3, mated: false }];
    expect(mistakeTakeaway('win', one)).toBeNull();
    expect(mistakeTakeaway('loss', one)).toBe('mistake.hanging');
    const two = [...one, { ply: 15, concept: 'hanging.undefended', takeaway: 'mistake.hanging', pawns: 1, mated: false }];
    expect(mistakeTakeaway('win', two)).toBe('mistake.hanging');
  });

  it('a mate beats a bigger material loss', () => {
    const ms = [
      { ply: 5, concept: 'hanging.undefended', takeaway: 'mistake.hanging', pawns: 9, mated: false },
      { ply: 21, concept: 'backRank', takeaway: 'mistake.backRank', pawns: 0, mated: true },
    ];
    expect(mistakeTakeaway('loss', ms)).toBe('mistake.backRank');
  });

  it('a taken-back attempt of the same ply does not lend its concept to the move that stayed', () => {
    const lesson = { ...initialLessonMemory(), mistakes: [{ turn: 3, ply: 5, concept: 'fork', uci: 'h5f7', lossPawns: 6, mated: false, victim: 'e1' }] };
    expect(playedMistakes(input({ judgements: [queenBlunder()], lesson }))[0]?.concept).toBe('hanging.undefended');
  });

  it('only confirmed weaker moves of the child count', () => {
    const quick = queenBlunder({ confidence: 'quick', winPctLoss: 12 });
    expect(playedMistakes(input({ judgements: [quick] }))).toEqual([]);
    const botMove = { ...queenBlunder(), color: 'b' as const };
    expect(playedMistakes(input({ judgements: [botMove] }))).toEqual([]);
  });
});

describe('quiz / found / theme keys', () => {
  it('two right answers of one kind (of three) → quiz.<kind>', () => {
    const lesson = {
      ...initialLessonMemory(),
      quizzes: [
        { turn: 3, ply: 5, kind: 'oppIdea' as const, correct: true },
        { turn: 7, ply: 13, kind: 'whichPiece' as const, correct: false },
        { turn: 12, ply: 23, kind: 'oppIdea' as const, correct: true },
      ],
    };
    expect(quizTakeaway(lesson)).toBe('quiz.oppIdea');
    expect(takeawayCandidates(input({ outcome: 'win', lesson, historySan: [] }))[0]).toBe('quiz.oppIdea');
  });

  it('two right answers of different kinds: the kind answered without a miss', () => {
    const lesson = {
      ...initialLessonMemory(),
      quizzes: [
        { turn: 3, ply: 5, kind: 'canCapture' as const, correct: true },
        { turn: 7, ply: 13, kind: 'danger' as const, correct: false },
        { turn: 12, ply: 23, kind: 'danger' as const, correct: true },
      ],
    };
    expect(quizTakeaway(lesson)).toBe('quiz.canCapture');
    expect(quizTakeaway({ quizzes: [{ turn: 1, ply: 1, kind: 'oppIdea', correct: true }] })).toBeNull();
  });

  it('a win: the found tactic first, then the theme, then the questions', () => {
    const lesson = {
      ...initialLessonMemory(),
      found: [{ turn: 5, ply: 9, kind: 'tactic' as const, motif: 'fork' }],
      goalsDone: ['aimF7', 'holdCentre'],
      quizzes: [
        { turn: 3, ply: 5, kind: 'oppIdea' as const, correct: true },
        { turn: 12, ply: 23, kind: 'oppIdea' as const, correct: true },
      ],
    };
    const keys = takeawayCandidates(input({ outcome: 'win', lesson, card: getStrategy('italian') ?? null, historySan: [] }));
    expect(keys).toEqual(['found.tactic', 'theme.f7', 'quiz.oppIdea', 'stage.2']);
  });

  it('a loss: the mistake, then the theme, then the tactic; the stage key always last', () => {
    const lesson = { ...initialLessonMemory(), found: [{ turn: 5, ply: 9, kind: 'treasure' as const }], goalsDone: ['aimF7', 'holdCentre'] };
    const keys = takeawayCandidates(input({ judgements: [queenBlunder()], lesson, card: getStrategy('italian') ?? null }));
    expect(keys).toEqual(['mistake.hanging', 'theme.f7', 'found.tactic', 'stage.2']);
  });

  it('theme by an early castle with every minor out — only for the development / castle families', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Nc3', 'Nf6', 'd3', 'd6', 'Bg5', 'h6', 'O-O'];
    const lesson = initialLessonMemory();
    expect(themeTakeaway({ card: getStrategy('open-game') ?? null, lesson, historySan: [...sans, 'O-O'], childColor: 'b' })).toBeNull(); // black minors not all out
    expect(themeTakeaway({ card: getStrategy('four-knights') ?? null, lesson, historySan: sans, childColor: 'w' })).toBe('theme.development');
    expect(themeTakeaway({ card: getStrategy('italian') ?? null, lesson, historySan: sans, childColor: 'w' })).toBeNull(); // the f7 family needs its goals
  });

  it('missed treasures (two of them) are a mistake takeaway', () => {
    const lesson = { ...initialLessonMemory(), treasureTurns: [3, 8, 12] };
    expect(takeawayCandidates(input({ outcome: 'draw', lesson, historySan: [] }))).toEqual(['mistake.missedTreasure', 'stage.2']);
  });
});

describe('the takeaway is the lesson of the find (not praise)', () => {
  const f = (kind: 'tactic' | 'treasure' | 'mate', motif?: string, ply = 9) => ({ turn: Math.ceil(ply / 2), ply, kind, ...(motif ? { motif } : {}) });

  it('a found fork → found.tactic with the variant «fork»; a named tactic beats a plain gift, an own find a treasure', () => {
    expect(foundLesson({ found: [f('tactic', 'fork')] })).toEqual({ key: 'found.tactic', variant: 'fork' });
    expect(foundLesson({ found: [f('treasure', 'hangingPiece', 5), f('tactic', 'pin', 11)] })).toEqual({ key: 'found.tactic', variant: 'pin' });
    expect(foundLesson({ found: [f('tactic', 'pin', 5), f('treasure', 'fork', 11)] })).toEqual({ key: 'found.tactic', variant: 'fork' });
    expect(foundLesson({ found: [f('treasure', 'fork', 5), f('tactic', 'fork', 11)] })).toEqual({ key: 'found.tactic', variant: 'fork' });
    expect(foundLesson({ found: [f('treasure', undefined, 5)] })).toEqual({ key: 'found.tactic', variant: null });
    expect(foundLesson({ found: [] })).toBeNull();
    expect(takeawayVariant('found.tactic', { found: [f('tactic', 'discoveredAttack')] })).toBe('discovered');
    expect(takeawayVariant('theme.center', { found: [f('tactic', 'fork')] })).toBeNull();
    expect(FOUND_TACTIC_VARIANTS).toEqual(expect.arrayContaining(['fork', 'pin', 'skewer', 'discovered', 'removeDefender', 'trapped', 'freeCapture']));
  });

  it('a mate is found.mate — also a mate that was the hidden treasure', () => {
    expect(foundLesson({ found: [f('tactic', 'fork', 5), f('mate', 'mateIn1', 21)] })).toEqual({ key: 'found.mate', variant: null });
    expect(foundTakeaway({ found: [f('treasure', 'mateIn1')] })).toEqual({ mate: 'found.mate', tactic: null });
    expect(takeawayVariant('found.tactic', { found: [f('treasure', 'mateIn1', 5), f('tactic', 'skewer', 9)] })).toBe('skewer');
  });

  it('the found mate and the found tactic are one lesson for the rotation', () => {
    expect(takeawayLesson('found.mate')).toBe(takeawayLesson('found.tactic'));
    const h = { ...emptyLessonHistory(), gameSeq: 3, takeaways: [{ game: 2, key: 'found.mate' }] };
    expect(takeawayRotationOk('found.tactic', h)).toBe(false);
    const h2 = { ...emptyLessonHistory(), gameSeq: 5, takeaways: [{ game: 0, key: 'found.tactic' }, { game: 2, key: 'found.mate' }, { game: 4, key: 'stage.3' }] };
    expect(takeawayRotationOk('found.tactic', h2)).toBe(false);
    expect(takeawayRotationOk('quiz.oppIdea', h2)).toBe(true);
  });

  it('ten won games in a row, each with a found tactic: the lesson rotates (never twice in a row, ≤ 2 of any 5)', () => {
    const { lessonEnd } = REACTION_IMPL;
    const SUMMARY = { accuracy: 70, acpl: 40, counts: { best: 5, excellent: 3, good: 2, inaccuracy: 0, mistake: 0, blunder: 0, missedWin: 0 }, takebacksOffered: 0, takebacksAccepted: 0, hintsUsed: 0, motifsMissed: [], motifsAllowed: [], keyMoments: [] };
    const book = createLessonBook({ seed: 3 });
    const keys: string[] = [];
    for (let g = 0; g < 10; g++) {
      book.newGame();
      const lesson = {
        ...initialLessonMemory(),
        found: [f(g % 3 === 0 ? 'mate' : 'tactic', g % 3 === 0 ? 'mateIn1' : g % 2 ? 'fork' : 'pin')],
        goalsDone: ['aimF7', 'holdCentre'],
        quizzes: [
          { turn: 3, ply: 5, kind: 'oppIdea' as const, correct: true },
          { turn: 12, ply: 23, kind: 'oppIdea' as const, correct: true },
        ],
      };
      const r = lessonEnd(
        { profile: profile({ stage: 3 }), tc: 'training', result: '1-0', childColor: 'w', termination: 'checkmate', summary: SUMMARY, strategyCard: getStrategy('italian') ?? null, judgements: [], historySan: ['e4', 'e5'] },
        { ...initialTeachMemory(), lesson },
        book,
      );
      keys.push(r.takeawayKey);
      book.finishGame();
    }
    const lessons = keys.map(takeawayLesson);
    for (let i = 1; i < lessons.length; i++) expect(lessons[i], keys.join(' ')).not.toBe(lessons[i - 1]);
    for (let i = 0; i + 5 <= lessons.length; i++) expect(lessons.slice(i, i + 5).filter((l) => l === 'found').length, keys.join(' ')).toBeLessThanOrEqual(2);
    expect(keys.filter((k) => k.startsWith('found.')).length).toBeGreaterThanOrEqual(3);
    expect(new Set(keys).size).toBeGreaterThanOrEqual(4);
  });
});

describe('rotation between games', () => {
  it('not the same key two games in a row, at most twice in the last five', () => {
    const h = { ...emptyLessonHistory(), gameSeq: 6, takeaways: [{ game: 5, key: 'mistake.hanging' }] };
    expect(takeawayRotationOk('mistake.hanging', h)).toBe(false);
    expect(takeawayRotationOk('found.tactic', h)).toBe(true);
    const h2 = {
      ...emptyLessonHistory(),
      gameSeq: 6,
      takeaways: [
        { game: 1, key: 'found.tactic' },
        { game: 2, key: 'stage.2' },
        { game: 3, key: 'found.tactic' },
        { game: 4, key: 'stage.2' },
        { game: 5, key: 'quiz.oppIdea' },
      ],
    };
    expect(takeawayRotationOk('found.tactic', h2)).toBe(false);
    expect(takeawayRotationOk('mistake.fork', h2)).toBe(true);
  });

  it('a judgement of a later ply than the history is ignored', () => {
    const j = judgement({ setup: QUEEN_LOST, played: 'exd5', best: 'exd5', over: { ply: 11 } });
    expect(playedMistakes(input({ judgements: [j] }))).toEqual([]);
  });
});

describe('the reaction half with the real words of @gambit/content', () => {
  const { lessonEnd, lessonReaction, lessonTakebackOffer, lessonTakebackReply } = REACTION_IMPL;
  const good = { winPctLoss: 0.3, classification: 'best' as const, winPctBefore: 55, winPctAfter: 55, evalAfter: { cp: 30, mate: null } };
  const SUMMARY = { accuracy: 50, acpl: 120, counts: { best: 1, excellent: 0, good: 2, inaccuracy: 0, mistake: 0, blunder: 1, missedWin: 0 }, takebacksOffered: 0, takebacksAccepted: 0, hintsUsed: 0, motifsMissed: [], motifsAllowed: [], keyMoments: [] };

  /** Said aloud as is: no Latin, no digits, no square, no «молодец», no placeholder left. */
  function clean(e: CoachEvent | null | undefined): void {
    if (!e) return;
    expect(e.text, e.text).not.toMatch(/[A-Za-z0-9{}]/);
    expect(hasSpokenSquare(e.text), e.text).toBe(false);
    expect(e.text.toLowerCase(), e.text).not.toMatch(/молод(е|ч)ц|умниц/);
    expect(e.clip).toBeUndefined();
    expect(e.brief).toBeUndefined();
  }

  for (const stage of [1, 2, 3, 4, 5]) {
    for (const address of ['m', 'f'] as const) {
      it(`stage ${stage} (${address}): praise, mistake, take-back, the end — true pools, clean words`, () => {
        const p = profile({ stage, address });
        const book = createLessonBook({ seed: stage * 10 + (address === 'f' ? 1 : 0) });
        const mem = { ...initialTeachMemory(), lesson: initialLessonMemory() };
        // an own knight-first move (the Italian card)
        const nf3 = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
        const praise = lessonReaction({ profile: p, tc: 'training', judgement: nf3, advice: [], adviceShown: false, strategyCard: getStrategy('italian') ?? null, historySan: ['e4', 'e5', 'Nf3'] }, mem, book);
        clean(praise.now);
        if (stage <= 3) expect(praise.now?.say?.[0]?.pool).toBe('v3.praise.knightFirst');
        else expect(praise.now?.say?.[0]?.pool).toBe('v3.praise.developed');
        // a found fork
        const fork = judgement({ fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', played: 'Nc7+', best: 'Nc7+', refutation: ['Kd7', 'Nxa8'], over: good });
        const found = lessonReaction({ profile: p, tc: 'training', judgement: fork, advice: [], adviceShown: false, historySan: [] }, praise.memory, book);
        clean(found.now);
        expect(found.now?.say?.[0]?.pool).toBe('v3.praise.tactic.fork');
        // the lost queen
        const mistake = lessonReaction({ profile: p, tc: 'training', judgement: queenBlunder(), advice: [], adviceShown: true, historySan: QUEEN_LOST.slice(0, 5) }, mem, book);
        clean(mistake.now);
        expect(mistake.now?.say?.map((x) => x.pool)).toEqual(['v3.mistake.hanging.undefended', 'v3.rule.hanging']);
        // the take-back offer and a reply
        const offer = lessonTakebackOffer({ profile: p, judgement: queenBlunder(), advice: [] }, mem, book);
        clean(offer.event);
        expect(offer.event.text).not.toBe('');
        const reply = lessonTakebackReply('yes', p, offer.memory, book);
        clean(reply.event);
        expect(reply.event.text).not.toBe('');
        // the end of a lost game
        const end = lessonEnd({ profile: p, tc: 'training', result: '0-1', childColor: 'w', termination: 'resign', summary: SUMMARY, strategyCard: null, judgements: [queenBlunder()], historySan: QUEEN_LOST }, mistake.memory, book);
        clean(end.event);
        expect(end.takeawayKey).toBe('mistake.hanging');
        expect(end.takeaway).not.toBe('');
      });
    }
  }
});
