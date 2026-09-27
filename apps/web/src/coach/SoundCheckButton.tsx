/**
 * <SoundCheckButton/> — the parent's two free checks in Settings, the two halves of «я его не слышу, и он меня тоже»:
 *  - «Проверить звук» plays the chime of ./soundCheck.ts through a hidden <audio> element (the same output path as the
 *    coach's voice) and says in plain Russian whether it played;
 *  - «Проверить микрофон» listens for ~3 s with the voice session's own microphone settings, shows the
 *    loudness on a bar and says «Я тебя слышу ✓» — or what to fix. Measured in this page only, no paid call.
 * Hidden under automation (silent runs make no sound and never open a microphone).
 */
import { useCallback, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { automationSilenced, isAutomatedBrowser } from '../automation.ts';
import { Button } from '../ui/index.ts';
import { checkMicrophone, MIC_CHECK_MS, playSoundCheck } from './soundCheck.ts';
import type { MicCheckResult, SoundCheckResult } from './soundCheck.ts';

export const SOUND_CHECK_TITLE = 'Проверить звук';
export const SOUND_CHECK_HINT = 'Сыграет короткую мелодию тем же способом, каким говорит Гамбитик. Микрофон не нужен, это бесплатно.';
export const MIC_CHECK_TITLE = 'Проверить микрофон';
export const MIC_CHECK_HINT = `Скажите что-нибудь — ${Math.round(MIC_CHECK_MS / 1000)} секунды полоска показывает громкость. Проверка идёт только на этом компьютере, это бесплатно.`;
export const MIC_HEARD_TEXT = 'Я тебя слышу ✓ Микрофон работает — Гамбитик услышит ребёнка.';

/** the parent-facing sentence for a check result */
export function soundCheckMessage(result: SoundCheckResult | 'playing'): string {
  if (result === 'playing') return 'Играет короткая мелодия…';
  if (result.ok) {
    return 'Мелодия проиграна. Если её не было слышно — прибавьте громкость Mac и проверьте, не выключен ли звук у вкладки Chrome (значок динамика на вкладке) и в настройках сайта.';
  }
  if (result.code === 'NotAllowedError') return 'Браузер не дал включить звук. Нажмите кнопку ещё раз; если не поможет — разрешите звук для этого сайта в настройках Chrome.';
  if (result.code === 'unsupported') return 'Этот браузер не умеет проигрывать проверочный звук.';
  return `Звук не проигрался (${result.code}). Проверьте громкость и устройство вывода звука на Mac.`;
}

/** the parent-facing sentence for a microphone check (`heardSoFar`: a voice already arrived while it still listens) */
export function micCheckMessage(result: MicCheckResult | 'listening', heardSoFar = false): string {
  if (result === 'listening') return heardSoFar ? MIC_HEARD_TEXT : 'Говорите что-нибудь… слушаю.';
  if (result.ok) return MIC_HEARD_TEXT;
  switch (result.code) {
    case 'quiet':
      return 'Микрофон включился, но голоса почти не слышно. Проверьте, какой микрофон выбран: значок камеры в адресной строке Chrome и «Системные настройки → Звук → Вход» на Mac.';
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Браузер не дал микрофон. Нажмите на значок слева от адреса страницы, разрешите микрофон — и проверьте ещё раз.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Микрофон не найден. Подключите его или выберите в «Системные настройки → Звук → Вход».';
    case 'NotReadableError':
    case 'AbortError':
      return 'Микрофон занят другой программой (например, Zoom или FaceTime). Закройте её и проверьте ещё раз.';
    case 'unsupported':
      return 'Здесь браузер не даёт микрофон. Откройте Гамбитика в Chrome или Safari по адресу localhost.';
    default:
      return `Микрофон не проверился (${result.code}). Попробуйте ещё раз.`;
  }
}

type Tone = 'info' | 'ok' | 'warn';

const noteStyle = { marginTop: 'var(--space-2)', fontSize: 'var(--text-sm)', lineHeight: 1.4 } as const;

export function SoundCheckButton(): ReactElement | null {
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState<Tone>('info');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const [micMessage, setMicMessage] = useState('');
  const [micTone, setMicTone] = useState<Tone>('info');
  const [micBusy, setMicBusy] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const micBusyRef = useRef(false);

  const onClick = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setTone('info');
    setMessage(soundCheckMessage('playing'));
    // play() runs inside this click (the autoplay policy): playSoundCheck calls it synchronously up to its first await
    void playSoundCheck()
      .then(
        (result) => {
          setTone(result.ok ? 'ok' : 'warn');
          setMessage(soundCheckMessage(result));
        },
        () => {
          setTone('warn');
          setMessage(soundCheckMessage({ ok: false, code: 'error', ms: 0 }));
        },
      )
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }, []);

  const onMicClick = useCallback(() => {
    // automation never opens a microphone (the button is not even rendered there — a second lock)
    if (micBusyRef.current || isAutomatedBrowser()) return;
    micBusyRef.current = true;
    setMicBusy(true);
    setMicTone('info');
    setMicLevel(0);
    setMicMessage(micCheckMessage('listening'));
    let heardShown = false;
    void checkMicrophone({
      onLevel: (level, heard) => {
        setMicLevel(level);
        if (heard && !heardShown) {
          heardShown = true;
          setMicTone('ok');
          setMicMessage(micCheckMessage('listening', true));
        }
      },
    })
      .then((result) => {
        setMicTone(result.ok ? 'ok' : 'warn');
        setMicMessage(micCheckMessage(result));
      })
      .finally(() => {
        micBusyRef.current = false;
        setMicBusy(false);
        setMicLevel(0);
      });
  }, []);

  if (automationSilenced() || isAutomatedBrowser()) return null;
  return (
    <div data-sound-check="">
      <Button variant="secondary" onClick={onClick} loading={busy} sound={false}>
        {SOUND_CHECK_TITLE}
      </Button>
      <p data-tone={tone} role="status" aria-live="polite" style={noteStyle}>
        {message === '' ? SOUND_CHECK_HINT : message}
      </p>

      <div data-mic-check="" style={{ marginTop: 'var(--space-3)' }}>
        <Button variant="secondary" onClick={onMicClick} loading={micBusy} sound={false}>
          {MIC_CHECK_TITLE}
        </Button>
        {micBusy ? (
          <div
            role="meter"
            aria-label="Громкость микрофона"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(micLevel * 100)}
            style={{ marginTop: 'var(--space-2)', height: 12, maxWidth: 320, borderRadius: 'var(--radius-pill)', background: '#efe5d0', overflow: 'hidden' }}
          >
            {/* a live meter: no easing (the progress bar's 500 ms would lag behind the voice) */}
            <div style={{ width: `${Math.round(micLevel * 100)}%`, height: '100%', borderRadius: 'var(--radius-pill)', background: 'var(--color-success)' }} />
          </div>
        ) : null}
        <p data-tone={micTone} role="status" aria-live="polite" style={noteStyle}>
          {micMessage === '' ? MIC_CHECK_HINT : micMessage}
        </p>
      </div>
    </div>
  );
}
