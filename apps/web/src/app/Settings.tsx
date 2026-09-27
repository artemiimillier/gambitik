/**
 * Settings — a calm, parent-oriented page (behind the parent gate, see ParentGate.tsx): who the student is and
 * on which curriculum stage, which voice Гамбитик uses and how the microphone works (with a plain-Russian status
 * from /api/health and the minutes of paid live voice), the daily limit of the paid voice (30 / 60 / 90 / 120 min or
 * none, next to today's minutes and a price hint, with the idle and daily rules), who writes the reviews, sounds,
 * text size.
 * WHICH voice he speaks with — the parent picks one of OpenAI's built-in voices (stored on the server,
 * GET|PUT /api/voice/voices; default = the .env voice `marin`) and may «Послушать» it first: one short, PAID line (the
 * button says so; never under automation). When the preferred paid voice gave up and the fallback model speaks, a note
 * says which, why and when it is tried again. «Проверить звук» checks the speakers AND the microphone.
 * Deliberately NOT here: «сбросить прогресс» — a child must not be able to wipe the journal.
 * «Записи» (docs/voice-clips/SPEC.md §8.1): the pre-recorded voice is one more choice — «Записанный голос —
 * бесплатно, без микрофона» — with its library line, the last game's share of recordings and a free «Послушать»
 * (a local clip; never offered to an automated browser).
 * Dev server only: `?clipsDemo=<seed>` (or the footer link) replays a harvested game through the real clips layer.
 * The lesson model (docs/TEACHING.md §4.4): without the server's runtime AI (`health.ai.runtime`, off by
 * default) the voice card offers only «Записанный голос» (the default: a stored 'auto' / 'live' / 'realtime' shows as
 * it, never rewritten), «Голос компьютера — черновик» and «Без голоса», says «Живой голос выключен: в партии ребёнка
 * ИИ не используется», and has no microphone, conversation, daily-limit or OpenAI voice sections. «Звуки»: the
 * permanent «Всегда без звука» (the game's «Звук» button only mutes until midnight, ../coach/soundMute.ts).
 * «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): the card «Дозапись новых фраз» (./ClipGenCard.tsx) — the paid switch
 * that records a missing lesson phrase on first use, its daily cap and spend; only when the server can record at all,
 * never in an automated browser.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CURRICULUM } from '@gambit/content';
import type { HealthInfo, StudentProfile } from '@gambit/shared';
import { getVoiceUsage } from '../api/client.ts';
import type { VoiceUsage } from '../api/client.ts';
import { isAutomatedBrowser } from '../automation.ts';
import { coach, useCoachStore } from '../coach/index.ts';
import { getVoiceChoice, saveVoiceChoice } from '../coach/liveApi.ts';
import type { VoiceChoiceInfo } from '../coach/liveApi.ts';
import { SoundCheckButton } from '../coach/SoundCheckButton.tsx';
import { clipsDemoSeed } from '../coach/clips/clipFlags.ts';
import { readClipStats } from '../coach/clips/clipMemory.ts';
import { CLIPS_VOICE_OPTION, clipPreviewEvent, describeClipsVoice } from '../coach/clips/clipSettings.ts';
import { getAppSoundMute, useSoundState } from '../coach/soundMute.ts';
import type { SoundMute } from '../coach/soundMute.ts';
import { previewVoice, voicePreviewMessage } from '../coach/voicePreview.ts';
import type { VoicePreviewOutcome } from '../coach/voicePreview.ts';
import { describeVoiceFallback } from '../coach/voiceStatus.ts';
import { BOARD_THEMES, BigChoice, Button, Card, Icon, Screen, isSoundMuted, onSoundMutedChange, setReducedMotion, setSoundMuted } from '../ui/index.ts';
import type { BoardThemeId } from '../ui/index.ts';
import type { SaveStudentResult } from './appStore.ts';
import { ClipGenCard } from './ClipGenCard.tsx';
import { AccountCard } from './account/AccountCard.tsx';
import { accountUser } from './account/accountSession.ts';
import {
  AI_OFF_CLIPS_NOTE,
  AI_OFF_LINE,
  aiOffVoiceChoice,
  aiOffVoiceOptions,
  dailyLimitOptions,
  describeDailyLimit,
  describeOpenAiKey,
  describePuzzles,
  describeTextAi,
  describeVoice,
  describeVoiceAiOff,
  describeVoiceUsage,
  micOptions,
  runtimeAiOf,
  talkativenessOptions,
  voiceOptions,
} from './healthText.ts';
import type { StatusText } from './healthText.ts';
import { NICKNAME_MAX_LENGTH, checkNickname, nicknameProblemRu } from './onboarding.ts';
import type { Address, NicknameProblem } from './onboarding.ts';
import styles from './Settings.module.css';
import shell from './shell.module.css';
import { FONT_SCALES, applyFontScale, getBrowserStorage, loadShellSettings, saveShellSettings } from './shellSettings.ts';
import type { FontScale } from './shellSettings.ts';
import { Toggle } from './Toggle.tsx';
import { VoicePicker, voicePickerView } from './VoicePicker.tsx';
import type { VoicePickerNote } from './VoicePicker.tsx';
import { loadVoiceSettings, parseVoiceSettings, saveVoiceSettings } from './voiceSettings.ts';
import type { DailyLimitChoice, MicChoice, TalkativenessChoice, VoiceChoice, VoiceSettings } from './voiceSettings.ts';

// The «Записи» demo replay (docs/voice-clips/demo-format.md): the DEV server only — `import.meta.env.DEV` is a build-time
// constant, so the production bundle has neither the chunk nor the import.
const ClipsDemo = import.meta.env.DEV ? lazy(() => import('../coach/clips/ClipsDemo.tsx').then((module) => ({ default: module.ClipsDemo }))) : null;

export interface SettingsProps {
  profile: StudentProfile;
  health: HealthInfo | null;
  serverOnline: boolean;
  saveStudent: (patch: { nickname?: string; address?: Address; stage?: number }) => Promise<SaveStudentResult>;
  onExit: () => void;
  onOpenPlayground: () => void;
  /** tests: another sound switch; the app uses its one switch (../coach/soundMute.ts) */
  soundMute?: SoundMute;
}

type SaveNote = { tone: 'ok' | 'info' | 'warn'; text: string } | null;

function StatusNote({ status }: { status: StatusText }) {
  return (
    <div className={shell.note} data-tone={status.tone} role="status">
      <p className={shell.noteSummary}>{status.summary}</p>
      {status.details.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function saveNoteFor(result: SaveStudentResult, what: 'name' | 'stage'): SaveNote {
  if (result.status === 'saved') return { tone: 'ok', text: 'Сохранено.' };
  if (result.status === 'deferred') return { tone: 'info', text: 'Запомнил. Отправлю на сервер, как только он заработает.' };
  return { tone: 'warn', text: what === 'stage' ? 'Сервер не принял эту ступень. Попробуйте ещё раз чуть позже.' : 'Сервер не принял это имя. Попробуйте другое — только буквы и цифры.' };
}

/** One short line per stage for the parent: the rating band and the goal of the stage. */
export function stageDescriptionRu(stage: { ratingBand: string; goal: string }): string {
  const band = stage.ratingBand.trim();
  const goal = stage.goal.trim();
  return band === '' ? goal : `${band}. ${goal}`;
}

const FONT_SCALE_LABEL: Record<FontScale, string> = { 1: 'Обычный', 1.15: 'Крупнее', 1.3: 'Самый крупный' };

export function Settings({ profile, health, serverOnline, saveStudent, onExit, onOpenPlayground, soundMute }: SettingsProps) {
  const sound = soundMute ?? getAppSoundMute();
  const soundState = useSoundState(sound);
  // no generative AI in the child's game unless the server says so (absent / offline = off, docs/TEACHING.md §4.4)
  const runtimeAi = serverOnline && runtimeAiOf(health);
  const voiceKind = useCoachStore((s) => s.voiceKind);
  const coachMuted = useCoachStore((s) => s.muted);
  const voiceLimitReached = useCoachStore((s) => s.voiceLimitReached);
  const voiceFallback = useCoachStore((s) => s.voiceFallback);
  const clipLibrary = useCoachStore((s) => s.clipLibrary);
  // behind the parental lock already (this page): the dev-only demo of the recorded voice
  const [demoSeed, setDemoSeed] = useState<string | null>(() => (import.meta.env.DEV ? clipsDemoSeed() : null));

  const [nickname, setNickname] = useState(profile.nickname);
  const [problem, setProblem] = useState<NicknameProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<SaveNote>(null);
  const [stageNote, setStageNote] = useState<SaveNote>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(() => loadVoiceSettings(getBrowserStorage()));
  const [usage, setUsage] = useState<VoiceUsage | null>(null);
  const [sfxMuted, setSfxMuted] = useState(isSoundMuted);
  // which voice Гамбитик speaks with (null = the server has no picker / is offline)
  const [voiceChoice, setVoiceChoice] = useState<VoiceChoiceInfo | null>(null);
  const [voiceChoiceNote, setVoiceChoiceNote] = useState<VoicePickerNote>(null);
  const [previewing, setPreviewing] = useState(false);
  const [shellSettings, setShellSettings] = useState(() => loadShellSettings(getBrowserStorage()));

  useEffect(() => onSoundMutedChange(setSfxMuted), []);
  // the profile can arrive later than the first render (slow server) or change after a deferred save
  useEffect(() => setNickname(profile.nickname), [profile.nickname]);

  // The dock can change the same settings («Я в наушниках» / «Буду нажимать кнопку» in its one-time note): follow the
  // coach store. Read defensively — the fields are newer than the store's first contract.
  useEffect(
    () =>
      useCoachStore.subscribe((state) => {
        const live = state as unknown as Record<string, unknown>;
        setVoiceSettings((current) => {
          const next = parseVoiceSettings(
            {
              voice: live.voicePreference,
              micMode: live.micMode,
              headphonesConfirmed: live.headphonesConfirmed,
              talkativeness: live.talkativeness,
              autoConversation: live.autoConversation,
              voiceDailyLimitMin: live.voiceDailyLimitMin,
            },
            { ...current },
          );
          const same = (Object.keys(next) as (keyof VoiceSettings)[]).every((key) => next[key] === current[key]);
          return same ? current : next;
        });
      }),
    [],
  );

  // minutes of paid live voice; an older server without the route (404 → null) or a silent one simply shows nothing
  // (no runtime AI: no paid voice, nothing to ask)
  useEffect(() => {
    if (!serverOnline || !runtimeAi) return;
    const abort = new AbortController();
    getVoiceUsage({ signal: abort.signal })
      .then((loaded) => {
        if (!abort.signal.aborted) setUsage(loaded);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [serverOnline, runtimeAi, voiceKind, voiceLimitReached]);

  useEffect(() => {
    if (!serverOnline || !runtimeAi) return;
    const abort = new AbortController();
    getVoiceChoice({ signal: abort.signal })
      .then((loaded) => {
        if (!abort.signal.aborted) setVoiceChoice(loaded);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [serverOnline, runtimeAi]);

  /** stored on the server; the next paid session speaks with it (an open one keeps its voice until it closes) */
  const chooseVoiceName = (voice: string | null): void => {
    if (voiceChoice !== null && voice === voiceChoice.selected) return;
    setVoiceChoiceNote(null);
    void saveVoiceChoice(voice)
      .then((saved) => {
        if (saved) setVoiceChoice(saved);
        // the server answers with what it stored: an automated run changes nothing there
        if (saved !== null && saved.selected !== voice) setVoiceChoiceNote({ tone: 'info', text: 'Голос не изменился (автоматический режим).' });
        else setVoiceChoiceNote({ tone: 'ok', text: 'Сохранено. Гамбитик заговорит этим голосом со следующего разговора.' });
      })
      .catch(() => setVoiceChoiceNote({ tone: 'warn', text: 'Сервер не сохранил голос. Попробуйте ещё раз чуть позже.' }));
  };

  const serverVoices = { live: health?.voice.live === true, realtime: health?.voice.realtime === true };

  /**
   * «Послушать»: one short PAID line in the chosen voice — never under automation, never past the daily limit of the
   * paid voice (the button is not even there then)
   */
  const previewChosenVoice = (): void => {
    if (voiceChoice === null || previewing || isAutomatedBrowser() || useCoachStore.getState().voiceLimitReached) return;
    const { chosen: id, previewKind: kind } = voicePickerView(voiceChoice, serverVoices);
    if (kind === null) return;
    // the coach himself falls silent — two voices at once would be a mess — and an open conversation ends: its
    // microphone would hear the preview and answer it
    coach.stopSpeaking();
    if (useCoachStore.getState().conversationOn) coach.endConversation();
    setPreviewing(true);
    setVoiceChoiceNote({ tone: 'info', text: voicePreviewMessage(id, 'playing') });
    void previewVoice(id, kind)
      .then((outcome: VoicePreviewOutcome) => setVoiceChoiceNote({ tone: outcome === 'spoken' ? 'ok' : outcome === 'automation' ? 'info' : 'warn', text: voicePreviewMessage(id, outcome) }))
      .finally(() => setPreviewing(false));
  };

  const save = (patch: { nickname?: string; address?: Address }): void => {
    setSaving(true);
    setSaveNote(null);
    void saveStudent(patch)
      .then((result) => setSaveNote(saveNoteFor(result, 'name')))
      .finally(() => setSaving(false));
  };

  const chooseStage = (stage: number): void => {
    if (stage === profile.stage || saving) return;
    setSaving(true);
    setStageNote(null);
    void saveStudent({ stage })
      .then((result) => setStageNote(saveNoteFor(result, 'stage')))
      .finally(() => setSaving(false));
  };

  const submitNickname = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const check = checkNickname(nickname);
    if (!check.ok) {
      setProblem(check.problem);
      return;
    }
    setProblem(null);
    setNickname(check.value);
    if (check.value !== profile.nickname) save({ nickname: check.value });
  };

  /** Stored through the coach settings API; the coach re-picks its voice layer at once (voiceSettings.ts). */
  const changeVoiceSettings = (patch: Partial<VoiceSettings>): void => {
    coach.unlockAudio();
    setVoiceSettings((current) => ({ ...current, ...patch }));
    void saveVoiceSettings(getBrowserStorage(), patch);
  };
  const chooseVoice = (voice: VoiceChoice): void => changeVoiceSettings({ voice });
  const chooseMic = (micMode: MicChoice): void => changeVoiceSettings({ micMode });
  const chooseTalkativeness = (talkativeness: TalkativenessChoice): void => changeVoiceSettings({ talkativeness });
  const chooseDailyLimit = (voiceDailyLimitMin: DailyLimitChoice): void => changeVoiceSettings({ voiceDailyLimitMin });

  const chooseFontScale = (fontScale: FontScale): void => {
    applyFontScale(fontScale);
    saveShellSettings(getBrowserStorage(), { fontScale });
    setShellSettings((current) => ({ ...current, fontScale }));
  };

  const chooseBoardTheme = (boardTheme: BoardThemeId): void => {
    saveShellSettings(getBrowserStorage(), { boardTheme });
    setShellSettings((current) => ({ ...current, boardTheme }));
  };

  const chooseReducedMotion = (reduced: boolean): void => {
    // off = follow the operating system again
    const reducedMotion = reduced ? true : null;
    setReducedMotion(reducedMotion);
    saveShellSettings(getBrowserStorage(), { reducedMotion });
    setShellSettings((current) => ({ ...current, reducedMotion }));
  };

  // /api/health names the .env voice; once the parent picked one, the status line names the one really used
  const pickedVoice = voiceChoice === null ? null : voiceKind === 'openai-realtime' ? voiceChoice.realtime : voiceChoice.live;
  const healthForStatus = health !== null && pickedVoice !== null ? { ...health, voice: { ...health.voice, voice: pickedVoice } } : health;
  const voiceStatus = describeVoice({ health: healthForStatus, serverOnline, voiceKind, preference: voiceSettings.voice, muted: coachMuted, micMode: voiceSettings.micMode });
  const fallbackLine = describeVoiceFallback(voiceFallback);
  const keyLine = describeOpenAiKey(serverOnline ? health : null);
  const usageLines = describeVoiceUsage(serverOnline ? usage : null);
  const limitLines = describeDailyLimit({ limitMin: voiceSettings.voiceDailyLimitMin, usage: serverOnline ? usage : null, limitReached: voiceLimitReached });
  const textAiStatus = describeTextAi(serverOnline ? health : null);
  const puzzlesLine = describePuzzles(serverOnline ? health : null);
  // without runtime AI a stored 'auto' / 'live' / 'realtime' speaks with AI_OFF_VOICE: that tile is pressed (never rewritten)
  const shownVoice = runtimeAi ? voiceSettings.voice : aiOffVoiceChoice(voiceSettings.voice);
  // «Записи»: its own status (describeVoice knows the paid and the robot voices)
  const clipsStatusRaw = describeClipsVoice({ voiceKind, preference: shownVoice, library: clipLibrary, lastGame: readClipStats(getBrowserStorage()), muted: coachMuted });
  // the lesson's new phrases are not recorded yet: the parent learns why some bubbles are silent
  const clipsStatus = clipsStatusRaw !== null && !runtimeAi ? { ...clipsStatusRaw, details: [AI_OFF_CLIPS_NOTE, ...clipsStatusRaw.details] } : clipsStatusRaw;
  const aiOffStatus = describeVoiceAiOff({ voiceKind, muted: coachMuted, serverOnline });
  const canPreviewClips = voiceKind === 'clips' && !coachMuted && !isAutomatedBrowser();
  /** «Послушать»: one short local recording, free — through the coach, so the bubble and the mouth follow it */
  const previewClips = (): void => {
    if (!canPreviewClips) return;
    coach.unlockAudio();
    coach.stopSpeaking();
    void coach.say(clipPreviewEvent());
  };
  const clipsPreview = canPreviewClips ? (
    <div className={styles.stack} data-clips-preview="">
      <div>
        <Button variant="secondary" onClick={previewClips} sound={false}>
          Послушать записанный голос
        </Button>
        <p className={styles.help}>Бесплатно: играет одна фраза с этого компьютера.</p>
      </div>
    </div>
  ) : null;
  const soundHelp = soundState.always
    ? 'Сейчас звука нет совсем. Выключите «Всегда без звука», чтобы Гамбитик снова говорил.'
    : soundState.until !== null
      ? 'Ребёнок выключил звук кнопкой «Звук» — до полуночи. Завтра голос и звуки включатся сами.'
      : 'Кнопка «Звук» в партии выключает голос и звуки ходов до полуночи — назавтра они включатся сами.';
  const nicknameDirty = checkNickname(nickname).ok && nickname.trim() !== profile.nickname;

  return (
    <Screen title="Настройки" subtitle="Страница для родителей" onBack={onExit} backLabel="Домой">
      <div className={styles.sections}>
        {/* the public site only: who is signed in, «Выйти», «Удалить аккаунт» */}
        <AccountCard />

        <Card as="section" title="Ученик" padding="lg">
          <form className={styles.nameForm} onSubmit={submitNickname} noValidate>
            <label className={styles.label} htmlFor="settings-nickname">
              Имя или прозвище
            </label>
            <div className={styles.nameRow}>
              <input
                id="settings-nickname"
                className={shell.field}
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={NICKNAME_MAX_LENGTH + 8}
                aria-invalid={problem !== null}
                aria-describedby="settings-nickname-help"
                value={nickname}
                onChange={(event) => {
                  setNickname(event.target.value);
                  setProblem(null);
                  setSaveNote(null);
                }}
              />
              <Button type="submit" size="lg" loading={saving} disabled={!nicknameDirty && problem === null}>
                Сохранить
              </Button>
            </div>
            <p id="settings-nickname-help" className={styles.help} data-problem={problem !== null ? 'true' : 'false'}>
              {problem !== null ? nicknameProblemRu(problem) : 'Так Гамбитик обращается к ребёнку. Фамилию и другие личные данные указывать не нужно.'}
            </p>
          </form>

          <p className={styles.label}>Как обращаться</p>
          <div className={styles.pair}>
            <BigChoice icon="👦" accent="blue" title="Мальчик" subtitle="«ты нашёл»" selected={profile.address === 'm'} disabled={saving} onClick={() => profile.address !== 'm' && save({ address: 'm' })} />
            <BigChoice icon="👧" accent="coral" title="Девочка" subtitle="«ты нашла»" selected={profile.address === 'f'} disabled={saving} onClick={() => profile.address !== 'f' && save({ address: 'f' })} />
          </div>
          <p className={styles.help}>Нужно только для русской грамматики во фразах тренера.</p>
          {saveNote ? (
            <p className={styles.saveNote} data-tone={saveNote.tone} role="status">
              {saveNote.text}
            </p>
          ) : null}
        </Card>

        <Card as="section" title="Ступень обучения" padding="lg">
          <p className={styles.help}>
            От ступени зависят подсказки тренера, темы задач и соперники «в самый раз». Новичок начинает с первой; если ребёнок уже играет — выберите ступень по описанию.
            Дальше Гамбитик сам предложит перейти выше, когда ребёнок будет готов.
          </p>
          <div className={styles.stageList} role="radiogroup" aria-label="Ступень обучения">
            {CURRICULUM.map((stage) => (
              <button key={stage.stage} type="button" role="radio" aria-checked={profile.stage === stage.stage} disabled={saving} className={styles.stageRow} onClick={() => chooseStage(stage.stage)}>
                <span className={styles.stageNumber} aria-hidden="true">
                  {stage.stage}
                </span>
                <span className={styles.stageText}>
                  <span className={styles.stageTitle}>
                    <span className={shell.srOnly}>Ступень {stage.stage}: </span>
                    {stage.title}
                  </span>
                  <span className={styles.stageDescription}>{stageDescriptionRu(stage)}</span>
                </span>
              </button>
            ))}
          </div>
          {stageNote ? (
            <p className={styles.saveNote} data-tone={stageNote.tone} role="status">
              {stageNote.text}
            </p>
          ) : null}
        </Card>

        <Card as="section" title="Голос Гамбитика" padding="lg">
          {runtimeAi ? (
            <>
              <div className={styles.voiceGrid}>
                <BigChoice
                  key={CLIPS_VOICE_OPTION.id}
                  title={CLIPS_VOICE_OPTION.title}
                  subtitle={CLIPS_VOICE_OPTION.subtitle}
                  selected={voiceSettings.voice === 'clips'}
                  onClick={() => chooseVoice('clips')}
                />
                {voiceOptions(serverOnline ? health : null).map((option) => (
                  <BigChoice
                    key={option.id}
                    title={option.title}
                    subtitle={option.subtitle}
                    selected={voiceSettings.voice === option.id}
                    disabled={option.unavailable && voiceSettings.voice !== option.id}
                    onClick={() => chooseVoice(option.id)}
                  />
                ))}
              </div>

              <h3 className={styles.subheading}>Микрофон</h3>
              <div className={styles.micGrid}>
                {micOptions().map((option) => (
                  <BigChoice key={option.id} title={option.title} subtitle={option.subtitle} selected={voiceSettings.micMode === option.id} onClick={() => chooseMic(option.id)} />
                ))}
              </div>
              {voiceSettings.micMode === 'open' ? (
                <div className={styles.stack}>
                  <Toggle
                    checked={voiceSettings.headphonesConfirmed}
                    onChange={(on) => changeVoiceSettings({ headphonesConfirmed: on })}
                    title="Ребёнок в наушниках"
                    hint="В наушниках Гамбитика можно перебивать голосом. Без них он не слушает, пока говорит сам, — иначе услышит себя; перебить его можно нажатием на Гамбитика"
                  />
                </div>
              ) : null}
              <p className={styles.help}>Микрофон нужен только живому голосу. С голосом компьютера Гамбитик не слушает.</p>

              <h3 className={styles.subheading}>Разговор с живым голосом</h3>
              <div className={styles.stack}>
                <Toggle
                  checked={voiceSettings.autoConversation}
                  onChange={(on) => changeVoiceSettings({ autoConversation: on })}
                  title="Разговор включается сам в начале партии"
                  hint="Гамбитик сразу слушает — можно спрашивать, не нажимая кнопок. Большая кнопка «Поговорить» у маскота включает и выключает разговор. В партии на 1 минуту он молчит до конца"
                />
              </div>
              <p className={`${styles.label} ${styles.talkLabel}`}>Как часто Гамбитик говорит сам</p>
              <div className={styles.talkGrid} role="group" aria-label="Как часто Гамбитик говорит сам">
                {talkativenessOptions().map((option) => (
                  <BigChoice
                    key={option.id}
                    title={option.title}
                    subtitle={option.subtitle}
                    selected={voiceSettings.talkativeness === option.id}
                    onClick={() => chooseTalkativeness(option.id)}
                  />
                ))}
              </div>
              <p className={styles.help}>На вопросы ребёнка он отвечает всегда. Ходы по одному не комментирует.</p>

              <h3 className={styles.subheading}>Лимит живого голоса в день</h3>
              <div className={styles.scaleRow} role="group" aria-label="Лимит живого голоса в день">
                {dailyLimitOptions().map((option) => (
                  <Button
                    key={option.id}
                    variant={voiceSettings.voiceDailyLimitMin === option.id ? 'primary' : 'secondary'}
                    aria-pressed={voiceSettings.voiceDailyLimitMin === option.id}
                    onClick={() => chooseDailyLimit(option.id)}
                  >
                    {option.title}
                  </Button>
                ))}
              </div>
              <div className={styles.limitFacts} data-reached={voiceLimitReached ? 'true' : 'false'}>
                {limitLines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>

              <h3 className={styles.subheading}>Каким голосом говорит Гамбитик</h3>
              <VoicePicker
                choice={voiceChoice}
                serverOnline={serverOnline}
                server={serverVoices}
                automated={isAutomatedBrowser()}
                limitReached={voiceLimitReached}
                previewing={previewing}
                note={voiceChoiceNote}
                onChoose={chooseVoiceName}
                onPreview={previewChosenVoice}
              />

              {fallbackLine !== null ? <StatusNote status={{ tone: 'warn', summary: 'Сейчас говорит запасной голос', details: [fallbackLine] }} /> : null}
              <StatusNote status={clipsStatus ?? voiceStatus} />
              {clipsPreview}
              <h3 className={styles.subheading}>Проверка звука и микрофона</h3>
              <SoundCheckButton />
              {keyLine !== null || usageLines.length > 0 ? (
                <div className={styles.facts}>
                  {keyLine !== null ? <p>{keyLine}</p> : null}
                  {usageLines.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <>
              {/* no generative AI in the child's game (docs/TEACHING.md §4.4): three free voices, no microphone */}
              <div className={styles.voiceGrid} role="group" aria-label="Голос в партии">
                {aiOffVoiceOptions().map((option) => (
                  <BigChoice key={option.id} title={option.title} subtitle={option.subtitle} selected={shownVoice === option.id} onClick={() => chooseVoice(option.id)} />
                ))}
              </div>
              <p className={styles.help} data-ai-off="">
                {AI_OFF_LINE}
              </p>
              <StatusNote status={clipsStatus ?? aiOffStatus} />
              {clipsPreview}
              {keyLine !== null ? (
                <div className={styles.facts}>
                  <p>{keyLine}</p>
                </div>
              ) : null}
            </>
          )}
        </Card>

        {/* recording asks only while the recorded voice really speaks here (the layer in use, not only the choice) */}
        <ClipGenCard health={health} serverOnline={serverOnline} clipsVoice={voiceKind === 'clips' && !coachMuted} />

        <Card as="section" title="Звуки" padding="lg">
          <div className={styles.stack}>
            <Toggle
              checked={!coachMuted}
              disabled={soundState.always}
              onChange={(on) => coach.setMuted(!on)}
              title="Голос Гамбитика"
              hint="Без голоса реплики остаются в облачке"
            />
            <Toggle
              checked={!sfxMuted}
              disabled={soundState.always}
              onChange={(on) => setSoundMuted(!on)}
              title="Звуки ходов и кнопок"
              hint="Стук фигур, щелчки, мелодия победы"
            />
            <Toggle
              checked={soundState.always}
              onChange={(on) => sound.setAlwaysMuted(on)}
              title="Всегда без звука"
              hint="Голос и звуки ходов выключены совсем: кнопка «Звук» в партии их не включит"
            />
          </div>
          <p className={styles.help}>{soundHelp}</p>
        </Card>

        <Card as="section" title="Разборы партий и задачи" padding="lg">
          <div className={styles.stack}>
            <StatusNote status={textAiStatus} />
            {puzzlesLine !== null ? <p className={styles.help}>{puzzlesLine}</p> : null}
          </div>
        </Card>

        <Card as="section" title="Экран" padding="lg">
          <p className={styles.label}>Размер текста</p>
          <div className={styles.scaleRow} role="group" aria-label="Размер текста">
            {FONT_SCALES.map((scale) => (
              <Button key={scale} variant={shellSettings.fontScale === scale ? 'primary' : 'secondary'} aria-pressed={shellSettings.fontScale === scale} onClick={() => chooseFontScale(scale)}>
                {FONT_SCALE_LABEL[scale]}
              </Button>
            ))}
          </div>
          <p className={styles.label}>Цвет доски в партии</p>
          <div className={styles.scaleRow} role="group" aria-label="Цвет доски">
            {(Object.keys(BOARD_THEMES) as BoardThemeId[]).map((id) => (
              <Button key={id} variant={shellSettings.boardTheme === id ? 'primary' : 'secondary'} aria-pressed={shellSettings.boardTheme === id} onClick={() => chooseBoardTheme(id)}>
                <span className={styles.boardSwatch} style={{ background: `linear-gradient(135deg, ${BOARD_THEMES[id].lightSquare} 50%, ${BOARD_THEMES[id].darkSquare} 50%)` }} aria-hidden="true" />
                {BOARD_THEMES[id].nameRu}
              </Button>
            ))}
          </div>
          <div className={styles.stack}>
            <Toggle checked={shellSettings.reducedMotion === true} onChange={chooseReducedMotion} title="Меньше анимации" hint="Без прыжков и конфетти; Гамбитик только моргает и говорит" />
          </div>
        </Card>

        <p className={styles.footer}>
          {accountUser() !== null ? (
            <>
              Партии, журналы и успехи хранятся на сервере в аккаунте ученика и не видны другим аккаунтам. ИИ выключен: ходы считает шахматный движок в браузере, а слова Гамбитика
              написаны заранее.
            </>
          ) : runtimeAi ? (
            <>
              Все партии и журналы хранятся в папке data рядом с приложением. Когда включён живой голос, звук с микрофона обрабатывается на серверах OpenAI, а ИИ-разбор получает
              запись партии; с голосом компьютера и шаблонными разборами компьютер ничего не отправляет.
            </>
          ) : (
            <>
              Все партии и журналы хранятся в папке data рядом с приложением. ИИ выключен: ни звук, ни партии не уходят в OpenAI или другие ИИ-сервисы — ходы считает движок на
              этом компьютере, а слова Гамбитика написаны заранее.
            </>
          )}{' '}
          {/* the component showcase is a developer tool: it is not part of the production bundle */}
          {import.meta.env.DEV ? (
            <button type="button" className={styles.linkButton} onClick={onOpenPlayground}>
              Для разработчика: витрина компонентов <Icon name="forward" />
            </button>
          ) : null}
          {ClipsDemo !== null ? (
            <>
              {' '}
              <button type="button" className={styles.linkButton} onClick={() => setDemoSeed('demo')}>
                Для разработчика: демо «Записей» <Icon name="forward" />
              </button>
            </>
          ) : null}
        </p>
      </div>
      {ClipsDemo !== null && demoSeed !== null ? (
        <Suspense fallback={null}>
          <ClipsDemo seed={demoSeed} onClose={() => setDemoSeed(null)} />
        </Suspense>
      ) : null}
    </Screen>
  );
}
