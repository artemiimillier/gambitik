/**
 * The harvest's pure half (no engine, no audio): the game mix, the holdout, the file format, the probe demand and the
 * demo choice — on hand-made records and on the committed 24-game sample (tools/voice-clips/harvest-sample.*.jsonl.gz).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Chess } from 'chess.js';
import { afterEach, describe, expect, it } from 'vitest';
import { hasClipLine, slotKeyOf } from '../../packages/core/src/coach/clips/index.ts';
import { DEFAULT_SAMPLE, DEFAULT_STATS } from './cliCatalog.ts';
import type { StatsFile } from './cliCatalog.ts';
import {
  demoEvents,
  demoFactsOf,
  demoFileOf,
  eventDemand,
  gameConfigOf,
  harvestStats,
  isHoldout,
  mergeHarvests,
  parseHarvestLines,
  pickDemo,
  probeIndex,
  readHarvest,
  writeHarvest,
} from './harvest.ts';
import type { HarvestCoachEvent, HarvestGame } from './harvest.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const sample = readHarvest(DEFAULT_SAMPLE);
const stats = JSON.parse(readFileSync(DEFAULT_STATS, 'utf8')) as StatsFile;

function game(over: Partial<HarvestGame> = {}): HarvestGame {
  return { t: 'game', ...gameConfigOf(0), strategyId: null, plies: [], result: '*', termination: 'abandoned', clockMs: 300_000, events: 0, ...over };
}

describe('the game mix', () => {
  it('is a pure function of the index: ≈ ¾ «Учитель», half 5-minute games, colours alternate', () => {
    expect(gameConfigOf(17)).toEqual(gameConfigOf(17));
    const all = Array.from({ length: 400 }, (_, i) => gameConfigOf(i));
    const teacher = all.filter((g) => g.coachStyle === 'teacher').length / all.length;
    const blitz = all.filter((g) => g.tc === 'blitz5').length / all.length;
    expect(teacher).toBeGreaterThan(0.68);
    expect(teacher).toBeLessThan(0.82);
    expect(blitz).toBeGreaterThan(0.42);
    expect(blitz).toBeLessThan(0.58);
    expect(all.every((g, i) => g.childColor === (i % 2 === 0 ? 'w' : 'b'))).toBe(true);
    expect(all.filter((g) => g.coachStyle === 'helper').every((g) => g.stage === 5)).toBe(true);
    expect(all.filter((g) => g.coachStyle === 'teacher').every((g) => g.stage >= 1 && g.stage <= 4)).toBe(true);
    expect(gameConfigOf(9, { blitz: true }).tc).toBe('blitz5');
  });

  it('holds out a quarter of the games, of both colours', () => {
    const held = Array.from({ length: 400 }, (_, i) => gameConfigOf(i)).filter(isHoldout);
    expect(held.length).toBe(100);
    expect(held.some((g) => g.childColor === 'w')).toBe(true);
    expect(held.some((g) => g.childColor === 'b')).toBe(true);
  });
});

describe('harvest files', () => {
  it('drop a game without its closing record, and round-trip through gzip', () => {
    const g = game({ game: 'g1', index: 1 });
    const ev = { t: 'ev', game: 'g1', n: 0, afterPly: 0, family: 'greeting', event: { id: 'g1-1', kind: 'greeting', priority: 1, text: 'Привет!', bubbleText: 'Привет!', pose: 'wave', pauseClock: false } };
    const orphan = { ...ev, game: 'g2' };
    const h = parseHarvestLines([JSON.stringify(ev), JSON.stringify(orphan), 'not json', JSON.stringify(g)].join('\n'));
    expect(h.games.map((x) => x.game)).toEqual(['g1']);
    expect([...h.events.keys()]).toEqual(['g1']);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-harvest-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'h.jsonl.gz');
    writeHarvest(file, h);
    const back = readHarvest(file);
    expect(back.games).toEqual(h.games);
    expect(back.events.get('g1')).toEqual(h.events.get('g1'));
    expect(mergeHarvests([h, back]).games).toHaveLength(1);
  });
});

describe('the probe library says what the planner would voice', () => {
  it('names the exact pools and the move slot of a twin, after the caps of a 5-minute game', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const ev: HarvestCoachEvent = {
      id: 't1',
      kind: 'teachTurn',
      priority: 1,
      text: '…',
      bubbleText: '…',
      pose: 'talk',
      pauseClock: true,
      teach: { moment: 'turn', style: 'full', ply: 2, advice: [{ uci: 'g8f6', san: 'Nf6', source: 'engine', arrow: 'green' }] },
      clip: {
        sentences: [
          { items: [{ line: 'opp.pawn' }], prio: 45, end: '.' },
          { items: [{ line: 'teach.head.answer' }, { slot: 'ins', san: 'Nf6', fen }, { line: 'reason.develop', piece: 'n' }], prio: 100, end: '.' },
        ],
        generic: 'generic.teachTurn.turn.talk',
        moment: 'turn',
      },
    };
    const slow = eventDemand(ev, { tc: 'training', name: '' });
    expect(slow.items.map((i) => `${i.kind}:${i.key}`)).toEqual(['pool:opp.pawn', 'pool:teach.head.answer', 'slot:ins:n:f6', 'pool:reason.develop@n']);
    const blitz = eventDemand(ev, { tc: 'blitz5', name: '' });
    expect(blitz.items.map((i) => i.key)).toEqual(['teach.head.answer', 'ins:n:f6', 'reason.develop@n']);
    // the superset keeps every sentence, whatever the caps
    expect(eventDemand(ev, { tc: 'blitz5', name: '' }, { superset: true }).items).toHaveLength(4);
    expect(slotKeyOf('Nf6', fen, 'ins')).toBe('ins:n:f6');
  });

  it('compiles an event without a twin and never invents a square', () => {
    const ev: HarvestCoachEvent = { id: 'x', kind: 'encourage', priority: 1, text: 'Поторопись!', bubbleText: 'Поторопись!', pose: 'talk', pauseClock: false };
    const d = eventDemand(ev, { tc: 'blitz5', name: '' });
    expect(d.items).toEqual([{ kind: 'frag', key: 'f:поторопись|!', text: 'Поторопись' }]);
    const hint: HarvestCoachEvent = { ...ev, id: 'y', kind: 'hint', text: 'Миша, конь на эф шесть под боем!', teach: { moment: 'turn', style: 'short', ply: 3, advice: [] } };
    // a square no advice names is refused by the guard: the generic line instead
    expect(eventDemand(hint, { tc: 'blitz5', name: 'Миша' }).plan.mismatch).toBe(true);
  });

  it('has one take per catalogue pool and per move slot', () => {
    const { index } = probeIndex();
    expect(index.pools['teach.head.advice']).toHaveLength(1);
    expect(index.pools['reason.attack@n']).toHaveLength(1);
    expect(index.keys['slot:cap:q:h7']).toHaveLength(1);
    expect(index.keys['slot:sq:e4']).toHaveLength(1);
  });
});

describe('the committed sample and stats', () => {
  it('are 24 games with the demo, the rest held out, every twin line in the catalogue', () => {
    expect(sample.games).toHaveLength(24);
    const demo = stats.demo?.seed as string;
    expect(sample.games.some((g) => g.game === demo)).toBe(true);
    expect(sample.games.filter((g) => g.game !== demo).every(isHoldout)).toBe(true);
    for (const list of sample.events.values()) {
      for (const e of list) for (const s of e.event.clip?.sentences ?? []) for (const it of s.items) if ('line' in it) expect(hasClipLine(it.line), it.line).toBe(true);
    }
  });

  it('stats rank on the training games only (≥ 300 games harvested, blitz «Учитель» included)', () => {
    expect(stats.games).toBeGreaterThanOrEqual(300);
    expect(stats.train.split).toBe('train');
    expect(stats.train.games + stats.holdoutGames).toBe(stats.games);
    expect(stats.train.blitzGames).toBeGreaterThan(100);
    expect(stats.train.pools['teach.head.arrow']?.plays).toBeGreaterThan(0);
    // the sample's games besides the demo are held-out ones: none of them was used to rank the units
    expect(harvestStats(sample, 'holdout').games).toBe(23);
  });
});

describe('the demo game (SPEC §9)', () => {
  it('is a seeded 5-minute «Учитель» game, the child White, with every family SPEC §9 asks for, all voiceable', () => {
    const picked = pickDemo(sample);
    expect(picked?.game.game).toBe(stats.demo?.seed);
    const f = picked?.facts;
    expect(f?.eligible).toBe(true);
    expect(picked?.game.tc).toBe('blitz5');
    expect(picked?.game.coachStyle).toBe('teacher');
    expect(picked?.game.childColor).toBe('w');
    expect(f?.teachTurns).toBeGreaterThanOrEqual(15);
    for (const k of ['treasure', 'danger', 'praise', 'takebackOffer'] as const) expect(f?.[k], k).toBeGreaterThanOrEqual(1);
    expect(f?.strategyIntro && f.gameEnd).toBe(true);
    expect(f?.unvoiceable).toBe(0);
  });

  it('writes the replay format: legal plies in turn, the events after the plies they followed', () => {
    const g = sample.games.find((x) => x.game === stats.demo?.seed) as HarvestGame;
    const events = sample.events.get(g.game) ?? [];
    const demo = demoFileOf(g, events) as unknown as Parameters<typeof demoEvents>[0] & { plies: { by: string; uci: string }[]; timeControlId: string; childColor: string; clockMs: number };
    expect(demo.timeControlId).toBe('blitz5');
    expect(demo.clockMs).toBe(300_000);
    const chess = new Chess();
    for (const p of demo.plies) {
      expect(p.by).toBe(chess.turn() === 'w' ? 'child' : 'bot');
      chess.move({ from: p.uci.slice(0, 2), to: p.uci.slice(2, 4), ...(p.uci[4] ? { promotion: p.uci[4] } : {}) });
    }
    expect(demoEvents(demo).map((e) => e.id)).toEqual(events.map((e) => e.event.id));
    expect(demoFactsOf(g, events).eligible).toBe(true);
  });
});
