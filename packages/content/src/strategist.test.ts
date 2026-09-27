import { describe, expect, it } from 'vitest';
import type { ReplanRequest } from '@gambit/shared';
import { REPLAN_PROMPT_RU, STRATEGIST_PROMPT_RU, buildReplanPrompt, buildStrategistPrompt, replanJsonSchema, strategistJsonSchema } from './strategist.ts';
import { getStrategiesFor, getStrategy } from './strategies.ts';
import { LATIN_RE } from './testUtils.ts';

const PLACEHOLDER = /\{\{|\}\}|\$\{|TODO|FIXME|undefined|NaN/;

describe('the smart strategist prompts', () => {
  it('the instructions are Russian, without placeholders; the chess truth stays with the candidates', () => {
    for (const p of [STRATEGIST_PROMPT_RU, REPLAN_PROMPT_RU]) {
      expect(p).not.toMatch(PLACEHOLDER);
      // field names of the JSON are the only Latin words
      const latin = [...p.matchAll(/[A-Za-z][A-Za-z0-9]*/g)].map((m) => m[0]);
      for (const w of latin) expect(['strategyId', 'introRu', 'history', 'stage', 'weaknesses', 'firstMoveRu', 'JSON', 'ply', 'planRu', 'preferredUci', 'whyRu', 'strategy', 'candidates', 'uci', 'null', 'ideasRu', 'planGoalsRu']).toContain(w);
    }
    expect(STRATEGIST_PROMPT_RU).toMatch(/ТОЛЬКО из кандидатов/);
    expect(STRATEGIST_PROMPT_RU).toMatch(/Разнообразие важнее всего/);
    expect(STRATEGIST_PROMPT_RU).toMatch(/без часов и времени, без цвета фигур/);
    expect(REPLAN_PROMPT_RU).toMatch(/Выбери ОДИН ход из candidates/);
    expect(REPLAN_PROMPT_RU).toMatch(/ничего не выдумывай/);
  });

  it('the strategy prompt carries the candidates, the history and the stage — no name, no child\'s words', () => {
    const candidates = getStrategiesFor('w', 2);
    const prompt = buildStrategistPrompt({
      request: { childColor: 'w', stage: 2, personaId: 'sasha', timeControlId: 'rapid10' },
      candidates,
      history: ['italian', 'london'],
      weaknesses: ['fork'],
      firstMoveRu: { italian: 'пешкой на е четыре' },
    });
    expect(prompt.startsWith(STRATEGIST_PROMPT_RU)).toBe(true);
    const payload = JSON.parse(prompt.slice(STRATEGIST_PROMPT_RU.length)) as { candidates: { strategyId: string; firstMoveRu?: string }[]; history: string[]; game: { stage: number } };
    expect(payload.candidates.map((c) => c.strategyId)).toEqual(candidates.map((c) => c.id));
    expect(payload.candidates.find((c) => c.strategyId === 'italian')?.firstMoveRu).toBe('пешкой на е четыре');
    expect(payload.history).toEqual(['italian', 'london']);
    expect(payload.game.stage).toBe(2);
    expect(prompt).not.toMatch(/nickname|address/);
    const schema = strategistJsonSchema(candidates.map((c) => c.id)) as { properties: { strategyId: { enum: string[] } }; required: string[] };
    expect(schema.properties.strategyId.enum).toEqual(candidates.map((c) => c.id));
    expect(schema.required).toEqual(['strategyId', 'introRu']);
  });

  it('the re-plan prompt carries only the engine\'s candidates; its schema pins the ply and the moves', () => {
    const request: ReplanRequest = {
      ply: 5,
      fen: 'rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3',
      childColor: 'w',
      strategyId: 'italian',
      movesSan: ['e4', 'e5', 'Nf3', 'd6'],
      candidates: [
        { uci: 'd2d4', san: 'd4', cp: 45, ideasRu: ['нападает на пешку на е пять в центре'] },
        { uci: 'f1c4', san: 'Bc4', cp: 30, ideasRu: ['выводит слона'] },
      ],
      stage: 2,
    };
    const prompt = buildReplanPrompt({ request, strategy: getStrategy('italian') ?? null });
    const payload = JSON.parse(prompt.slice(REPLAN_PROMPT_RU.length)) as { candidates: { uci: string; cp?: number }[]; strategy: { titleRu: string; planGoalsRu?: string[] } };
    expect(payload.candidates.map((c) => c.uci)).toEqual(['d2d4', 'f1c4']);
    expect(payload.candidates.every((c) => c.cp === undefined)).toBe(true); // no numbers for the words
    expect(payload.strategy.titleRu).toBe('Итальянская партия');
    // the goals outlive the main line: the new plan may go on with them
    expect(payload.strategy.planGoalsRu).toEqual(getStrategy('italian')?.planGoalsRu);
    expect(REPLAN_PROMPT_RU).toMatch(/Цели стратегии \(planGoalsRu\) не кончаются/);
    const schema = replanJsonSchema(request) as { properties: { ply: { enum: number[] }; preferredUci: { enum: (string | null)[] } } };
    expect(schema.properties.ply.enum).toEqual([5]);
    expect(schema.properties.preferredUci.enum).toEqual(['d2d4', 'f1c4', null]);
    expect(REPLAN_PROMPT_RU.replace(/[A-Za-z]+/g, '')).not.toMatch(LATIN_RE);
  });
});
