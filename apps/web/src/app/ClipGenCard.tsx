/**
 * «Дозапись новых фраз» — the parent's card for recording missing lesson phrases (docs/voice-clips/ONDEMAND.md; Settings is behind the
 * parent gate already). Recording costs Higgsfield credits, so:
 *  - the card shows only when this server can record (`health.clipGen` present and not 'off' in `.env`), never in an
 *    automated browser (`clipGenCardVisible`);
 *  - the switch is off by default and goes on only after the confirmation with the price and the day's cap;
 *  - the daily cap is one of 3 / 6 / 10 / 15 credits, only up to the server's maximum (the server clamps it anyway),
 *    plus that maximum and the cap in force when they are none of those — the pressed button is the cap really spent up to;
 *  - it says so when the recorded voice does not speak here (another voice, the sound off): then nothing is recorded;
 *  - it shows today's and the total spend, what was recorded, queued and refused, that the balance is not checked, and
 *    why recording pauses — in plain Russian (./healthText.ts).
 * Everything is read from and written to the local server (GET /voice/clips/status, PUT /voice/clips/settings).
 */
import { useEffect, useState } from 'react';
import type { ClipGenSettings, ClipGenStatus, HealthInfo } from '@gambit/shared';
import { getClipGenStatus, saveClipGenSettings } from '../api/client.ts';
import { isAutomatedBrowser } from '../automation.ts';
import { Button, Card, Modal } from '../ui/index.ts';
import { clipGenCapChoices, clipGenCardVisible, clipGenConfirmText, describeClipGen, formatCreditsRu } from './healthText.ts';
import styles from './Settings.module.css';
import shell from './shell.module.css';
import { Toggle } from './Toggle.tsx';

export interface ClipGenCardApi {
  status(): Promise<ClipGenStatus>;
  save(settings: ClipGenSettings): Promise<ClipGenStatus>;
}

export interface ClipGenCardProps {
  health: HealthInfo | null;
  serverOnline: boolean;
  /** tests: the routes (the app: the typed client) */
  api?: ClipGenCardApi;
  /** tests: a status already loaded (the app asks the server when the card appears) */
  initialStatus?: ClipGenStatus | null;
  /** tests: default `isAutomatedBrowser()` */
  automated?: boolean;
  /** tests: the clock for «до 14:30» */
  now?: () => number;
  /** the recorded voice speaks in this browser now (false: another voice or the sound off — nothing is recorded) */
  clipsVoice?: boolean | null;
}

type Note = { tone: 'ok' | 'info' | 'warn'; text: string } | null;

const DEFAULT_API: ClipGenCardApi = { status: () => getClipGenStatus(), save: (settings) => saveClipGenSettings(settings) };

export function ClipGenCard({ health, serverOnline, api = DEFAULT_API, initialStatus = null, automated, now = Date.now, clipsVoice = null }: ClipGenCardProps) {
  const visible = clipGenCardVisible({ health, serverOnline, automated: automated ?? isAutomatedBrowser() });
  const [status, setStatus] = useState<ClipGenStatus | null>(initialStatus);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    api
      .status()
      .then((loaded) => {
        if (live) setStatus(loaded);
      })
      .catch(() => {
        if (live) setNote({ tone: 'warn', text: 'Сервер не ответил. Загляните сюда чуть позже.' });
      });
    return () => {
      live = false;
    };
  }, [visible, api]);

  if (!visible) return null;

  const save = (settings: ClipGenSettings): void => {
    setSaving(true);
    setNote(null);
    void api
      .save(settings)
      .then((saved) => {
        setStatus(saved);
        // the server answers with what it stored (an automated run stores nothing)
        setNote(saved.enabled === settings.enabled && saved.caps.dailyMilli === settings.dailyCapMilli ? { tone: 'ok', text: 'Сохранено.' } : { tone: 'info', text: 'Сервер оставил прежние настройки.' });
      })
      .catch(() => setNote({ tone: 'warn', text: 'Сервер не сохранил настройку. Попробуйте ещё раз чуть позже.' }))
      .finally(() => setSaving(false));
  };

  const cap = status?.caps.dailyMilli ?? 0;
  // the cap the server applies is always one of the buttons (a non-standard maximum or an older choice included)
  const choices = status ? clipGenCapChoices(status.caps.dailyMaxMilli, cap) : [];
  const shownCap = choices.includes(cap) || choices.length === 0 ? cap : (choices.filter((c) => c <= cap).pop() ?? (choices[0] as number));
  const described = status ? describeClipGen(status, now(), { clipsVoice }) : null;

  const toggle = (on: boolean): void => {
    if (!status || saving) return;
    if (on) setConfirming(true);
    else save({ enabled: false, dailyCapMilli: shownCap });
  };
  const chooseCap = (dailyCapMilli: number): void => {
    if (!status || saving || dailyCapMilli === cap) return;
    save({ enabled: status.enabled, dailyCapMilli });
  };
  const confirm = (): void => {
    setConfirming(false);
    save({ enabled: true, dailyCapMilli: shownCap });
  };

  return (
    <Card as="section" title="Дозапись новых фраз" padding="lg" data-clip-gen="">
      <p className={styles.help}>
        Если у фразы ещё нет записи, Гамбитик показывает её в облачке, а сервер записывает её голосом Giselle. Если запись готова, пока
        облачко на экране, фраза звучит сразу, иначе — со следующего раза. Слова те же, что в облачке: они написаны заранее.
      </p>
      <div className={styles.stack}>
        <Toggle
          checked={status?.enabled === true}
          disabled={status === null || saving}
          onChange={toggle}
          title="Записывать новые фразы"
          hint="Платно: кредиты Higgsfield. Выключено — новые фразы остаются в облачке без голоса"
        />
      </div>
      {choices.length > 0 ? (
        <>
          <h3 className={styles.subheading}>Не больше в день</h3>
          <div className={styles.scaleRow} role="group" aria-label="Лимит дозаписи в день">
            {choices.map((choice) => (
              <Button key={choice} variant={shownCap === choice ? 'primary' : 'secondary'} aria-pressed={shownCap === choice} disabled={saving} onClick={() => chooseCap(choice)}>
                {`${formatCreditsRu(choice)} кр.`}
              </Button>
            ))}
          </div>
        </>
      ) : null}
      {described !== null ? (
        <div className={shell.note} data-tone={described.tone} role="status">
          <p className={shell.noteSummary}>{described.summary}</p>
          {described.details.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : note === null ? (
        <p className={styles.help}>Узнаю у сервера…</p>
      ) : null}
      {note !== null ? (
        <p className={styles.saveNote} data-tone={note.tone} role="status">
          {note.text}
        </p>
      ) : null}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Включить дозапись?"
        size="md"
        actions={
          <>
            <Button variant="ghost" size="lg" onClick={() => setConfirming(false)}>
              Отмена
            </Button>
            <Button variant="primary" size="lg" onClick={confirm}>
              Да, включить
            </Button>
          </>
        }
      >
        <p>{clipGenConfirmText(shownCap)}</p>
      </Modal>
    </Card>
  );
}
