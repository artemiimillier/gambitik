import { describe, expect, it } from 'vitest';
import { PERSONA_ORDER, getPersona } from '@gambit/content';
import { createMemoryStorage, sampleGame } from './testUtils.ts';
import { DAY_LOG_STORAGE_KEY, WARMUP_PUZZLES, buildTodayPlan, loadDayLog, localDayKey, markReviewedToday, notePuzzleDoneToday, withName } from './todayPlan.ts';

const NOW = new Date(2026, 8, 21, 16, 0, 0); // local 21 Sep 2026, 16:00
const TODAY_MORNING = new Date(2026, 8, 21, 9, 30, 0).toISOString();
const YESTERDAY = new Date(2026, 8, 20, 18, 0, 0).toISOString();

function suggestedId(plan: ReturnType<typeof buildTodayPlan>): string | undefined {
  return plan.steps.find((step) => step.suggested)?.id;
}

describe('today plan', () => {
  it('on a fresh day suggests the warm-up and never locks anything that can be opened', () => {
    const plan = buildTodayPlan({ now: NOW, games: [], reviewedToday: [], puzzlesToday: 0 });
    expect(plan.steps.map((step) => step.id)).toEqual(['warmup', 'game', 'review']);
    expect(plan.steps.map((step) => step.done)).toEqual([false, false, false]);
    expect(suggestedId(plan)).toBe('warmup');
    expect(plan.steps[1]?.target).toEqual({ name: 'new' });
    expect(plan.steps[2]?.target).toBeNull(); // nothing to review yet
    expect(plan.allDone).toBe(false);
  });

  it('«Три задачи» opens a session of THREE, and is ticked after three puzzles — not after one', () => {
    const fresh = buildTodayPlan({ now: NOW, games: [], reviewedToday: [], puzzlesToday: 0 });
    expect(fresh.steps[0]?.hint).toBe('Три задачи');
    expect(fresh.steps[0]?.target).toEqual({ name: 'puzzles', warmup: true });
    expect(WARMUP_PUZZLES).toBe(3);

    const afterOne = buildTodayPlan({ now: NOW, games: [], reviewedToday: [], puzzlesToday: 1 });
    expect(afterOne.steps[0]?.done).toBe(false);
    expect(afterOne.steps[0]?.hint).toBe('Ещё две задачи');
    expect(suggestedId(afterOne)).toBe('warmup');
    expect(buildTodayPlan({ now: NOW, games: [], reviewedToday: [], puzzlesToday: 2 }).steps[0]?.hint).toBe('Ещё одна задача');

    const afterThree = buildTodayPlan({ now: NOW, games: [], reviewedToday: [], puzzlesToday: 3 });
    expect(afterThree.steps[0]?.done).toBe(true);
    expect(suggestedId(afterThree)).toBe('game');
    expect(buildTodayPlan({ now: NOW, games: [], reviewedToday: [], puzzlesToday: 40 }).steps[0]?.done).toBe(true);
  });

  it('does not count yesterday', () => {
    const games = [sampleGame({ id: 'old', startedAt: YESTERDAY })];
    const plan = buildTodayPlan({ now: NOW, games, reviewedToday: ['old'], puzzlesToday: 0 });
    expect(plan.steps.map((step) => step.done)).toEqual([false, false, false]);
    // an older game can still be opened from the strip, it is just not "the next step"
    expect(plan.steps[2]?.target).toEqual({ name: 'review', gameId: 'old' });
    expect(suggestedId(plan)).toBe('warmup');
  });

  it('after a game today points at its review', () => {
    const games = [sampleGame({ id: 'today', startedAt: TODAY_MORNING }), sampleGame({ id: 'old', startedAt: YESTERDAY })];
    const plan = buildTodayPlan({ now: NOW, games, reviewedToday: [], puzzlesToday: 3 });
    expect(plan.steps.map((step) => step.done)).toEqual([true, true, false]);
    expect(suggestedId(plan)).toBe('review');
    expect(plan.steps[2]?.target).toEqual({ name: 'review', gameId: 'today' });
  });

  it('skipping the warm-up is fine: the plan keeps suggesting, never blocks', () => {
    const games = [sampleGame({ id: 'today', startedAt: TODAY_MORNING })];
    const plan = buildTodayPlan({ now: NOW, games, reviewedToday: ['today'], puzzlesToday: 0 });
    expect(plan.steps.map((step) => step.done)).toEqual([false, true, true]);
    expect(suggestedId(plan)).toBe('warmup');
    expect(plan.steps.every((step) => step.target !== null)).toBe(true);
  });

  it('offers a natural stopping point when everything is done', () => {
    const games = [sampleGame({ id: 'today', startedAt: TODAY_MORNING })];
    const plan = buildTodayPlan({ now: NOW, games, reviewedToday: ['today'], puzzlesToday: 5 });
    expect(plan.allDone).toBe(true);
    expect(suggestedId(plan)).toBeUndefined();
    expect(plan.headline).toContain('завтра');
  });

  it('survives broken dates and a junk puzzle count', () => {
    const plan = buildTodayPlan({ now: NOW, games: [sampleGame({ startedAt: 'not a date' })], reviewedToday: [], puzzlesToday: Number.NaN });
    expect(plan.steps.map((step) => step.done)).toEqual([false, false, false]);
    expect(plan.steps[0]?.hint).toBe('Три задачи');
  });

  it('has at most one suggested step', () => {
    const plan = buildTodayPlan({ now: NOW, games: [sampleGame({ startedAt: TODAY_MORNING })], reviewedToday: [], puzzlesToday: 0 });
    expect(plan.steps.filter((step) => step.suggested)).toHaveLength(1);
  });

  it('names the last game: a game from today in the game step (kindly — a loss only says with whom), an older one in the review step', () => {
    const today = (result: '1-0' | '0-1' | '1/2-1/2' | '*') => sampleGame({ id: 'today', startedAt: TODAY_MORNING, personaId: 'sonya', childColor: 'w', result });
    const old = sampleGame({ id: 'old', startedAt: YESTERDAY, personaId: 'grisha' });
    const hints = (games: ReturnType<typeof sampleGame>[]) => buildTodayPlan({ now: NOW, games, reviewedToday: [], puzzlesToday: 0 }).steps.map((step) => step.hint);
    expect(hints([today('1-0'), old])).toEqual(['Три задачи', 'Победа над Соней!', 'Посмотрим партию вместе']);
    expect(hints([today('1/2-1/2')])[1]).toBe('Ничья с Соней');
    expect(hints([today('0-1')])[1]).toBe('Сыграна с Соней');
    // a game left in the middle is not the day's game
    expect(hints([today('*')])).toEqual(['Три задачи', 'Сыграй с соперником', 'Посмотрим партию вместе']);
    expect(hints([old])).toEqual(['Три задачи', 'Сыграй с соперником', 'Прошлая партия с Гришей']);
    expect(hints([])[2]).toBe('Появится после партии');
  });

  it('after a game today suggests its review, not the warm-up that was skipped', () => {
    const games = [sampleGame({ id: 'today', startedAt: TODAY_MORNING })];
    expect(suggestedId(buildTodayPlan({ now: NOW, games, reviewedToday: [], puzzlesToday: 0 }))).toBe('review');
    expect(suggestedId(buildTodayPlan({ now: NOW, games, reviewedToday: ['today'], puzzlesToday: 0 }))).toBe('warmup');
  });

  it('a second game after a reviewed one waits for its own review', () => {
    const first = sampleGame({ id: 'first', startedAt: TODAY_MORNING });
    const second = sampleGame({ id: 'second', startedAt: new Date(2026, 8, 21, 15, 0, 0).toISOString() });
    const plan = buildTodayPlan({ now: NOW, games: [second, first], reviewedToday: ['first'], puzzlesToday: 3 });
    expect(plan.steps[2]?.target).toEqual({ name: 'review', gameId: 'second' });
    expect(plan.steps[2]?.done).toBe(false);
    expect(suggestedId(plan)).toBe('review');
    expect(plan.allDone).toBe(false);
  });
});

describe('withName', () => {
  it('declines every opponent of the app: «Партия с Петей»', () => {
    const names = PERSONA_ORDER.map((id) => getPersona(id)?.name ?? '');
    expect(names.map(withName)).toEqual(['Петей', 'Соней', 'Гришей', 'Сашей', 'Викой', 'Лёвой', 'Никой', 'Димой']);
  });

  it('keeps a name it cannot decline', () => {
    expect(withName('Лев')).toBe('Лев');
    expect(withName('')).toBe('');
  });
});

describe('day log', () => {
  it('formats the local day', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('remembers the reviews opened today and forgets yesterday', () => {
    const storage = createMemoryStorage();
    expect(loadDayLog(storage, NOW)).toEqual({ day: '2026-09-21', reviewed: [], puzzles: 0 });

    markReviewedToday(storage, 'a', NOW);
    markReviewedToday(storage, 'a', NOW);
    expect(markReviewedToday(storage, 'b', NOW).reviewed).toEqual(['a', 'b']);
    expect(loadDayLog(storage, NOW).reviewed).toEqual(['a', 'b']);

    const tomorrow = new Date(2026, 8, 22, 8, 0, 0);
    expect(loadDayLog(storage, tomorrow)).toEqual({ day: '2026-09-22', reviewed: [], puzzles: 0 });
    expect(markReviewedToday(storage, 'c', tomorrow).reviewed).toEqual(['c']);
  });

  it('counts the puzzles finished today next to the reviews, and starts from zero tomorrow', () => {
    const storage = createMemoryStorage();
    markReviewedToday(storage, 'a', NOW);
    expect(notePuzzleDoneToday(storage, NOW).puzzles).toBe(1);
    expect(notePuzzleDoneToday(storage, NOW).puzzles).toBe(2);
    expect(loadDayLog(storage, NOW)).toEqual({ day: '2026-09-21', reviewed: ['a'], puzzles: 2 });
    expect(markReviewedToday(storage, 'b', NOW)).toEqual({ day: '2026-09-21', reviewed: ['a', 'b'], puzzles: 2 });

    const tomorrow = new Date(2026, 8, 22, 8, 0, 0);
    expect(notePuzzleDoneToday(storage, tomorrow)).toEqual({ day: '2026-09-22', reviewed: [], puzzles: 1 });
    expect(notePuzzleDoneToday(null, NOW).puzzles).toBe(1);
  });

  it('tolerates junk in storage and a missing storage', () => {
    const storage = createMemoryStorage({ [DAY_LOG_STORAGE_KEY]: JSON.stringify({ day: '2026-09-21', reviewed: ['ok', 7, null], puzzles: -4 }) });
    expect(loadDayLog(storage, NOW)).toEqual({ day: '2026-09-21', reviewed: ['ok'], puzzles: 0 });
    expect(loadDayLog(createMemoryStorage({ [DAY_LOG_STORAGE_KEY]: JSON.stringify({ day: '2026-09-21', puzzles: 2 }) }), NOW)).toEqual({ day: '2026-09-21', reviewed: [], puzzles: 2 });
    expect(loadDayLog(createMemoryStorage({ [DAY_LOG_STORAGE_KEY]: '{broken' }), NOW).reviewed).toEqual([]);
    expect(markReviewedToday(null, 'x', NOW).reviewed).toEqual(['x']);
  });
});
