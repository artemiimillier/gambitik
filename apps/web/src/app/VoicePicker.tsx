/**
 * «Каким голосом говорит Гамбитик» — the parent's pick of the voice (Settings, behind the parental lock).
 *
 * The .env default `marin` is an adult woman, Гамбитик is a boy foal and needs a young, childlike voice.
 * The list comes from the server (GET /api/voice/voices — the built-in voices of gpt-live-1 / gpt-realtime-2.x, never
 * fetched from OpenAI); the pick is stored there (PUT) and used by every new paid session. «Послушать» says ONE short,
 * PAID line in that voice — the button says so, and it is never offered to an automated browser.
 * A dumb component: loading, saving and the preview itself live in Settings.tsx (tested here by a server render).
 */
import type { ReactElement } from 'react';
import type { VoiceChoiceInfo, VoiceOption } from '../coach/liveApi.ts';
import { previewKindFor, VOICE_PREVIEW_COST_RU, voiceButtonLabel } from '../coach/voicePreview.ts';
import type { OpenAiVoiceKind } from '../coach/voiceTypes.ts';
import { Button } from '../ui/index.ts';
import styles from './Settings.module.css';

export type VoicePickerNote = { tone: 'ok' | 'info' | 'warn'; text: string } | null;

const WRAPPING_BUTTON = { whiteSpace: 'normal', maxWidth: '100%' } as const;

/** instead of «Послушать» once the paid voice of the day is used up (the preview is paid too) */
export const VOICE_PREVIEW_LIMIT_RU = 'Дневной лимит голоса исчерпан, а «Послушать» тоже платное: послушать можно будет завтра или после увеличения лимита.';

/** the voice Гамбитик speaks with now (the pick, else the server's default) and the model «Послушать» would use */
export function voicePickerView(
  choice: VoiceChoiceInfo,
  server: { live: boolean; realtime: boolean },
): { chosen: string; option: VoiceOption; isDefault: boolean; previewKind: OpenAiVoiceKind | null } {
  const chosen = choice.selected ?? choice.live;
  const option = choice.voices.find((voice) => voice.id === chosen) ?? { id: chosen, live: true, realtime: choice.realtime === chosen };
  return { chosen, option, isDefault: choice.selected === null, previewKind: previewKindFor(option, server) };
}

export interface VoicePickerProps {
  /** null = not loaded (offline, an older server) */
  choice: VoiceChoiceInfo | null;
  serverOnline: boolean;
  /** which paid models the server has now (/api/health `voice.live` / `voice.realtime`) */
  server: { live: boolean; realtime: boolean };
  /** an automated browser: no «Послушать» at all (silent, free) */
  automated: boolean;
  /** the paid voice of the day is used up (coachStore `voiceLimitReached`): no «Послушать», the limit line instead */
  limitReached?: boolean;
  previewing: boolean;
  note: VoicePickerNote;
  onChoose(voice: string | null): void;
  onPreview(): void;
}

export function VoicePicker({ choice, serverOnline, server, automated, limitReached = false, previewing, note, onChoose, onPreview }: VoicePickerProps): ReactElement {
  if (choice === null) {
    return <p className={styles.help}>{serverOnline ? 'Выбор голоса появится, когда сервер ответит.' : 'Голос можно выбрать, когда сервер работает.'}</p>;
  }
  const { chosen, isDefault, previewKind } = voicePickerView(choice, { live: serverOnline && server.live, realtime: serverOnline && server.realtime });
  const canPreview = previewKind !== null && !automated && !limitReached;
  return (
    <div data-voice-picker="">
      <p className={styles.help}>
        Встроенные голоса OpenAI. Детских и русских среди них нет, пометки — по описанию OpenAI, на слух их никто не проверял: послушайте несколько и выберите тот,
        что больше нравится ребёнку. Сейчас: {chosen}
        {isDefault ? ' (по умолчанию)' : ''}.
      </p>
      <div className={styles.scaleRow} role="radiogroup" aria-label="Голос Гамбитика">
        {choice.voices.map((option) => (
          <Button
            key={option.id}
            variant={chosen === option.id ? 'primary' : 'secondary'}
            role="radio"
            aria-checked={chosen === option.id}
            onClick={() => onChoose(option.id)}
            // a long note wraps inside its button on a phone instead of widening the whole page
            style={WRAPPING_BUTTON}
          >
            {voiceButtonLabel(option)}
          </Button>
        ))}
      </div>
      {!isDefault ? (
        <p className={styles.help}>
          <button type="button" className={styles.linkButton} onClick={() => onChoose(null)}>
            Вернуть голос по умолчанию ({choice.defaults.live})
          </button>
        </p>
      ) : null}
      {canPreview ? (
        <div className={styles.stack}>
          <div>
            <Button variant="secondary" onClick={onPreview} loading={previewing} sound={false} data-voice-preview="">
              Послушать голос {chosen}
            </Button>
            <p className={styles.help}>{VOICE_PREVIEW_COST_RU}</p>
          </div>
        </div>
      ) : previewKind !== null && !automated && limitReached ? (
        <p className={styles.help} data-voice-preview-limit="">
          {VOICE_PREVIEW_LIMIT_RU}
        </p>
      ) : null}
      {note ? (
        <p className={styles.saveNote} data-tone={note.tone} role="status">
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
