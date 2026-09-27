import { describe, expect, it } from 'vitest';
import type { CoachEvent, GameListItem, HintLevel, MotifId, StudentProfile } from '@gambit/shared';
import { TIME_CONTROLS } from '@gambit/shared';
import {
  MAX_IN_GAME_WORDS,
  TAKEBACK_DECLINE_REASONS,
  buildDeclineReasonReply,
  buildExplainBest,
  buildGameEnd,
  buildGameHello,
  buildGameResumed,
  buildGameStart,
  buildGreeting,
  buildHint,
  buildOpeningIdea,
  buildPraise,
  buildSilenceNudge,
  buildTakebackAccepted,
  buildTakebackDeclined,
  buildTakebackOffer,
  buildTakebackQuestion,
  buildThinkingRoutine,
  buildThreatWarning,
  buildVoluntaryTakeback,
  childOutcome,
  declineReasonLabelRu,
  isRealTacticMotif,
} from './events.ts';
import { MAX_BRIEF_CHARS } from './brief.ts';
import { hasSpokenSquare } from './clips/lint.ts';
import { countSentences, countWords } from './phrase.ts';
import { sanToSpokenRu, squareToSpokenRu } from './spoken.ts';
import {
  ALL_MOTIFS,
  BACK_RANK_FEN,
  FORK_FEN,
  PERSONA,
  RNG_SWEEP,
  analysisOf,
  backRankBlunder,
  bestMoveJudgement,
  constRng,
  counts,
  facts,
  forkBlunder,
  hanging,
  judgement,
  profile,
  queenBlunder,
  seededRng,
  summary,
} from './test-fixtures.ts';

const LATIN = /[A-Za-z]/;
/** Words banned from the game: generic praise. */
const BANNED_PRAISE = /молод(ец|цы|чина)|умниц|так держать/i;
const SHAMING = /плох|глуп|ужасн|стыд|тупо|тупой|неправильн|двойк|опять|сколько можно|как можно|слабо|ошибся|ошиблась|ты ошиб|лёгк|легко/i;
const MASCULINE_CHILD_VERBS =
  /(?<![а-яё])(нашёл|сходил|заметил|увидел|забрал|победил|выиграл|вернул|играл|думал|подумал|справился|старался|искал|поработал|боролся|смотрел|выбрал|сам)(?![а-яё])/i;
const FEMININE_CHILD_VERBS =
  /(?<![а-яё])(нашла|сходила|заметила|увидела|забрала|победила|выиграла|вернула|играла|думала|подумала|справилась|старалась|искала|поработала|боролась|смотрела|выбрала|сама)(?![а-яё])/i;

const HINT_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4'; // Qxf7# is on
const LAST_GAME: GameListItem = {
  id: 'g0',
  startedAt: '2026-09-20T10:00:00.000Z',
  personaId: 'petya',
  timeControlId: 'rapid10',
  childColor: 'w',
  result: '1-0',
  accuracy: 80,
  blunders: 0,
  reviewStatus: 'ready',
};

function sweep(build: (rng: () => number) => CoachEvent | null): CoachEvent[] {
  const out: CoachEvent[] = [];
  for (const r of RNG_SWEEP) {
    const e = build(constRng(r));
    if (e) out.push(e);
  }
  return out;
}

function distinctTexts(events: CoachEvent[]): number {
  return new Set(events.map((e) => e.text)).size;
}

const PROFILES: StudentProfile[] = [
  profile(),
  profile({ address: 'f', nickname: 'Маша' }),
  profile({ nickname: 'Max' }),
  profile({ nickname: '' }),
  profile({ stage: 5, nickname: 'Анна-Мария', address: 'f' }),
];

/** Every builder × many inputs — the corpus the global text rules are checked against. */
function corpus(p: StudentProfile, rng: () => number): CoachEvent[] {
  const out: (CoachEvent | null)[] = [];
  const latinPersona = { ...PERSONA, name: 'Peter' };
  for (const hour of [7, 13, 19, 23]) {
    out.push(buildGreeting({ profile: p, hour }, rng));
    out.push(buildGreeting({ profile: p, hour, lastGame: LAST_GAME }, rng));
    out.push(buildGreeting({ profile: p, hour, lastGame: { ...LAST_GAME, result: '0-1' } }, rng));
    out.push(buildGreeting({ profile: p, hour, lastGame: { ...LAST_GAME, result: '1/2-1/2' } }, rng));
    out.push(buildGreeting({ profile: { ...p, totals: { ...p.totals, games: 0 } }, hour }, rng));
  }
  for (const tc of Object.values(TIME_CONTROLS)) {
    out.push(buildGameStart({ persona: PERSONA, timeControl: tc, childColor: 'w', profile: p }, rng));
    out.push(buildGameStart({ persona: latinPersona, timeControl: tc, childColor: 'b', profile: p }, rng));
  }
  out.push(buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: p, examMode: true }, rng));
  out.push(buildGameResumed({ childToMove: true, profile: p }, rng), buildGameResumed({ childToMove: false, profile: p }, rng));
  out.push(buildVoluntaryTakeback(p, rng));
  for (const reason of TAKEBACK_DECLINE_REASONS) out.push(buildDeclineReasonReply(reason, p, rng));
  out.push(buildOpeningIdea({ title: 'Тихая итальянка', idea: 'Развиваем все фигуры, прячем короля и готовим удар в центре.', profile: p }, rng));
  out.push(buildOpeningIdea({ title: 'Почему нельзя жадничать', idea: 'Пешку на фланге не удержать, а фигуры отстанут.', warning: true, profile: p }, rng));
  for (const motif of [undefined, ...ALL_MOTIFS]) {
    out.push(buildTakebackOffer(queenBlunder({ allowedMotif: motif }), p, rng));
    out.push(buildTakebackOffer(forkBlunder({ allowedMotif: motif }), p, rng));
    out.push(buildTakebackOffer(backRankBlunder({ allowedMotif: motif }), p, rng));
    out.push(buildTakebackOffer(queenBlunder({ allowedMotif: motif, refutationPvUci: [], refutationPvSan: [] }), p, rng));
    out.push(buildExplainBest(forkBlunder({ allowedMotif: motif, missedMotif: motif }), p, rng));
    out.push(buildExplainBest(queenBlunder({ allowedMotif: motif }), p, rng));
    out.push(buildExplainBest(backRankBlunder({ allowedMotif: undefined, missedMotif: motif }), p, rng));
    out.push(buildExplainBest(bestMoveJudgement(motif), p, rng));
    out.push(buildPraise(bestMoveJudgement(motif), p, rng));
    out.push(buildPraise(bestMoveJudgement(motif, { classification: 'excellent', bestUci: 'a2a3' }), p, rng));
    out.push(
      buildGameEnd(
        { result: '1-0', childColor: 'w', termination: 'checkmate', summary: summary({ motifsAllowed: motif ? [motif] : [] }), persona: PERSONA, profile: p },
        rng,
      ),
    );
    out.push(
      buildGameEnd(
        { result: '1-0', childColor: 'b', termination: 'resign', summary: summary({ motifsAllowed: [], motifsMissed: motif ? [motif] : [] }), persona: latinPersona, profile: p },
        rng,
      ),
    );
  }
  for (const level of [1, 2, 3, 4] as HintLevel[]) {
    out.push(buildHint(level, { fen: HINT_FEN, best: analysisOf(HINT_FEN, 'Qxf7#', { mate: 1 }), facts: facts(HINT_FEN), profile: p }, rng));
    out.push(buildHint(level, { fen: FORK_FEN, best: analysisOf(FORK_FEN, 'O-O-O'), facts: facts(FORK_FEN), profile: p }, rng));
    out.push(buildHint(level, { fen: BACK_RANK_FEN, best: analysisOf(BACK_RANK_FEN, 'Ra8'), facts: facts(BACK_RANK_FEN), profile: p }, rng));
    out.push(
      buildHint(level, { fen: FORK_FEN, best: analysisOf(FORK_FEN, 'Rd1'), facts: facts(FORK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['d4'])] }), profile: p }, rng),
    );
    out.push(buildHint(level, { fen: FORK_FEN, best: { fen: FORK_FEN, lines: [], bestmove: '(none)', depth: 0, timeMs: 0 }, facts: facts(FORK_FEN), profile: p }, rng));
  }
  for (const piece of ['n', 'b', 'r', 'q'] as const) {
    out.push(buildThreatWarning({ fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('a1', piece, 'w', 300, ['d4', 'c2'])] }), profile: p }, rng));
  }
  // engine-found threats (null-move line): mate and tactic, with and without a hanging piece
  const mateThreat = { uci: 'e8e1', san: 'Re1#', motif: 'backRankMate' as const, targetSquares: ['g1'], gainCp: 10_000 };
  const forkThreat = { uci: 'd4c2', san: 'Nxc2+', motif: 'fork' as const, targetSquares: ['e1', 'a1'], gainCp: 500 };
  out.push(buildThreatWarning({ fen: BACK_RANK_FEN, facts: facts(BACK_RANK_FEN), profile: p, threat: mateThreat, lastMove: null }, rng));
  out.push(buildThreatWarning({ fen: FORK_FEN, facts: facts(FORK_FEN), profile: p, threat: forkThreat }, rng));
  out.push(buildThreatWarning({ fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['d4'])] }), profile: p, threat: forkThreat }, rng));
  out.push(buildSilenceNudge(p, rng));
  out.push(buildPraise(bestMoveJudgement('fork'), p, rng, undefined, { onlyMove: true }));
  out.push(buildThinkingRoutine(p, rng), buildTakebackDeclined(p, rng), buildTakebackAccepted(p, rng));
  for (const [result, termination] of [
    ['0-1', 'checkmate'],
    ['0-1', 'timeout'],
    ['0-1', 'resign'],
    ['1/2-1/2', 'stalemate'],
    ['1/2-1/2', 'draw'],
    ['*', 'abandoned'],
    ['1-0', 'timeout'],
  ] as const) {
    out.push(buildGameEnd({ result, childColor: 'w', termination, summary: summary(), persona: PERSONA, profile: p }, rng));
    out.push(
      buildGameEnd(
        { result, childColor: 'w', termination, summary: summary({ takebacksAccepted: 0, counts: counts({ best: 0, excellent: 0, blunder: 3 }), accuracy: 40 }), persona: PERSONA, profile: p },
        rng,
      ),
    );
  }
  return out.filter((e): e is CoachEvent => e !== null);
}

describe('global text rules over a large generated corpus', () => {
  const events: { e: CoachEvent; p: StudentProfile }[] = [];
  for (const p of PROFILES) {
    for (const r of RNG_SWEEP) for (const e of corpus(p, constRng(r))) events.push({ e, p });
    for (const e of corpus(p, seededRng(42))) events.push({ e, p });
  }

  it('generates a big corpus', () => {
    expect(events.length).toBeGreaterThan(10_000);
  });

  it('`text` never contains Latin letters or notation', () => {
    for (const { e } of events) expect(e.text, `${e.kind}: ${e.text}`).not.toMatch(LATIN);
  });

  it('`text` has no digits-as-notation, no empty / dangling fragments', () => {
    for (const { e } of events) {
      expect(e.text.length, e.kind).toBeGreaterThan(5);
      expect(e.bubbleText.length, e.kind).toBeGreaterThan(5);
      expect(e.text, e.text).not.toMatch(/undefined|null|NaN|\s{2,}|\s[,.!?]/);
      expect(e.bubbleText, e.bubbleText).not.toMatch(/undefined|null|NaN|\s{2,}|\s[,.!?]/);
      expect(e.text, e.text).toMatch(/^[А-ЯЁ«]/);
      expect(e.text, e.text).toMatch(/[.!?»]$/);
    }
  });

  it('never shames', () => {
    for (const { e } of events) {
      expect(e.text, e.text).not.toMatch(SHAMING);
      expect(e.bubbleText, e.bubbleText).not.toMatch(SHAMING);
    }
  });

  it('never names a square and never says «молодец» — in the words or in the bubble', () => {
    for (const { e } of events) {
      expect(hasSpokenSquare(e.text), `${e.kind}: ${e.text}`).toBe(false);
      expect(hasSpokenSquare(e.bubbleText), `${e.kind}: ${e.bubbleText}`).toBe(false);
      expect(e.text, e.text).not.toMatch(BANNED_PRAISE);
      expect(e.bubbleText, e.bubbleText).not.toMatch(BANNED_PRAISE);
    }
  });

  it('the bubble shows words, not notation (only a Latin name typed by the parent may stand in it)', () => {
    for (const { e } of events) expect(e.bubbleText.replace(/Max|Peter/g, ''), `${e.kind}: ${e.bubbleText}`).not.toMatch(LATIN);
  });

  it('agrees past-tense verbs with profile.address', () => {
    for (const { e, p } of events) {
      const wrong = p.address === 'f' ? MASCULINE_CHILD_VERBS : FEMININE_CHILD_VERBS;
      // «Я бы сыграл так» / «я подсветил» is the mascot talking about himself — not in the list.
      expect(e.text, `${p.address}: ${e.text}`).not.toMatch(wrong);
    }
  });

  it('in-game events are ≤ 2 sentences and ≤ 25 words', () => {
    const inGame = new Set(['takebackOffer', 'hint', 'praise', 'threatWarning', 'explainBest', 'encourage']);
    for (const { e } of events) {
      if (!inGame.has(e.kind)) continue;
      expect(countWords(e.text), e.text).toBeLessThanOrEqual(MAX_IN_GAME_WORDS);
      expect(countSentences(e.text), e.text).toBeLessThanOrEqual(2);
    }
  });

  it('the thinking routine is the routine itself plus at most one lead-in, ≤ 25 words', () => {
    for (const { e } of events) {
      if (e.kind !== 'thinkingRoutine') continue;
      expect(countWords(e.text), e.text).toBeLessThanOrEqual(MAX_IN_GAME_WORDS);
      expect(countSentences(e.text), e.text).toBeLessThanOrEqual(4);
    }
  });

  it('out-of-game events stay short too (≤ 5 sentences, ≤ 45 words)', () => {
    for (const { e } of events) {
      expect(countWords(e.text), e.text).toBeLessThanOrEqual(45);
      expect(countSentences(e.text), e.text).toBeLessThanOrEqual(5);
    }
  });

  it('uses the nickname sparingly in in-game events (< 35 % of them)', () => {
    const named = events.filter(({ e, p }) => p.nickname === 'Миша' && e.kind !== 'greeting' && e.kind !== 'gameStart');
    const withName = named.filter(({ e }) => e.text.includes('Миша'));
    expect(named.length).toBeGreaterThan(1000);
    expect(withName.length).toBeGreaterThan(0);
    expect(withName.length / named.length).toBeLessThan(0.35);
  });

  it('a Latin nickname is kept out of speech but may appear in the bubble', () => {
    const max = events.filter(({ p }) => p.nickname === 'Max');
    expect(max.some(({ e }) => e.bubbleText.includes('Max'))).toBe(true);
    expect(max.every(({ e }) => !e.text.includes('Max'))).toBe(true);
  });

  it('every event carries a brief for conversational voices: Latin-free, structured, short', () => {
    for (const { e } of events) {
      const brief = e.brief ?? '';
      expect(brief, `${e.kind}: no brief`).not.toBe('');
      expect(brief, `${e.kind}: ${brief}`).not.toMatch(LATIN);
      expect(brief, brief).toMatch(/^Момент: [А-ЯЁ]/);
      expect(brief, brief).toMatch(/\nЦель: [А-ЯЁ]/);
      expect(brief, brief).not.toMatch(/undefined|null|NaN|\s{2,}|\s[,.!?;:]|;\s*;|\.\./);
      expect(brief.length, brief).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
      // the child is talked ABOUT (third person): «ты» in a brief would be the model itself
      expect(brief.replace(/«[^»]*»/g, ''), brief).not.toMatch(/(?<![а-яё])(твой|твоя|твою|твоего|тебе)(?![а-яё])/i);
      // no evaluation numbers, no engine jargon
      expect(brief, brief).not.toMatch(/%|сантипеш|движ/);
    }
  });

  it('briefs speak about a girl as «ученица», with feminine verbs', () => {
    for (const { e, p } of events) {
      if (p.address !== 'f') continue;
      expect(e.brief, e.brief).not.toMatch(/(?<![а-яё])ученик(?:а|у|ом)?(?![а-яё])/);
      expect(e.brief, e.brief).not.toMatch(/(?<![а-яё])ученица (сыграл|сделал|попросил|решил|согласился|открыл|выиграл|проиграл|объяснил)(?![а-яё])/);
    }
  });

  it('briefs never contain the best move of the CURRENT position (only hint level 4 and the post-mortem explainBest may)', () => {
    let checked = 0;
    for (const { e } of events) {
      const j = e.judgement;
      if (!j || e.kind === 'explainBest' || e.hintLevel === 4) continue;
      if (j.bestUci === j.uci || j.bestSan === j.san) continue; // the child PLAYED the best move — naming it is praise, not a hint
      const best = sanToSpokenRu(j.bestSan, j.fenBefore);
      expect(e.brief, `${e.kind}: ${e.brief}`).not.toContain(best);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('facts are present where the moment is about the board (take-back, threat, praise, game end)', () => {
    const factful = new Set(['takebackOffer', 'threatWarning', 'praise', 'gameEnd', 'hint']);
    for (const { e } of events) {
      if (!factful.has(e.kind)) continue;
      expect(e.brief, `${e.kind}: ${e.brief}`).toMatch(/\nФакты: [А-ЯЁ]/);
    }
  });

  it('gives every event a unique id and a valid shape', () => {
    const ids = new Set(events.map(({ e }) => e.id));
    expect(ids.size).toBe(events.length);
    for (const { e } of events) {
      expect([0, 1, 2]).toContain(e.priority);
      expect(typeof e.pauseClock).toBe('boolean');
      if (e.board) {
        for (const a of e.board.arrows) {
          expect(a.from).toMatch(/^[a-h][1-8]$/);
          expect(a.to).toMatch(/^[a-h][1-8]$/);
        }
        for (const h of e.board.highlights) expect(h.square).toMatch(/^[a-h][1-8]$/);
      }
    }
  });
});

describe('≥ 4 phrase variants per builder', () => {
  const p = profile();
  const cases: [string, (rng: () => number) => CoachEvent | null][] = [
    ['greeting', (rng) => buildGreeting({ profile: p, hour: 10, lastGame: LAST_GAME }, rng)],
    ['greeting (first time)', (rng) => buildGreeting({ profile: { ...p, totals: { ...p.totals, games: 0 } }, hour: 10 }, rng)],
    ['greeting (night)', (rng) => buildGreeting({ profile: p, hour: 23 }, rng)],
    ['gameStart', (rng) => buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.rapid10, childColor: 'w', profile: p }, rng)],
    ['gameStart (bullet)', (rng) => buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.bullet1, childColor: 'b', profile: p }, rng)],
    ['takebackOffer (hanging)', (rng) => buildTakebackOffer(queenBlunder(), p, rng)],
    ['takebackOffer (fork)', (rng) => buildTakebackOffer(forkBlunder(), p, rng)],
    ['takebackOffer (mate)', (rng) => buildTakebackOffer(backRankBlunder(), p, rng)],
    ['hint 1', (rng) => buildHint(1, { fen: HINT_FEN, best: analysisOf(HINT_FEN, 'Qxf7#', { mate: 1 }), facts: facts(HINT_FEN), profile: p }, rng)],
    ['hint 2', (rng) => buildHint(2, { fen: HINT_FEN, best: analysisOf(HINT_FEN, 'Qxf7#', { mate: 1 }), facts: facts(HINT_FEN), profile: p }, rng)],
    ['hint 3', (rng) => buildHint(3, { fen: HINT_FEN, best: analysisOf(HINT_FEN, 'Qxf7#', { mate: 1 }), facts: facts(HINT_FEN), profile: p }, rng)],
    ['hint 4', (rng) => buildHint(4, { fen: HINT_FEN, best: analysisOf(HINT_FEN, 'Qxf7#', { mate: 1 }), facts: facts(HINT_FEN), profile: p }, rng)],
    ['hint (no best move)', (rng) => buildHint(1, { fen: FORK_FEN, best: { fen: FORK_FEN, lines: [], bestmove: '', depth: 0, timeMs: 0 }, facts: facts(FORK_FEN), profile: p }, rng)],
    ['explainBest', (rng) => buildExplainBest(forkBlunder({ missedMotif: 'kingSafety' }), p, rng)],
    ['explainBest (found best)', (rng) => buildExplainBest(bestMoveJudgement('fork'), p, rng)],
    ['praise (generic)', (rng) => buildPraise(bestMoveJudgement(undefined), p, rng)],
    ['praise (fork)', (rng) => buildPraise(bestMoveJudgement('fork'), p, rng)],
    ['threatWarning (named)', (rng) => buildThreatWarning({ fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['d4'])] }), profile: p }, rng)],
    ['threatWarning (socratic)', (rng) => buildThreatWarning({ fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['d4'])] }), profile: profile({ stage: 5 }) }, rng)],
    ['thinkingRoutine (2 questions)', (rng) => buildThinkingRoutine(profile({ stage: 1 }), rng)],
    ['thinkingRoutine (3 questions)', (rng) => buildThinkingRoutine(profile({ stage: 4 }), rng)],
    ['gameEnd win', (rng) => buildGameEnd({ result: '1-0', childColor: 'w', termination: 'checkmate', summary: summary(), persona: PERSONA, profile: p }, rng)],
    ['gameEnd loss', (rng) => buildGameEnd({ result: '0-1', childColor: 'w', termination: 'checkmate', summary: summary(), persona: PERSONA, profile: p }, rng)],
    ['gameEnd draw', (rng) => buildGameEnd({ result: '1/2-1/2', childColor: 'w', termination: 'draw', summary: summary(), persona: PERSONA, profile: p }, rng)],
    ['gameEnd unfinished', (rng) => buildGameEnd({ result: '*', childColor: 'w', termination: 'abandoned', summary: summary(), persona: PERSONA, profile: p }, rng)],
    ['takebackDeclined', (rng) => buildTakebackDeclined(p, rng)],
    ['takebackAccepted', (rng) => buildTakebackAccepted(p, rng)],
  ];

  it.each(cases)('%s', (_name, build) => {
    const seeded = seededRng(7);
    const events = [...sweep(build), ...Array.from({ length: 40 }, () => build(seeded)).filter((e): e is CoachEvent => e !== null)];
    expect(distinctTexts(events)).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic for an injected rng', () => {
    for (const [, build] of cases) {
      expect(build(constRng(0.37))?.text).toBe(build(constRng(0.37))?.text);
    }
  });

  it('with the default rng it never says the same line twice in a row', () => {
    let previous = '';
    for (let i = 0; i < 60; i++) {
      const text = buildThinkingRoutine(profile({ stage: 4 })).text;
      expect(text).not.toBe(previous);
      previous = text;
    }
    previous = '';
    for (let i = 0; i < 60; i++) {
      const text = buildTakebackDeclined(profile()).text;
      expect(text).not.toBe(previous);
      previous = text;
    }
  });
});

describe('buildGreeting', () => {
  it('varies by hour', () => {
    const at = (hour: number): string => buildGreeting({ profile: profile(), hour }, constRng(0)).text;
    expect(at(8)).toMatch(/^Доброе утро, Миша!/);
    expect(at(14)).toMatch(/^Привет-привет, Миша!/);
    expect(at(19)).toMatch(/^Добрый вечер, Миша!/);
    expect(at(23)).toMatch(/^Ого, как поздно, Миша!/);
    expect(at(2)).toMatch(/^Ого, как поздно/);
    expect(at(Number.NaN)).toMatch(/^Привет-привет/);
  });

  it('late at night it suggests a short session (no dark patterns)', () => {
    for (const e of sweep((rng) => buildGreeting({ profile: profile(), hour: 23, lastGame: LAST_GAME }, rng))) {
      expect(e.text).toMatch(/отдыха|спать|боковую/);
    }
  });

  it('varies by the last game and respects gender', () => {
    const won = buildGreeting({ profile: profile({ address: 'f', nickname: 'Маша' }), hour: 14, lastGame: LAST_GAME }, constRng(0));
    expect(won.text).toContain('ты победила');
    const lost = buildGreeting({ profile: profile(), hour: 14, lastGame: { ...LAST_GAME, result: '0-1' } }, constRng(0));
    expect(lost.text).toContain('трудной');
    const draw = buildGreeting({ profile: profile(), hour: 14, lastGame: { ...LAST_GAME, result: '1/2-1/2' } }, constRng(0));
    expect(draw.text).toContain('ничья');
    const blackWin = buildGreeting({ profile: profile(), hour: 14, lastGame: { ...LAST_GAME, childColor: 'b', result: '0-1' } }, constRng(0));
    expect(blackWin.text).toContain('ты победил');
  });

  it('introduces the mascot on the very first visit', () => {
    const p = profile({ totals: { games: 0, wins: 0, losses: 0, draws: 0, puzzlesAttempted: 0, puzzlesSolved: 0, minutesPlayed: 0 } });
    for (const e of sweep((rng) => buildGreeting({ profile: p, hour: 10 }, rng))) {
      expect(e.text).toContain('Гамбитик');
      expect(e.pose).toBe('wave');
      expect(e.kind).toBe('greeting');
    }
  });

  it('works without a nickname', () => {
    expect(buildGreeting({ profile: profile({ nickname: '  ' }), hour: 8 }, constRng(0)).text).toMatch(/^Доброе утро! /);
  });
});

describe('buildGameStart', () => {
  it('names the opponent, never the colour or whose move it is («не озвучивай очевидное»)', () => {
    const e = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.rapid10, childColor: 'w', profile: profile() }, constRng(0));
    expect(e.kind).toBe('gameStart');
    expect(e.text).toContain('Петя');
    expect(e.pauseClock).toBe(false);
    for (const tc of Object.values(TIME_CONTROLS)) {
      for (const childColor of ['w', 'b'] as const) {
        for (const examMode of [false, true]) {
          for (const x of sweep((rng) => buildGameStart({ persona: PERSONA, timeControl: tc, childColor, profile: profile(), examMode }, rng))) {
            expect(x.text).not.toMatch(/белыми|чёрными|белые|чёрные|твой ход|ходит соперник|начинаешь ты/i);
            expect(x.brief ?? '').not.toMatch(/играет (белыми|чёрными)|первым ходит|первый ход за|каким цветом|с кем играем/);
            expect(x.brief).toMatch(/не называй очевидное: чей ход, цвет, циферблат/i);
          }
        }
      }
    }
  });

  it('WAVES as the game starts — every style; the lines after it talk («помахал и начал говорить»)', () => {
    for (const coachStyle of [undefined, 'helper', 'exam', 'teacher'] as const) {
      for (const tc of Object.values(TIME_CONTROLS)) {
        const e = buildGameStart({ persona: PERSONA, timeControl: tc, childColor: 'w', profile: profile(), ...(coachStyle ? { coachStyle } : {}) }, constRng(0));
        expect(e.pose, `${coachStyle} ${tc.id}`).toBe('wave');
      }
    }
  });

  it('greets when the app\'s hello was not heard: «Привет!» (by name) first, in one line with the start', () => {
    for (const tc of Object.values(TIME_CONTROLS)) {
      for (const e of sweep((rng) => buildGameStart({ persona: PERSONA, timeControl: tc, childColor: 'w', profile: profile(), greet: true }, rng))) {
        expect(e.text).toMatch(/^Приве/);
        expect(e.pose).toBe('wave');
        expect(e.brief).toMatch(/сначала поздоровайся одним словом и по имени/i);
        expect(e.text).not.toMatch(LATIN);
      }
    }
    expect(buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.rapid10, childColor: 'w', profile: profile(), greet: true }, constRng(0)).text).toMatch(/^Привет, Миша!/);
    // a Latin nickname is never spoken
    const latin = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.rapid10, childColor: 'w', profile: profile({ nickname: 'Max' }), greet: true }, constRng(0));
    expect(latin.text).toMatch(/^Привет!/);
    // without the flag — no hello: the child has just heard it at home
    for (const e of sweep((rng) => buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.blitz5, childColor: 'w', profile: profile() }, rng))) {
      expect(e.text).not.toMatch(/Приве/);
      expect(e.brief).not.toMatch(/поздоровайся/);
    }
    // bullet: he greets and says he talks after the game
    const bullet = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.bullet1, childColor: 'w', profile: profile(), greet: true }, constRng(0));
    expect(bullet.text).toMatch(/^Привет.*(молч|помолчу|подсказок не будет)/);
  });

  it('buildGameHello: one word and a wave, nothing about the game (the teacher\'s intro follows)', () => {
    for (const p of PROFILES) {
      for (const e of sweep((rng) => buildGameHello(p, rng))) {
        expect(e).toMatchObject({ kind: 'greeting', priority: 1, pose: 'wave', pauseClock: false });
        expect(e.text).toMatch(/^Приве/);
        expect(countWords(e.text)).toBeLessThanOrEqual(3);
        expect(e.text).not.toMatch(LATIN);
        expect(e.brief).toMatch(/поздоровайся одним-двумя словами/i);
        expect(e.brief).toMatch(/ни о партии, ни о ходах/i);
        expect(e.brief).not.toMatch(LATIN);
      }
    }
  });

  it('announces silence in bullet and calm in training', () => {
    for (const e of sweep((rng) => buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.bullet1, childColor: 'w', profile: profile() }, rng))) {
      expect(e.text).toMatch(/молч|помолчу|подсказок не будет/);
    }
    for (const e of sweep((rng) => buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: profile() }, rng))) {
      expect(e.text).toMatch(/Часов нет|Торопиться некуда|Времени сколько хочешь|без часов/);
    }
  });

  it('exam mode never promises hints or company', () => {
    for (const tc of [TIME_CONTROLS.training, TIME_CONTROLS.rapid10, TIME_CONTROLS.blitz5]) {
      for (const p of [profile(), profile({ address: 'f' })]) {
        for (const e of sweep((rng) => buildGameStart({ persona: PERSONA, timeControl: tc, childColor: 'w', profile: p, examMode: true }, rng))) {
          expect(e.text).toMatch(/экзамен/i);
          expect(e.text).not.toMatch(/Подсказка|я рядом|подумаем вместе/);
          if (p.address === 'f') expect(e.text).not.toMatch(/(?<![а-яё])сам(?![а-яё])/);
        }
      }
    }
    // without the flag nothing changes
    const usual = sweep((rng) => buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: profile() }, rng)).map((e) => e.text).join(' ');
    expect(usual).not.toMatch(/экзамен/i);
  });

  it('keeps a Latin persona name out of speech only', () => {
    const e = buildGameStart({ persona: { ...PERSONA, name: 'Peter' }, timeControl: TIME_CONTROLS.rapid10, childColor: 'w', profile: profile() }, constRng(0));
    expect(e.text).not.toMatch(LATIN);
    expect(e.bubbleText).toContain('Peter');
  });
});

describe('buildGameStart — coach styles (TEACHER-MODE §6.2)', () => {
  it('the teacher without a strategy: ONE short line — no greeting, clock, colour or «спрашивай меня»', () => {
    for (const tc of [TIME_CONTROLS.training, TIME_CONTROLS.rapid10]) {
      for (const e of sweep((rng) => buildGameStart({ persona: PERSONA, timeControl: tc, childColor: 'w', profile: profile(), coachStyle: 'teacher' }, rng))) {
        expect(e.kind).toBe('gameStart');
        expect(e.text).toMatch(/покаж|показ/i);
        expect(e.text).not.toMatch(/Подсказка|Петя|белыми|чёрными|часы|часов|минут|секунд|время|удачи|спрашивай/i);
        expect(e.text.split(/[.!?]/).filter((x) => x.trim() !== '').length).toBeLessThanOrEqual(2);
        expect(e.brief).toMatch(/показывать хорошие ходы/);
        expect(e.brief ?? '').not.toMatch(/часы|минут|секунд|время|белыми|чёрными/i);
        expect(e.brief).toMatch(/без приветствий/);
        expect(e.brief).not.toMatch(/замолчи|можно говорить в любой момент/);
        expect(e.teach).toMatchObject({ moment: 'openingPlan', advice: [] });
      }
    }
    const girl = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.rapid10, childColor: 'b', profile: profile({ address: 'f' }), coachStyle: 'teacher' }, constRng(0.6));
    expect(girl.text).not.toMatch(MASCULINE_CHILD_VERBS);
    expect(girl.brief).toMatch(/выбирает ученица/);
  });

  it('exam via coachStyle is the exam; bullet stays silent even with a teacher style; helper is unchanged', () => {
    const exam = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: profile(), coachStyle: 'exam' }, constRng(0));
    expect(exam.text).toMatch(/экзамен/i);
    expect(exam.brief).toMatch(/без подсказок/);
    const bullet = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.bullet1, childColor: 'w', profile: profile(), coachStyle: 'teacher' }, constRng(0));
    expect(bullet.brief).not.toMatch(/учитель/);
    expect(bullet.brief).toMatch(/молчать/);
    const helper = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: profile(), coachStyle: 'helper' }, constRng(0.3));
    const plain = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: profile() }, constRng(0.3));
    expect(helper.text).toBe(plain.text);
    expect(helper.brief).toBe(plain.brief);
  });
});

describe('buildTakebackOffer — teacher variant (TEACHER-MODE §1.4, §6.2)', () => {
  const advice = [
    { uci: 'f1c4', san: 'Bc4', source: 'repertoire' as const, arrow: 'green' as const },
    { uci: 'b1c3', san: 'Nc3', source: 'engine' as const, arrow: 'blue' as const },
  ];

  it('is concrete and reminds the advice; in-game length rules hold for every variant and address', () => {
    for (const p of PROFILES) {
      for (const e of sweep((rng) => buildTakebackOffer(queenBlunder(), p, rng, { advice }))) {
        expect(e.kind).toBe('takebackOffer');
        expect(e.priority).toBe(2);
        expect(e.teach).toEqual({ moment: 'reaction', style: 'full', ply: 5, advice });
        expect(countWords(e.text), e.text).toBeLessThanOrEqual(MAX_IN_GAME_WORDS);
        expect(countSentences(e.text), e.text).toBeLessThanOrEqual(2);
        expect(e.text).not.toMatch(LATIN);
        expect(e.text).not.toMatch(SHAMING);
        expect(e.brief).toMatch(/Можно назвать: слон на цэ четыре; конь на цэ три; конь бьёт на е пять \(ход соперника\)\./);
        expect(e.brief).toMatch(/раньше ты советовал: слон на цэ четыре или конь на цэ три/i);
        expect(e.brief).not.toMatch(LATIN);
        expect((e.brief ?? '').length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
        if (p.address === 'f') expect(e.brief).not.toMatch(/(?<![а-яё])ученик(?:а|у|ом)?(?![а-яё])/);
      }
    }
  });

  it('an empty or illegal advice falls back to the helper offer', () => {
    const plain = buildTakebackOffer(queenBlunder(), profile(), constRng(0));
    expect(buildTakebackOffer(queenBlunder(), profile(), constRng(0), { advice: [] }).brief).toBe(plain.brief);
    expect(buildTakebackOffer(queenBlunder(), profile(), constRng(0), { advice: [{ uci: 'a1a8', san: 'Ra8', source: 'engine', arrow: 'green' }] }).teach).toBeUndefined();
  });

  it('the second try in the same position: «и этот ход теряет …» and the advice, short', () => {
    for (const p of PROFILES) {
      for (const e of sweep((rng) => buildTakebackOffer(queenBlunder(), p, rng, { advice, again: true }))) {
        expect(e).toMatchObject({ kind: 'takebackOffer', priority: 2, pauseClock: true });
        expect(e.text).toMatch(/ферзя/);
        expect(e.text).toMatch(/подумаем/);
        expect(countWords(e.text), e.text).toBeLessThanOrEqual(MAX_IN_GAME_WORDS);
        expect(e.text).not.toMatch(SHAMING);
        expect(e.brief).toMatch(/уже вернул|уже вернула/);
        expect(e.brief).toMatch(/и этот ход теряет/);
        expect(e.teach?.advice).toEqual(advice);
      }
    }
  });
});

describe('buildTakebackOffer — the second try in the same position', () => {
  it('one short line «и этот ход теряет ферзя — давай ещё подумаем», no second Socratic speech, no shame', () => {
    for (const p of PROFILES) {
      for (const e of sweep((rng) => buildTakebackOffer(queenBlunder(), p, rng, { again: true }))) {
        expect(e).toMatchObject({ kind: 'takebackOffer', priority: 2, pose: 'oops', pauseClock: true });
        expect(e.text).toMatch(/ферзя/);
        expect(e.text).toMatch(/подумаем/);
        expect(e.text).not.toMatch(/Стоп-стоп|Тпру|Погоди-ка/);
        expect(countSentences(e.text), e.text).toBeLessThanOrEqual(2);
        expect(e.text).not.toMatch(SHAMING);
        expect(e.text).not.toMatch(LATIN);
        expect(e.brief).toMatch(/в той же позиции другой, но и он что-то теряет/);
        expect(e.brief).toMatch(/и этот ход теряет/);
        expect(e.brief).toMatch(/не говори «опять»/);
        expect(e.brief).not.toMatch(LATIN);
        if (p.address === 'f') expect(e.brief).toMatch(/уже вернула/);
      }
    }
    // the red squares stay: the danger is on the board again
    expect(buildTakebackOffer(queenBlunder(), profile(), constRng(0), { again: true }).board?.highlights).toEqual([{ square: 'e5', color: 'red' }]);
    // a mate: nothing «lost» by name
    for (const e of sweep((rng) => buildTakebackOffer(backRankBlunder(), profile(), rng, { again: true }))) expect(e.text).toMatch(/что-то теря/);
  });

  it('differs from the first offer', () => {
    const first = new Set(sweep((rng) => buildTakebackOffer(queenBlunder(), profile(), rng)).map((e) => e.text));
    for (const e of sweep((rng) => buildTakebackOffer(queenBlunder(), profile(), rng, { again: true }))) expect(first.has(e.text)).toBe(false);
  });
});

describe('buildTakebackQuestion («Почему так?» while the take-back question is open)', () => {
  it('asks the same Socratic question again: no «Стоп-стоп», no better move, the red squares, a recorded question line', () => {
    for (const j of [queenBlunder(), forkBlunder(), backRankBlunder()]) {
      for (const e of sweep((rng) => buildTakebackQuestion(j, profile(), rng))) {
        const offer = buildTakebackOffer(j, profile(), constRng(0));
        expect(e).toMatchObject({ kind: 'answer', priority: 1, pauseClock: true });
        expect(e.text).toMatch(/\?$/);
        expect(e.text).not.toMatch(/верн(ём|уть) ход|хороший ход|крепкий/);
        expect(e.board).toEqual(offer.board);
        const items = (e.clip?.sentences ?? []).flatMap((x) => x.items);
        expect(items).toHaveLength(1);
        expect(items[0] && 'line' in items[0] ? items[0].line : '').toMatch(/^takeback\.q\./);
      }
    }
  });
});

describe('buildTakebackOffer', () => {
  it('is an interrupting, clock-pausing offer that carries the judgement', () => {
    const j = queenBlunder();
    const e = buildTakebackOffer(j, profile(), constRng(0));
    expect(e).toMatchObject({ kind: 'takebackOffer', priority: 2, pose: 'oops', pauseClock: true, motif: 'hangingPiece', judgement: j });
    expect(e.hintLevel).toBeUndefined();
  });

  it('always offers to return the move and asks a question', () => {
    for (const j of [queenBlunder(), forkBlunder(), backRankBlunder()]) {
      for (const e of sweep((rng) => buildTakebackOffer(j, profile(), rng))) {
        expect(e.text).toMatch(/верн(ём|уть) ход/);
        expect(e.text).toMatch(/\?$/);
      }
    }
  });

  it('marks the endangered squares in RED and never shows the solution', () => {
    const j = forkBlunder();
    for (const e of sweep((rng) => buildTakebackOffer(j, profile(), rng))) {
      expect(e.board).toEqual({ arrows: [], highlights: [{ square: 'c2', color: 'red' }, { square: 'a1', color: 'red' }] });
      // neither the best move nor its squares are spoken or written
      expect(e.bubbleText).not.toContain('0-0-0');
      expect(e.text).not.toContain('рокировка');
    }
    expect(buildTakebackOffer(queenBlunder(), profile(), constRng(0)).board?.highlights).toEqual([{ square: 'e5', color: 'red' }]);
    expect(buildTakebackOffer(backRankBlunder(), profile(), constRng(0)).board?.highlights).toEqual([{ square: 'g1', color: 'red' }]);
  });

  it('has no board when there is no refutation line', () => {
    const e = buildTakebackOffer(queenBlunder({ refutationPvUci: [], refutationPvSan: [] }), profile(), constRng(0));
    expect(e.board).toBeUndefined();
  });

  it('is motif-aware', () => {
    const texts = (j: ReturnType<typeof queenBlunder>): string => sweep((rng) => buildTakebackOffer(j, profile(), rng)).map((e) => e.text).join(' | ');
    expect(texts(forkBlunder())).toMatch(/вилк/);
    expect(texts(queenBlunder({ allowedMotif: 'pin' }))).toMatch(/связк/);
    expect(texts(queenBlunder())).toMatch(/без защиты/);
    expect(texts(queenBlunder())).toMatch(/под боем/);
    expect(texts(backRankBlunder())).toMatch(/форточк/);
    expect(texts(queenBlunder({ allowedMotif: 'mateIn2' }))).toMatch(/шах/);
    expect(texts(queenBlunder({ allowedMotif: 'skewer' }))).toMatch(/на одной линии/);
    expect(texts(queenBlunder({ allowedMotif: 'trappedPiece' }))).toMatch(/отступить|путь назад/);
  });

  it('asks the Socratic question about the punishing piece', () => {
    const texts = sweep((rng) => buildTakebackOffer(forkBlunder({ allowedMotif: undefined, materialLossPawns: 0 }), profile(), rng)).map((e) => e.text);
    expect(texts.some((t) => t.includes('Посмотри, что теперь может сделать конь соперника?'))).toBe(true);
    const forkTexts = sweep((rng) => buildTakebackOffer(forkBlunder(), profile(), rng)).map((e) => e.text);
    expect(forkTexts.some((t) => t.includes('Куда может прыгнуть конь соперника'))).toBe(true);
  });

  it('treats an unnamed mate / material loss sensibly', () => {
    const mate = sweep((rng) => buildTakebackOffer(backRankBlunder({ allowedMotif: undefined }), profile(), rng));
    expect(mate.every((e) => /шах|корол/i.test(e.text))).toBe(true);
    expect(mate[0]?.board?.highlights).toEqual([{ square: 'g1', color: 'red' }]);
    const material = sweep((rng) => buildTakebackOffer(queenBlunder({ allowedMotif: undefined, materialLossPawns: 8 }), profile(), rng));
    expect(material.some((e) => /под боем|без защиты|теряет|забрать/.test(e.text))).toBe(true);
  });
});

describe('buildHint — the ladder', () => {
  const args = { fen: HINT_FEN, best: analysisOf(HINT_FEN, 'Qxf7#', { mate: 1 }), facts: facts(HINT_FEN), profile: profile() };

  it('level 1: a Socratic question, no board marks, nothing revealed', () => {
    for (const e of sweep((rng) => buildHint(1, args, rng))) {
      expect(e).toMatchObject({ kind: 'hint', hintLevel: 1, priority: 2, pauseClock: true, pose: 'think' });
      expect(e.board).toBeUndefined();
      expect(e.text).toMatch(/\?$/);
      expect(e.text).not.toMatch(/эф семь|аш пять|ферз/);
    }
  });

  it('level 2: a YELLOW zone around the target, still no piece and no move', () => {
    for (const e of sweep((rng) => buildHint(2, args, rng))) {
      expect(e.hintLevel).toBe(2);
      expect(e.board?.arrows).toEqual([]);
      expect(e.board?.highlights).toHaveLength(9);
      expect(e.board?.highlights.every((h) => h.color === 'yellow')).toBe(true);
      expect(e.board?.highlights.map((h) => h.square)).toContain('f7');
      expect(e.text).toMatch(/королевск/);
      expect(e.text).not.toMatch(/эф семь|ферз/);
    }
  });

  it('level 3: the piece to move in BLUE — named by the piece, never by its square; the destination is not revealed', () => {
    for (const e of sweep((rng) => buildHint(3, args, rng))) {
      expect(e.hintLevel).toBe(3);
      expect(e.board).toEqual({ arrows: [], highlights: [{ square: 'h5', color: 'blue' }] });
      expect(e.text).toMatch(/ферз/);
      expect(hasSpokenSquare(e.text), e.text).toBe(false);
      expect(e.bubbleText).toBe(e.text);
    }
  });

  it('level 4: GREEN arrow of the move; the words say the piece (what it takes) and why — no square, no «лучший»', () => {
    for (const e of sweep((rng) => buildHint(4, args, rng))) {
      expect(e.hintLevel).toBe(4);
      expect(e.board).toEqual({ arrows: [{ from: 'h5', to: 'f7', color: 'green' }], highlights: [] });
      expect(e.text).toContain('ферзь бьёт пешку');
      expect(e.text).toContain('Это мат!');
      expect(hasSpokenSquare(e.text), e.text).toBe(false);
      expect(e.text).not.toMatch(/лучш|сильнейш|сильный ход/i);
      expect(e.bubbleText).toBe(e.text);
    }
  });

  it('adapts the idea: saving a hanging piece, castling, developing', () => {
    const save = { fen: FORK_FEN, best: analysisOf(FORK_FEN, 'Rd1'), facts: facts(FORK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['d4'])] }), profile: profile() };
    expect(buildHint(1, save, constRng(0.99)).text).toMatch(/под боем|спокойно/);
    expect(buildHint(3, save, constRng(0)).text).toBe('Посмотри на свою ладью. Она под боем — куда ей лучше уйти?');
    expect(buildHint(4, save, constRng(0)).text).toBe('Смотри на зелёную стрелку: ход ладьёй. Так ладья уходит из-под боя.');

    const castle = { fen: FORK_FEN, best: analysisOf(FORK_FEN, 'O-O-O'), facts: facts(FORK_FEN), profile: profile() };
    expect(buildHint(3, castle, constRng(0)).text).toBe('Посмотри на своего короля. Как спрятать его в безопасный домик?');
    expect(buildHint(4, castle, constRng(0)).text).toContain('длинная рокировка');
    expect(buildHint(4, castle, constRng(0)).bubbleText).toContain('длинная рокировка');

    const start = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const develop = { fen: start, best: analysisOf(start, 'Nf3'), facts: facts(start, { phase: 'opening' as const }), profile: profile() };
    expect(buildHint(1, develop, constRng(0)).text).toContain('спят дома');
    expect(buildHint(3, develop, constRng(0)).text).toBe('Посмотри на своего коня. Он ещё не вышел в игру — куда его поставить?');
    expect(buildHint(4, develop, constRng(0)).text).toBe('Смотри на зелёную стрелку: ход конём. Ещё одна фигура выходит в игру.');
    // a capture names what it takes; every template of the ladder is square-free for every idea
    const takeFen = '4k3/8/8/3p4/8/8/3R4/4K3 w - - 0 1';
    const take = { fen: takeFen, best: analysisOf(takeFen, 'Rxd5'), facts: facts(takeFen), profile: profile() };
    expect(buildHint(4, take, constRng(0)).text).toBe('Смотри на зелёную стрелку: ладья бьёт пешку. Это выгодное взятие.');
    for (const a of [save, castle, develop, take]) {
      for (const level of [1, 2, 3, 4] as HintLevel[]) {
        for (const e of sweep((rng) => buildHint(level, a, rng))) {
          expect(hasSpokenSquare(e.text), e.text).toBe(false);
          expect(e.bubbleText, e.bubbleText).not.toMatch(LATIN);
        }
      }
    }
  });

  it('falls back to bestmove when there are no lines, and to a generic question when nothing is legal', () => {
    const noLines = { fen: HINT_FEN, best: { ...analysisOf(HINT_FEN, 'Qxf7#'), lines: [] }, facts: facts(HINT_FEN), profile: profile() };
    expect(buildHint(4, noLines, constRng(0)).board?.arrows).toEqual([{ from: 'h5', to: 'f7', color: 'green' }]);
    const broken = { fen: HINT_FEN, best: { fen: HINT_FEN, lines: [], bestmove: 'a1a8', depth: 0, timeMs: 0 }, facts: facts(HINT_FEN), profile: profile() };
    const e = buildHint(4, broken, constRng(0));
    expect(e.board).toBeUndefined();
    expect(e.hintLevel).toBe(4);
    expect(e.text).toMatch(/\?$|\.$/);
  });
});

describe('buildExplainBest', () => {
  it('draws the best move in GREEN and the refutation in RED', () => {
    const j = forkBlunder({ missedMotif: 'kingSafety' });
    const e = buildExplainBest(j, profile(), constRng(0));
    expect(e).toMatchObject({ kind: 'explainBest', priority: 1, pauseClock: true, judgement: j });
    expect(e.board).toEqual({
      arrows: [
        { from: 'e1', to: 'c1', color: 'green' },
        { from: 'd4', to: 'c2', color: 'red' },
      ],
      highlights: [],
    });
    expect(e.text).toBe('Сильнее было так: длинная рокировка — так королю спокойнее. А после твоего хода соперник ставит вилку.');
    // the bubble shows the same words: no notation, the arrows show the moves
    expect(e.bubbleText).toBe(e.text);
  });

  it('a nominative move always follows a colon: never «Сильнее было конь бьёт на …» (docs/voice-clips/SPEC.md §3.5)', () => {
    const texts = sweep((rng) => buildExplainBest(queenBlunder({ missedMotif: 'fork' }), profile({ address: 'f' }), rng)).map((e) => e.text);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t).not.toMatch(/сильнее было (?!так:)/iu);
      if (/сильнее было/iu.test(t)) expect(t).toMatch(/сильнее было так: /iu);
    }
    expect(texts.some((t) => /Ты сходила иначе, а сильнее было так: /u.test(t))).toBe(true);
  });

  it('uses motif wording for what was missed and what was allowed', () => {
    const all = (j: ReturnType<typeof forkBlunder>): string => sweep((rng) => buildExplainBest(j, profile(), rng)).map((e) => e.text).join(' | ');
    expect(all(queenBlunder({ missedMotif: 'fork' }))).toContain('это вилка');
    expect(all(queenBlunder({ missedMotif: 'pin', allowedMotif: 'hangingPiece' }))).toContain('фигура осталась без защиты');
    expect(all(backRankBlunder())).toContain('угроза мата');
    expect(all(backRankBlunder({ allowedMotif: undefined }))).toContain('угроза мата');
    expect(all(queenBlunder({ allowedMotif: undefined }))).toContain('красная стрелка');
  });

  it('names the better move by its piece and what it takes, never by a square (the green arrow shows which rook)', () => {
    const j = forkBlunder({ bestSan: 'Rad1', bestUci: 'a1d1' });
    const e = buildExplainBest(j, profile(), constRng(0));
    expect(e.text).toContain('Сильнее было так: ход ладьёй');
    expect(e.bubbleText).toBe(e.text);
    const take = judgement({ fen: '4k3/8/8/3p4/8/8/3R4/4K3 w - - 0 1', played: 'Kf1', best: 'Rxd5', refutation: ['Ke7'], over: { missedMotif: 'freeCapture' } });
    for (const x of sweep((rng) => buildExplainBest(take, profile({ address: 'f' }), rng))) {
      expect(x.text).toMatch(/ладья бьёт пешку/);
      expect(hasSpokenSquare(x.text), x.text).toBe(false);
      expect(x.bubbleText).not.toMatch(LATIN);
    }
  });

  it('respects gender', () => {
    const texts = sweep((rng) => buildExplainBest(forkBlunder(), profile({ address: 'f' }), rng)).map((e) => e.text);
    expect(texts.some((t) => t.includes('Ты сходила иначе'))).toBe(true);
  });

  it('when the child already played the best move it only confirms it', () => {
    const e = buildExplainBest(bestMoveJudgement('fork'), profile(), constRng(0));
    expect(e.text).toBe('Ты нашёл самый сильный ход в этой позиции!');
    for (const x of sweep((rng) => buildExplainBest(bestMoveJudgement('fork'), profile({ address: 'f' }), rng))) {
      expect(x.text).not.toMatch(/лучш|так держать/i);
      expect(hasSpokenSquare(x.text), x.text).toBe(false);
      expect(x.bubbleText).toBe(x.text);
    }
    expect(e.board).toEqual({ arrows: [{ from: 'd4', to: 'b5', color: 'green' }], highlights: [] });
    expect(e.pose).toBe('cheer');
  });

  it('survives a judgement without refutation', () => {
    const e = buildExplainBest(queenBlunder({ refutationPvUci: [], refutationPvSan: [], allowedMotif: undefined }), profile(), constRng(0));
    expect(e.board?.arrows).toEqual([{ from: 'f1', to: 'c4', color: 'green' }]);
    expect(e.text).toContain('ход слоном');
  });
});

describe('buildPraise', () => {
  it('is optional chatter that does not stop the clock', () => {
    const j = bestMoveJudgement('fork');
    const e = buildPraise(j, profile(), constRng(0));
    expect(e).toMatchObject({ kind: 'praise', priority: 0, pose: 'cheer', pauseClock: false, motif: 'fork', judgement: j });
    expect(e.board).toBeUndefined();
  });

  it('names the motif the child found', () => {
    const head = (m: MotifId): string => buildPraise(bestMoveJudgement(m), profile(), constRng(0)).text;
    expect(head('fork')).toMatch(/^Вилка/);
    expect(head('pin')).toMatch(/^Связка/);
    expect(head('hangingPiece')).toMatch(/без защиты — и ты её забрал!/);
    expect(buildPraise(bestMoveJudgement('hangingPiece'), profile({ address: 'f' }), constRng(0)).text).toMatch(/ты её забрала!/);
    expect(buildPraise(bestMoveJudgement('fork', { san: 'Qxf7#' }), profile(), constRng(0)).text).toMatch(/^Мат/);
  });

  it('accepts the found motif explicitly when the judgement carries none', () => {
    const e = buildPraise(bestMoveJudgement(undefined), profile(), constRng(0), 'pin');
    expect(e.text).toMatch(/^Связка/);
    expect(e.motif).toBe('pin');
  });

  it('praises the process, not talent', () => {
    for (const m of [undefined, ...ALL_MOTIFS]) {
      for (const e of sweep((rng) => buildPraise(bestMoveJudgement(m), profile(), rng))) {
        expect(e.text).not.toMatch(/умн|талант|гени|молодец/i);
      }
    }
  });

  it('only claims "the strongest move" when it was the engine\'s best', () => {
    const notBest = bestMoveJudgement(undefined, { classification: 'excellent', bestUci: 'a2a3' });
    for (const e of sweep((rng) => buildPraise(notBest, profile(), rng))) expect(e.text).not.toContain('самый сильный');
    const best = sweep((rng) => buildPraise(bestMoveJudgement(undefined), profile(), rng));
    expect(best.some((e) => e.text.includes('самый сильный'))).toBe(true);
  });

  it('«Ход конём!» is reserved for knight moves', () => {
    const knight = sweep((rng) => buildPraise(bestMoveJudgement(undefined), profile(), rng));
    expect(knight.some((e) => e.text.startsWith('Ход конём!'))).toBe(true);
    const pawn = sweep((rng) => buildPraise(bestMoveJudgement(undefined, { san: 'e4' }), profile(), rng));
    expect(pawn.some((e) => e.text.includes('Ход конём'))).toBe(false);
  });
});

describe('buildThreatWarning', () => {
  const rookHangs = facts(FORK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['d4', 'c2', 'b3'])] });

  it('returns null when nothing of the child hangs', () => {
    expect(buildThreatWarning({ fen: FORK_FEN, facts: facts(FORK_FEN), profile: profile() })).toBeNull();
    // opponent's piece hanging is not a threat to the child
    expect(buildThreatWarning({ fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('d4', 'n', 'b', 300)] }), profile: profile() })).toBeNull();
    // a pawn is not worth an interruption
    expect(buildThreatWarning({ fen: FORK_FEN, facts: facts(FORK_FEN, { hanging: [hanging('c2', 'p', 'w', 100)] }), profile: profile() })).toBeNull();
  });

  it('stays silent when the child is in check', () => {
    expect(buildThreatWarning({ fen: FORK_FEN, facts: { ...rookHangs, inCheck: true }, profile: profile() })).toBeNull();
  });

  it('names and marks the most valuable hanging piece on early stages', () => {
    const f = facts(FORK_FEN, { hanging: [hanging('h1', 'n', 'w', 300, ['g3']), hanging('a1', 'r', 'w', 500, ['d4', 'c2', 'b3'])] });
    const e = buildThreatWarning({ fen: FORK_FEN, facts: f, profile: profile({ stage: 2 }) }, constRng(0));
    expect(e).toMatchObject({ kind: 'threatWarning', priority: 1, pauseClock: true, motif: 'hangingPiece' });
    expect(e?.text).toBe('Осторожно: твоя ладья под боем! Кто её защищает?');
    // the square is never said nor written: the red mark shows it
    expect(e?.bubbleText).toBe(e?.text);
    expect(e?.board).toEqual({
      arrows: [
        { from: 'd4', to: 'a1', color: 'red' },
        { from: 'c2', to: 'a1', color: 'red' },
      ],
      highlights: [{ square: 'a1', color: 'red' }],
    });
  });

  it('agrees pronouns with the piece', () => {
    const knight = facts(FORK_FEN, { hanging: [hanging('f3', 'n', 'w', 300, ['g4'])] });
    expect(buildThreatWarning({ fen: FORK_FEN, facts: knight, profile: profile() }, constRng(0))?.text).toBe('Осторожно: твой конь под боем! Кто его защищает?');
    expect(buildThreatWarning({ fen: FORK_FEN, facts: knight, profile: profile() }, constRng(0.5))?.text).toBe('Копытом чую: на твоего коня кто-то напал! Как ему помочь?');
    for (const e of sweep((rng) => buildThreatWarning({ fen: FORK_FEN, facts: knight, profile: profile({ stage: 1 }) }, rng))) {
      expect(e.text).toMatch(/кон/);
      expect(hasSpokenSquare(e.text), e.text).toBe(false);
      expect(e.bubbleText).not.toMatch(LATIN);
    }
  });

  it('from stage 4 it only asks — no piece, no marks', () => {
    for (const e of sweep((rng) => buildThreatWarning({ fen: FORK_FEN, facts: rookHangs, profile: profile({ stage: 4 }) }, rng))) {
      expect(e.board).toBeUndefined();
      expect(e.text).not.toMatch(/ладь|а один/);
      expect(e.text).toMatch(/\?|\./);
    }
  });
});

describe('buildThinkingRoutine', () => {
  it('stages 1–2: two questions', () => {
    for (const e of sweep((rng) => buildThinkingRoutine(profile({ stage: 2 }), rng))) {
      expect(e.text).toContain('Что хочет соперник? Мой ход безопасен?');
      expect(e.kind).toBe('thinkingRoutine');
    }
  });

  it('stage 3+: the three questions from ARCHITECTURE §5, verbatim', () => {
    for (const e of sweep((rng) => buildThinkingRoutine(profile({ stage: 3 }), rng))) {
      expect(e.text).toContain('Что хочет соперник? Что могу я — шахи, взятия, угрозы? Безопасно ли?');
    }
  });
});

describe('buildGameEnd', () => {
  const base = { childColor: 'w' as const, persona: PERSONA, profile: profile() };

  it('childOutcome', () => {
    expect(childOutcome('1-0', 'w')).toBe('win');
    expect(childOutcome('1-0', 'b')).toBe('loss');
    expect(childOutcome('0-1', 'b')).toBe('win');
    expect(childOutcome('0-1', 'w')).toBe('loss');
    expect(childOutcome('1/2-1/2', 'w')).toBe('draw');
    expect(childOutcome('*', 'b')).toBe('unfinished');
  });

  it('win: cheers, praises the process, gives one thing to practise', () => {
    const e = buildGameEnd({ ...base, result: '1-0', termination: 'checkmate', summary: summary({ motifsAllowed: ['fork', 'pin', 'fork'] }) }, constRng(0));
    expect(e).toMatchObject({ kind: 'gameEnd', priority: 2, pose: 'cheer', pauseClock: false, motif: 'fork' });
    // a take-back alone is NOT «нашёл лучше»: pressing the button is not the achievement
    expect(e.text).toBe('Победа! И-го-го! Ты вернул ход и подумал ещё раз — это сильная привычка. Идея на завтра: потренируемся замечать вилки заранее.');
  });

  it('claims «вернул ход и нашёл лучше» only when the code has proved it (takebacksImproved)', () => {
    const args = { ...base, result: '1-0' as const, termination: 'checkmate' as const, summary: summary({ takebacksAccepted: 1 }) };
    const proved = buildGameEnd({ ...args, takebacksImproved: 1 }, constRng(0));
    expect(proved.text).toContain('Мне понравилось, как ты вернул ход и нашёл лучше — вот это работа головой!');
    const girl = buildGameEnd({ ...args, profile: profile({ address: 'f' }), takebacksImproved: 2 }, constRng(0));
    expect(girl.text).toContain('как ты вернула ход и нашла лучше');
    for (const improved of [undefined, 0]) {
      for (const e of sweep((rng) => buildGameEnd({ ...args, takebacksImproved: improved }, rng))) {
        expect(e.text).not.toMatch(/наш(ёл|ла) лучше/);
      }
    }
    // no take-back at all → no take-back praise, whatever the caller passes
    const none = sweep((rng) => buildGameEnd({ ...args, summary: summary({ takebacksAccepted: 0 }) }, rng)).map((e) => e.text).join(' | ');
    expect(none).not.toMatch(/вернул ход/);
  });

  it('does not say «сам» about strong moves in a game with hints', () => {
    const withHints = summary({ takebacksAccepted: 0, hintsUsed: 5, counts: counts({ best: 6, excellent: 3, blunder: 2 }), accuracy: 60 });
    const texts = sweep((rng) => buildGameEnd({ ...base, result: '1-0', termination: 'checkmate', summary: withHints }, rng)).map((e) => e.text);
    expect(texts.join(' | ')).toContain('У тебя было много сильных ходов — ты искал их внимательно.');
    for (const t of texts) expect(t).not.toMatch(/нашёл их сам/);
    const alone = summary({ takebacksAccepted: 0, hintsUsed: 0, takebacksOffered: 1, counts: counts({ best: 6, excellent: 3, blunder: 2 }), accuracy: 60 });
    const aloneTexts = sweep((rng) => buildGameEnd({ ...base, result: '1-0', termination: 'checkmate', summary: alone }, rng)).map((e) => e.text).join(' | ');
    expect(aloneTexts).toContain('и ты нашёл их сам');
  });

  it('loss: feelings first, still one praise and one idea', () => {
    for (const e of sweep((rng) => buildGameEnd({ ...base, result: '0-1', termination: 'checkmate', summary: summary({ motifsAllowed: ['hangingPiece'] }) }, rng))) {
      expect(e.pose).toBe('idle');
      expect(e.text).toMatch(/^(Обидно, понимаю|Трудная была партия|Ничего страшного|Сегодня сильнее оказался соперник)/);
      expect(e.text).toMatch(/Мне понравилось|Ты вернул ход|Ты играл|У тебя было|Ты справился|Ты старался|Каждая партия/);
      expect(e.text).toContain('«Это безопасно?»');
      expect(e.motif).toBe('hangingPiece');
    }
  });

  it('draw and unfinished games', () => {
    const draw = buildGameEnd({ ...base, result: '1/2-1/2', termination: 'stalemate', summary: summary() }, constRng(0.99));
    expect(draw.text).toMatch(/^Пат — это ничья/);
    const unfinished = buildGameEnd({ ...base, result: '*', termination: 'abandoned', summary: summary() }, constRng(0));
    expect(unfinished.text).toMatch(/^Партия не доиграна/);
  });

  it('falls back to what the child missed, then to a default practice line', () => {
    const missed = buildGameEnd({ ...base, result: '1-0', termination: 'resign', summary: summary({ motifsAllowed: [], motifsMissed: ['backRankMate'] }) }, constRng(0));
    expect(missed.motif).toBe('backRankMate');
    expect(missed.text).toContain('форточку');
    const none = buildGameEnd({ ...base, result: '1-0', termination: 'resign', summary: summary({ motifsAllowed: [], motifsMissed: [] }) }, constRng(0));
    expect(none.motif).toBeUndefined();
    expect(none.text).toContain('Идея на завтра: решим пару задачек');
  });

  it('only gives praise that the summary supports', () => {
    const rough = summary({ takebacksAccepted: 0, takebacksOffered: 2, hintsUsed: 3, accuracy: 35, counts: counts({ best: 1, excellent: 0, blunder: 4 }) });
    for (const e of sweep((rng) => buildGameEnd({ ...base, result: '0-1', termination: 'resign', summary: rough }, rng))) {
      expect(e.text).not.toMatch(/ни одного зевка|очень точно|без единой подсказки|вернул ход|до самого конца/);
      expect(e.text).toMatch(/Ты старался|Каждая партия/);
    }
    const clean = summary({ takebacksAccepted: 0, takebacksOffered: 0, hintsUsed: 0, accuracy: 91, counts: counts({ blunder: 0 }) });
    const texts = sweep((rng) => buildGameEnd({ ...base, result: '1-0', termination: 'checkmate', summary: clean }, rng)).map((e) => e.text).join(' | ');
    expect(texts).toContain('ни одного зевка');
    expect(texts).toContain('очень точно');
    expect(texts).toContain('без единой подсказки');
  });

  it('speech and bubble pick the same variant (identical when there is no notation or Latin name)', () => {
    for (const r of RNG_SWEEP) {
      const e = buildGameEnd({ ...base, result: '1-0', termination: 'checkmate', summary: summary() }, constRng(r));
      expect(e.text).toBe(e.bubbleText);
    }
    const latin = buildGameEnd({ ...base, persona: { ...PERSONA, name: 'Peter' }, result: '1-0', termination: 'checkmate', summary: summary() }, constRng(0.6));
    expect(latin.text).toMatch(/^Победа за тобой!/);
    expect(latin.bubbleText).toMatch(/^Соперник сегодня — Peter, и победа за тобой!/);
  });
});

describe('small extras of the live game', () => {
  it('buildGameResumed: one happy line with a wave — never whose move it is (the board shows it), never pauses the clock', () => {
    for (const childToMove of [true, false]) {
      for (const e of sweep((rng) => buildGameResumed({ childToMove, profile: profile() }, rng))) {
        expect(e).toMatchObject({ kind: 'gameStart', priority: 1, pauseClock: false, pose: 'wave' });
        expect(e.text).not.toMatch(/твой ход|ход соперника|чей/i);
        expect(e.brief).not.toMatch(/сейчас ход|скажи, чей ход/i);
        expect(e.brief).toMatch(/не называй очевидное/i);
      }
    }
  });

  it('decline reasons: three first-person labels (gendered) and a kind, droppable reply to each', () => {
    expect(TAKEBACK_DECLINE_REASONS).toEqual(['planned', 'dontSee', 'risk']);
    expect(declineReasonLabelRu('planned', 'm')).toBe('Я так задумал');
    expect(declineReasonLabelRu('planned', 'f')).toBe('Я так задумала');
    expect(declineReasonLabelRu('dontSee', 'f')).toBe('Не вижу, что не так');
    expect(declineReasonLabelRu('risk', 'm')).toBe('Хочу рискнуть');
    for (const reason of TAKEBACK_DECLINE_REASONS) {
      for (const e of sweep((rng) => buildDeclineReasonReply(reason, profile(), rng))) {
        expect(e).toMatchObject({ kind: 'encourage', priority: 0, pauseClock: false });
        expect(e.text).not.toMatch(SHAMING);
        expect(countWords(e.text)).toBeLessThanOrEqual(12);
      }
    }
  });

  it('buildVoluntaryTakeback treats a slip as a slip', () => {
    for (const e of sweep((rng) => buildVoluntaryTakeback(profile(), rng))) {
      expect(e).toMatchObject({ kind: 'encourage', priority: 1, pauseClock: false });
      expect(e.text).not.toMatch(SHAMING);
    }
  });

  it('buildOpeningIdea names the plan and tells its idea; a cautionary line is introduced as a warning', () => {
    const idea = 'Развиваем все фигуры, прячем короля и готовим удар в центре.';
    const e = buildOpeningIdea({ title: 'Тихая итальянка', idea, profile: profile() }, constRng(0));
    expect(e).toMatchObject({ kind: 'encourage', priority: 1, pauseClock: true });
    expect(e.text).toBe(`Узнаю наш дебютный план: тихая итальянка. ${idea}`);
    expect(e.text).toBe(e.bubbleText);
    const warnings = sweep((rng) => buildOpeningIdea({ title: 'Почему нельзя жадничать.', idea: 'Пешку не удержать.', warning: true, profile: profile() }, rng)).map((x) => x.text);
    for (const text of warnings) {
      expect(text).toMatch(/^(Осторожно, знакомая история: почему нельзя жадничать\.|Помнишь наш урок — почему нельзя жадничать\?) Пешку не удержать\.$/);
    }
  });
});

describe('briefs — facts + goal for the conversational coach', () => {
  it('take-back offer: what was played, the opponent\'s answer, the loss, the chances — never the better move', () => {
    const j = forkBlunder();
    for (const e of sweep((rng) => buildTakebackOffer(j, profile({ address: 'f' }), rng))) {
      const brief = e.brief ?? '';
      expect(brief).toContain('Ход ученицы: пешка на аш три.');
      expect(brief).toContain('конь бьёт на цэ два, шах');
      expect(brief).toMatch(/соперник ставит вилку \(одна фигура нападает сразу на две\)/);
      expect(brief).toContain('ладью');
      expect(brief).toMatch(/позиция была примерно равной, стала почти проигранной/);
      expect(brief).toMatch(/Цель: Мягко останови и предложи вернуть ход; спроси своими словами, что теперь может сделать соперник; мысль вопроса — «[^»]+», но скажи её по-своему, не этими словами/);
      expect(brief).toMatch(/Нельзя: Не называй лучший ход/);
      expect(brief).not.toContain('длинная рокировка');
      // the Socratic question of the template is offered as an example, the model phrases its own
      expect(brief).toContain(e.text.slice(e.text.lastIndexOf('!') + 2));
    }
  });

  it('take-back offer into mate: says how soon the mate comes', () => {
    const e = buildTakebackOffer(backRankBlunder(), profile(), constRng(0));
    expect(e.brief).toContain('ладья на е один, мат');
    expect(e.brief).toContain('Соперник может сразу поставить мат.');
  });

  it('a refutation line that would sound like the best move is cut before it', () => {
    // the child's best was Kd2; the (made-up) refutation line has the child play Kd2 as a reply: it must not be read out
    const j = forkBlunder({ bestSan: 'Kd2', bestUci: 'e1d2' });
    const e = buildTakebackOffer(j, profile(), constRng(0));
    expect(e.brief).toContain('конь бьёт на цэ два, шах');
    expect(e.brief).not.toContain('король на дэ два');
  });

  it('hint ladder: levels 1–3 never name the move or its target square, level 4 does', () => {
    const cases = [
      { fen: HINT_FEN, san: 'Qxf7#', mate: 1 as number | null, to: 'f7' },
      { fen: FORK_FEN, san: 'O-O-O', mate: null, to: 'c1' },
      { fen: BACK_RANK_FEN, san: 'h3', mate: null, to: 'h3' },
    ];
    for (const c of cases) {
      const args = { fen: c.fen, best: analysisOf(c.fen, c.san, { mate: c.mate }), facts: facts(c.fen), profile: profile() };
      const spoken = sanToSpokenRu(c.san, c.fen);
      for (const level of [1, 2, 3] as HintLevel[]) {
        for (const e of sweep((rng) => buildHint(level, args, rng))) {
          expect(e.brief, e.brief).not.toContain(spoken);
          expect(e.brief, e.brief).not.toContain(squareToSpokenRu(c.to));
          expect(e.brief).toMatch(new RegExp(`${['первая', 'вторая', 'третья'][level - 1]} ступень`));
        }
      }
      const top = buildHint(4, args, constRng(0));
      expect(top.brief).toContain(`Сильный ход: ${spoken}`);
    }
    const third = buildHint(3, { fen: HINT_FEN, best: analysisOf(HINT_FEN, 'Qxf7#', { mate: 1 }), facts: facts(HINT_FEN), profile: profile() }, constRng(0));
    expect(third.brief).toContain('Ходить стоит ферзём с клетки аш пять');
  });

  it('threat warning: a hanging piece, an engine-found mate or tactic — named facts, a Socratic goal on later stages', () => {
    const rook = facts(FORK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['d4'])] });
    const named = buildThreatWarning({ fen: FORK_FEN, facts: rook, profile: profile({ stage: 2 }), lastMove: { san: 'Nd4', fenBefore: 'r3k2r/ppp2ppp/8/4n3/8/8/PPP2PPP/R3K2R b KQkq - 0 11' } }, constRng(0));
    expect(named?.brief).toContain('Соперник сыграл конь на дэ четыре');
    expect(named?.brief).toContain('Под боем ладья на а один, нападает конь соперника');
    expect(named?.brief).toMatch(/помоги ученику самому заметить опасность/);
    const socratic = buildThreatWarning({ fen: FORK_FEN, facts: rook, profile: profile({ stage: 5 }) }, constRng(0));
    expect(socratic?.brief).toMatch(/не называя фигуру/);
    expect(socratic?.board).toBeUndefined();

    // no hanging piece, but the engine sees a fork coming
    const forkThreat = { uci: 'd4c2', san: 'Nxc2+', motif: 'fork' as const, targetSquares: ['e1', 'a1'], gainCp: 500 };
    const tactic = buildThreatWarning({ fen: FORK_FEN, facts: facts(FORK_FEN), profile: profile({ stage: 2 }), threat: forkThreat }, constRng(0));
    expect(tactic).not.toBeNull();
    expect(tactic?.motif).toBe('fork');
    expect(tactic?.text).toMatch(/вилк/);
    expect(tactic?.board?.highlights).toEqual([
      { square: 'e1', color: 'red' },
      { square: 'a1', color: 'red' },
    ]);
    expect(tactic?.brief).toContain('соперник сыграет конь бьёт на цэ два, шах и получит вилку');
    expect(tactic?.brief).toContain('Под прицелом: король на е один, ладья на а один.');

    const mateThreat = { uci: 'e8e1', san: 'Re1+', motif: 'mateIn2' as const, targetSquares: ['g1'], gainCp: 10_000 };
    const mate = buildThreatWarning({ fen: BACK_RANK_FEN, facts: facts(BACK_RANK_FEN, { hanging: [hanging('a1', 'r', 'w', 500, ['e8'])] }), profile: profile(), threat: mateThreat }, constRng(0));
    // a mate threat outranks a hanging rook
    expect(mate?.motif).toBe('mateIn2');
    expect(mate?.text).toMatch(/мат/);
    expect(mate?.brief).toContain('получит мат');
  });

  it('praise brief names what was found; only a real tactic is worth the normal talkativeness', () => {
    const e = buildPraise(bestMoveJudgement('fork'), profile(), constRng(0), undefined, { onlyMove: true });
    expect(e.brief).toContain('Ход ученика: конь на бэ пять.');
    expect(e.brief).toContain('Это вилка');
    expect(e.brief).toContain('Других хороших ходов здесь почти не было.');
    expect(e.brief).toMatch(/а не за ум/);
    expect(isRealTacticMotif('fork')).toBe(true);
    expect(isRealTacticMotif('mateIn1')).toBe(true);
    expect(isRealTacticMotif('hangingPiece')).toBe(false);
    expect(isRealTacticMotif('freeCapture')).toBe(false);
    expect(isRealTacticMotif(undefined)).toBe(false);
  });

  it('game end brief: result, how it ended, what went well, one idea — feelings first after a loss', () => {
    const loss = buildGameEnd({ result: '0-1', childColor: 'w', termination: 'checkmate', summary: summary(), persona: PERSONA, profile: profile({ address: 'f' }) }, constRng(0));
    expect(loss.brief).toContain('Ученица проиграла партию сопернику по имени Петя.');
    expect(loss.brief).toContain('Соперник поставил мат.');
    expect(loss.brief).toMatch(/Что получилось: ученица соглашалась вернуть ход/);
    expect(loss.brief).toMatch(/Идея на будущее: потренируемся замечать вилки заранее\./);
    expect(loss.brief).toMatch(/Цель: Сначала посочувствуй/);
    const win = buildGameEnd({ result: '1-0', childColor: 'w', termination: 'resign', summary: summary(), persona: { ...PERSONA, name: 'Peter' }, profile: profile() }, constRng(0));
    expect(win.brief).toContain('Ученик выиграл партию.');
    expect(win.brief).toContain('Соперник сдался.');
    expect(win.brief).not.toMatch(/[A-Za-z]/);
  });

  it('silence nudge: one gentle invitation to think aloud, never hurries, never hints', () => {
    for (const e of sweep((rng) => buildSilenceNudge(profile(), rng))) {
      expect(e).toMatchObject({ kind: 'encourage', priority: 1, pauseClock: false, pose: 'listen' });
      expect(e.text).not.toMatch(/быстр|скорее|давай уже/i);
      expect(e.brief).toMatch(/молча думает/);
      expect(e.brief).toMatch(/не торопи/i);
    }
  });

  it('greeting and game start briefs: the moment and the goal, no personal questions', () => {
    const g = buildGreeting({ profile: profile(), hour: 23, lastGame: LAST_GAME }, constRng(0));
    expect(g.brief).toMatch(/почти ночь/);
    expect(g.brief).toMatch(/одну спокойную партию/);
    expect(g.brief).toMatch(/Не расспрашивай о личном/);
    const start = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.bullet1, childColor: 'b', profile: profile() }, constRng(0));
    expect(start.brief).toMatch(/до конца партии будешь молчать/);
    // the colour and whose move it is are on the screen: not a fact to retell
    expect(start.brief).not.toMatch(/играет (белыми|чёрными)|первым ходит|первый ход за/);
    const exam = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: profile(), examMode: true }, constRng(0));
    expect(exam.brief).toMatch(/экзамен/);
    expect(exam.brief).toMatch(/Не обещай подсказок/);
    const coached = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: profile() }, constRng(0));
    expect(coached.brief).toMatch(/с тобой можно говорить в любой момент/);
  });
});
