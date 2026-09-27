/**
 * First-run onboarding — pure state logic (the component is Onboarding.tsx).
 *
 *   'name'    «Как тебя зовут?»            nickname (a pseudonym, never the full name)
 *   'address' «Ты мальчик или девочка?»    → StudentProfile.address, needed only for Russian verb endings
 *   'welcome' Гамбитик waves and greets    → the app opens the home screen
 */
import type { StudentProfile } from '@gambit/shared';

/** What the server puts into a brand-new profile (apps/server defaultProfile). */
export const DEFAULT_NICKNAME = 'Шахматист';
/** Mirrors the server's PUT /student validation. */
export const NICKNAME_MAX_LENGTH = 24;

export type Address = StudentProfile['address'];
export type OnboardingStep = 'name' | 'address' | 'welcome';
export type NicknameProblem = 'empty' | 'tooLong' | 'badChars';

export interface OnboardingState {
  step: OnboardingStep;
  /** raw text of the input */
  nicknameInput: string;
  /** validated nickname, set when the name step was passed */
  nickname: string | null;
  address: Address | null;
  problem: NicknameProblem | null;
}

export type OnboardingAction =
  | { type: 'typeNickname'; value: string }
  | { type: 'submitNickname' }
  | { type: 'chooseAddress'; address: Address }
  /** the server refused the nickname after all — ask again, gently */
  | { type: 'nicknameRejected' }
  | { type: 'back' };

export type NicknameCheck = { ok: true; value: string } | { ok: false; problem: NicknameProblem };

// The server refuses markup and control characters in a pseudonym: < > \\ | ` and U+0000..U+001F.
const FORBIDDEN_NICKNAME_PUNCTUATION = '<>|`' + String.fromCharCode(92);

function hasForbiddenChar(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127 || FORBIDDEN_NICKNAME_PUNCTUATION.includes(char)) return true;
  }
  return false;
}

/** Trims and collapses inner whitespace; does not drop or replace any visible character. */
export function normalizeNickname(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function checkNickname(raw: string): NicknameCheck {
  // test the raw text too: a tab or a newline must not silently become a space
  if (hasForbiddenChar(raw.trim())) return { ok: false, problem: 'badChars' };
  const value = normalizeNickname(raw);
  if (value === '') return { ok: false, problem: 'empty' };
  // the server counts UTF-16 code units (zod `.max`), so do the same here
  if (value.length > NICKNAME_MAX_LENGTH) return { ok: false, problem: 'tooLong' };
  return { ok: true, value };
}

/** Warm, never blaming. */
export function nicknameProblemRu(problem: NicknameProblem): string {
  switch (problem) {
    case 'empty':
      return 'Напиши, как тебя называть, — хватит и прозвища.';
    case 'tooLong':
      return 'Получилось длинновато. Давай покороче — до 24 букв.';
    case 'badChars':
      return 'Давай без значков вроде < > | — только буквы и цифры.';
  }
}

/**
 * First run = the profile still carries no chosen name. A brand-new server profile is pre-filled
 * with «Шахматист», so that value only counts as "chosen" once onboarding was finished on this
 * computer (`onboardedFlag`, kept in localStorage).
 */
export function needsOnboarding(profile: Pick<StudentProfile, 'nickname'> | null, onboardedFlag: boolean): boolean {
  if (profile === null) return !onboardedFlag;
  const nickname = profile.nickname.trim();
  if (nickname === '') return true;
  return nickname === DEFAULT_NICKNAME && !onboardedFlag;
}

export function initialOnboardingState(profile: Pick<StudentProfile, 'nickname' | 'address'> | null): OnboardingState {
  const known = profile?.nickname.trim() ?? '';
  return {
    step: 'name',
    // never pre-fill the placeholder pseudonym — the child should see an empty, inviting field
    nicknameInput: known === DEFAULT_NICKNAME ? '' : known,
    nickname: null,
    address: null,
    problem: null,
  };
}

export function onboardingReducer(state: OnboardingState, action: OnboardingAction): OnboardingState {
  switch (action.type) {
    case 'typeNickname':
      if (state.step !== 'name') return state;
      // the hint disappears as soon as the child keeps typing
      return { ...state, nicknameInput: action.value, problem: null };

    case 'submitNickname': {
      if (state.step !== 'name') return state;
      const check = checkNickname(state.nicknameInput);
      if (!check.ok) return { ...state, problem: check.problem };
      return { ...state, step: 'address', nickname: check.value, nicknameInput: check.value, problem: null };
    }

    case 'chooseAddress':
      if (state.step !== 'address' || state.nickname === null) return state;
      return { ...state, step: 'welcome', address: action.address };

    case 'nicknameRejected':
      return { ...state, step: 'name', nickname: null, address: null, problem: 'badChars' };

    case 'back':
      if (state.step === 'address') return { ...state, step: 'name', problem: null };
      if (state.step === 'welcome') return { ...state, step: 'address' };
      return state;
  }
}

/** The PUT /student body once both questions are answered; null before that. */
export function onboardingResult(state: OnboardingState): { nickname: string; address: Address } | null {
  if (state.nickname === null || state.address === null) return null;
  return { nickname: state.nickname, address: state.address };
}
