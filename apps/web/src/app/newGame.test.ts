import { PERSONA_ORDER } from '@gambit/content';
import { PERSONA_IDS, TIME_CONTROL_IDS } from '@gambit/shared';
import { describe, expect, it } from 'vitest';
import {
  BULLET_COACH_NOTE,
  BULLET_COACH_PHRASE,
  COACH_STYLE_MEMORY_MS,
  COACH_STYLE_STORAGE_KEY,
  TIME_CONTROL_CARDS,
  WIZARD_TITLES,
  coachStyleChoiceAvailable,
  coachStylePhrase,
  coachStyleTile,
  coachStyleTiles,
  createStepGuard,
  initialCoachStyle,
  isStretchOpponent,
  personaRung,
  playRouteFor,
  previousStep,
  recommendedPersonaIds,
  rememberCoachStyle,
  rememberedCoachStyle,
  resolveColor,
  stretchOpponentPhrase,
  timeStepPhrase,
} from './newGame.ts';
import { formatRoute, parseHash } from './router.ts';
import type { KeyValueStorage } from './shellSettings.ts';
import { createMemoryStorage } from './testUtils.ts';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('new-game wizard logic', () => {
  it('has one card per time control, in contract order, with kid-friendly copy', () => {
    expect(TIME_CONTROL_CARDS.map((card) => card.control.id)).toEqual([...TIME_CONTROL_IDS]);
    for (const card of TIME_CONTROL_CARDS) {
      expect(card.title.length).toBeGreaterThan(3);
      expect(card.subtitle.length).toBeGreaterThan(10);
      expect(card.subtitle).not.toMatch(/[A-Za-z]/);
    }
  });

  it('tells on the calm time controls that Гамбитик can teach (TEACHER-MODE §1.3)', () => {
    const subtitle = (id: string): string | undefined => TIME_CONTROL_CARDS.find((card) => card.control.id === id)?.subtitle;
    expect(subtitle('rapid10')).toBe('Спокойная игра. Гамбитик может быть учителем');
    expect(subtitle('training')).toBe('Думай сколько хочешь — Гамбитик научит');
    // 5 minutes: the teacher too, and the clock waits for his words
    expect(subtitle('blitz5')).toBe('Быстрая игра. Пока Гамбитик учит, часы стоят');
  });

  it('says plainly what Гамбитик does in 1 minute and where the teacher is', () => {
    const subtitle = TIME_CONTROL_CARDS.find((card) => card.control.id === 'bullet1')?.subtitle ?? '';
    expect(subtitle).toMatch(/поздоровается/);
    expect(subtitle).toMatch(/после/);
    expect(BULLET_COACH_NOTE).toBe('В молнии Гамбитик только поздоровается, а поговорим после партии. «Учитель» есть в играх на 5 и 10 минут и «Без часов».');
    expect(BULLET_COACH_NOTE).not.toMatch(/[A-Za-z]/);
    expect(timeStepPhrase().text).toMatch(/В молнии я только поздороваюсь/);
    // (said as two catalogue sentences, so «Записи» can record exactly the bubble — «Дозапись голоса»)
    expect(timeStepPhrase().text).toMatch(/Учить могу на пяти, десяти минутах и без часов\.$/);
  });

  it('marks the one-minute game as «без подсказок»: nothing to choose there', () => {
    const bullet = TIME_CONTROL_CARDS.find((card) => card.control.id === 'bullet1');
    expect(bullet?.badge?.text).toBe('без подсказок');
    expect(coachStyleChoiceAvailable('bullet1')).toBe(false);
    expect(coachStyleChoiceAvailable('blitz5')).toBe(true);
    expect(coachStyleChoiceAvailable('rapid10')).toBe(true);
    expect(coachStyleChoiceAvailable('training')).toBe(true);
  });

  it('recommends personas of the current curriculum stage and clamps odd stages', () => {
    expect(recommendedPersonaIds(1)).toEqual(['petya', 'sonya']);
    expect(recommendedPersonaIds(0)).toEqual(recommendedPersonaIds(1));
    expect(recommendedPersonaIds(99).length).toBeGreaterThan(0);
    for (const id of recommendedPersonaIds(5)) expect(PERSONA_IDS).toContain(id);
  });

  it('ranks the ladder 1..8', () => {
    expect(PERSONA_ORDER.map(personaRung)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('calls a bot a stretch when it is 3+ rungs above the recommended ones', () => {
    // stage 1 recommends petya (1) and sonya (2)
    expect(isStretchOpponent('sonya', 1)).toBe(false);
    expect(isStretchOpponent('sasha', 1)).toBe(false); // rung 4 = +2
    expect(isStretchOpponent('vika', 1)).toBe(true); // rung 5 = +3
    expect(isStretchOpponent('dima', 1)).toBe(true);
    expect(isStretchOpponent('dima', 10)).toBe(false);
    expect(isStretchOpponent('petya', 10)).toBe(false);
  });

  it('resolves «сюрприз» once, so the play link is stable', () => {
    expect(resolveColor('w')).toBe('w');
    expect(resolveColor('b')).toBe('b');
    expect(resolveColor('random', () => 0.1)).toBe('w');
    expect(resolveColor('random', () => 0.9)).toBe('b');

    const route = playRouteFor({ timeControlId: 'rapid10', personaId: 'grisha', color: 'random', coachStyle: 'exam' }, () => 0.9);
    expect(route).toEqual({ name: 'play', personaId: 'grisha', timeControlId: 'rapid10', childColor: 'b', coachStyle: 'exam', examMode: true });
    expect(parseHash(formatRoute(route))).toEqual(route);
  });

  it('starts the game with the chosen style; examMode follows it', () => {
    for (const coachStyle of ['teacher', 'helper', 'exam'] as const) {
      const route = playRouteFor({ timeControlId: 'training', personaId: 'petya', color: 'w', coachStyle, stage: 2 });
      expect(route).toMatchObject({ coachStyle, examMode: coachStyle === 'exam' });
      expect(formatRoute(route)).toBe(`#/play?persona=petya&tc=training&color=w&coach=${coachStyle}`);
      expect(parseHash(formatRoute(route))).toEqual(route);
    }
  });

  it('5 minutes keeps the teacher; a style the time control does not offer becomes the default', () => {
    expect(playRouteFor({ timeControlId: 'blitz5', personaId: 'petya', color: 'w', coachStyle: 'teacher', stage: 1 })).toMatchObject({ coachStyle: 'teacher', examMode: false });
    expect(playRouteFor({ timeControlId: 'blitz5', personaId: 'petya', color: 'w', coachStyle: 'teacher' })).toMatchObject({ coachStyle: 'teacher' });
    expect(playRouteFor({ timeControlId: 'bullet1', personaId: 'petya', color: 'w', coachStyle: 'teacher', stage: 1 })).toMatchObject({ coachStyle: 'helper', examMode: false });
  });

  it('never starts a bullet game in exam mode (the coach is silent there anyway)', () => {
    expect(playRouteFor({ timeControlId: 'bullet1', personaId: 'petya', color: 'w', coachStyle: 'exam' })).toMatchObject({ coachStyle: 'helper', examMode: false });
    expect(playRouteFor({ timeControlId: 'bullet1', personaId: 'petya', color: 'w', coachStyle: 'teacher', stage: 1 })).toMatchObject({ coachStyle: 'helper', examMode: false });
  });

  it('steps back color → opponent → time → exit', () => {
    expect(previousStep('color')).toBe('opponent');
    expect(previousStep('opponent')).toBe('time');
    expect(previousStep('time')).toBeNull();
    expect(Object.keys(WIZARD_TITLES)).toEqual(['time', 'opponent', 'color']);
  });
});

describe('«Как помогает Гамбитик?» — coach style tiles (TEACHER-MODE §1.2–§1.3)', () => {
  it('shows three tiles for training, 10 and 5 minutes, none for bullet', () => {
    expect(coachStyleTiles('training').map((tile) => tile.style)).toEqual(['teacher', 'helper', 'exam']);
    expect(coachStyleTiles('rapid10').map((tile) => tile.style)).toEqual(['teacher', 'helper', 'exam']);
    expect(coachStyleTiles('blitz5').map((tile) => tile.style)).toEqual(['teacher', 'helper', 'exam']);
    expect(coachStyleTiles('bullet1')).toEqual([]);
  });

  it('names them for a child: icon, one word, what he does', () => {
    expect(coachStyleTile('teacher')).toMatchObject({ icon: '🎓', title: 'Учитель', subtitle: 'Объясняет каждый ход и показывает хорошие ходы' });
    expect(coachStyleTile('helper')).toMatchObject({ icon: '💡', title: 'Подсказчик', subtitle: 'Помогает, когда попросишь' });
    expect(coachStyleTile('exam')).toMatchObject({ icon: '🏆', title: 'Экзамен' });
    expect(coachStyleTile('exam').subtitle).toContain('Без подсказок');
    for (const style of ['teacher', 'helper', 'exam'] as const) {
      const tile = coachStyleTile(style);
      for (const text of [tile.title, tile.subtitle, tile.hint]) expect(text).not.toMatch(/[A-Za-z]/);
      expect(tile.subtitle.split(/\s+/).length).toBeLessThanOrEqual(7);
      expect(tile.hint.length).toBeLessThan(110);
    }
  });

  it('preselects the stage default of §1.2 when nothing is remembered', () => {
    const empty = createMemoryStorage();
    expect(initialCoachStyle('training', 2, empty, NOW)).toBe('teacher');
    expect(initialCoachStyle('rapid10', 4, empty, NOW)).toBe('teacher');
    // the lesson model (docs/TEACHING.md §2.10): «Учитель» is the default on stages 1–5, «Подсказчик» from stage 6
    expect(initialCoachStyle('rapid10', 5, empty, NOW)).toBe('teacher');
    expect(initialCoachStyle('rapid10', 6, empty, NOW)).toBe('helper');
    expect(initialCoachStyle('training', 7, empty, NOW)).toBe('helper');
    // 5 minutes: «Учитель» preselected there too, up to stage 5
    expect(initialCoachStyle('blitz5', 1, empty, NOW)).toBe('teacher');
    expect(initialCoachStyle('blitz5', 5, empty, NOW)).toBe('teacher');
    expect(initialCoachStyle('blitz5', 6, empty, NOW)).toBe('helper');
    expect(initialCoachStyle('training', 1, null, NOW)).toBe('teacher');
  });

  it('remembers the last choice per time control, as { [tc]: { style, at } }', () => {
    const storage = createMemoryStorage();
    expect(rememberCoachStyle(storage, 'rapid10', 'exam', NOW)).toBe(true);
    expect(rememberCoachStyle(storage, 'training', 'helper', NOW)).toBe(true);
    expect(JSON.parse(storage.data.get(COACH_STYLE_STORAGE_KEY) ?? '{}')).toEqual({
      rapid10: { style: 'exam', at: '2026-09-22T12:00:00.000Z' },
      training: { style: 'helper', at: '2026-09-22T12:00:00.000Z' },
    });
    // a stage-1 child: the remembered choice wins over the teacher default, per time control
    expect(initialCoachStyle('rapid10', 1, storage, NOW + DAY)).toBe('exam');
    expect(initialCoachStyle('training', 1, storage, NOW + DAY)).toBe('helper');
    expect(initialCoachStyle('blitz5', 1, storage, NOW + DAY)).toBe('teacher');
    // choosing again overwrites only that time control
    rememberCoachStyle(storage, 'rapid10', 'teacher', NOW + 2 * DAY);
    expect(rememberedCoachStyle(storage, 'rapid10', NOW + 2 * DAY)).toBe('teacher');
    expect(rememberedCoachStyle(storage, 'training', NOW + 2 * DAY)).toBe('helper');
  });

  it('forgets a choice after 30 days: the stage default knows better then', () => {
    const storage = createMemoryStorage();
    rememberCoachStyle(storage, 'training', 'exam', NOW);
    expect(rememberedCoachStyle(storage, 'training', NOW + COACH_STYLE_MEMORY_MS - 1)).toBe('exam');
    expect(rememberedCoachStyle(storage, 'training', NOW + COACH_STYLE_MEMORY_MS)).toBeNull();
    expect(initialCoachStyle('training', 1, storage, NOW + 31 * DAY)).toBe('teacher');
    expect(initialCoachStyle('training', 6, storage, NOW + 31 * DAY)).toBe('helper');
    // a timestamp from the far future is a broken clock, not a choice
    expect(rememberedCoachStyle(storage, 'training', NOW - 2 * DAY)).toBeNull();
  });

  it('ignores a remembered style the time control does not offer, and never stores one', () => {
    const storage = createMemoryStorage({ [COACH_STYLE_STORAGE_KEY]: JSON.stringify({ bullet1: { style: 'teacher', at: '2026-09-22T11:00:00.000Z' } }) });
    expect(rememberedCoachStyle(storage, 'bullet1', NOW)).toBeNull();
    expect(rememberCoachStyle(storage, 'bullet1', 'helper', NOW)).toBe(false);
    expect(JSON.parse(storage.data.get(COACH_STYLE_STORAGE_KEY) ?? '{}')).toEqual({ bullet1: { style: 'teacher', at: '2026-09-22T11:00:00.000Z' } });
    // a «Подсказчик» remembered for 5 minutes before the teacher came there stays the child's choice
    const blitz = createMemoryStorage({ [COACH_STYLE_STORAGE_KEY]: JSON.stringify({ blitz5: { style: 'helper', at: '2026-09-22T11:00:00.000Z' } }) });
    expect(initialCoachStyle('blitz5', 1, blitz, NOW)).toBe('helper');
  });

  it('survives junk, a numeric timestamp and a throwing localStorage (every read and write in try/catch)', () => {
    for (const raw of ['not json', '[]', '"teacher"', '{"training":"teacher"}', '{"training":{"style":"boss","at":"2026-09-22T11:00:00.000Z"}}', '{"training":{"style":"exam","at":"yesterday"}}', '{"training":{"style":"exam"}}']) {
      const storage = createMemoryStorage({ [COACH_STYLE_STORAGE_KEY]: raw });
      expect(rememberedCoachStyle(storage, 'training', NOW), raw).toBeNull();
      expect(initialCoachStyle('training', 1, storage, NOW), raw).toBe('teacher');
    }
    const numeric = createMemoryStorage({ [COACH_STYLE_STORAGE_KEY]: JSON.stringify({ training: { style: 'exam', at: NOW - DAY } }) });
    expect(rememberedCoachStyle(numeric, 'training', NOW)).toBe('exam');

    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(rememberedCoachStyle(broken, 'training', NOW)).toBeNull();
    expect(initialCoachStyle('training', 1, broken, NOW)).toBe('teacher');
    expect(rememberCoachStyle(broken, 'training', 'exam', NOW)).toBe(false);
    expect(rememberCoachStyle(null, 'training', 'exam', NOW)).toBe(false);
  });

  it('with the stage: a choice equal to the stage default means «follow the default», so the stage-6 default can take over', () => {
    const storage = createMemoryStorage();
    // stage 2 keeps the teacher default: nothing to remember, the next wizard still preselects «Учитель»
    expect(rememberCoachStyle(storage, 'rapid10', 'teacher', NOW, 2)).toBe(true);
    expect(storage.data.has(COACH_STYLE_STORAGE_KEY)).toBe(false);
    expect(initialCoachStyle('rapid10', 2, storage, NOW + DAY)).toBe('teacher');
    // …and when the child reaches stage 6, the §1.2 default «Подсказчик» is preselected (not a stale «Учитель»);
    // stage 5 is still the teacher's (the lesson model, TEACHER_DEFAULT_MAX_STAGE = 5)
    expect(initialCoachStyle('rapid10', 5, storage, NOW + DAY)).toBe('teacher');
    expect(initialCoachStyle('rapid10', 6, storage, NOW + DAY)).toBe('helper');

    // a real deviation is remembered; choosing the default again forgets it
    rememberCoachStyle(storage, 'rapid10', 'exam', NOW, 2);
    rememberCoachStyle(storage, 'training', 'helper', NOW, 2);
    expect(initialCoachStyle('rapid10', 2, storage, NOW + DAY)).toBe('exam');
    expect(rememberCoachStyle(storage, 'rapid10', 'teacher', NOW + DAY, 2)).toBe(true);
    expect(JSON.parse(storage.data.get(COACH_STYLE_STORAGE_KEY) ?? '{}')).toEqual({ training: { style: 'helper', at: '2026-09-22T12:00:00.000Z' } });
    expect(initialCoachStyle('rapid10', 2, storage, NOW + 2 * DAY)).toBe('teacher');
    // an older child who asks for the teacher keeps him
    rememberCoachStyle(storage, 'rapid10', 'teacher', NOW, 6);
    expect(initialCoachStyle('rapid10', 6, storage, NOW + DAY)).toBe('teacher');
  });

  it('keeps foreign entries when writing (read-modify-write)', () => {
    const storage = createMemoryStorage({ [COACH_STYLE_STORAGE_KEY]: JSON.stringify({ rapid10: { style: 'helper', at: '2026-09-20T10:00:00.000Z' }, extra: 1 }) });
    rememberCoachStyle(storage, 'training', 'teacher', NOW);
    expect(JSON.parse(storage.data.get(COACH_STYLE_STORAGE_KEY) ?? '{}')).toEqual({
      rapid10: { style: 'helper', at: '2026-09-20T10:00:00.000Z' },
      extra: 1,
      training: { style: 'teacher', at: '2026-09-22T12:00:00.000Z' },
    });
  });
});

describe('spoken wizard guidance', () => {
  it('is a normal phrase (priority 1), not droppable chatter — for a non-reader the voice is the interface', () => {
    const stylePhrases = (['training', 'rapid10', 'blitz5', 'bullet1'] as const).map((tc) => coachStylePhrase(tc));
    for (const phrase of [timeStepPhrase(), stretchOpponentPhrase('Дима'), ...stylePhrases]) {
      expect(phrase).not.toBeNull();
      if (phrase === null) continue;
      expect(phrase.priority).toBe(1);
      expect(phrase.text).not.toMatch(/[A-Za-z]/);
      expect(phrase.text.length).toBeLessThan(120);
    }
    expect(timeStepPhrase().text).toContain('Сколько будем играть?');
    expect(stretchOpponentPhrase('Дима').text).toContain('Дима играет очень сильно');
  });

  it('offers the teacher on step 3 — in training, 10 and 5 minutes (§1.3)', () => {
    expect(coachStylePhrase('training')?.text).toBe('Хочешь, я буду твоим учителем — показывать хорошие ходы и объяснять? Или подумаешь сам, а я помогу, когда попросишь?');
    expect(coachStylePhrase('rapid10')?.text).toBe(coachStylePhrase('training')?.text);
    expect(coachStylePhrase('blitz5')?.text).toBe(coachStylePhrase('training')?.text);
    // bullet: nothing to choose — he says plainly that he only greets there and where the teacher is
    expect(coachStylePhrase('bullet1').text).toBe(BULLET_COACH_PHRASE);
    expect(BULLET_COACH_PHRASE).toMatch(/только поздороваюсь, а поговорим после партии/);
    expect(BULLET_COACH_PHRASE).toMatch(/на пяти, десяти минутах и без часов/);
    // the stretch phrase does not talk about him
    expect(stretchOpponentPhrase('Дима').text).not.toMatch(/учител/i);
  });

  it('at most one phrase per wizard step, also when the effect runs twice or the child goes back', () => {
    const guard = createStepGuard();
    expect(guard.claim('time')).toBe(true);
    expect(guard.claim('time')).toBe(false); // React StrictMode runs the mount effect twice
    expect(guard.claim('opponent')).toBe(true);
    expect(guard.claim('opponent')).toBe(false); // back → another strong bot: no second speech on the same step
    expect(createStepGuard().claim('time')).toBe(true); // a new wizard starts fresh
  });
});
