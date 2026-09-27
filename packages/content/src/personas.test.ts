import { describe, expect, it } from 'vitest';
import { PERSONA_IDS } from '@gambit/shared';
import type { Persona } from '@gambit/shared';
import { CURRICULUM } from './curriculum.ts';
import { PERSONAS, PERSONA_ORDER, getPersona, listPersonas } from './personas.ts';
import { LATIN_RE, PLACEHOLDER_RE, sentenceCount } from './testUtils.ts';

/** Elo values fixed by the task / contracts. */
const EXPECTED_ELO: Record<string, number> = {
  petya: 300,
  sonya: 500,
  grisha: 700,
  sasha: 900,
  vika: 1100,
  lyova: 1400,
  nika: 1800,
  dima: 2500,
};

const LINE_TYPES = ['intro', 'onWin', 'onLose', 'onDraw', 'onGoodMoveByChild'] as const;

/**
 * Heuristics for "gendered towards the child": a past-tense verb or a gendered short adjective
 * right after «ты» (optionally with one or two words in between).
 */
const GENDERED_TOWARDS_CHILD = [
  /(?:^|[^а-яё])ты(?:\s+[а-яё-]+){0,2}\s+[а-яё]+(?:ал|ала|ил|ила|ел|ела|ял|яла|ул|ула|ёл|шла|шёл|ыл|ыла)(?:ся|сь)?(?![а-яё])/i,
  /(?:^|[^а-яё])ты\s+(?:готов|готова|рад|рада|сам|сама|должен|должна|прав|права|уверен|уверена)(?![а-яё])/i,
  /(?:^|[^а-яё])(?:сам|сама)\s+(?:наш[её]л|нашла|увидел|увидела|догадался|догадалась)/i,
];

const SHAMING = /глуп|тупо|тупой|дурак|слабак|неудачни|позор|стыд(?!но)|лузер|легкотня|ерунда|ничтож|бездар/i;

const personas = listPersonas();

describe('PERSONAS', () => {
  it('contains exactly the ids fixed by contracts.ts, in ladder order', () => {
    expect(Object.keys(PERSONAS).sort()).toEqual([...PERSONA_IDS].sort());
    expect(PERSONA_ORDER).toEqual([...PERSONA_IDS]);
    for (const id of PERSONA_IDS) expect(PERSONAS[id].id).toBe(id);
  });

  it('has the agreed nominal Elo for every persona', () => {
    for (const id of PERSONA_IDS) expect(PERSONAS[id].nominalElo).toBe(EXPECTED_ELO[id]);
  });

  it('age, strength and the recommended stage grow along the ladder', () => {
    for (let i = 1; i < personas.length; i += 1) {
      const prev = personas[i - 1] as Persona;
      const next = personas[i] as Persona;
      expect(next.age, `${next.id} must be older than ${prev.id}`).toBeGreaterThan(prev.age);
      expect(next.nominalElo).toBeGreaterThan(prev.nominalElo);
      expect(next.recommendedFromStage).toBeGreaterThanOrEqual(prev.recommendedFromStage);
    }
    expect(personas[0]?.recommendedFromStage).toBe(1);
    for (const p of personas) {
      expect(p.recommendedFromStage).toBeGreaterThanOrEqual(1);
      expect(p.recommendedFromStage).toBeLessThanOrEqual(CURRICULUM.length);
    }
  });

  it('has unique names and distinct avatars', () => {
    expect(new Set(personas.map((p) => p.name)).size).toBe(personas.length);
    expect(new Set(personas.map((p) => JSON.stringify(p.avatar))).size).toBe(personas.length);
    expect(new Set(personas.map((p) => p.avatar.bg)).size).toBe(personas.length);
    expect(new Set(personas.map((p) => `${p.avatar.hairStyle}/${p.avatar.accessory ?? '-'}`)).size).toBe(personas.length);
    for (const p of personas) {
      for (const colour of [p.avatar.bg, p.avatar.skin, p.avatar.hair]) expect(colour).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it.each(personas.map((p) => [p.id, p] as const))('%s: texts are Russian, short, kind and gender-neutral', (_id, p) => {
    expect(p.name).toMatch(/^[А-ЯЁ][а-яё]+$/);
    for (const text of [p.tagline, p.style]) {
      expect(text.trim().length).toBeGreaterThan(10);
      expect(text).not.toMatch(LATIN_RE);
      expect(text).not.toMatch(PLACEHOLDER_RE);
    }
    expect(sentenceCount(p.tagline)).toBeLessThanOrEqual(2);

    for (const type of LINE_TYPES) {
      const variants = p.lines[type];
      expect(variants.length, `${p.id}.${type} needs ≥ 3 variants`).toBeGreaterThanOrEqual(3);
      expect(new Set(variants).size, `${p.id}.${type} has duplicates`).toBe(variants.length);
      for (const line of variants) {
        expect(line.trim()).toBe(line);
        expect(line.length).toBeGreaterThan(3);
        expect(line.length, `too long for a bubble: ${line}`).toBeLessThanOrEqual(120);
        expect(sentenceCount(line), `too many sentences: ${line}`).toBeLessThanOrEqual(4);
        expect(line, `Latin letters: ${line}`).not.toMatch(LATIN_RE);
        expect(line, `placeholder: ${line}`).not.toMatch(PLACEHOLDER_RE);
        expect(line, `digits are not TTS/bubble friendly: ${line}`).not.toMatch(/\d/);
        expect(line, `shaming word: ${line}`).not.toMatch(SHAMING);
        for (const re of GENDERED_TOWARDS_CHILD) expect(line, `gendered towards the child: ${line}`).not.toMatch(re);
      }
    }
  });

  it('the gender heuristics catch what they are meant to catch', () => {
    const gendered = ['Как ты меня обыграл!', 'Ты нашла вилку!', 'Ты готов?', 'Ты сам догадался?', 'Ты уверена?'];
    const neutral = ['Ты играешь сильнее меня.', 'Ты видишь дальше меня.', 'У тебя точно получится!', 'Я выиграл, а ты держишься всё лучше.'];
    const hit = (line: string) => GENDERED_TOWARDS_CHILD.some((re) => re.test(line));
    for (const line of gendered) expect(hit(line), line).toBe(true);
    for (const line of neutral) expect(hit(line), line).toBe(false);
  });

  it('static end-of-game lines never assert concrete events of the game (only code-proven facts)', () => {
    // «Там была вилка», «Попалась фигурка», «Эндшпиль — моя стихия», «Атака прошла» would be false after games without them
    const CLAIMS = /там был|была вилка|попал(ась|ся)|эндшпиль — моя|атака прошла|детский мат|комбинаци|зевнул|ты потерял|я поймал|я выиграл(а)? (фигуру|ферзя|ладью)/i;
    for (const p of personas) {
      for (const line of [...p.lines.onWin, ...p.lines.onLose, ...p.lines.onDraw]) {
        expect(line, `claims something that may not have happened: ${line}`).not.toMatch(CLAIMS);
      }
    }
  });

  it('the very first intro of every bot introduces it by name', () => {
    for (const p of personas) expect(p.lines.intro[0]).toContain(p.name);
  });

  it('getPersona tolerates unknown ids', () => {
    expect(getPersona('vika')?.name).toBe('Вика');
    expect(getPersona('nobody')).toBeUndefined();
    expect(getPersona('toString')).toBeUndefined();
  });
});
