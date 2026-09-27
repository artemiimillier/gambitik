/**
 * Clip twins of the builders (docs/voice-clips/SPEC.md §3.4, §11 twins.test.ts): every ported event carries a twin
 * that validates, points only into the catalogue, keeps ≤ 2 sentences (1 in the short style) and plans at level 1 on
 * the full library; it agrees with the text on its parts; the strategist's free text never reaches it; a treasure's
 * square / move is never said before the reveal; the opponent's move, a danger, a treasure are piece only.
 *
 * Positions: 240 child turns of seeded random games with a scripted engine (three candidate lines, captures first),
 * half of the games with a library strategy — the real explainer, concept cards and opening book (test-only imports).
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, ClipItem, ClipUtterance, CoachEvent, Color, MotifId, ReplanResponse } from '@gambit/shared';
import { getConceptCard } from '../../../../content/src/conceptCards.ts';
import { STRATEGIES } from '../../../../content/src/strategies.ts';
import { lookupOpening } from '../../../../openings/src/index.ts';
import {
  buildDeclineReasonReply,
  buildGameEnd,
  buildGameHello,
  buildGameResumed,
  buildGameStart,
  buildGreeting,
  buildPraise,
  buildTakebackAccepted,
  buildTakebackDeclined,
  buildTakebackOffer,
  buildVoluntaryTakeback,
} from '../events.ts';
import { buildReplanFollowUp, buildTeachRepeat, buildTeachReveal, buildTeachTurn, initialTeachMemory, planTeachTurn, teachTurnClip } from '../teacher.ts';
import type { TeachContext, TeachMemory, TeachPlan } from '../teacher.ts';
import { ALL_MOTIFS, PERSONA, bestMoveJudgement, constRng, counts, forkBlunder, judgement, profile, queenBlunder, seededRng, summary } from '../test-fixtures.ts';
import { clipCatalogLine, hasClipLine } from './catalog.ru.ts';
import { slotGuardOf } from './compile.ts';
import { catalogIndex } from './fixtures.ts';
import { normalizeSan } from './keys.ts';
import { planClips, validateClipUtterance } from './plan.ts';
import { TWIN_TAIL_WEIGHT, fitTwin, lineItem, moveSentence, twinCapsFor, wholeSentence, withClip } from './twins.ts';
import type { ClipPlan } from './types.ts';

const INDEX = catalogIndex();
const START = new Chess().fen();

/** Plans a twin on the full library the way the web layer does: SAN guard of the event, no jitter, no bark. */
function heard(ev: CoachEvent): ClipPlan {
  return planClips(ev.clip, INDEX, { rng: () => 0.99, jitter: false, allowedSans: slotGuardOf(ev), priority: ev.priority });
}

const lines = (u: ClipUtterance | undefined): string[] => (u?.sentences ?? []).flatMap((s) => s.items.flatMap((i) => ('line' in i ? [i.line] : [])));
const slots = (u: ClipUtterance | undefined): Extract<ClipItem, { slot: string }>[] => (u?.sentences ?? []).flatMap((s) => s.items.flatMap((i) => ('slot' in i ? [i] : [])));

/** What the server's `clipUtteranceSchema` asks for (apps/server/src/schemas.ts) — checked here without the server. */
function serverShaped(u: ClipUtterance): boolean {
  if (u.sentences.length > 4 || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(u.generic) || (u.moment ?? '').length > 40) return false;
  return u.sentences.every(
    (s) =>
      Number.isInteger(s.prio) &&
      s.prio >= 0 &&
      s.prio <= 100 &&
      ['.', '!', '?'].includes(s.end) &&
      s.items.length >= 1 &&
      s.items.length <= 3 &&
      s.items.every((i) => ('line' in i ? /^[A-Za-z][A-Za-z0-9_.-]*$/.test(i.line) && i.line.length <= 80 : ['nom', 'cap', 'ins'].includes(i.slot))),
  );
}

/** Every check a twin must pass wherever it comes from. */
function expectGoodTwin(ev: CoachEvent, maxSentences = 2): ClipPlan {
  const u = ev.clip;
  expect(u, `${ev.kind}: ${ev.text}`).toBeDefined();
  if (!u) throw new Error('no twin');
  expect(validateClipUtterance(u)).toEqual([]);
  expect(serverShaped(u)).toBe(true);
  expect(lines(u).filter((id) => !hasClipLine(id))).toEqual([]);
  expect(u.sentences.length).toBeLessThanOrEqual(maxSentences);
  const plan = heard(ev);
  expect(plan.level, `${ev.text} → ${plan.heard}`).toBe(1);
  expect(plan.mismatch).toBe(false);
  expect(plan.stats.split).toBe(0);
  expect(plan.heard).not.toMatch(/[A-Za-z{}]/);
  return plan;
}

// ───────────────────────── 240 generated teacher turns ─────────────────────────

const VALUE: Readonly<Record<string, number>> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

interface Turn {
  plan: TeachPlan;
  ev: CoachEvent;
  ctx: TeachContext;
}

function generatedTurns(): Turn[] {
  const out: Turn[] = [];
  const rng = seededRng(2026);
  for (let game = 0; game < 16 && out.length < 240; game++) {
    const childColor: Color = game % 2 === 0 ? 'w' : 'b';
    const chess = new Chess();
    const history: string[] = [];
    let memory: TeachMemory | null = null;
    let lastBotMove: TeachContext['lastBotMove'] = null;
    const card = game % 4 < 2 ? (STRATEGIES.filter((s) => s.side === childColor)[game % 5] ?? null) : null;
    for (let ply = 1; ply <= 44 && !chess.isGameOver() && out.length < 240; ply++) {
      const fen = chess.fen();
      const moves = chess.moves({ verbose: true });
      if (chess.turn() !== childColor) {
        const m = moves[Math.floor(rng() * moves.length)] as (typeof moves)[number];
        chess.move(m.san);
        history.push(m.san);
        lastBotMove = { uci: `${m.from}${m.to}${m.promotion ?? ''}`, san: m.san, fenBefore: fen };
        continue;
      }
      const scored = moves.map((m) => ({ m, v: (m.captured ? (VALUE[m.captured] ?? 0) * 100 : 0) + rng() * 60 })).sort((a, b) => b.v - a.v).slice(0, 3);
      const engineLines = scored.map((x, i) => ({ multipv: i + 1, depth: 16, pvUci: [`${x.m.from}${x.m.to}${x.m.promotion ?? ''}`], cp: Math.round(40 + x.v - i * 12), mate: null }));
      const analysis: AnalysisResult = { fen, lines: engineLines, bestmove: engineLines[0]?.pvUci[0] ?? '', depth: 16, timeMs: 300 };
      const ctx: TeachContext = {
        fen,
        ply,
        childColor,
        profile: profile({ stage: 1 + (game % 4), address: game % 3 === 1 ? 'f' : 'm' }),
        talkativeness: game % 5 === 4 ? 'chatty' : 'normal',
        analysis,
        lastBotMove,
        historySan: [...history],
        memory,
        openingNameRu: (f) => lookupOpening(f)?.nameRu,
        conceptCard: getConceptCard,
        conceptsIntroduced: [],
        strategy: card ? { strategyId: card.id, titleRu: card.titleRu, ideaRu: card.ideaRu } : null,
        strategyCard: card,
        remainingMs: ply > 30 && game % 3 === 0 ? 20_000 : null,
      };
      const plan = planTeachTurn(ctx, rng);
      out.push({ plan, ev: buildTeachTurn(plan, rng), ctx });
      memory = plan.memory;
      const next = plan.advice[0] && rng() < 0.7 ? plan.advice[0].san : (moves[Math.floor(rng() * moves.length)]?.san as string);
      history.push(chess.move(next).san);
    }
  }
  return out;
}

const TURNS = generatedTurns();

describe('teacher turns: 240 generated positions', () => {
  it('cover the families: treasures, dangers, the opponent first, plans, short turns, strategy intros', () => {
    expect(TURNS.length).toBe(240);
    expect(TURNS.filter((t) => t.plan.treasure).length).toBeGreaterThan(10);
    expect(TURNS.filter((t) => t.plan.danger).length).toBeGreaterThan(10);
    expect(TURNS.filter((t) => t.plan.opener === 'opp').length).toBeGreaterThan(10);
    expect(TURNS.filter((t) => t.plan.style === 'short').length).toBeGreaterThan(5);
    expect(TURNS.filter((t) => t.plan.intro).length).toBeGreaterThan(0);
    expect(TURNS.filter((t) => t.plan.hurry).length).toBeGreaterThan(0);
  });

  it('every one carries a valid twin that plans at level 1 on the full library (≤ 1 sentence when short)', () => {
    for (const t of TURNS) expectGoodTwin(t.ev, t.plan.style === 'short' ? 1 : 2);
  });

  it('the twin is a pure function of the plan (the text\'s rng is never drawn)', () => {
    for (const t of TURNS.slice(0, 60)) expect(teachTurnClip(t.plan)).toEqual(t.ev.clip);
  });

  it('agrees with the text on parts and prio: the advised move is the core, extras keep their weight', () => {
    const prios = new Set([100, 90, 85, 80, 70, 60, 50, 45, 40, 35, 33, 25]);
    for (const t of TURNS) {
      const u = t.ev.clip as ClipUtterance;
      for (const s of u.sentences) expect(prios.has(s.prio), `${s.prio}`).toBe(true);
      expect(u.sentences.some((s) => s.prio === 100), t.ev.text).toBe(true);
      const primary = t.plan.advice[0];
      const said = slots(u).map((s) => normalizeSan(s.san));
      if (primary && !t.plan.treasure) expect(said, t.ev.text).toContain(normalizeSan(primary.san));
      // a slot names only an advised move (SAN guard of §6.2) and the event's teach summary lists it
      const allowed = (slotGuardOf(t.ev) ?? []).map(normalizeSan);
      for (const san of said) expect(allowed).toContain(san);
      // the text's news is the twin's news
      if (t.plan.danger && !t.plan.treasure && t.plan.style !== 'short') expect(lines(u).some((id) => id.startsWith('danger.')), t.ev.text).toBe(true);
      if (/Найдёшь ход/u.test(t.ev.text)) expect(lines(u)).toContain('ask.find');
      if (t.plan.treasure) expect(lines(u).some((id) => id.startsWith('treasure.'))).toBe(true);
      if (t.plan.opener === 'opp' && t.plan.style !== 'short') {
        expect(lines(u).some((id) => id.startsWith('opp.')), t.ev.text).toBe(true);
        expect(lines(u).some((id) => id.startsWith('teach.head.answer')), t.ev.text).toBe(true);
      }
      if (t.plan.intro) expect(lines(u)[0]).toMatch(/^strategy\.|^start\.teacher\.plain$/);
    }
  });

  it('a treasure\'s square and move are never said before the reveal; the reveal says the move', () => {
    const treasures = TURNS.filter((t) => t.plan.treasure);
    for (const t of treasures) {
      expect(slots(t.ev.clip)).toEqual([]);
      expect(slotGuardOf(t.ev)).toEqual([]);
      const reveal = buildTeachReveal(t.plan, constRng(0));
      expectGoodTwin(reveal, 1);
      expect(slots(reveal.clip).map((s) => normalizeSan(s.san))).toEqual([normalizeSan(t.plan.treasure?.san ?? '')]);
      expect(lines(reveal.clip)[0]).toBe('reveal.head');
    }
  });

  it('the opponent\'s move, a danger, a treasure are whole piece-only lines — never with a slot', () => {
    for (const t of TURNS) {
      for (const s of (t.ev.clip as ClipUtterance).sentences) {
        const ids = s.items.flatMap((i) => ('line' in i ? [i.line] : []));
        if (ids.some((id) => /^(opp|danger|treasure)\./.test(id))) expect(s.items.length).toBe(1);
      }
    }
  });

  it('«Совет» again: the move said again, the choice or «Решай сам!» after it', () => {
    for (const t of TURNS.filter((x) => x.plan.advice.length > 0).slice(0, 40)) {
      const ev = buildTeachRepeat(t.plan, constRng(0), { asked: true, revealed: true });
      const plan = expectGoodTwin(ev, 1);
      expect(slots(ev.clip).length).toBeGreaterThan(0);
      expect(plan.heard.length).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────── golden turns ─────────────────────────

function ctxAfter(sans: readonly string[], childColor: Color, specs: readonly [string, number][], over: Partial<TeachContext> = {}): TeachContext {
  const chess = new Chess();
  let lastBotMove: TeachContext['lastBotMove'] = null;
  for (const san of sans) {
    const before = chess.fen();
    const m = chess.move(san);
    lastBotMove = { uci: `${m.from}${m.to}${m.promotion ?? ''}`, san: m.san, fenBefore: before };
  }
  const fen = chess.fen();
  const engineLines = specs.map(([san, cp], i) => {
    const m = new Chess(fen).move(san);
    return { multipv: i + 1, depth: 16, pvUci: [`${m.from}${m.to}${m.promotion ?? ''}`], cp, mate: null };
  });
  return {
    fen,
    ply: sans.length + 1,
    childColor,
    profile: profile({ stage: 1 }),
    analysis: { fen, lines: engineLines, bestmove: engineLines[0]?.pvUci[0] ?? '', depth: 16, timeMs: 300 },
    lastBotMove: sans.length > 0 ? lastBotMove : null,
    historySan: sans,
    conceptCard: getConceptCard,
    conceptsIntroduced: [],
    ...over,
  };
}

describe('golden twins', () => {
  it('a treasure: what it is and the question — no square, no move («Смотри, тут подарок: ферзь соперника без защиты!»)', () => {
    const ctx = ctxAfter(['e4', 'e5', 'Nf3', 'Qg5'], 'w', [['Nxg5', 900], ['d4', 20], ['Nc3', 10]], { memory: { ...initialTeachMemory(), turns: 2 } });
    const plan = planTeachTurn(ctx, constRng(0));
    const ev = buildTeachTurn(plan, constRng(0));
    expect(ev.clip?.sentences).toEqual([
      { items: [{ line: 'treasure.free', piece: 'q' }], prio: 100, end: '!' },
      { items: [{ line: 'ask.find', g: 'm' }], prio: 60, end: '?' },
    ]);
    expect(ev.clip?.generic).toBe('generic.teachTurn.turn.think');
    expect(ev.clip?.moment).toBe('turn');
    expect(ev.clip?.bark).toBe('think');
    // any wording of the queen's pool (a piece-neutral one joins it), never a square
    const said = heard(ev).heard;
    expect(said).toMatch(/без защиты|без охраны|забрать бесплатно|никем не защищ/u);
    expect(said).not.toMatch(/ферзь соперника на |(?<![а-яё])(же|эф|е|дэ) (пять|шесть)(?![а-яё])/u);
    const reveal = buildTeachReveal(plan, constRng(0));
    expect(reveal.clip?.sentences).toEqual([
      { items: [{ line: 'reveal.head' }, { slot: 'cap', san: 'Nxg5', fen: ctx.fen }, { line: 'reason.freeCapture', piece: 'q' }], prio: 100, end: '.' },
    ]);
  });

  it('a girl hears her own forms: «Найдёшь ход сама?»', () => {
    const ctx = ctxAfter(['e4', 'e5', 'Nf3', 'Qg5'], 'w', [['Nxg5', 900], ['d4', 20]], { profile: profile({ stage: 1, address: 'f' }) });
    const ev = buildTeachTurn(planTeachTurn(ctx, constRng(0)), constRng(0));
    expect(ev.clip?.sentences[1]?.items).toEqual([{ line: 'ask.find', g: 'f' }]);
    expect(heard(ev).heard).toMatch(/сама|Поищи|Поищешь|Ищи|найди его|какой ход/u);
  });

  it('the strategy intro: the library\'s own line, then «Первый ход —» the move (never the strategist\'s intro)', () => {
    const italian = STRATEGIES.find((s) => s.id === 'italian');
    const ctx = ctxAfter([], 'w', [['e4', 30], ['d4', 25]], {
      strategy: { strategyId: 'italian', titleRu: 'Итальянская партия', ideaRu: italian?.ideaRu ?? '', introRu: 'Сегодня выдумаем свою хитрую игру через слабую клетку' },
      strategyCard: italian ?? null,
    });
    const plan = planTeachTurn(ctx, constRng(0));
    expect(plan.intro).toBe(true);
    const ev = buildTeachTurn(plan, constRng(0));
    expect(ev.clip?.sentences).toEqual([
      { items: [{ line: 'strategy.italian' }], prio: 100, end: '!' },
      { items: [{ line: 'start.head.first' }, { slot: 'nom', san: 'e4', fen: START }], prio: 100, end: '.' },
    ]);
    // the strategist's own words are in the text, never in the twin
    expect(ev.text).toMatch(/хитрую игру/u);
    expect(JSON.stringify(ev.clip)).not.toMatch(/хитр|выдума/u);
    expect(expectGoodTwin(ev).heard).toMatch(/^Разыграем Итальянскую партию|^Сегодня у нас Итальянская партия/u);
  });

  it('a danger outlives the reason of the move: «Осторожно: твой конь под боем!» · «Мой совет — …»', () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Nc3 d6 4.Nb5 a6: the knight on b5 is attacked by the pawn
    const ctx = ctxAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'd6', 'Nb5', 'a6'], 'w', [['Nc3', 30], ['Na3', 10]]);
    const plan = planTeachTurn(ctx, constRng(0));
    expect(plan.danger?.kind).toBe('hanging');
    const ev = buildTeachTurn(plan, constRng(0));
    const u = ev.clip as ClipUtterance;
    expect(u.sentences[0]).toEqual({ items: [{ line: 'danger.hanging', piece: 'n' }], prio: 90, end: '!' });
    expect(slots(u).map((s) => s.san)).toEqual(['Nc3']);
    expectGoodTwin(ev);
  });

  it('the strategist\'s «why» and new plan words are never recorded; the move and a plan head are', () => {
    const london = STRATEGIES.find((s) => s.id === 'london');
    const base = ctxAfter(['d4', 'd5'], 'w', [['Bf4', 30], ['Nf3', 25], ['c4', 20]], {
      strategy: { strategyId: 'london', titleRu: 'Лондонская система', ideaRu: london?.ideaRu ?? '' },
      strategyCard: london ?? null,
      introSaid: true,
      memory: { ...initialTeachMemory(), turns: 1, strategyIntroSaid: true },
    });
    const replan: ReplanResponse = { ply: base.ply, planRu: 'хитро давим по тайной линии', whyRu: 'так советует волшебная сова', preferredUci: base.analysis?.lines[1]?.pvUci[0] ?? null, provider: 'codex' };
    const ev = buildTeachTurn(planTeachTurn({ ...base, replan }, constRng(0)), constRng(0));
    expect(`${ev.text} ${ev.brief ?? ''}`).toMatch(/сова|тайной/u);
    expect(JSON.stringify(ev.clip)).not.toMatch(/сова|тайн|хитро/u);
    expectGoodTwin(ev);
  });

  it('a late re-plan follow-up: «По новому плану —» the move, the strategist\'s «why» left out', () => {
    const london = STRATEGIES.find((s) => s.id === 'london');
    const base = ctxAfter(['d4', 'd5'], 'w', [['Bf4', 30], ['Nf3', 25], ['c4', 20]], {
      strategy: { strategyId: 'london', titleRu: 'Лондонская система', ideaRu: london?.ideaRu ?? '' },
      strategyCard: london ?? null,
      introSaid: true,
      memory: { ...initialTeachMemory(), turns: 1, strategyIntroSaid: true },
    });
    const prev = planTeachTurn(base, constRng(0));
    const other = base.analysis?.lines.find((l) => l.pvUci[0] !== prev.advice[0]?.uci)?.pvUci[0] ?? null;
    const next = planTeachTurn({ ...base, replan: { ply: base.ply, planRu: '', whyRu: 'волшебная сова так сказала', preferredUci: other, provider: 'codex' } }, constRng(0));
    const ev = buildReplanFollowUp(prev, next, constRng(0));
    expect(ev).not.toBeNull();
    expect(ev?.text).toMatch(/сова/u);
    expect(lines(ev?.clip)[0]).toBe('teach.head.replan');
    expect(JSON.stringify(ev?.clip)).not.toMatch(/сова/u);
    expectGoodTwin(ev as CoachEvent, 1);
  });
});

// ───────────────────────── the events.ts families ─────────────────────────

describe('greeting, hello, game start', () => {
  it('greets by the day part and the last game, never by name', () => {
    const cases: { hour: number; part: string }[] = [
      { hour: 8, part: 'morning' },
      { hour: 14, part: 'day' },
      { hour: 19, part: 'evening' },
      { hour: 23, part: 'night' },
    ];
    for (const { hour, part } of cases) {
      for (const address of ['m', 'f'] as const) {
        const p = profile({ address, nickname: 'Миша' });
        const ev = buildGreeting({ profile: p, hour }, constRng(0));
        expect(ev.text).toMatch(/Миша/u);
        expect(lines(ev.clip)[0]).toBe(`greet.hello.${part}`);
        expect(JSON.stringify(ev.clip)).not.toMatch(/Миша/u);
        expectGoodTwin(ev);
      }
    }
    const first = buildGreeting({ profile: profile({ totals: { ...profile().totals, games: 0 } }), hour: 10 }, constRng(0));
    expect(lines(first.clip)[1]).toBe('greet.first');
    const lastWin = buildGreeting({ profile: profile({ address: 'f' }), hour: 10, lastGame: { id: 'g1', startedAt: '', result: '1-0', childColor: 'w' } as never }, constRng(0));
    expect(lastWin.clip?.sentences[1]?.items[0]).toEqual({ line: 'greet.win', g: 'f' });
  });

  it('«Привет!» when the board opens; the game start by mode, the opponent\'s name never recorded', () => {
    expect(lines(buildGameHello(profile(), constRng(0)).clip)).toEqual(['hello.game']);
    const base = { persona: PERSONA, childColor: 'w' as const, profile: profile({ address: 'f' }) };
    // an opener that names the opponent stays in the bubble: the twin says the tail (never another opener)
    const coached = buildGameStart({ ...base, timeControl: { id: 'rapid10', initialMs: 600_000, incrementMs: 0, coachMode: 'full' } as never }, constRng(0));
    expect(coached.text).toMatch(/^Сегодня твой соперник — Петя\./u);
    expect(lines(coached.clip)).toEqual(['start.tail.coached']);
    expect(coached.clip?.sentences[0]?.prio).toBe(100);
    const silent = buildGameStart({ ...base, timeControl: { id: 'bullet', initialMs: 60_000, incrementMs: 0, coachMode: 'off' } as never }, constRng(0));
    expect(lines(silent.clip)).toEqual(['start.tail.silent']);
    // a nameless opener is said; with the hello, the hello (with or without the opener) is said
    const nameless = buildGameStart({ ...base, persona: { ...PERSONA, name: '' }, timeControl: { id: 'rapid10', initialMs: 600_000, incrementMs: 0, coachMode: 'full' } as never }, constRng(0));
    expect(lines(nameless.clip)).toEqual(['start.open', 'start.tail.coached']);
    const untimed = buildGameStart({ ...base, greet: true, timeControl: { id: 'training', initialMs: null, incrementMs: 0, coachMode: 'full' } as never }, constRng(0));
    expect(lines(untimed.clip)).toEqual(['start.open.greet', 'start.tail.untimed']);
    const exam = buildGameStart({ ...base, examMode: true, timeControl: { id: 'rapid10', initialMs: 600_000, incrementMs: 0, coachMode: 'full' } as never }, constRng(0));
    expect(exam.clip?.sentences[0]?.items[0]).toEqual({ line: 'start.tail.exam', g: 'f' });
    for (const ev of [coached, silent, nameless, untimed, exam]) {
      expect(JSON.stringify(ev.clip)).not.toMatch(/Петя/u);
      expectGoodTwin(ev);
    }
    expect(lines(buildGameResumed({ childToMove: true, profile: profile() }, constRng(0)).clip)).toEqual(['start.resumed']);
  });

  it('the teacher\'s start: every one of the 24 strategies, White and Black, plans at level 1', () => {
    const tc = { id: 'rapid10', initialMs: 600_000, incrementMs: 0, coachMode: 'full' } as never;
    for (const s of STRATEGIES) {
      const strategy = { strategyId: s.id, titleRu: s.titleRu, ideaRu: s.ideaRu, titleAccRu: s.titleAccRu, lineSan: s.lineSan };
      let fen: string | undefined;
      if (s.side === 'b') {
        const chess = new Chess();
        chess.move(s.against === 'e4' ? 'e4' : s.against === 'd4' ? 'd4' : (s.mainLineSan[0] as string));
        fen = chess.fen();
      }
      const ev = buildGameStart({ persona: PERSONA, timeControl: tc, childColor: s.side as Color, profile: profile(), coachStyle: 'teacher', strategy, ...(fen ? { fen } : {}) }, constRng(0));
      const u = ev.clip as ClipUtterance;
      expect(u.moment).toBe('openingPlan');
      expect(lines(u)[0]).toBe(`strategy.${s.id}`);
      expect(lines(u)[1]).toBe(s.side === 'w' ? 'start.head.first' : 'teach.head.answer');
      expect(slots(u).map((x) => normalizeSan(x.san))).toEqual([normalizeSan(s.lineSan[0] as string)]);
      expectGoodTwin(ev);
    }
    // no strategy: the plain teacher line, gendered
    const plain = buildGameStart({ persona: PERSONA, timeControl: tc, childColor: 'w', profile: profile({ address: 'f' }), coachStyle: 'teacher', strategy: null }, constRng(0));
    expect(plain.clip?.sentences).toEqual([{ items: [{ line: 'start.teacher.plain', g: 'f' }], prio: 100, end: '.' }]);
    // Black before the opponent's first move: the strategy alone
    const noMove = buildGameStart({ persona: PERSONA, timeControl: tc, childColor: 'b', profile: profile(), coachStyle: 'teacher', strategy: { strategyId: 'french', titleRu: 'Французская защита', ideaRu: 'x', lineSan: ['e6'] } }, constRng(0));
    expect(lines(noMove.clip)).toEqual(['strategy.french']);
  });
});

describe('praise, take-backs, game end', () => {
  it('praise: the found idea, then the process — for every motif, gendered', () => {
    for (const motif of ALL_MOTIFS) {
      const ev = buildPraise(bestMoveJudgement(motif), profile({ address: 'f' }), constRng(0), motif);
      const u = ev.clip as ClipUtterance;
      expect(lines(u)[0], motif).toMatch(/^praise\./);
      expect(u.sentences[1]?.items[0]).toEqual({ line: 'praise.process', g: 'f' });
      expectGoodTwin(ev);
    }
    const generic = buildPraise(bestMoveJudgement(undefined), profile(), constRng(0));
    expect(lines(generic.clip)[0]).toBe('praise.generic');
  });

  it('a take-back offer: «Стоп-стоп…» and a question of the same group (the punisher among its pieces)', () => {
    const ev = buildTakebackOffer(forkBlunder(), profile(), constRng(0));
    expect(lines(ev.clip)[0]).toBe('takeback.stop');
    expect(lines(ev.clip)[1]).toMatch(/^takeback\.q\./);
    expectGoodTwin(ev);
    const again = buildTakebackOffer(queenBlunder(), profile(), constRng(0), { again: true });
    expect(again.clip?.sentences.length).toBe(1);
    expect(lines(again.clip)[0]).toBe('takeback.again');
    expectGoodTwin(again);
  });

  it('the teacher\'s take-back: «Мой совет был такой:» the advised move «— а так соперник заберёт …»', () => {
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4', 'Qa4', 'Nxc2+'];
    const j = judgement({ setup: sans, played: 'Kd1', best: 'Qxc2', refutation: ['Nxa1'], over: { materialLossPawns: 4 } });
    const ev = buildTakebackOffer(j, profile({ stage: 1 }), constRng(0), { advice: [{ uci: 'a4c2', san: 'Qxc2', source: 'engine', arrow: 'green' }] });
    const u = ev.clip as ClipUtterance;
    expect(u.moment).toBe('reaction');
    expect(lines(u)[0]).toBe('takeback.stop');
    expect(u.sentences[1]?.items[0]).toEqual({ line: 'takeback.head.advice' });
    expect(slots(u).map((s) => s.san)).toEqual(['Qxc2']);
    expect(u.sentences[1]?.items[2]).toEqual({ line: 'takeback.tail.lost', piece: 'r' });
    expectGoodTwin(ev);
  });

  it('what follows a take-back offer: accepted, declined, the reason chips, a voluntary take-back', () => {
    expect(lines(buildTakebackAccepted(profile(), constRng(0)).clip)).toEqual(['takeback.accepted']);
    expect(lines(buildTakebackDeclined(profile(), constRng(0)).clip)).toEqual(['takeback.declined']);
    for (const r of ['planned', 'dontSee', 'risk'] as const) expect(lines(buildDeclineReasonReply(r, profile(), constRng(0)).clip)).toEqual([`takeback.reason.${r}`]);
    expect(lines(buildVoluntaryTakeback(profile(), constRng(0)).clip)).toEqual(['takeback.voluntary']);
  });

  it('game end: the result — the line of the opener the bubble shows —, then the SAME praise the text chose', () => {
    const p = profile({ address: 'f' });
    const cases = [
      { result: '1-0' as const, termination: 'checkmate' as const, own: 'end.win.checkmate', opener: 'Мат — и победа твоя!', line: 'end.win' },
      { result: '1-0' as const, termination: 'resign' as const, own: null, opener: null, line: 'end.win' },
      { result: '0-1' as const, termination: 'timeout' as const, own: 'end.loss.timeout', opener: 'Время закончилось — так бывает у всех.', line: 'end.loss' },
      { result: '1/2-1/2' as const, termination: 'stalemate' as const, own: 'end.draw.stalemate', opener: 'Пат — это ничья. Запомним этот приём!', line: 'end.draw' },
      { result: '*' as const, termination: 'abandoned' as const, own: null, opener: null, line: 'end.unfinished' },
    ];
    for (const c of cases) {
      const seen = new Set<string>();
      for (const seed of [0, 0.3, 0.6, 0.9]) {
        const ev = buildGameEnd({ result: c.result, childColor: 'w', termination: c.termination, summary: summary(), persona: PERSONA, profile: p }, constRng(seed));
        const u = ev.clip as ClipUtterance;
        const first = lines(u)[0] as string;
        seen.add(first);
        // the termination's own opener → its own line; the opener that names the opponent stays in the bubble (the
        // twin starts with the praise); any other → the result's general line
        if (c.opener !== null && ev.text.startsWith(c.opener)) expect(first, ev.text).toBe(c.own);
        else if (/^[^.!]*Петя/u.test(ev.text)) expect(first, ev.text).toMatch(/^end\.praise\./);
        else expect(first, ev.text).toBe(c.line);
        const praiseLine = lines(u).at(-1) as string;
        expect(praiseLine).toMatch(/^end\.praise\./);
        // the praise the text says is one of that line's wordings (girl's forms)
        const said = (clipCatalogLine(praiseLine)?.wordings ?? []).map((w) => w.t.replace(/\{g:[^|]+\|([^}]+)\}/g, '$1'));
        expect(said.some((t) => ev.text.includes(t.replace(/[.!]$/u, '')) || ev.text.includes(t.split(/[—,]/u)[0]?.trim() ?? '###')), `${ev.text} / ${praiseLine}`).toBe(true);
        expectGoodTwin(ev);
      }
      if (c.own !== null) expect(seen).toContain(c.own);
    }
    const strong = buildGameEnd({ result: '1-0', childColor: 'w', termination: 'resign', summary: summary({ counts: counts({ best: 6, excellent: 3 }), hintsUsed: 0, takebacksOffered: 0, takebacksAccepted: 0, accuracy: 60 }), persona: PERSONA, profile: p }, constRng(0));
    expect(lines(strong.clip)[1]).toMatch(/^end\.praise\.(noBlunder|manyStrong|noHints)$/);
  });
});

// ───────────────────────── fitting and guards ─────────────────────────

describe('fitTwin and withClip', () => {
  const advice = moveSentence({ head: 'teach.head.advice', san: 'Nf3', fen: START, reason: lineItem('reason.develop', { piece: 'n' }), prio: 100 });

  it('drops the lightest first: the opponent (40) before the tail (65) before «Поторопись!» (85) / a danger (90)', () => {
    const opp = wholeSentence(lineItem('opp.developed', { piece: 'n' }), 40);
    const danger = wholeSentence(lineItem('danger.hanging', { piece: 'b' }), 90);
    const fit2 = fitTwin([opp, advice], { maxSentences: 2, maxWords: 11 });
    expect(fit2.map((s) => s.prio)).toEqual([100]);
    expect(fit2[0]?.items.length).toBe(3);
    const fitDanger = fitTwin([danger, advice], { maxSentences: 2, maxWords: 12 });
    expect(fitDanger.map((s) => s.prio)).toEqual([90, 100]);
    expect(fitDanger[1]?.items.length).toBe(2);
    expect(fitDanger[1]?.end).toBe('.');
    // the core is never dropped, only its tail
    const tight = fitTwin([advice], { maxSentences: 1, maxWords: 1 });
    expect(tight).toHaveLength(1);
    expect(tight[0]?.items.map((i) => ('line' in i ? i.line : i.slot))).toEqual(['teach.head.advice', 'ins']);
    // over the sentence count: sentences only, by prio
    expect(fitTwin([wholeSentence('teach.hurry', 85), danger, advice], twinCapsFor({ teacher: true })).map((s) => s.prio)).toEqual([90, 100]);
    expect(TWIN_TAIL_WEIGHT).toBe(65);
  });

  it('a mate tail says what the move is: it replaces the reason and outweighs the extras', () => {
    const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
    const s = moveSentence({ head: 'teach.head.arrow', san: 'Ra8#', fen, reason: lineItem('reason.attack', { piece: 'k' }), prio: 100, moveNews: true });
    expect(s?.items[2]).toEqual({ line: 'reason.mate' });
    expect(s?.tailWeight).toBe(95);
    const promo = moveSentence({ head: 'teach.head.arrow', san: 'a8=Q', fen: '8/P5k1/8/8/8/8/6K1/8 w - - 0 1', prio: 100, moveNews: true });
    expect(promo?.items[1]).toEqual({ slot: 'nom', san: 'a8=Q', fen: '8/P5k1/8/8/8/8/6K1/8 w - - 0 1' });
    expect(promo?.items[2]).toEqual({ line: 'move.promo', piece: 'q' });
  });

  it('castling is said «короткая рокировка» after any head; a capture «конь бьёт на …»; an illegal move gives nothing', () => {
    const castleFen = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    expect(moveSentence({ head: 'teach.head.advice', san: 'O-O', fen: castleFen, prio: 100 })?.items[1]).toEqual({ slot: 'nom', san: 'O-O', fen: castleFen });
    const scandi = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
    expect(moveSentence({ head: 'teach.head.advice', san: 'exd5', fen: scandi, prio: 100 })?.items[1]).toEqual({ slot: 'cap', san: 'exd5', fen: scandi });
    expect(moveSentence({ head: 'teach.head.advice', san: 'Nf6', fen: START, prio: 100 })).toBeNull();
  });

  it('withClip attaches only a twin that validates and points into the catalogue', () => {
    const ev = buildTakebackAccepted(profile(), constRng(0));
    const bare = { ...ev };
    delete bare.clip;
    const bad: ClipUtterance = { sentences: [{ items: [{ line: 'no.such.line' }], prio: 100, end: '.' }], generic: 'generic' };
    expect(withClip({ ...bare }, bad).clip).toBeUndefined();
    const illegal: ClipUtterance = { sentences: [{ items: [{ line: 'teach.head.advice' }, { slot: 'ins', san: 'Nf6', fen: START }], prio: 100, end: '.' }], generic: 'generic' };
    expect(withClip({ ...bare }, illegal).clip).toBeUndefined();
    expect(withClip({ ...bare }, null).clip).toBeUndefined();
    expect(withClip({ ...bare }, ev.clip).clip).toEqual(ev.clip);
  });

  it('a motif without a praise line of its own falls back to the generic praise, recorded under its family', () => {
    const motifs: MotifId[] = ['hangingPiece', 'freeCapture'];
    for (const m of motifs) expect(lines(buildPraise(bestMoveJudgement(m), profile(), constRng(0), m).clip)[0]).toBe('praise.capture');
  });
});
