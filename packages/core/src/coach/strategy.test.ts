/**
 * The game strategy of «Учитель» (brief, never reads the clock, a new strategy every game): the one-line strategy
 * intro, «по нашему плану …» reasons, the deviation line, the strategist's re-plans (fresh vs stale), and the brevity invariants over scripted 20-ply games — ≤ 25 words, ≤ 2 sentences, no clock words
 * in texts AND briefs. The strategy library and the content come from the sibling packages (test-only relative imports).
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, CoachEvent, Color, EngineLine, GameStrategy, MoveJudgement, ReplanResponse, StudentProfile } from '@gambit/shared';
import { TIME_CONTROLS } from '@gambit/shared';
import { getConceptCard } from '../../../content/src/conceptCards.ts';
import { getRepertoirePlan, mainLineMoves } from '../../../content/src/openings.ts';
import { STRATEGIES, getStrategy } from '../../../content/src/strategies.ts';
import type { StrategyEntry } from '../../../content/src/strategies.ts';
import { lookupOpening } from '../../../openings/src/index.ts';
import { winPct } from '../analysis/eval.ts';
import { buildPositionAnswerRu, LOW_CLOCK_MS } from './answers.ts';
import { buildGameStart, buildTakebackOffer } from './events.ts';
import { computePositionFacts } from '../analysis/facts.ts';
import { countSentences, countWords } from './phrase.ts';
import {
  CLOCK_WORDS_RE,
  cleanStrategistRu,
  freshReplan,
  introFromStrategist,
  moveInsRu,
  planGoalDone,
  planGoalFits,
  planGoalFor,
  planGoalRu,
  replanWords,
  strategyIntroRu,
  strategyProgress,
  titleAccRu,
} from './strategy.ts';
import type { TeachStrategy } from './strategy.ts';
import {
  CHOICE_EVERY_TURNS,
  OPP_SENTENCE_WORDS,
  TEACH_MAX_WORDS,
  acceptReplan,
  buildReplanFollowUp,
  buildReplanRequest,
  buildTeachReaction,
  buildTeachTurn,
  initialTeachMemory,
  planTeachTurn,
  reactionVerdict,
  replanCandidates,
  replanReason,
  resolveTeachStrategy,
} from './teacher.ts';
import type { MoveIdeasApi, ReactionVerdict, TeachContext, TeachMemory, TeachPlan } from './teacher.ts';
import { PERSONA, constRng, judgement, profile, seededRng } from './test-fixtures.ts';

const CLOCK = /минут|секунд|часы|время/i;
const LATIN = /[A-Za-z]/;

// ───────────────────────── the scripted engine ─────────────────────────

type Spec = [string, number];

function fenOf(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

function scripted(fen: string, specs: readonly Spec[], depth = 16): AnalysisResult {
  const lines: EngineLine[] = specs.map(([san, cp], i) => {
    const m = new Chess(fen).move(san);
    return { multipv: i + 1, depth, pvUci: [`${m.from}${m.to}${m.promotion ?? ''}`], cp, mate: null };
  });
  return { fen, lines, bestmove: lines[0]?.pvUci[0] ?? '', depth, timeMs: 300 };
}

function card(id: string): StrategyEntry {
  const c = getStrategy(id);
  if (!c) throw new Error(`no strategy ${id}`);
  return c;
}

/** The server's answer for a library strategy (the template provider). */
function gameStrategy(c: StrategyEntry, over: Partial<GameStrategy> = {}): GameStrategy {
  return { strategyId: c.id, titleRu: c.titleRu, ideaRu: c.ideaRu, introRu: '', provider: 'template', ...over };
}

function ctxAfter(sans: readonly string[], childColor: Color, specs: readonly Spec[] | null, over: Partial<TeachContext> = {}): TeachContext {
  const fen = fenOf(sans);
  let lastBotMove: TeachContext['lastBotMove'] = null;
  if (sans.length > 0) {
    const before = fenOf(sans.slice(0, -1));
    const m = new Chess(before).move(sans[sans.length - 1] as string);
    lastBotMove = { uci: `${m.from}${m.to}${m.promotion ?? ''}`, san: m.san, fenBefore: before };
  }
  return {
    fen,
    ply: sans.length + 1,
    childColor,
    profile: profile({ stage: 1 }),
    analysis: specs ? scripted(fen, specs) : null,
    lastBotMove,
    historySan: sans,
    repertoire: getRepertoirePlan(sans, childColor) ?? null,
    mainLineSans: mainLineMoves(fen),
    openingNameRu: (f) => lookupOpening(f)?.nameRu,
    conceptCard: getConceptCard,
    conceptsIntroduced: [],
    timed: true,
    remainingMs: 300_000,
    ...over,
  };
}

function withStrategy(ctx: TeachContext, c: StrategyEntry, over: Partial<GameStrategy> = {}): TeachContext {
  return { ...ctx, strategy: gameStrategy(c, over), strategyCard: c };
}

function turn(ctx: TeachContext, rng: () => number = constRng(0)): { plan: TeachPlan; ev: CoachEvent } {
  const plan = planTeachTurn(ctx, rng);
  return { plan, ev: buildTeachTurn(plan, rng) };
}

function judged(sans: readonly string[], played: string, best: string, before = 25, after = 25): MoveJudgement {
  const wb = winPct({ cp: before, mate: null });
  const wa = winPct({ cp: after, mate: null });
  return judgement({
    setup: [...sans],
    played,
    best,
    over: { ply: sans.length + 1, evalBefore: { cp: before, mate: null }, evalAfter: { cp: after, mate: null }, winPctBefore: wb, winPctAfter: wa, winPctLoss: Math.max(0, wb - wa), classification: 'best' },
  });
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((x) => x.trim() !== '');
}

/** The brevity contract of every teacher phrase. */
function checkBrief(ev: CoachEvent): void {
  expect(countWords(ev.text), ev.text).toBeLessThanOrEqual(TEACH_MAX_WORDS);
  expect(countSentences(ev.text), ev.text).toBeLessThanOrEqual(2);
  expect(ev.text, ev.text).not.toMatch(CLOCK);
  expect(ev.text, ev.text).not.toMatch(LATIN);
  expect(ev.brief ?? '', ev.brief).not.toMatch(CLOCK);
  expect(ev.brief ?? '', ev.brief).not.toMatch(LATIN);
  expect(ev.brief ?? '', ev.brief).not.toMatch(/белыми|чёрными|режим «Учитель»/);
  // the hard sentence budget is in the brief itself (the voice frame of the web may still say more)
  expect(ev.brief ?? '').toMatch(/не больше (двух|одного) предложени/);
  // the opponent's move — a few words at most (also when it leads the advice: «Соперник вывел коня на эф шесть — …»)
  for (const s of sentences(ev.text)) if (/^Соперник (вывел|поставил|пошёл|забрал|напал|рано|сделал|объявил)/.test(s)) expect(countWords(s.split(' — ')[0] as string), s).toBeLessThanOrEqual(6);
}

// ───────────────────────── the strategy intro ─────────────────────────

describe('the strategy intro — ONE line at the start', () => {
  const italian = card('italian');

  it('gameStart in teacher style: «В этот раз разыграем …. Начни …» with the first move as the green arrow', () => {
    const ev = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.rapid10, childColor: 'w', profile: profile(), coachStyle: 'teacher', strategy: resolveTeachStrategy({ strategy: gameStrategy(italian), strategyCard: italian }) }, constRng(0));
    expect(ev.kind).toBe('gameStart');
    expect(ev.text).toBe('В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е четыре.');
    expect(countWords(ev.text)).toBeLessThanOrEqual(20);
    expect(ev.bubbleText).toContain('e4');
    expect(ev.teach).toEqual({ moment: 'openingPlan', style: 'full', ply: 1, advice: [{ uci: 'e2e4', san: 'e4', source: 'repertoire', arrow: 'green' }], reveal: 'now' });
    expect(ev.board?.arrows).toEqual([{ from: 'e2', to: 'e4', color: 'green' }]);
    expect(ev.brief).toContain('Можно назвать: пешка на е четыре (зелёная стрелка).');
    expect(ev.brief).toMatch(/Итальянская партия/);
    // no greeting fluff, no clock, no colour, no «спрашивай меня»
    expect(ev.text).not.toMatch(/Петя|белыми|удачи|привет|спрашивай|минут|часы/i);
    expect(ev.brief ?? '').not.toMatch(CLOCK);
    expect(ev.brief ?? '').not.toMatch(/белыми|чёрными/);
  });

  it('Black: the reply after the opponent\'s first move; before it — the strategy without a move', () => {
    const open = card('open-game');
    const strategy = resolveTeachStrategy({ strategy: gameStrategy(open), strategyCard: open });
    const after = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'b', profile: profile(), coachStyle: 'teacher', strategy, fen: fenOf(['e4']) }, constRng(0));
    expect(after.text).toBe('В этот раз разыграем Открытую игру — отвечаем пешкой в центр и выводим все фигуры. Ответь пешкой на е пять.');
    expect(after.teach?.ply).toBe(2);
    expect(after.teach?.advice.map((a) => a.san)).toEqual(['e5']);
    const before = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'b', profile: profile(), coachStyle: 'teacher', strategy }, constRng(0));
    expect(before.text).toBe('В этот раз разыграем Открытую игру — отвечаем пешкой в центр и выводим все фигуры.');
    expect(before.teach?.advice).toEqual([]);
    expect(before.board).toBeUndefined();
    expect(before.brief).not.toContain('Можно назвать');
  });

  it('the strategist\'s own intro is used only when it is clean and names no other move', () => {
    const own = 'Сегодня играем итальянку: быстро выводим фигуры. Начни пешкой на е четыре!';
    const ok = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: profile(), coachStyle: 'teacher', strategy: { ...resolveTeachStrategy({ strategy: gameStrategy(italian, { introRu: own }), strategyCard: italian }) as TeachStrategy } }, constRng(0));
    expect(ok.text).toBe(own);
    expect(introFromStrategist('Начни конём на е четыре.', 'e4')).toBeNull(); // right square, wrong piece
    expect(introFromStrategist('Начни пешкой на дэ четыре.', 'e4')).toBeNull(); // another square
    expect(introFromStrategist('Play e4 now', 'e4')).toBeNull();
    expect(introFromStrategist('У тебя пять минут, начинаем итальянку.', 'e4')).toBeNull();
    expect(introFromStrategist('Играем итальянку и целимся в слабую точку', 'e4')).toBe('Играем итальянку и целимся в слабую точку.');
    // a clean intro without a move gets the verified move appended
    const noMove = buildGameStart({ persona: PERSONA, timeControl: TIME_CONTROLS.training, childColor: 'w', profile: profile(), coachStyle: 'teacher', strategy: resolveTeachStrategy({ strategy: gameStrategy(italian, { introRu: 'Сегодня итальянка — целимся в слабую точку.' }), strategyCard: italian }) }, constRng(0));
    expect(noMove.text).toBe('Сегодня итальянка — целимся в слабую точку. Начни пешкой на е четыре.');
  });

  it('strategyIntroRu: every library strategy gives a clean intro of ≤ 20 words (the server\'s template provider)', () => {
    for (const c of STRATEGIES) {
      const first = c.side === 'b' ? { e4: 'e2e4', d4: 'd2d4', other: 'g1f3', any: undefined }[c.against] : undefined;
      const intro = strategyIntroRu(resolveTeachStrategy({ strategyCard: c }) as TeachStrategy, c.side, first);
      expect(intro, c.id).toMatch(/^В этот раз разыграем /);
      expect(intro, c.id).toMatch(/(Начни|Ответь) [а-яё]+ на [а-яё]+ [а-яё]+\.$/);
      expect(countWords(intro), intro).toBeLessThanOrEqual(20);
      expect(intro, intro).not.toMatch(LATIN);
      expect(intro, intro).not.toMatch(CLOCK_WORDS_RE);
    }
  });

  it('titles in the accusative and moves in the instrumental', () => {
    expect(titleAccRu('Итальянская партия')).toBe('Итальянскую партию');
    expect(titleAccRu('Партия четырёх коней')).toBe('Партию четырёх коней');
    expect(titleAccRu('Защита Каро-Канн')).toBe('Защиту Каро-Канн');
    expect(titleAccRu('Ферзевый гамбит')).toBe('Ферзевый гамбит');
    expect(titleAccRu('Лондонская система')).toBe('Лондонскую систему');
    for (const c of STRATEGIES) expect(titleAccRu(c.titleRu).toLowerCase()).toBe(c.titleAccRu.toLowerCase());
    expect(moveInsRu('e4')).toBe('пешкой на е четыре');
    expect(moveInsRu('Nf3')).toBe('конём на эф три');
    expect(moveInsRu('O-O')).toBe('короткой рокировкой');
    expect(moveInsRu('Nbd2')).toBe('');
  });

  it('the first teacher turn of a game with a strategy IS the intro (when the game did not say it at the start)', () => {
    const london = card('london');
    // E1: e4 +28, Нf3 +20, d4 +20 — the London's d4 is within the tolerance and leads by the strategy bonus
    const ctx = withStrategy(ctxAfter([], 'w', [['e4', 28], ['Nf3', 20], ['d4', 20]]), london);
    const { plan, ev } = turn(ctx);
    expect(plan.intro).toBe(true);
    expect(plan.advice[0]?.san).toBe('d4');
    expect(plan.advice[0]?.planFit).toBe('line');
    expect(ev.teach?.moment).toBe('openingPlan');
    expect(ev.teach?.style).toBe('full');
    expect(ev.text).toBe('В этот раз разыграем Лондонскую систему — сначала выводим слона, потом строим крепость из пешек. Начни пешкой на дэ четыре.');
    expect(ev.board?.arrows[0]).toEqual({ from: 'd2', to: 'd4', color: 'green' });
    expect(briefLineOf(ev.brief, 'Цель')).toMatch(/какую стратегию разыграем/);
    checkBrief(ev);
    expect(plan.memory.strategyIntroSaid).toBe(true);
    // said at the start already: the turn is marked, the intro is not repeated
    const again = turn({ ...ctx, introSaid: true });
    expect(again.plan.intro).toBe(false);
    expect(again.plan.alreadySaid).toBe(true);
    expect(again.plan.style).toBe('full');
    expect(again.ev.text).not.toMatch(/В этот раз/);
  });

  it('different strategies lead different first moves from the same engine lines', () => {
    const lines: Spec[] = [['e4', 28], ['Nf3', 20], ['d4', 20]];
    const first = (id: string): string | undefined => turn(withStrategy(ctxAfter([], 'w', lines), card(id))).plan.advice[0]?.san;
    expect(first('italian')).toBe('e4');
    expect(first('london')).toBe('d4');
    expect(first('queens-gambit')).toBe('d4');
  });
});

/** The brief without its «Нельзя» line (which quotes forbidden words on purpose), lower-cased. */
function claimsOf(brief: string | undefined): string {
  return (brief ?? '').split('\n').filter((l) => !l.startsWith('Нельзя:')).join('\n').toLowerCase();
}

function briefLineOf(brief: string | undefined, name: string): string {
  return (brief ?? '').split('\n').find((l) => l.startsWith(`${name}:`)) ?? '';
}

// ───────────────────────── plan-aware reasons ─────────────────────────

describe('«по нашему плану …» — the reason connects the move to the strategy', () => {
  const italian = card('italian');
  const sans = ['e4', 'e5', 'Nf3', 'Nc6'];
  // E5 of TEACHER-MODE §8.1: d4 +33, Сb5 +32, Сc4 +20
  const specs: Spec[] = [['d4', 33], ['Bb5', 32], ['Bc4', 20]];
  const memory: TeachMemory = { ...initialTeachMemory(), turns: 2, strategyIntroSaid: true };

  it('the strategy move Сc4 becomes the green arrow and is explained by the plan and its concrete idea', () => {
    const { plan, ev } = turn(withStrategy(ctxAfter(sans, 'w', specs, { memory }), italian));
    expect(plan.advice[0]?.san).toBe('Bc4');
    expect(plan.advice[0]?.planFit).toBe('line');
    expect(plan.advice[0]?.source).toBe('repertoire');
    // a plan head (the opener of the turn) with the move and its concrete idea
    expect(plan.opener).toBe('plan');
    expect(ev.text).toMatch(/^По нашему плану — слон на цэ четыре/);
    expect(ev.text).toMatch(/эф семь/);
    // (the title is the intro's; each turn only says it is «ход нашего плана» — nothing extra)
    // (this turn brings the topic «разбуди фигуры» — the topic IS the reason, no second one)
    expect(ev.brief).toContain('Слон на цэ четыре (зелёная стрелка) — ход нашего плана. Новая тема «разбуди фигуры»: каждым ходом — новая фигура в игру.');
    expect(ev.brief).not.toContain('«Итальянская партия»');
    expect(briefLineOf(ev.brief, 'Цель')).toMatch(/назови ход как шаг нашего плана/);
    expect(briefLineOf(ev.brief, 'Цель')).toMatch(/начни со слов «По нашему плану»/);
    expect(briefLineOf(ev.brief, 'Нельзя')).toMatch(/ничего не добавляй от себя: [^.;]*ни всего плана/);
    checkBrief(ev);
  });

  it('without a strategy the same position is advised as before (no plan words)', () => {
    const { plan, ev } = turn(ctxAfter(sans, 'w', specs, { memory: { ...initialTeachMemory(), turns: 2 } }));
    expect(plan.advice[0]?.planFit).toBeUndefined();
    expect(ev.text).not.toMatch(/плану/);
  });

  it('a middlegame tag of the strategy is «по плану» too; an unrelated move is not', () => {
    const fen = 'r1bqr1k1/bpp2pp1/p1np1n1p/4p3/2B1P3/2PP1NN1/PP3PPP/R1BQR1K1 w - - 2 11';
    const ctx: TeachContext = { fen, ply: 21, childColor: 'w', profile: profile({ stage: 3 }), analysis: scripted(fen, [['h3', 20], ['a4', 15], ['b4', 10]]), memory: { ...initialTeachMemory(), turns: 10, strategyIntroSaid: true }, strategy: gameStrategy(italian), strategyCard: italian };
    const { plan } = turn(ctx);
    expect(plan.advice.find((a) => a.san === 'h3')?.planFit).toBe('middlegame');
    expect(plan.advice.find((a) => a.san === 'b4')?.planFit).toBeUndefined();
  });
});

// ───────────────────────── the opponent leaves the road ─────────────────────────

describe('the deviation line — «соперник свернул с дороги — теперь …»', () => {
  const italian = card('italian');
  // the Italian main line has 2…Nc6; the bot plays 2…d6
  const sans = ['e4', 'e5', 'Nf3', 'd6'];
  const specs: Spec[] = [['Bc4', 45], ['d4', 40], ['Nc3', 25]];
  const memory: TeachMemory = { ...initialTeachMemory(), turns: 2, strategyIntroSaid: true };

  it('is said once, shortly, with the plan\'s next GOAL when there is no re-plan (the strategy goes on)', () => {
    expect(strategyProgress(resolveTeachStrategy({ strategyCard: italian }), sans, 'w')?.left).toEqual({ ply: 4, by: 'opponent' });
    const { plan, ev } = turn(withStrategy(ctxAfter(sans, 'w', specs, { memory }), italian));
    expect(plan.deviation?.textRu).toBe('Соперник свернул с нашей дороги — теперь целимся слоном в слабую точку эф семь.');
    expect(ev.text).toMatch(/^Соперник свернул с нашей дороги — теперь целимся слоном в слабую точку эф семь\. /);
    expect(ev.brief).toMatch(/Соперник свернул с дороги нашей стратегии «Итальянская партия» — теперь цель плана: целимся слоном в слабую точку эф семь/);
    expect(ev.brief).not.toMatch(/по правилам/);
    // the goal counts as said: the next one is another
    expect(plan.memory.goalTurn).toBe(1);
    checkBrief(ev);
    // the next turn does not repeat it
    const next = turn(withStrategy(ctxAfter([...sans, 'Bc4', 'Be7'], 'w', [['Nc3', 30], ['O-O', 28], ['d3', 20]], { memory: plan.memory }), italian));
    expect(next.plan.deviation).toBeNull();
    expect(next.ev.text).not.toMatch(/свернул/);
    // …and the planned moves still count off the main line: Сc4 was «по нашему плану» (a later planned move)
    expect(plan.advice.find((a) => a.san === 'Bc4')?.planFit).toBe('lineLater');
  });

  it('with a fresh re-plan the line carries the new plan words', () => {
    const replan: ReplanResponse = { ply: 5, planRu: 'давим на центр и быстро выводим фигуры', preferredUci: null, whyRu: '', provider: 'codex' };
    const { plan, ev } = turn(withStrategy(ctxAfter(sans, 'w', specs, { memory, replan }), italian));
    expect(plan.deviation?.textRu).toBe('Соперник свернул с нашей дороги — теперь давим на центр и быстро выводим фигуры.');
    expect(ev.brief).toMatch(/теперь давим на центр/);
    checkBrief(ev);
    expect(plan.memory.planRu).toBe('давим на центр и быстро выводим фигуры');
    expect(plan.memory.planRuSaid).toBe(true);
  });

  it('a child who leaves the road is not told that the OPPONENT did', () => {
    // the child played 2.d4 instead of the Italian 2.Nf3
    const own = ['e4', 'e5', 'd4', 'exd4'];
    const { plan } = turn(withStrategy(ctxAfter(own, 'w', [['Qxd4', 20], ['c3', 15], ['Nf3', 10]], { memory }), italian));
    expect(plan.deviation).toBeNull();
  });
});

describe('a Black system against any first move (against: «other»)', () => {
  const system = card('classic-development');

  it('the opponent never leaves the road of a system: after 1.b3 the plan move is 1…d5, «по нашему плану»', () => {
    const s = resolveTeachStrategy({ strategyCard: system });
    expect(s?.against).toBe('other');
    // (its main line starts with 1.Nf3 only as an example)
    expect(strategyProgress(s, ['b3'], 'b')).toEqual({ onLine: true, nextSan: 'd5', left: null, remaining: [...system.lineSan] });
    expect(strategyProgress(s, ['b3', 'd5', 'Bb2', 'Nf6', 'e3'], 'b')).toMatchObject({ onLine: true, nextSan: 'e6', left: null });
    // the child's own other move leaves it — by the child
    expect(strategyProgress(s, ['b3', 'e5', 'Bb2'], 'b')).toMatchObject({ onLine: false, nextSan: null, left: { ply: 2, by: 'child' } });
    const { plan, ev } = turn(withStrategy(ctxAfter(['b3'], 'b', [['e5', 30], ['d5', 25], ['Nf6', 20]], { memory: { ...initialTeachMemory(), strategyIntroSaid: true } }), system));
    expect(plan.deviation).toBeNull();
    expect(plan.advice[0]?.san).toBe('d5');
    expect(plan.advice[0]?.planFit).toBe('line');
    expect(ev.text).not.toMatch(/свернул/);
    checkBrief(ev);
  });

  it('the intro for Black answers the real first move: «Ответь пешкой на дэ пять.»', () => {
    const intro = strategyIntroRu(resolveTeachStrategy({ strategyCard: system }) as TeachStrategy, 'b', 'b2b3');
    expect(intro).toMatch(/^В этот раз разыграем классическое развитие/);
    expect(intro).toMatch(/Ответь пешкой на дэ пять\.$/);
  });
});

describe('the plan goals — the strategy goes on after the opponent left the road («давим на цепочку пешек ударом c5»)', () => {
  const goalsOf = (id: string): TeachStrategy => ({ ...(resolveTeachStrategy({ strategyCard: card(id) }) as TeachStrategy), planGoalsRu: card(id).planGoalsRu });

  it('the advised move picks the goal that names it: a pawn strike, a knight jump, castling', () => {
    expect(planGoalRu(goalsOf('french'), { san: 'c5' })).toEqual({ textRu: 'бьём по цепочке пешек ударом цэ пять', namesMove: true });
    expect(planGoalRu(goalsOf('french'), { san: 'f6' })).toEqual({ textRu: 'ломаем цепочку ударом эф шесть', namesMove: true });
    expect(planGoalRu(goalsOf('dutch-stonewall'), { san: 'Ne4' })).toEqual({ textRu: 'прыгаем конём на е четыре', namesMove: true });
    // a pawn on e4 is never the knight's goal «прыгаем конём на е четыре», a bishop on e4 not even the pawns' one
    expect(planGoalRu(goalsOf('dutch-stonewall'), { san: 'e4' })?.textRu).not.toMatch(/конём/u);
    expect(planGoalRu(goalsOf('dutch-stonewall'), { san: 'Be4' })?.namesMove).toBe(false);
    expect(planGoalRu(goalsOf('open-game'), { san: 'O-O' })).toEqual({ textRu: 'прячем короля рокировкой', namesMove: true });
  });

  it('otherwise the goals take turns, so the teacher does not repeat one line', () => {
    const french = goalsOf('french');
    const said = [0, 1, 2, 3].map((turn) => planGoalRu(french, { san: 'Be7', turn })?.textRu);
    expect(said).toEqual([...card('french').planGoalsRu, card('french').planGoalsRu[0]]);
    expect(planGoalRu(french)?.namesMove).toBe(false);
  });

  it('only clean goals; none → null', () => {
    expect(planGoalRu(null)).toBeNull();
    expect(planGoalRu(goalsOf('italian'), {})?.textRu).toBe('целимся слоном в слабую точку эф семь');
    const dirty: TeachStrategy = { strategyId: 'x', titleRu: 'Икс', ideaRu: '', planGoalsRu: ['play e4 now', 'у нас пять минут', 'держим центр.'] };
    expect(planGoalRu(dirty, { turn: 0 })).toEqual({ textRu: 'держим центр', namesMove: false });
    expect(planGoalRu({ ...dirty, planGoalsRu: ['play e4'] })).toBeNull();
  });

  it('every library card has goals the teacher may say (Russian, ≤ 12 words, no clock words)', () => {
    for (const c of STRATEGIES) {
      const s = { ...(resolveTeachStrategy({ strategyCard: c }) as TeachStrategy), planGoalsRu: c.planGoalsRu };
      for (let turn = 0; turn < c.planGoalsRu.length; turn += 1) {
        const goal = planGoalRu(s, { turn });
        expect(goal?.textRu, c.id).toBe(c.planGoalsRu[turn]);
        expect(countWords(goal?.textRu ?? ''), c.id).toBeLessThanOrEqual(12);
        expect(goal?.textRu, c.id).not.toMatch(CLOCK_WORDS_RE);
      }
    }
  });
});

describe('the strategist\'s words go inside a sentence (the free template capitalises them)', () => {
  it('replanWords: the first letter is lowered, the end mark dropped', () => {
    expect(replanWords({ ply: 3, planRu: 'Выводим фигуры, держим центр и прячем короля.', preferredUci: 'g1f3', whyRu: 'Выводишь коня в игру.', provider: 'template' })).toEqual({
      planRu: 'выводим фигуры, держим центр и прячем короля',
      whyRu: 'выводишь коня в игру',
    });
  });
});

// ───────────────────────── the strategist's re-plan ─────────────────────────

describe('re-plans: a fresh one picks among the engine\'s candidates; a stale one is dropped', () => {
  const italian = card('italian');
  const sans = ['e4', 'e5', 'Nf3', 'd6'];
  const specs: Spec[] = [['Bc4', 45], ['d4', 40], ['Nc3', 25]];
  const memory: TeachMemory = { ...initialTeachMemory(), turns: 2, strategyIntroSaid: true, strategyLeftPly: 4 };

  it('fresh: its preferred candidate becomes the green arrow with its «why»', () => {
    const replan: ReplanResponse = { ply: 5, planRu: 'бьёмся за центр', preferredUci: 'd2d4', whyRu: 'пешка бьёт по центру и открывает дорогу слону', provider: 'codex' };
    const base = withStrategy(ctxAfter(sans, 'w', specs, { memory }), italian);
    const before = turn(base).plan;
    expect(before.advice[0]?.san).toBe('Bc4'); // the strategy move without a re-plan
    const { plan, ev } = turn({ ...base, replan });
    expect(plan.advice[0]?.san).toBe('d4');
    expect(plan.advice[0]?.planFit).toBe('replan');
    expect(plan.advice[0]?.planWhyRu).toBe('пешка бьёт по центру и открывает дорогу слону');
    expect(ev.text).toMatch(/^(Новый план: бьёмся за центр\. )?По новому плану — пешка на дэ четыре: пешка бьёт по центру и открывает дорогу слону\.$/);
    checkBrief(ev);
    // the late answer while the child still thinks: one short follow-up line, only because the arrow moved
    const follow = buildReplanFollowUp(before, plan, constRng(0));
    expect(follow?.text).toMatch(/пешка на дэ четыре/);
    expect(follow?.teach).toMatchObject({ moment: 'turn', style: 'short', ply: 5 });
    checkBrief(follow as CoachEvent);
    expect(buildReplanFollowUp(plan, plan, constRng(0))).toBeNull();
  });

  it('stale (another ply): the move choice is dropped, the plan words still update the plan from this turn', () => {
    const stale: ReplanResponse = { ply: 3, planRu: 'давим на центр пешками', preferredUci: 'd2d4', whyRu: 'бьёт по центру', provider: 'openrouter' };
    expect(freshReplan(stale, 5)).toBeNull();
    const { plan, ev } = turn(withStrategy(ctxAfter(sans, 'w', specs, { memory, replan: stale }), italian));
    expect(plan.advice[0]?.san).toBe('Bc4');
    expect(plan.advice[0]?.planFit).not.toBe('replan');
    expect(plan.newPlanRu).toBe('давим на центр пешками');
    expect(ev.text).toMatch(/Новый план: давим на центр пешками\./);
    checkBrief(ev);
    // taken once: the same answer next turn is not news
    const next = turn(withStrategy(ctxAfter([...sans, 'Bc4', 'Be7'], 'w', [['Nc3', 30], ['O-O', 28], ['d3', 20]], { memory: plan.memory, replan: stale }), italian));
    expect(next.plan.newPlanRu).toBeNull();
  });

  it('a preferred move outside the candidates, a kid-filtered one, or a broken answer is ignored', () => {
    const base = withStrategy(ctxAfter(sans, 'w', specs, { memory }), italian);
    expect(turn({ ...base, replan: { ply: 5, planRu: '', preferredUci: 'h2h4', whyRu: 'просто так', provider: 'codex' } }).plan.advice[0]?.san).toBe('Bc4');
    const request = buildReplanRequest(base);
    expect(request?.candidates.map((c) => c.san)).toEqual(['Bc4', 'd4', 'Nc3']);
    expect(request?.candidates.every((c) => c.ideasRu.every((i) => !LATIN.test(i)))).toBe(true);
    expect(request).toMatchObject({ ply: 5, strategyId: 'italian', childColor: 'w', movesSan: sans, stage: 1 });
    expect(acceptReplan({ ply: 4, planRu: 'x', preferredUci: 'd2d4', whyRu: '', provider: 'codex' }, request!)).toBeNull();
    expect(acceptReplan(null, request!)).toBeNull();
    const cleaned = acceptReplan({ ply: 5, planRu: 'Play d4 now', preferredUci: 'h2h4', whyRu: 'because', provider: 'hacker' }, request!);
    expect(cleaned).toEqual({ ply: 5, planRu: '', preferredUci: null, whyRu: '', provider: 'template' });
    expect(acceptReplan({ ply: 5, planRu: 'бьёмся за центр', preferredUci: 'd2d4', whyRu: 'открывает дорогу слону', provider: 'codex' }, request!)?.preferredUci).toBe('d2d4');
    // the queen sortie is never a re-plan candidate in the opening (kid filter)
    const qctx = withStrategy(ctxAfter(['e4', 'e5'], 'w', [['Nf3', 19], ['Qh5', 5], ['Nc3', 8]]), italian);
    expect(replanCandidates(qctx).map((c) => c.san)).not.toContain('Qh5');
  });

  it('replanReason: the opponent left the road with his last move, or the phase changed', () => {
    expect(replanReason(withStrategy(ctxAfter(sans, 'w', null), italian))).toBe('deviation');
    expect(replanReason(withStrategy(ctxAfter(['e4', 'e5', 'Nf3', 'Nc6'], 'w', null), italian))).toBeNull();
    expect(replanReason(ctxAfter(sans, 'w', null))).toBeNull(); // no strategy
    const mid = 'r1bqr1k1/bpp2pp1/p1np1n1p/4p3/2B1P3/2PP1NN1/PP3PPP/R1BQR1K1 w - - 2 11';
    expect(computePositionFacts(mid).phase).toBe('middlegame');
    const phaseCtx: TeachContext = { fen: mid, ply: 21, childColor: 'w', profile: profile(), analysis: null, strategy: gameStrategy(italian), strategyCard: italian, memory: { ...initialTeachMemory(), lastPhase: 'opening' } };
    expect(replanReason(phaseCtx)).toBe('phase');
  });

  it('strategist words are accepted only clean and short', () => {
    expect(cleanStrategistRu('бьёмся за центр', 15)).toBe('бьёмся за центр');
    expect(cleanStrategistRu('play d4', 15)).toBeNull();
    expect(cleanStrategistRu('осталось время, спеши', 15)).toBeNull();
    expect(cleanStrategistRu(Array.from({ length: 16 }, () => 'слово').join(' '), 15)).toBeNull();
  });
});

// ───────────────────────── brevity over scripted games ─────────────────────────

interface GameRun {
  events: CoachEvent[];
  plans: TeachPlan[];
}

/** A scripted game: the child plays `movesSan`; every child position has three engine lines around the model move. */
function scriptedGame(movesSan: readonly string[], childColor: Color, p: StudentProfile, rng: () => number, strategy: StrategyEntry | null, opts: { remainingMs?: (ply: number) => number } = {}): GameRun {
  const events: CoachEvent[] = [];
  const plans: TeachPlan[] = [];
  let memory: TeachMemory | null = null;
  let reaction: ReactionVerdict | null = null;
  const chess = new Chess();
  for (let i = 0; i < movesSan.length; i++) {
    const san = movesSan[i] as string;
    const sans = movesSan.slice(0, i);
    if (chess.turn() === childColor) {
      const others = chess
        .moves({ verbose: true })
        .filter((m) => m.san !== san && !m.san.startsWith('K') && !m.san.startsWith('Q') && !/[a-h]x/.test(m.san) && !/^[abgh]/.test(m.san))
        .slice(0, 2)
        .map((m) => m.san);
      const specs: Spec[] = [[san, 25], ...others.map((o, k) => [o, 15 - 10 * k] as Spec)];
      let ctx = ctxAfter(sans, childColor, specs, { profile: p, memory, reaction, remainingMs: opts.remainingMs?.(i + 1) ?? 300_000 });
      if (strategy) ctx = withStrategy(ctx, strategy);
      const plan = planTeachTurn(ctx, rng);
      const ev = buildTeachTurn(plan, rng);
      events.push(ev);
      plans.push(plan);
      memory = plan.memory;
      reaction = reactionVerdict({ judgement: judged(sans, san, san), advice: ev.teach?.advice ?? [] });
    }
    chess.move(san);
  }
  return { events, plans };
}

const ITALIAN_GAME = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O', 'Re1', 'a6', 'Nbd2', 'Ba7', 'Nf1', 'h6', 'Ng3', 'Re8', 'h3', 'Be6'];
const SPANISH_AS_BLACK = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3', 'Bb7', 'd4', 'Re8', 'Nbd2', 'Bf8'];
const LONDON_GAME = ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'c5', 'c3', 'Nc6', 'Nd2', 'e6', 'Ngf3', 'Bd6', 'Bg3', 'O-O', 'Bd3', 'b6', 'O-O', 'Bb7', 'Qe2', 'Qc7', 'Ne5', 'Rfd8'];

describe('brevity invariants over scripted 20-ply games', () => {
  const runs: { name: string; run: GameRun }[] = [];
  for (const [name, moves, color, strategyId] of [
    ['italian with the Italian strategy', ITALIAN_GAME, 'w', 'italian'],
    ['London with the London strategy', LONDON_GAME, 'w', 'london'],
    ['Black: the bot leaves the Open game with 3.Сb5', SPANISH_AS_BLACK, 'b', 'open-game'],
    ['italian without a strategy', ITALIAN_GAME, 'w', null],
  ] as const) {
    for (const p of [profile({ stage: 1 }), profile({ stage: 3, address: 'f', nickname: 'Маша' })]) {
      for (const seed of [1, 2, 3]) runs.push({ name: `${name} s${p.stage} #${seed}`, run: scriptedGame(moves, color, p, seededRng(seed), strategyId ? card(strategyId) : null) });
    }
  }

  it('every phrase: ≤ 25 words, ≤ 2 sentences, no clock / colour words in texts and briefs, no Latin', () => {
    for (const { name, run } of runs) {
      expect(run.events.length, name).toBeGreaterThanOrEqual(10);
      for (const ev of run.events) checkBrief(ev);
    }
  });

  it('«Что выберешь?» at most every fourth turn', () => {
    for (const { name, run } of runs) {
      const asked = run.plans.map((p, i) => (p.choice ? i : -1)).filter((i) => i >= 0);
      for (let k = 1; k < asked.length; k++) expect((asked[k] as number) - (asked[k - 1] as number), name).toBeGreaterThanOrEqual(CHOICE_EVERY_TURNS);
      for (const [i, ev] of run.events.entries()) if (!run.plans[i]?.choice) expect(ev.text, `${name}: ${ev.text}`).not.toMatch(/выбирай|выберешь|решай/i);
    }
  });

  it('with a strategy: the first turn is the intro, later turns explain «по плану», the deviation comes once', () => {
    for (const { name, run } of runs.filter((r) => !r.name.includes('without'))) {
      const texts = run.events.map((e) => e.text);
      expect(texts[0], name).toMatch(/^В этот раз разыграем /);
      expect(texts.filter((t) => /В этот раз разыграем/.test(t)).length, name).toBe(1);
      expect(texts.slice(1).some((t) => /плану|плана/.test(t)), name).toBe(true);
      // the bot leaves the road in the Black game (3.Сb5) and in the London one (3…c5); the Italian game is left by the
      // CHILD (8.Кbd2 instead of 8.Сb3) — never told as the opponent's deviation
      const deviations = texts.filter((t) => /свернул/.test(t)).length;
      expect(deviations, name).toBe(name.includes('Italian strategy') ? 0 : 1);
    }
    for (const { run } of runs.filter((r) => r.name.includes('without'))) expect(run.events.some((e) => /В этот раз|по нашему плану/i.test(e.text))).toBe(false);
  });

  it('LESS to say («ничего лишнего»): the advice — the move + ONE reason — and at most one extra; topics ≤ 2 a game, 8 plies apart', () => {
    const facts = (brief: string | undefined): string[] =>
      briefLineOf(brief, 'Факты')
        .replace(/^Факты: /, '')
        .split(/(?<=[.!?])\s+(?=[А-ЯЁ])/u)
        .filter((f) => f !== '');
    let turns = 0;
    for (const { name, run } of runs) {
      const topicPlies: number[] = [];
      for (const [i, plan] of run.plans.entries()) {
        const ev = run.events[i] as CoachEvent;
        if (plan.intro || ev.kind !== 'teachTurn') continue;
        turns += 1;
        const who = `${name} #${i}: ${ev.brief}`;
        // the fields of the other extras are empty
        const extras = [plan.reaction, plan.deviation, plan.newPlanRu, plan.opponentMentionRu, plan.openingName, plan.extra === 'topic' ? plan.concept : null, plan.plan].filter((x) => x !== null);
        expect(extras.length, who).toBeLessThanOrEqual(1);
        if (plan.extra !== 'opponent') expect(briefLineOf(ev.brief, 'Момент'), who).not.toMatch(/Ход соперника/);
        // the advice fact: one reason, no «how common» / «проверен» clause
        expect(claimsOf(ev.brief), who).not.toMatch(/ход проверен|так обычно играют|есть имя|одно слово одобрения/);
        // advice + one extra (a danger may bring its «можно не спасать» note; a choice turn names the blue arrow)
        expect(facts(ev.brief).length, who).toBeLessThanOrEqual(plan.danger || plan.choice ? 3 : 2);
        if (plan.extra === 'topic') topicPlies.push(ev.teach?.ply ?? 0);
      }
      expect(topicPlies.length, name).toBeLessThanOrEqual(2);
      for (let k = 1; k < topicPlies.length; k++) expect((topicPlies[k] as number) - (topicPlies[k - 1] as number), name).toBeGreaterThanOrEqual(8);
    }
    expect(turns).toBeGreaterThan(100);
  });

  it('«Поторопись!» — once, only under 30 s; never another clock word', () => {
    const run = scriptedGame(ITALIAN_GAME, 'w', profile(), seededRng(4), card('italian'), { remainingMs: (ply) => (ply >= 11 ? 20_000 : 200_000) });
    const hurried = run.events.filter((e) => /Поторопись/.test(e.text));
    expect(hurried.length).toBe(1);
    expect(run.events.findIndex((e) => /Поторопись/.test(e.text))).toBeGreaterThanOrEqual(5);
    for (const ev of run.events) checkBrief(ev);
    expect(briefLineOf(hurried[0]?.brief, 'Цель')).toMatch(/^Цель: Начни со слова «Поторопись!»/);
  });

  it('is deterministic for an injected rng', () => {
    const a = scriptedGame(ITALIAN_GAME, 'w', profile(), seededRng(9), card('italian')).events.map((e) => [e.text, e.brief]);
    const b = scriptedGame(ITALIAN_GAME, 'w', profile(), seededRng(9), card('italian')).events.map((e) => [e.text, e.brief]);
    expect(a).toEqual(b);
  });
});

// ───────────────────────── clock words anywhere the teacher speaks ─────────────────────────

describe('no clock readings in the other facts either', () => {
  it('game start briefs of every style carry no «у каждого по N минут»', () => {
    for (const tc of Object.values(TIME_CONTROLS)) {
      for (const coachStyle of ['helper', 'teacher', 'exam'] as const) {
        const ev = buildGameStart({ persona: PERSONA, timeControl: tc, childColor: 'w', profile: profile(), coachStyle }, constRng(0));
        expect(ev.brief ?? '', `${tc.id} ${coachStyle}`).not.toMatch(/минут|секунд|часы/i);
      }
    }
  });

  it('the position answer: never the clock; under 30 s only «Поторопись!»', () => {
    const fen = fenOf(['e4', 'e5']);
    const base = { fen, facts: computePositionFacts(fen), childColor: 'w' as const, profile: profile() };
    const calm = buildPositionAnswerRu({ ...base, clock: { child: 290_000, opponent: 240_000 } });
    expect(calm).not.toMatch(/минут|секунд|Часы|поторопи/i);
    const hurry = buildPositionAnswerRu({ ...base, clock: { child: LOW_CLOCK_MS - 1_000, opponent: 240_000 } });
    expect(hurry).toMatch(/«Поторопись!»/);
    expect(hurry).not.toMatch(/минут|секунд|Часы/);
  });

  it('a teacher reaction and a teacher take-back offer say nothing about the clock', () => {
    const advice = [{ uci: 'g1f3', san: 'Nf3', source: 'mainLine' as const, arrow: 'green' as const }];
    const j = judgement({ setup: ['e4', 'e5'], played: 'f3', best: 'Nf3', refutation: ['Nf6'], over: { winPctLoss: 12, classification: 'mistake', evalBefore: { cp: 19, mate: null }, evalAfter: { cp: -90, mate: null } } });
    const reaction = buildTeachReaction(reactionVerdict({ judgement: j, advice }), { profile: profile() }, constRng(0)) as CoachEvent;
    checkBrief(reaction);
    const ng5 = judgement({ setup: ['e4', 'e5', 'Nf3', 'Nc6'], played: 'Ng5', best: 'd4', refutation: ['Qxg5'], over: { materialLossPawns: 3, allowedMotif: 'hangingPiece' } });
    const offer = buildTakebackOffer(ng5, profile(), constRng(0), { advice: [{ uci: 'f1c4', san: 'Bc4', source: 'repertoire', arrow: 'green' }] });
    expect(offer.brief ?? '').not.toMatch(CLOCK);
    expect(buildTakebackOffer(ng5, profile(), constRng(0)).brief ?? '').not.toMatch(CLOCK);
  });
});

// ───────────────────────── the goals past the main line; «по плану» only where the code proves it ─────────────────────────

/** 20 child moves each (40 plies): the weak bots leave the road on move 1–3. */
const WEAK_ITALIAN = 'e4 a6 Nf3 h6 Bc4 b5 Bb3 e6 d4 Bb7 Nc3 Nf6 O-O Be7 Re1 O-O Bf4 d6 h3 Nbd7 Qd2 c5 Rad1 Qc7 a3 Rfe8 Ba2 Bf8 d5 e5 Bg3 Nh5 Bh2 g6 Ne2 Bg7 c3 Nf8 Ng3 Nf4'.split(' ');
const FRENCH_WEAK = 'e4 e6 Nc3 d5 Qf3 Nf6 e5 Nfd7 Qg3 c5 Nf3 Nc6 Be2 Qb6 O-O Be7 d3 O-O Bf4 f6 exf6 Bxf6 Rab1 e5 Bg5 Bxg5 Nxg5 Nf6 Rfe1 Bd7 h3 Rae8 Bf1 h6 Nf3 Qc7 Re2 Kh8 Rbe1 Qd6'.split(' ');
const LONDON_LONG = 'd4 d5 Bf4 Nf6 e3 c5 c3 Nc6 Nd2 e6 Ngf3 Bd6 Bg3 O-O Bd3 b6 O-O Bb7 Qe2 Qc7 Ne5 Rfd8 f4 Rac8 Rad1 Be7 Qf3 Ne4 Bxe4 dxe4 Qe2 f6 Nec4 cxd4 exd4 Na5 Nxa5 bxa5 Nc4 Bd5'.split(' ');
const KI_SETUP = 'Nf3 Nf6 g3 g6 Bg2 Bg7 O-O O-O d3 d6 e4 e5 Nc3 Nc6 h3 h6 Be3 Be6 Qd2 Kh7 a3 a6 b4 b5 Rab1 Qd7 Nh2 Rae8 f4 exf4 gxf4 Nd4 Ne2 c5 Nxd4 cxd4 Bf2 Qc7 Qe1 Nd7'.split(' ');

const PLAN_WORDS_RE = /план/iu;
/** The advice told as a step of the plan: every plan head of the teacher (./teacher.ts adviceSentence). */
const PLAN_HEAD_RE = /^(По нашему плану|Дальше по плану|Следующий шаг плана|По новому плану)|— это (по плану|наш план)|— (а мы )?по (новому )?плану /u;

describe('the plan goals carry the strategy past the main line — only where the code proves them', () => {
  const goalsOf = (id: string): TeachStrategy => resolveTeachStrategy({ strategyCard: card(id) }) as TeachStrategy;

  it('the teacher\'s strategy takes the card\'s goals (the server\'s GameStrategy has none)', () => {
    expect(resolveTeachStrategy({ strategy: gameStrategy(card('french')), strategyCard: card('french') })?.planGoalsRu).toEqual(card('french').planGoalsRu);
  });

  it('planGoalFor: the goal naming the move, a «выводим …» goal of a developing knight / bishop, the long diagonal of a fianchetto — nothing else', () => {
    const develop = [{ id: 'develop' as const }];
    expect(planGoalFor(goalsOf('french'), { san: 'c5' })).toEqual({ textRu: 'бьём по цепочке пешек ударом цэ пять', namesMove: true });
    expect(planGoalFor(goalsOf('london'), { san: 'Bf4', ideas: develop })).toEqual({ textRu: 'выводим слона на эф четыре раньше пешки е три', namesMove: true });
    expect(planGoalFor(goalsOf('four-knights'), { san: 'Nc3', ideas: develop })).toEqual({ textRu: 'выводим обоих коней к центру', namesMove: false });
    // a knight move the explainer does not call developing serves no «выводим …» goal; a bishop is not «обоих коней»
    expect(planGoalFor(goalsOf('four-knights'), { san: 'Nc3', ideas: [{ id: 'quiet' }] })).toBeNull();
    expect(planGoalFor(goalsOf('four-knights'), { san: 'Be2', ideas: develop })).toBeNull();
    expect(planGoalFor(goalsOf('kings-indian-setup'), { san: 'Bg7' })).toEqual({ textRu: 'ставим слона на длинную диагональ', namesMove: false });
    expect(planGoalFor(goalsOf('kings-indian-setup'), { san: 'Be7', ideas: develop })).toBeNull();
    expect(planGoalFor(goalsOf('italian'), { san: 'h3' })).toBeNull();
    expect(planGoalFor(null, { san: 'Nf3' })).toBeNull();
  });

  it('planGoalDone: castled, struck, developed — never a «держим …» goal; the rotation skips what the board shows as done', () => {
    const castled = fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O']);
    expect(planGoalDone('прячем короля рокировкой', castled, 'w')).toBe(true);
    expect(planGoalDone('прячем короля рокировкой', castled, 'b')).toBe(false);
    const french = fenOf(['e4', 'e6', 'd4', 'd5', 'e5', 'c5']);
    expect(planGoalDone('бьём по цепочке пешек ударом цэ пять', french, 'b')).toBe(true);
    expect(planGoalDone('ломаем цепочку ударом эф шесть', french, 'b')).toBe(false);
    expect(planGoalDone('выводим обоих коней к центру', fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6']), 'b')).toBe(true);
    expect(planGoalDone('выводим обоих коней к центру', fenOf(['e4', 'e5', 'Nf3', 'Nc6']), 'b')).toBe(false);
    expect(planGoalDone('держим центр пешкой е пять', fenOf(['e4', 'e5']), 'b')).toBe(false);
    expect(planGoalDone('ставим слона на длинную диагональ', fenOf(['Nf3', 'g6', 'g3', 'Bg7']), 'b')).toBe(true);
    // the rotation: the French's first goal is reached — the next one is said instead
    expect(planGoalRu(goalsOf('french'), { turn: 0, fen: french, color: 'b' })?.textRu).toBe('давим конём и ферзём на пешку дэ четыре');
    expect(planGoalRu(goalsOf('french'), { turn: 0 })?.textRu).toBe('бьём по цепочке пешек ударом цэ пять');
  });

  it('planGoalFits: a goal about what the board does not show is not said (French 1.e4 e6 2.d3 — no chain)', () => {
    const main = fenOf(['e4', 'e6', 'd4', 'd5', 'e5']);
    expect(planGoalFits('бьём по цепочке пешек ударом цэ пять', main, 'b')).toBe(true);
    expect(planGoalFits('ломаем цепочку ударом эф шесть', main, 'b')).toBe(true);
    expect(planGoalFits('давим конём и ферзём на пешку дэ четыре', main, 'b')).toBe(true);
    const offRoad = fenOf(['e4', 'e6', 'd3']);
    // (d3–e4 stand diagonally, but a strike from c5 / f6 hits nothing of theirs; no pawn on d4 to press on)
    expect(planGoalFits('бьём по цепочке пешек ударом цэ пять', offRoad, 'b')).toBe(false);
    expect(planGoalFits('ломаем цепочку ударом эф шесть', offRoad, 'b')).toBe(false);
    expect(planGoalFits('давим конём и ферзём на пешку дэ четыре', offRoad, 'b')).toBe(false);
    expect(planGoalFits('бьём по цепочке пешек', fenOf(['d4', 'e6']), 'b')).toBe(false);
    // the child's own plan fits wherever; the pawn it presses on must be there
    expect(planGoalFits('прячем короля рокировкой', offRoad, 'b')).toBe(true);
    expect(planGoalFits('нападаем конями на пешку е четыре', offRoad, 'b')).toBe(true);
    expect(planGoalFits('нападаем конями на пешку е четыре', fenOf(['d4', 'e6']), 'b')).toBe(false);
    expect(planGoalFits('давим конями на пешку в центре', fenOf(['e4', 'd5', 'exd5', 'Nf6', 'd4']), 'b')).toBe(true);
    expect(planGoalFits('давим конями на пешку в центре', fenOf(['Nf3', 'd5', 'c4']), 'b')).toBe(false);
    // the pin needs the opponent's knight next to the bishop's square
    expect(planGoalFits('связываем коня соперника слоном на же пять', fenOf(['d4', 'd5', 'c4', 'Nf6']), 'w')).toBe(true);
    expect(planGoalFits('связываем коня соперника слоном на же пять', fenOf(['d4', 'd5']), 'w')).toBe(false);
    // after 2.d3 no goal of the French fits: no rotation line, no «goal» of the advised c5
    expect(planGoalRu(goalsOf('french'), { turn: 0, fen: offRoad, color: 'b' })).toBeNull();
    expect(planGoalRu(goalsOf('french'), { san: 'c5', fen: offRoad, color: 'b' })).toBeNull();
    expect(planGoalFor(goalsOf('french'), { san: 'c5', fen: offRoad, color: 'b' })).toBeNull();
    expect(planGoalFor(goalsOf('french'), { san: 'c5', fen: fenOf(['e4', 'e6', 'd4', 'd5', 'e5']), color: 'b' })?.namesMove).toBe(true);
  });

  it('the French after 2.d3: the deviation line says the principles, never a pawn chain that is not on the board', () => {
    const french = card('french');
    const memory: TeachMemory = { ...initialTeachMemory(), turns: 1, strategyIntroSaid: true };
    const { plan, ev } = turn(withStrategy(ctxAfter(['e4', 'e6', 'd3'], 'b', [['d5', 40], ['c5', 22], ['Nf6', 18]], { memory }), french));
    expect(plan.deviation?.textRu).toBe('Соперник свернул с нашей дороги — теперь играем по правилам: центр, фигуры, рокировка.');
    expect(ev.text).not.toMatch(/цепоч/u);
    expect(ev.brief).not.toMatch(/цепоч/u);
    expect(plan.advice.every((a) => !a.planGoal)).toBe(true);
    checkBrief(ev);
  });

  it('the bot leaves the road and the advised move serves a goal: «…, но план тот же», the advice says the goal', () => {
    // the London's main line has 1…d5; the bot plays 1…Кf6
    const london = card('london');
    const memory: TeachMemory = { ...initialTeachMemory(), turns: 1, strategyIntroSaid: true };
    const { plan, ev } = turn(withStrategy(ctxAfter(['d4', 'Nf6'], 'w', [['Bf4', 30], ['c4', 22], ['Nf3', 10]], { memory }), london));
    expect(plan.advice[0]?.san).toBe('Bf4');
    expect(plan.advice[0]?.planGoal).toEqual({ textRu: 'выводим слона на эф четыре раньше пешки е три', namesMove: true });
    expect(plan.deviation?.textRu).toBe('Соперник свернул с нашей дороги, но план тот же.');
    expect(ev.text).toMatch(/^Соперник свернул с нашей дороги, но план тот же\. .*выводим слона на эф четыре раньше пешки е три/);
    expect(briefLineOf(ev.brief, 'Факты')).toMatch(/Слон на эф четыре \(зелёная стрелка\) — ход нашего плана: выводим слона на эф четыре раньше пешки е три/);
    expect(ev.brief).not.toMatch(/по правилам/);
    checkBrief(ev);
  });

  it('a card without goals falls back to the plain line «играем по правилам: центр, фигуры, рокировка»', () => {
    const bare: StrategyEntry = { ...card('italian'), planGoalsRu: [] };
    const memory: TeachMemory = { ...initialTeachMemory(), turns: 2, strategyIntroSaid: true };
    const { plan } = turn(withStrategy(ctxAfter(['e4', 'e5', 'Nf3', 'd6'], 'w', [['Bc4', 45], ['d4', 40], ['Nc3', 25]], { memory }), bare));
    expect(plan.deviation?.textRu).toBe('Соперник свернул с нашей дороги — теперь играем по правилам: центр, фигуры, рокировка.');
  });

  it('a tactic or a rescue is never told «по плану», even when it is a planned move of the card', () => {
    // the explainer says the Italian's planned Сc4 wins a piece: that is the position's gift, not the strategy
    const capture: MoveIdeasApi = {
      explainMove: (a) => (a.uci === 'f1c4' ? [{ id: 'freeCapture', group: 'A', squares: ['c4'], phraseRu: 'забирает фигуру', phraseYouRu: 'забираешь фигуру', gainPawns: 3 }] : [{ id: 'develop', group: 'D', squares: [], phraseRu: 'выводит фигуру', phraseYouRu: 'выводишь фигуру' }]),
      pickIdeas: (ideas) => ideas.slice(0, 1),
      explainOpponentMove: () => ({ ideas: [], wants: null }),
    };
    const memory: TeachMemory = { ...initialTeachMemory(), turns: 2, strategyIntroSaid: true, strategyLeftPly: 4 };
    const { plan, ev } = turn(withStrategy(ctxAfter(['e4', 'e5', 'Nf3', 'd6'], 'w', [['Bc4', 45], ['d4', 40], ['Nc3', 25]], { memory, ideas: capture }), card('italian')));
    expect(plan.advice[0]?.san).toBe('Bc4');
    expect(plan.advice[0]?.planFit).toBeUndefined();
    expect(plan.advice[0]?.planGoal).toBeUndefined();
    expect(ev.text).not.toMatch(PLAN_WORDS_RE);
    expect(claimsOf(ev.brief)).not.toMatch(/ход нашего плана|как шаг нашего плана/);
  });

  it('a danger decides the move: no «по плану» on a rescue (G: 3…b5 against the Italian\'s bishop)', () => {
    const memory: TeachMemory = { ...initialTeachMemory(), turns: 3, strategyIntroSaid: true, strategyLeftPly: 2 };
    const { plan, ev } = turn(withStrategy(ctxAfter(['e4', 'a6', 'Nf3', 'h6', 'Bc4', 'b5'], 'w', [['Bb3', 20], ['Be2', 10], ['Bd5', 0]], { memory, profile: profile({ stage: 3 }) }), card('italian')));
    expect(plan.danger).not.toBeNull();
    expect(plan.advice[0]?.san).toBe('Bb3');
    expect(plan.advice[0]?.planFit).toBeUndefined();
    expect(ev.text).not.toMatch(PLAN_WORDS_RE);
    checkBrief(ev);
  });

  it('off the road the goals come back as a reminder beside advice that is no step of the plan — in turn, never claimed as its reason', () => {
    let reminders = 0;
    for (const seed of [1, 2, 3]) {
      const run = scriptedGame(WEAK_ITALIAN, 'w', profile({ stage: 1 }), seededRng(seed), card('italian'));
      const goals: string[] = [];
      for (const [i, plan] of run.plans.entries()) {
        const ev = run.events[i] as CoachEvent;
        if (!plan.plan?.key.startsWith('goal:')) continue;
        reminders += 1;
        const goal = plan.plan.key.slice('goal:'.length);
        goals.push(goal);
        expect(card('italian').planGoalsRu, goal).toContain(goal);
        expect(plan.advice[0]?.planFit, ev.text).toBeUndefined();
        expect(plan.advice[0]?.planGoal, ev.text).toBeUndefined();
        expect(ev.text, ev.text).toContain(goal);
        expect(briefLineOf(ev.brief, 'Факты')).toContain(`Цель нашего плана: ${goal}`);
        expect(briefLineOf(ev.brief, 'Цель')).toMatch(/напомни цель нашего плана/);
        checkBrief(ev);
      }
      for (let k = 1; k < goals.length; k++) expect(goals[k], `seed ${seed}`).not.toBe(goals[k - 1]);
      // the deviation of 1…a6 says the plan's next goal, not the plain «центр, фигуры, рокировка»
      expect(run.events[1]?.text).toMatch(/^Соперник свернул с нашей дороги — теперь целимся слоном в слабую точку эф семь\./);
    }
    expect(reminders).toBeGreaterThanOrEqual(3);
  });
});

// ───────────────────────── phrase variety ─────────────────────────

/**
 * The variety metric of tools/voice-smoke/teacher.mjs (`checks.variety`): the Jaccard index of the word sets of every
 * two consecutive teacher remarks (lower case, ё → е, punctuation dropped), each pair below 0.5 (a game whose remarks
 * mostly begin with «По нашему плану…» fails it).
 */
function voiceSmokeJaccard(a: string, b: string): number {
  const tokens = (t: string): Set<string> =>
    new Set(
      t
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let common = 0;
  for (const w of ta) if (tb.has(w)) common += 1;
  return Math.round((common / (ta.size + tb.size - common)) * 100) / 100;
}

describe('phrase variety over 20-move teacher games (not «По нашему плану…» at the start of most remarks)', () => {
  const runs: { name: string; stage: number; run: GameRun }[] = [];
  for (const [name, moves, color, strategyId] of [
    ['Italian, the bot leaves on move 1', WEAK_ITALIAN, 'w', 'italian'],
    ['French, the bot leaves on move 2', FRENCH_WEAK, 'b', 'french'],
    ['London, the bot leaves on move 3', LONDON_LONG, 'w', 'london'],
    ['King\'s Indian set-up against 1.Кf3', KI_SETUP, 'b', 'kings-indian-setup'],
    ['no strategy', WEAK_ITALIAN, 'w', null],
  ] as const) {
    for (const stage of [1, 3]) {
      for (const seed of [1, 2, 3]) runs.push({ name: `${name} s${stage} #${seed}`, stage, run: scriptedGame(moves, color, profile({ stage, ...(stage === 3 ? { address: 'f' as const, nickname: 'Маша' } : {}) }), seededRng(seed), strategyId ? card(strategyId) : null) });
    }
  }

  it('every game has 20 teacher remarks, each within the budget (≤ 25 words, ≤ 2 sentences)', () => {
    for (const { name, run } of runs) {
      expect(run.events.length, name).toBe(20);
      for (const ev of run.events) checkBrief(ev);
    }
  });

  it('two consecutive remarks never pass the voice-smoke Jaccard bound (every pair < 0.5)', () => {
    for (const { name, run } of runs) {
      const texts = run.events.map((e) => e.text);
      for (let k = 1; k < texts.length; k++) expect(voiceSmokeJaccard(texts[k - 1] as string, texts[k] as string), `${name} #${k}: «${texts[k - 1]}» / «${texts[k]}»`).toBeLessThan(0.5);
    }
  });

  it('the start rotates: never the same opener twice in a row (bar the opponent\'s news), «По нашему плану» in at most a quarter', () => {
    for (const { name, run } of runs) {
      const openers = run.plans.map((p) => p.opener);
      for (let k = 1; k < openers.length; k++) {
        if (openers[k] === null || openers[k] === 'opp') continue;
        expect(openers[k], `${name} #${k}: ${openers.join(',')}`).not.toBe(openers[k - 1]);
      }
      const byPlan = run.events.filter((e) => /^По нашему плану/.test(e.text)).length;
      expect(byPlan, name).toBeLessThanOrEqual(5);
      expect(new Set(openers.filter((o) => o !== null)).size, name).toBeGreaterThanOrEqual(5);
    }
  });

  it('the opponent\'s move leads about every second remark that has room for it — «Соперник вывел коня на эф шесть — отвечаем …»', () => {
    for (const { name, run } of runs) {
      for (const [i, plan] of run.plans.entries()) {
        if (plan.opener !== 'opp') continue;
        const ev = run.events[i] as CoachEvent;
        // his move in ≤ 6 words (checkBrief), then our answer in the same sentence; it is the one extra of the turn
        expect(ev.text, name).toMatch(/^Соперник [^—.!?]+ — (а мы )?(по (новому )?плану )?(отвечаем|наш ответ|а мы|[а-яё]+ )/u);
        // one sentence holding his move, our answer and why — within the voice's twenty words
        expect(countWords(sentences(ev.text)[0] as string), ev.text).toBeLessThanOrEqual(OPP_SENTENCE_WORDS);
        expect(plan.extra, name).toBe('opponent');
        expect(briefLineOf(ev.brief, 'Цель'), name).toMatch(/сначала ход соперника|ход соперника в двух-трёх словах/);
        expect(briefLineOf(ev.brief, 'Нельзя'), name).not.toMatch(/ни хода соперника/);
      }
    }
    // a remark with room for it: no danger, no treasure, no other extra of the turn (a topic, a praise, the deviation…)
    const roomy = runs.flatMap(({ run }) => run.plans.slice(1)).filter((p) => !p.danger && !p.treasure && (p.extra === null || p.extra === 'opponent'));
    const share = roomy.filter((p) => p.opener === 'opp').length / roomy.length;
    expect(share).toBeGreaterThanOrEqual(0.45);
    expect(share).toBeLessThanOrEqual(0.75);
    // stage 1: a quarter to a half of ALL remarks (his move leads only when our answer AND why fit with it; else
    // another head keeps the why)
    const stage1 = runs.filter((r) => r.stage === 1).flatMap(({ run }) => run.plans.slice(1));
    const led = stage1.filter((p) => p.opener === 'opp').length / stage1.length;
    expect(led).toBeGreaterThanOrEqual(0.25);
    expect(led).toBeLessThanOrEqual(0.6);
  });

  it('his move leads only with the why: never «… — отвечаем слоном на цэ четыре.» without a reason, never with the blue arrow', () => {
    let checked = 0;
    for (const { name, run } of runs) {
      for (const [i, plan] of run.plans.entries()) {
        if (plan.opener !== 'opp') continue;
        // (the choice waits for the next turn: his move, our answer, the why AND the blue arrow were four things in one breath)
        expect(plan.choice, `${name} #${i}`).toBe(false);
        // a turn whose advice has a why to say (not the one said last time)
        if (!plan.memory.lastReasonRu) continue;
        checked += 1;
        const first = sentences((run.events[i] as CoachEvent).text)[0] as string;
        expect(first, `${name} #${i}`).not.toMatch(/(отвечаем [^:]+|наш ответ: [^,]+)\.$/u);
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('the brief asks the voice for the same start (the live model copied the one «по нашему плану …» of every goal)', () => {
    for (const { name, run } of runs) {
      for (const [i, plan] of run.plans.entries()) {
        const ev = run.events[i] as CoachEvent;
        const goal = briefLineOf(ev.brief, 'Цель');
        expect(goal, name).not.toMatch(/«по нашему плану …»/);
        if (!plan.opener || plan.opener === 'opp' || plan.mode === 'rules') continue;
        expect(goal, `${name} #${i}`).toMatch(/начни (со слов «[^»]+»|прямо с хода)/);
        // the template begins the same way
        const words = /«([^»]+)»/.exec(goal.split(/начни со слов /)[1] ?? '')?.[1];
        // (after another extra said first — his move that did not fit one sentence with our answer and why — it is the
        // advice sentence that begins so: «совет начни …»)
        const begins = (text: string): boolean => (/совет начни/.test(goal) ? sentences(text).some((s) => s.startsWith(words ?? '')) : text.startsWith(words ?? ''));
        if (words && !plan.danger && !plan.reaction && !plan.deviation && !plan.hurry) expect(begins(ev.text), `${name} #${i}: ${words} / ${ev.text}`).toBe(true);
      }
    }
  });

  it('a plan head only for a move that IS the plan (its line, tag, theme, a goal it serves) — never beside a danger', () => {
    for (const { name, run } of runs.filter((r) => !r.name.startsWith('no strategy'))) {
      for (const [i, plan] of run.plans.entries()) {
        const ev = run.events[i] as CoachEvent;
        const a = plan.advice[0];
        if (!a || plan.intro) continue;
        const planHead = PLAN_HEAD_RE.test(ev.text);
        if (planHead) expect(!!a.planFit || !!a.planGoal, `${name} #${i}: ${ev.text}`).toBe(true);
        if (plan.danger) expect(planHead, `${name} #${i}: ${ev.text} | ${JSON.stringify(a.planFit)} ${JSON.stringify(a.planGoal)}`).toBe(false);
      }
    }
    // without a strategy there is no «наш план» to follow
    for (const { run } of runs.filter((r) => r.name.startsWith('no strategy'))) expect(run.events.filter((e) => PLAN_HEAD_RE.test(e.text)).map((e) => e.text)).toEqual([]);
  });

  it('never the same reason twice in a row («идёт длинным путём на королевский фланг» for Кf1, then for Кg3)', () => {
    for (const seed of [1, 2, 3, 4]) {
      const italian = scriptedGame(ITALIAN_GAME, 'w', profile({ stage: 1 }), seededRng(seed), card('italian'));
      const nf1 = italian.plans.findIndex((p) => p.advice[0]?.san === 'Nf1');
      expect(italian.plans[nf1 + 1]?.advice[0]?.san).toBe('Ng3');
      const both = [italian.events[nf1]?.text, italian.events[nf1 + 1]?.text].filter((t) => /длинным путём/.test(t ?? ''));
      expect(both.length, `seed ${seed}`).toBeLessThanOrEqual(1);
    }
    for (const { name, run } of runs) {
      for (let k = 1; k < run.plans.length; k++) {
        const prev = run.plans[k - 1]?.memory.lastReasonRu ?? null;
        const now = run.plans[k]?.memory.lastReasonRu ?? null;
        if (prev !== null && now !== null) expect(now, `${name} #${k}`).not.toBe(prev);
      }
    }
  });
});
