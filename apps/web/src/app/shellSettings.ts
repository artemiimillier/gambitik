/**
 * Shell part of the app settings. They share the `gambit.settings` localStorage object with the
 * coach module (voice, muted), so every write is read-modify-write and foreign fields survive.
 */
import { SETTINGS_STORAGE_KEY } from '../coach/settings.ts';
import { BOARD_THEMES, DEFAULT_BOARD_THEME_ID } from '../ui/boardTheme.ts';
import type { BoardThemeId } from '../ui/boardTheme.ts';

export type FontScale = 1 | 1.15 | 1.3;
export const FONT_SCALES: readonly FontScale[] = [1, 1.15, 1.3];

export interface ShellSettings {
  /** onboarding was finished on this computer */
  onboarded: boolean;
  /** parent setting 100 / 115 / 130 % → the --font-scale token */
  fontScale: FontScale;
  /** true = «меньше анимации»; null = follow the operating system */
  reducedMotion: boolean | null;
  /** colours of the game board (GameScreen reads this key) */
  boardTheme: BoardThemeId;
}

export const DEFAULT_SHELL_SETTINGS: ShellSettings = { onboarded: false, fontScale: 1, reducedMotion: null, boardTheme: DEFAULT_BOARD_THEME_ID };

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * localStorage can throw (private mode) — treat that as "no storage".
 * `window` is checked first: Node 26 has an experimental global localStorage that warns when touched (unit tests).
 */
export function getBrowserStorage(): KeyValueStorage | null {
  try {
    return typeof window === 'undefined' || typeof window.localStorage === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readJsonObject(storage: KeyValueStorage | null, key: string): Record<string, unknown> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function writeJson(storage: KeyValueStorage | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // quota / private mode: the value simply does not persist
  }
}

export function isBoardThemeId(value: unknown): value is BoardThemeId {
  return typeof value === 'string' && Object.hasOwn(BOARD_THEMES, value);
}

function isFontScale(value: unknown): value is FontScale {
  return FONT_SCALES.some((scale) => scale === value);
}

export function loadShellSettings(storage: KeyValueStorage | null): ShellSettings {
  const raw = readJsonObject(storage, SETTINGS_STORAGE_KEY);
  return {
    onboarded: raw.onboarded === true,
    fontScale: isFontScale(raw.fontScale) ? raw.fontScale : DEFAULT_SHELL_SETTINGS.fontScale,
    reducedMotion: typeof raw.reducedMotion === 'boolean' ? raw.reducedMotion : null,
    boardTheme: isBoardThemeId(raw.boardTheme) ? raw.boardTheme : DEFAULT_SHELL_SETTINGS.boardTheme,
  };
}

export function saveShellSettings(storage: KeyValueStorage | null, patch: Partial<ShellSettings>): void {
  writeJson(storage, SETTINGS_STORAGE_KEY, { ...readJsonObject(storage, SETTINGS_STORAGE_KEY), ...patch });
}

/** Applies the parent's font-size choice to the ui-kit token on <html>. */
export function applyFontScale(scale: FontScale, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!root) return;
  if (scale === 1) root.style.removeProperty('--font-scale');
  else root.style.setProperty('--font-scale', String(scale));
}
