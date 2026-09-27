/**
 * The Russian catalogue of the «Записи» voice (docs/voice-clips/SPEC.md §11 catalog.test.ts): the lint of §10 with the
 * catalogue's voice rules (Гамбитик speaks as a boy; the opponent's move, a danger, a treasure without squares),
 * generics for every event kind, pools sized by frequency (§7.1), and the strategy library mirrored line by line —
 * @gambit/content is read through a test-only relative import (core has no runtime dependency on it).
 */
import { describe, expect, it } from 'vitest';
import type { ClipCatalogLine, CoachEventKind } from '@gambit/shared';
import { STRATEGIES } from '../../../../content/src/strategies.ts';
import { CLIP_CATALOG, CLIP_TAP_LINES, PLAN_GOAL_LINES, clipCatalogLine, hasClipLine, planGoalLineOf, strategyLineOf } from './catalog.ru.ts';
import { catalogUnits, linePieces, usesGender, usesPiece } from './catalog.ts';
import { FIXTURE_CATALOG } from './fixtures.ts';
import { hasFeminineSelfReference, hasSpokenSquare, lintCatalog } from './lint.ts';
import { HEAD_SLOT_FORM } from './twins.ts';

const KINDS: readonly CoachEventKind[] = [
  'greeting',
  'gameStart',
  'praise',
  'takebackOffer',
  'hint',
  'explainBest',
  'threatWarning',
  'botMoveComment',
  'gameEnd',
  'reviewMoment',
  'encourage',
  'thinkingRoutine',
  'answer',
  'teachTurn',
  'teachReaction',
];

/** Every `MoveIdeaId` of ./moveIdeas.ts — each one is a possible «почему» of an advised move. */
const IDEAS: readonly string[] = [
  'mate', 'mateSoon', 'promotion', 'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'removeDefender', 'trappedPiece',
  'freeCapture', 'winMaterial', 'recapture', 'defendMate', 'answerCheck', 'escape', 'defend', 'block', 'threatMate', 'attack',
  'check', 'castle', 'develop', 'centerPawn', 'fightCenter', 'supportCenter', 'openLine', 'aimWeakSquare', 'prepareCastle',
  'centerControl', 'connectRooks', 'rookOpenFile', 'rookSeventh', 'passedPawn', 'trade', 'space', 'kingActivity', 'restrictKing',
  'opposition', 'improvePiece', 'quiet',
];

const units = CLIP_CATALOG.flatMap(catalogUnits);
const line = (id: string): ClipCatalogLine => {
  const l = clipCatalogLine(id);
  if (!l) throw new Error(`no line ${id}`);
  return l;
};

/** The wordings a pool offers (a plain wording of a byPiece / byGender line joins every variant pool). */
function poolSizes(l: ClipCatalogLine): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const u of catalogUnits(l)) for (const p of u.pools) sizes.set(p, (sizes.get(p) ?? 0) + 1);
  return sizes;
}

describe('the lint of SPEC §10 with the catalogue voice rules', () => {
  it('finds nothing in the whole catalogue', () => {
    expect(lintCatalog(CLIP_CATALOG)).toEqual([]);
    expect(units.every((u) => u.text !== null)).toBe(true);
  });

  it('the lint does bite: a feminine self-reference, a square, Latin, a long whole line', () => {
    const bad: ClipCatalogLine[] = [
      { id: 'x.fem', role: 'whole', wordings: [{ t: 'Я так рада!' }] },
      { id: 'x.sq', role: 'whole', wordings: [{ t: 'Соперник вывел коня на эф шесть.' }] },
      { id: 'x.lat', role: 'whole', wordings: [{ t: 'Ход Nf3!' }] },
      { id: 'x.long', role: 'whole', wordings: [{ t: 'Раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать.' }] },
    ];
    expect(new Set(lintCatalog(bad).map((i) => i.rule))).toEqual(new Set(['selfFeminine', 'square', 'latin', 'length']));
  });

  it('Гамбитик speaks as a boy: masculine self-reference is there, a feminine one nowhere', () => {
    const texts = units.map((u) => u.text as string);
    expect(texts.some((t) => /я готов(?![а-яё])/iu.test(t))).toBe(true);
    expect(texts.some((t) => /я уже соскучился/iu.test(t))).toBe(true);
    expect(texts.some((t) => /я тоже заметил/iu.test(t))).toBe(true);
    expect(texts.some((t) => /я бы сходил/iu.test(t))).toBe(true);
    expect(texts.filter(hasFeminineSelfReference)).toEqual([]);
  });

  it('the child is addressed by gender only through {g:…} (a girl never hears «сам», «готов», «выбрал»)', () => {
    // a bare child-gendered word in a line that is not byGender would be wrong for half of the children
    const childMasc = /(?<![а-яё])(ты [а-яё]*(?:ал|ил|ел|ял|ёл|ыл)|решай сам|найдёшь ход сам|готов подумать)(?![а-яё])/iu;
    const offenders = CLIP_CATALOG.filter((l) => !l.byGender).flatMap((l) => l.wordings.map((w) => w.t)).filter((t) => childMasc.test(t));
    expect(offenders).toEqual([]);
    for (const l of CLIP_CATALOG.filter((x) => x.byGender)) expect(l.wordings.some((w) => usesGender(w.t)), l.id).toBe(true);
  });

  it('the opponent\'s move, dangers, treasures and «Спроси» answers are piece only — never a square', () => {
    const pieceOnly = CLIP_CATALOG.filter((l) => /^(opp|danger|treasure|ask|takeback\.again|takeback\.tail)\b/.test(l.id));
    expect(pieceOnly.length).toBeGreaterThan(25);
    for (const l of pieceOnly) {
      for (const u of catalogUnits(l)) {
        expect(hasSpokenSquare(u.text as string), u.unitKey).toBe(false);
        expect(u.text, u.unitKey).not.toMatch(/(?<![а-яё])на (а|бэ|цэ|дэ|е|эф|же|аш)(?![а-яё])/iu);
      }
    }
    // and no square anywhere outside a slot
    expect(units.filter((u) => hasSpokenSquare(u.text as string)).map((u) => u.unitKey)).toEqual([]);
  });

  it('ids are plain dotted ids the server accepts; wordings are distinct within a line', () => {
    for (const l of CLIP_CATALOG) {
      expect(l.id, l.id).toMatch(/^[A-Za-z][A-Za-z0-9_.-]*$/);
      expect(l.id.length).toBeLessThanOrEqual(80);
      const texts = l.wordings.map((w) => w.t);
      expect(new Set(texts).size, l.id).toBe(texts.length);
    }
  });

  it('a byPiece line offers a piece-neutral plain pool (the L3 fallback) or falls back to a line that does', () => {
    for (const l of CLIP_CATALOG.filter((x) => linePieces(x).length > 0)) {
      const neutral = l.wordings.some((w) => !usesPiece(w.t));
      const fb = l.fallback ? clipCatalogLine(l.fallback) : undefined;
      expect(neutral || (fb !== undefined && fb.wordings.some((w) => !usesPiece(w.t))), l.id).toBe(true);
      expect(l.wordings.some((w) => usesPiece(w.t)), `${l.id} names its piece somewhere`).toBe(true);
    }
  });
});

describe('pools by frequency (SPEC §7.1)', () => {
  it('a line heard ≥ 1× a game offers ≥ 4 wordings in every pool a twin plays; ≥ 3× a game — ≥ 6', () => {
    for (const l of CLIP_CATALOG.filter((x) => (x.freq ?? 0) >= 1)) {
      const min = (l.freq ?? 0) >= 3 ? 6 : 4;
      const sizes = poolSizes(l);
      const pieces = linePieces(l);
      // the pools the twins ask for: the piece variants of a byPiece line, the gender variants of a byGender one
      const played = [...sizes.entries()].filter(([pool]) => (pieces.length === 0 || /@[pnbrqk]/.test(pool)) && (!l.byGender || /\/[mf]$/.test(pool)));
      expect(played.length, l.id).toBeGreaterThan(0);
      for (const [pool, n] of played) expect(n, `${pool} (freq ${l.freq})`).toBeGreaterThanOrEqual(min);
    }
  });

  it('the hottest lines — «Смотри, тут подарок», «Осторожно», «Найдёшь ход сам?» — have the biggest pools', () => {
    expect(line('treasure.free').freq).toBeGreaterThanOrEqual(3);
    expect(line('danger.hanging').freq).toBeGreaterThanOrEqual(3);
    expect(line('ask.find').wordings.length).toBeGreaterThanOrEqual(8);
    expect(poolSizes(line('danger.hanging')).get('danger.hanging@n')).toBeGreaterThanOrEqual(8);
    for (const id of ['teach.head.advice', 'teach.head.arrow', 'teach.head.good', 'reveal.head', 'repeat.head', 'praise.process', 'praise.generic']) {
      expect(line(id).wordings.length, id).toBeGreaterThanOrEqual(6);
    }
  });
});

describe('generics — ladder L5', () => {
  it.each(KINDS)('%s has ≥ 4 generic wordings', (kind) => {
    expect(line(`generic.${kind}`).wordings.length).toBeGreaterThanOrEqual(4);
  });

  it('the root line and the teacher moments exist; a generic never names a move', () => {
    expect(hasClipLine('generic')).toBe(true);
    for (const id of ['generic.teachTurn.turn', 'generic.teachTurn.reveal', 'generic.teachTurn.repeat', 'generic.teachTurn.openingPlan', 'generic.gameStart.openingPlan']) {
      expect(line(id).wordings.length, id).toBeGreaterThanOrEqual(4);
    }
    const generics = CLIP_CATALOG.filter((l) => l.id === 'generic' || l.id.startsWith('generic.'));
    for (const l of generics) {
      expect(l.role).toBe('whole');
      expect(linePieces(l)).toEqual([]);
      for (const w of l.wordings) expect(w.t, l.id).not.toMatch(/(?<![а-яё])(пешк|кон[ьяё]|слон|ладь|ферз)[а-яё]* на /iu);
    }
  });
});

describe('heads, reasons, barks', () => {
  it('every head has its slot form, every slot form a head', () => {
    const heads = CLIP_CATALOG.filter((l) => l.role === 'head').map((l) => l.id);
    expect(heads.filter((id) => HEAD_SLOT_FORM[id] === undefined)).toEqual([]);
    expect(Object.keys(HEAD_SLOT_FORM).filter((id) => !heads.includes(id))).toEqual([]);
  });

  it('every idea of the explainer has its reason tail (a promotion says what the pawn becomes)', () => {
    const missing = IDEAS.filter((id) => id !== 'promotion' && !hasClipLine(`reason.${id}`));
    expect(missing).toEqual([]);
    expect(line('move.promo').byPiece).toEqual(['q', 'r', 'b', 'n']);
    for (const id of IDEAS) if (hasClipLine(`reason.${id}`)) expect(line(`reason.${id}`).role).toBe('tail');
  });

  it('barks for the poses the twins say them with; each a short interjection', () => {
    for (const pose of ['talk', 'think', 'cheer', 'oops']) {
      const l = line(`bark.${pose}`);
      expect(l.role).toBe('bark');
      expect(l.wordings.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps the planner fixture\'s heads compatible: the real advice head reads before «конём …»', () => {
    // the fixture (plan tests) and the real catalogue agree on the one line both have
    const real = line('teach.head.advice').wordings.map((w) => w.t);
    const fixture = FIXTURE_CATALOG.find((l) => l.id === 'teach.head.advice')?.wordings.map((w) => w.t) ?? [];
    expect(fixture.filter((t) => !real.includes(t))).toEqual([]);
  });
});

describe('the lines the web layer asks for (apps/web/src/coach/clips: clipAsk, clipSettings)', () => {
  it('exist, with the piece variants it passes', () => {
    const ids = ['poke', 'preview', 'ask.why.think', 'ask.opp.notYet', 'ask.opp.none', 'ask.repeat.stale', 'opp.pawn', 'opp.castled', 'opp.check', 'generic.answer', 'generic.botMoveComment'];
    for (const chip of ['easy', 'hard', 'goodMove', 'mistake', 'rematch']) ids.push(`thought.${chip}`);
    expect(ids.filter((id) => !hasClipLine(id))).toEqual([]);
    for (const id of ['opp.developed', 'opp.took', 'opp.attack', 'opp.moved', 'ask.opp.hanging']) expect(linePieces(line(id)).length, id).toBeGreaterThan(0);
    // (the chips pass no gender: their replies must play from the plain pool)
    for (const chip of ['easy', 'hard', 'goodMove', 'mistake', 'rematch']) expect(line(`thought.${chip}`).byGender).toBeFalsy();
  });

  it('CLIP_TAP_LINES: every tap line exists, whole, nameless, without gender, and its pieces are recorded variants', () => {
    for (const t of CLIP_TAP_LINES) {
      const l = line(t.line);
      expect(l.role, t.line).toBe('whole');
      expect(l.byGender ?? false, t.line).toBe(false);
      for (const p of t.pieces ?? []) expect(linePieces(l), `${t.line}@${p}`).toContain(p);
    }
    expect(new Set(CLIP_TAP_LINES.map((t) => t.line)).size).toBe(CLIP_TAP_LINES.length);
  });

  it('the «Спроси» answers say what their bubble says: «Почему так?» with nothing to explain asks back, «соперник ещё не ходил»', () => {
    expect(line('ask.why.think').wordings[0]?.t).toBe('Давай подумаем вместе: какая фигура ещё не в игре?');
    for (const w of line('ask.why.think').wordings) expect(w.t, w.t).not.toMatch(/хороший ход|крепкий/u);
    expect(line('ask.opp.notYet').wordings[0]?.t).toBe('Соперник ещё не ходил — ход за тобой!');
    for (const w of line('ask.opp.none').wordings) expect(w.t, w.t).not.toMatch(/ещё не ходил/u);
  });
});

describe('variety of openers (the voice must never sound «запрограммированно, неживо»)', () => {
  /** the first word of a wording, lowercased, punctuation and placeholder braces dropped («{Конь}» → «конь») */
  const firstWord = (t: string): string => (t.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[{}«»"!?.,:;…—-]+/gu, '');

  it('in an opponent pool (heard ≈ 5 times a game) no first word opens more than half of the wordings', () => {
    const pools = CLIP_CATALOG.filter((l) => l.role === 'whole' && (l.id.startsWith('opp.') || l.id.startsWith('ask.opp.')) && l.wordings.length >= 4);
    expect(pools.length).toBeGreaterThanOrEqual(8);
    for (const l of pools) {
      const counts = new Map<string, number>();
      for (const w of l.wordings) counts.set(firstWord(w.t), (counts.get(firstWord(w.t)) ?? 0) + 1);
      const [word, n] = [...counts].sort((a, b) => b[1] - a[1])[0] as [string, number];
      expect(n, `${l.id}: «${word}» opens ${n} of ${l.wordings.length}`).toBeLessThanOrEqual(l.wordings.length / 2);
    }
  });

  it('«Соперник» opens at most half of all the opponent wordings together', () => {
    const all = CLIP_CATALOG.filter((l) => l.id.startsWith('opp.')).flatMap((l) => l.wordings.map((w) => w.t));
    expect(all.filter((t) => firstWord(t) === 'соперник').length).toBeLessThanOrEqual(all.length / 2);
  });
});

describe('the strategy library, mirrored (test-only import of @gambit/content)', () => {
  it('has the 24 strategies, each with its intro line that names it', () => {
    expect(STRATEGIES.length).toBe(24);
    for (const s of STRATEGIES) {
      const id = strategyLineOf(s.id);
      expect(id, s.id).toBe(`strategy.${s.id}`);
      const texts = line(id as string).wordings.map((w) => w.t.toLowerCase());
      expect(texts.some((t) => t.includes(s.titleAccRu.toLowerCase()) || t.includes(s.titleRu.toLowerCase())), s.id).toBe(true);
      expect(texts.length).toBeGreaterThanOrEqual(2);
    }
    expect(strategyLineOf('rules')).toBeNull();
    expect(strategyLineOf('')).toBeNull();
  });

  it('says every plan goal of the library as a goal tail without squares', () => {
    const goals = [...new Set(STRATEGIES.flatMap((s) => s.planGoalsRu))];
    const missing = goals.filter((g) => planGoalLineOf(g) === null);
    expect(missing).toEqual([]);
    for (const g of goals) {
      const l = line(planGoalLineOf(g) as string);
      expect(l.role).toBe('tail');
      expect(l.id.startsWith('goal.')).toBe(true);
    }
    expect(planGoalLineOf('Целимся слоном в слабую точку эф семь.')).toBe('goal.aimF7');
    expect(planGoalLineOf('придуманная цель')).toBeNull();
    expect(planGoalLineOf(undefined)).toBeNull();
    expect(Object.values(PLAN_GOAL_LINES).filter((id) => !hasClipLine(id))).toEqual([]);
  });

  it('never carries the strategist\'s free text: every intro is the library\'s title + idea, ≤ 12 words', () => {
    for (const s of STRATEGIES) {
      for (const u of catalogUnits(line(`strategy.${s.id}`))) {
        expect((u.text as string).split(/\s+/).filter((w) => /[а-яё]/iu.test(w)).length).toBeLessThanOrEqual(12);
      }
    }
  });
});
