import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NICKNAME,
  NICKNAME_MAX_LENGTH,
  checkNickname,
  initialOnboardingState,
  needsOnboarding,
  nicknameProblemRu,
  normalizeNickname,
  onboardingReducer,
  onboardingResult,
} from './onboarding.ts';
import type { OnboardingAction, OnboardingState } from './onboarding.ts';

function run(state: OnboardingState, ...actions: OnboardingAction[]): OnboardingState {
  return actions.reduce(onboardingReducer, state);
}

describe('needsOnboarding', () => {
  it('asks on the very first run: the server pre-fills «Шахматист» and nothing was finished here', () => {
    expect(needsOnboarding({ nickname: DEFAULT_NICKNAME }, false)).toBe(true);
  });

  it('asks whenever the nickname is empty, even if the flag says otherwise', () => {
    expect(needsOnboarding({ nickname: '' }, true)).toBe(true);
    expect(needsOnboarding({ nickname: '   ' }, false)).toBe(true);
  });

  it('does not ask again once a real name is known (e.g. localStorage was cleared)', () => {
    expect(needsOnboarding({ nickname: 'Тигр' }, false)).toBe(false);
    expect(needsOnboarding({ nickname: 'Тигр' }, true)).toBe(false);
  });

  it('respects a child who really wants to be called «Шахматист»', () => {
    expect(needsOnboarding({ nickname: DEFAULT_NICKNAME }, true)).toBe(false);
  });

  it('without any profile decides by the local flag', () => {
    expect(needsOnboarding(null, false)).toBe(true);
    expect(needsOnboarding(null, true)).toBe(false);
  });
});

describe('nickname check', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeNickname('  Маша   Пешка ')).toBe('Маша Пешка');
    expect(checkNickname('  Тигр ')).toEqual({ ok: true, value: 'Тигр' });
    expect(checkNickname('Super Knight 7')).toEqual({ ok: true, value: 'Super Knight 7' });
  });

  it('refuses an empty name', () => {
    expect(checkNickname('')).toEqual({ ok: false, problem: 'empty' });
    expect(checkNickname('    ')).toEqual({ ok: false, problem: 'empty' });
  });

  it('mirrors the server limit of 24 characters', () => {
    expect(checkNickname('я'.repeat(NICKNAME_MAX_LENGTH)).ok).toBe(true);
    expect(checkNickname('я'.repeat(NICKNAME_MAX_LENGTH + 1))).toEqual({ ok: false, problem: 'tooLong' });
  });

  it('refuses the characters the server refuses: markup, backslash, pipe, backtick, control characters', () => {
    for (const bad of ['<b>Тигр', 'Тигр>', 'Ти\\гр', 'Ти|гр', 'Ти`гр', `Ти${String.fromCharCode(9)}гр`, `Ти${String.fromCharCode(10)}гр`, `Ти${String.fromCharCode(0)}гр`, `Ти${String.fromCharCode(127)}гр`]) {
      expect(checkNickname(bad), JSON.stringify(bad)).toEqual({ ok: false, problem: 'badChars' });
    }
  });

  it('keeps friendly punctuation, digits, Latin letters and emoji', () => {
    for (const fine of ['Тигр-7', 'Анна-Мария', "Д'Артаньян", 'Max', 'Ёжик!', 'Лев 🦁']) {
      expect(checkNickname(fine).ok, fine).toBe(true);
    }
  });

  it('explains every problem warmly, without blaming words', () => {
    for (const problem of ['empty', 'tooLong', 'badChars'] as const) {
      const text = nicknameProblemRu(problem);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/ошибк|неправильн|нельзя|плохо/i);
    }
  });
});

describe('onboarding reducer', () => {
  const start = initialOnboardingState({ nickname: DEFAULT_NICKNAME, address: 'm' });

  it('starts on the name step with an empty, inviting field', () => {
    expect(start).toEqual({ step: 'name', nicknameInput: '', nickname: null, address: null, problem: null });
    expect(initialOnboardingState(null).nicknameInput).toBe('');
    expect(initialOnboardingState({ nickname: ' Лиса ', address: 'f' }).nicknameInput).toBe('Лиса');
  });

  it('walks name → address → welcome', () => {
    const named = run(start, { type: 'typeNickname', value: '  Тигр ' }, { type: 'submitNickname' });
    expect(named.step).toBe('address');
    expect(named.nickname).toBe('Тигр');
    expect(named.nicknameInput).toBe('Тигр');
    expect(onboardingResult(named)).toBeNull();

    const done = run(named, { type: 'chooseAddress', address: 'f' });
    expect(done.step).toBe('welcome');
    expect(onboardingResult(done)).toEqual({ nickname: 'Тигр', address: 'f' });
  });

  it('stays on the name step with a gentle hint when the name is not usable', () => {
    const empty = run(start, { type: 'submitNickname' });
    expect(empty.step).toBe('name');
    expect(empty.problem).toBe('empty');

    const retyped = run(empty, { type: 'typeNickname', value: 'Т' });
    expect(retyped.problem).toBeNull();

    const tooLong = run(start, { type: 'typeNickname', value: 'а'.repeat(40) }, { type: 'submitNickname' });
    expect(tooLong).toMatchObject({ step: 'name', problem: 'tooLong', nickname: null });

    const markup = run(start, { type: 'typeNickname', value: '<img>' }, { type: 'submitNickname' });
    expect(markup).toMatchObject({ step: 'name', problem: 'badChars' });
  });

  it('goes back one step at a time and keeps what was typed', () => {
    const atAddress = run(start, { type: 'typeNickname', value: 'Тигр' }, { type: 'submitNickname' });
    const backToName = run(atAddress, { type: 'back' });
    expect(backToName).toMatchObject({ step: 'name', nicknameInput: 'Тигр' });
    expect(run(backToName, { type: 'back' })).toBe(backToName);

    const atWelcome = run(atAddress, { type: 'chooseAddress', address: 'm' });
    expect(run(atWelcome, { type: 'back' }).step).toBe('address');
  });

  it('ignores actions that do not belong to the current step', () => {
    expect(run(start, { type: 'chooseAddress', address: 'm' })).toBe(start);
    const atAddress = run(start, { type: 'typeNickname', value: 'Тигр' }, { type: 'submitNickname' });
    expect(run(atAddress, { type: 'typeNickname', value: 'Лев' })).toBe(atAddress);
    expect(run(atAddress, { type: 'submitNickname' })).toBe(atAddress);
  });

  it('returns to the name question when the server refuses the nickname after all', () => {
    const atAddress = run(start, { type: 'typeNickname', value: 'Тигр' }, { type: 'submitNickname' });
    const rejected = run(atAddress, { type: 'nicknameRejected' });
    expect(rejected).toMatchObject({ step: 'name', nickname: null, address: null, problem: 'badChars', nicknameInput: 'Тигр' });
    expect(onboardingResult(rejected)).toBeNull();
  });
});
