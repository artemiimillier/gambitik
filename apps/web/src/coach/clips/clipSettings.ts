/**
 * The parent's side of «Записи» (docs/voice-clips/SPEC.md §8.1): the voice choice in Settings (behind the parental
 * lock), the library line («1 240 фраз, версия 3; прошлая партия: 96 % записями»), the free «Послушать». Pure texts;
 * Settings.tsx renders them.
 */
import type { CoachEvent } from '@gambit/shared';
import type { ClipLibraryStatus } from '../voiceTypes.ts';
import { clipLibraryLineRu } from '../voiceStatus.ts';
import { recordedPercent } from './clipMemory.ts';
import type { StoredClipStats } from './clipMemory.ts';

/** The voice choice (SPEC §8.1: first, recommended once the library is accepted; the default stays as today). */
export const CLIPS_VOICE_OPTION = {
  id: 'clips',
  title: 'Записанный голос — бесплатно, без микрофона',
  subtitle: 'Живой голос Giselle, фразы записаны заранее. Без интернета и без трат',
} as const;

export interface ClipsStatusInput {
  /** the voice speaking now */
  voiceKind: string;
  /** the parent's choice */
  preference: string;
  library: ClipLibraryStatus | null;
  lastGame: StoredClipStats | null;
  muted?: boolean;
}

/** What Settings says about the recorded voice; null when it is neither chosen nor speaking. */
export function describeClipsVoice(input: ClipsStatusInput): { tone: 'ok' | 'info' | 'warn'; summary: string; details: string[] } | null {
  if (input.preference !== 'clips' && input.voiceKind !== 'clips') return null;
  const details: string[] = [];
  if (input.library) details.push(`В библиотеке ${clipLibraryLineRu(input.library)}.`);
  const pct = recordedPercent(input.lastGame);
  if (pct !== null && input.lastGame) {
    details.push(`Прошлая партия: ${pct} % фраз прозвучали записями как есть, остальное — общими фразами (точный ход всегда в облачке и стрелкой).`);
  }
  details.push('Микрофон не нужен: ребёнок спрашивает кнопкой «Спроси» у Гамбитика. Нажатие на Гамбитика, пока он говорит, останавливает его.');
  details.push('В партии звучат только готовые записи с этого компьютера.');
  if (input.voiceKind === 'clips') {
    return { tone: input.muted ? 'info' : 'ok', summary: input.muted ? 'Записанный голос выбран, но приглушён кнопкой с динамиком.' : 'Сейчас говорит записанный голос — бесплатно и без микрофона.', details };
  }
  // chosen, but the layer fell to silent: no library in this build (or it failed to load)
  return {
    tone: 'warn',
    summary: 'Записанный голос выбран, но библиотека записей не загрузилась — пока Гамбитик пишет в облачке.',
    details: ['Записи появятся после того, как их запишут и положат в папку приложения (apps/web/public/voice). Проверьте позже или выберите другой голос.', ...details.slice(-2)],
  };
}

/** «Послушать»: one short recorded line (free, local). Never offered to an automated browser. */
export function clipPreviewEvent(seq: number = Date.now()): CoachEvent {
  const text = 'Привет! Я Гамбитик. Давай играть в шахматы!';
  return {
    id: `clip-preview-${seq}`,
    kind: 'greeting',
    priority: 1,
    text,
    bubbleText: text,
    pose: 'wave',
    pauseClock: false,
    clip: { sentences: [{ items: [{ line: 'preview' }], prio: 100, end: '!' }], generic: 'generic.greeting', bark: 'wave' },
  };
}
