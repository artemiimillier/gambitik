/**
 * <MascotDock/> — fixed in the bottom-right corner: Гамбитик, his speech bubble and the round buttons.
 * Reads `useCoachStore`, talks to `coach`.
 *
 * The big round «Поговорить» button next to the mascot is THE way to talk (like a voice assistant): a tap opens the
 * full-duplex conversation — open microphone, barge-in — and a tap while it runs ends it («Пока!»). It shows the
 * conversation state: off «Поговорить» · connecting (spinner) «Подключаюсь…» · listening (soft pulse) «Слушаю» ·
 * child speaking (a ring that follows the microphone level) · thinking (dots) · coach speaking (his mouth moves) ·
 * error «Не получилось — нажми ещё раз». It exists only for a conversational voice (Live / Realtime) — never under
 * automation (the silent layer). Once the parent's daily minutes are used up it is disabled: «Лимит на сегодня».
 * «Подсказка» stays, smaller (secondary) — in teacher mode (`coach.onGameStart({ coachStyle: 'teacher' })`) it reads «Совет»
 * and repeats the teacher's advice; an exam hides it. In push-to-talk mode a hold-to-talk microphone button joins while the
 * conversation runs. While the open microphone runs without confirmed headphones, a one-time note offers
 * «Я в наушниках» / «Буду нажимать кнопку» (shared settings contract). The dock's `title` carries a short status for a
 * parent (which voice and model, whether the session is open).
 *
 * Layout contract with the screens: the dock is ONE column — the bubble sits above the mascot's head and is
 * never wider than `bubbleWidth`. A screen that keeps a strip of `--mascot-dock-size` free on the right
 * (ui <Screen dock="side">, the game panel's dock space) is therefore never covered by the mascot's speech.
 *
 * The mouth and the microphone ring are driven outside React: store subscriptions write `--mouth` straight to the SVG
 * and `--gmb-mic-level` to the «Поговорить» button.
 *
 * Hearing self-check: when the model spoke but the page could
 * not play it (`hearingCheck`), a big «Не слышно? Нажми сюда» button appears above the bubble — its click re-unlocks the
 * audio INSIDE the gesture (`coach.recheckHearing()`). A refused microphone shows «Микрофон закрыт — нажми, чтобы
 * разрешить» on the talk button while he goes on speaking (it is not an «error» of the conversation);
 * tapping it asks for the microphone again on the same session. When the site is on «Блокировать» (asking cannot work)
 * or the browser still refuses, a note with the exact steps for this browser stays above
 * the bubble («Нажми на значок слева от адреса → Микрофон → Разрешить…», `micHelp`) and he says them; allowed in the
 * site settings, the microphone comes back without a reload and the note goes.
 *
 * Cutting in: on laptop speakers the echo guard closes the microphone while Гамбитик talks, so the child
 * could not get a word in. A tap on Гамбитик while he speaks — or on «Поговорить» on loudspeakers — stops him at once
 * and opens the microphone (`coach.interrupt()`; voiceStatus.ts mascotTapAction / talkTapAction). With headphones the
 * child simply talks over him.
 *
 * «Записи» (the pre-recorded voice, docs/voice-clips/SPEC.md §8.2): no microphone at all — no «Поговорить», no mic
 * notes. In a game a round «Спроси» button opens big chips instead: «Почему так?», «Что задумал соперник?»,
 * «Совет»/«Подсказка», «Повтори» (`coach.ask`; the game answers through its own `sayEvent`, so the clock is held).
 * None in an exam. A tap on Гамбитик while he speaks stops him; an idle tap is a recorded catchphrase (`pokeClip`).
 *
 * The lesson model (docs/TEACHING.md §4.4–§4.5): no generative AI in the child's game unless the server says
 * `runtimeAi` — without it no «Поговорить», no microphone button, no microphone / headphones notes, whatever voice is
 * painted. «Спроси» is there in every game for EVERY voice, the silent one and a muted coach included (the answers are
 * in the bubble), except while the game's quiz card is open (`askSuppressed`). A lesson phrase «Записи» has no
 * recording for gets a small «не озвучено» mark in the bubble (`unvoiced`) — «записываю голос…» while the server records
 * it («Дозапись голоса», `unvoicedMark: 'recording'`: the next time it is said aloud). The speaker button is the same switch as
 * the game's big «Звук вкл / выкл» (./soundMute.ts: voice + move sounds, off until midnight; the parent's «Всегда без
 * звука» locks it).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { MASCOT } from '@gambit/content';
import type { CoachEvent } from '@gambit/shared';
import { registerDevHook } from '../devHook.ts';
import { coach as defaultCoach } from './coachController.ts';
import type { CoachController } from './coachController.ts';
import { useCoachStore as defaultStore } from './coachStore.ts';
import type { CoachStore } from './coachStore.ts';
import { askChipsFor, pokeClip } from './clips/clipAsk.ts';
import type { AskChip, AskKind } from './clips/clipAsk.ts';
import { Mascot, setMascotMouth } from './Mascot.tsx';
import { getAppSoundMute, useSoundState } from './soundMute.ts';
import type { SoundMute } from './soundMute.ts';
import { isOpenAiVoiceKind } from './voiceTypes.ts';
import {
  conversationButtonLabel,
  conversationCaption,
  conversationIsActive,
  describeVoiceStatus,
  HEADPHONES_NOTE,
  hintButtonText,
  mascotTapAction,
  MIC_HELP_DISMISS,
  MIC_HELP_TITLE,
  micHelpBrowser,
  micHelpStepsRu,
  shouldShowHeadphonesNote,
  talkTapAction,
  VOICE_LIMIT_CAPTION,
  VOICE_LIMIT_LABEL,
} from './voiceStatus.ts';
import type { MicHelpBrowser } from './voiceStatus.ts';
import { paginateBubble } from './voiceUtils.ts';
import './MascotDock.css';

export interface MascotDockProps {
  /** mascot width in px; default 180 */
  size?: number;
  /** left-handed mode mirrors the dock to the bottom-left corner */
  side?: 'right' | 'left';
  /** widest the speech bubble may get, px; default 304 (fits the --mascot-dock-size strip) */
  bubbleWidth?: number;
  /** shrink Гамбитик to 124 px on a low window (≤ 760 px): for screens that need every pixel of height (the game) */
  compactOnLowWindow?: boolean;
  /**
   * 'corner' (default): the bubble above his head in the bottom-right corner. 'bar' (the game on a phone held upright):
   * a strip across the bottom — the bubble (three lines a page) to the left of Гамбитик, «Спроси» and the speaker in a
   * column before it. The game keeps that strip free (GameScreen .dockBar), so his words never cover the board.
   * The bar has no «Подсказка»: the game's own button row has it right above.
   */
  layout?: 'corner' | 'bar';
  /** dependency injection for the playground / tests; the app uses the singletons */
  coach?: CoachController;
  store?: CoachStore;
  /** tests / the playground: the «Спроси» chips start open */
  initialAskOpen?: boolean;
  /**
   * The sound switch the speaker button drives (./soundMute.ts). Default: the app's one switch with the app's coach;
   * with an injected coach (tests, the playground) none — the button then toggles only that coach's voice.
   */
  soundMute?: SoundMute | null;
}

/** the small mark on a lesson phrase that has no recording yet (docs/TEACHING.md §4.5) */
export const UNVOICED_MARK = 'не озвучено';
/** the same mark while the local server records the phrase («Дозапись голоса», docs/voice-clips/ONDEMAND.md): heard next time */
export const RECORDING_MARK = 'записываю голос…';

const GESTURE_PROMPT = 'Привет! Нажми на меня';

/** the self-check button (the model spoke, the page played nothing) */
export const HEARING_CHECK_TEXT = 'Не слышно? Нажми сюда';
export const HEARING_CHECK_LABEL = 'Не слышно Гамбитика? Нажми сюда — я снова включу звук';

/** which browser's steps the microphone help shows (read once per render; no navigator on the server) */
function currentMicHelpBrowser(): MicHelpBrowser {
  return micHelpBrowser(typeof navigator === 'undefined' ? undefined : navigator);
}

/**
 * What he says when the child pokes him: his signature phrases from @gambit/content (gender-neutral, no Latin
 * notation, never shaming), each with a pose that suits it.
 */
const POKE_POSES: readonly CoachEvent['pose'][] = ['wave', 'talk', 'cheer', 'think'];
const POKE_PHRASES: readonly { text: string; pose: CoachEvent['pose'] }[] = MASCOT.catchphrases.map((text, i) => ({
  text,
  pose: POKE_POSES[i % POKE_POSES.length] ?? 'talk',
}));

const DEFAULT_BUBBLE_WIDTH = 304;

/**
 * What safely fits four lines of the bubble: ≈ 0.62 em per Cyrillic character of Nunito 750 at 19 px,
 * minus one word per line lost to wrapping. The CSS clamps at five lines as a safety net.
 */
function bubblePageChars(bubbleWidth: number, lines = 4): number {
  const charsPerLine = Math.floor((bubbleWidth - 42) / 11.8);
  return Math.max(40, (charsPerLine - 4) * lines);
}

/** The low laptop window of MascotDock.css (`data-compact`): Гамбитик shrinks and a bubble page holds three lines. */
const LOW_WINDOW_QUERY = '(min-width: 721px) and (max-height: 760px)';

function lowWindowNow(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(LOW_WINDOW_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * A screen that asked for the compact dock on a low window (the game) also gets shorter bubble pages there: on a
 * 1280×690 window a four-line bubble stood over the result card's «Ещё партию» / «Домой».
 */
function useLowWindow(enabled: boolean): boolean {
  const [low, setLow] = useState(() => enabled && lowWindowNow());
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      setLow(false);
      return undefined;
    }
    let query: MediaQueryList;
    try {
      query = window.matchMedia(LOW_WINDOW_QUERY);
    } catch {
      return undefined;
    }
    const update = (): void => setLow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [enabled]);
  return low;
}

function pageDurationMs(page: string): number {
  return Math.max(2600, page.length * 68);
}

/** Splits the bubble into ≤3-line pages and flips them while the coach talks. */
function useBubblePages(text: string, pageChars: number): { page: string; index: number; count: number } {
  const pages = useMemo(() => paginateBubble(text, pageChars), [text, pageChars]);
  const [index, setIndex] = useState(0);
  const previousText = useRef('');

  useEffect(() => {
    // a growing live caption jumps to its newest page, a new phrase starts from the first
    const grows = previousText.current !== '' && text.startsWith(previousText.current);
    previousText.current = text;
    setIndex(grows ? Math.max(0, pages.length - 1) : 0);
  }, [text, pages.length]);

  useEffect(() => {
    if (index >= pages.length - 1) return undefined;
    const timer = setTimeout(() => setIndex((i) => Math.min(i + 1, pages.length - 1)), pageDurationMs(pages[index] ?? ''));
    return () => clearTimeout(timer);
  }, [index, pages]);

  const safeIndex = Math.min(index, Math.max(0, pages.length - 1));
  return { page: pages[safeIndex] ?? '', index: safeIndex, count: pages.length };
}

// ───────────────────────── icons (inline, no asset downloads) ─────────────────────────

function BulbIcon(): ReactElement {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M16 3.5c-5.5 0-9.8 4.2-9.8 9.5 0 3.2 1.6 5.8 3.8 7.6.9.8 1.4 1.7 1.5 2.7l.1.7c.1.8.8 1.4 1.6 1.4h5.6c.8 0 1.5-.6 1.6-1.4l.1-.7c.1-1 .6-1.9 1.5-2.7 2.2-1.8 3.8-4.4 3.8-7.6 0-5.3-4.3-9.5-9.8-9.5z"
      />
      <rect fill="currentColor" x="12.2" y="26.6" width="7.6" height="2.9" rx="1.45" />
      <path fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" opacity=".75" d="M11.2 12.2c.5-2.2 2.1-3.7 4.2-4.1" />
    </svg>
  );
}

function MicIcon({ off = false }: { off?: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
      <rect fill="currentColor" x="11.5" y="3.5" width="9" height="16" rx="4.5" />
      <path fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" d="M7 15.5c0 5 4 9 9 9s9-4 9-9M16 24.5v4" />
      {off ? <path fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" d="M6 5l20 22" /> : null}
    </svg>
  );
}

function ThinkingDots(): ReactElement {
  return (
    <span className="gmb-talk-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M5 12.5c0-.8.7-1.5 1.5-1.5H10l5.6-4.7c1-.8 2.4-.1 2.4 1.1v17.2c0 1.2-1.4 1.9-2.4 1.1L10 21H6.5c-.8 0-1.5-.7-1.5-1.5z" />
      {muted ? (
        <path fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" d="M22 12.5l6 7M28 12.5l-6 7" />
      ) : (
        <path fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" d="M22 12c1.3 1.1 2 2.5 2 4s-.7 2.9-2 4M25 8.5c2.3 2 3.5 4.6 3.5 7.5s-1.2 5.5-3.5 7.5" />
      )}
    </svg>
  );
}

// ───────────────────────── «Спроси» (clips mode) ─────────────────────────

export const ASK_BUTTON_TEXT = 'Спроси';
export const ASK_GROUP_LABEL = 'Спроси Гамбитика';

/** The big chips of the no-microphone mode (a dumb component; the dock decides when and which). */
export function AskChips({ chips, onAsk }: { chips: readonly AskChip[]; onAsk: (kind: AskKind) => void }): ReactElement {
  return (
    <div className="gmb-ask" role="group" aria-label={ASK_GROUP_LABEL}>
      {chips.map((chip) => (
        <button key={chip.kind} type="button" className="gmb-ask-chip" data-ask={chip.kind} onClick={() => onAsk(chip.kind)}>
          <span className="gmb-ask-icon" aria-hidden="true">
            {chip.icon}
          </span>
          <span className="gmb-ask-label">{chip.label}</span>
        </button>
      ))}
    </div>
  );
}

function AskIcon(): ReactElement {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M6 7.5C6 5.6 7.6 4 9.5 4h13C24.4 4 26 5.6 26 7.5v10c0 1.9-1.6 3.5-3.5 3.5H15l-5.6 4.6c-.8.6-1.9.1-1.9-.9V21H9.5C7.6 21 6 19.4 6 17.5z" />
      <path fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" d="M13.2 10.4c.3-1.5 1.5-2.4 3-2.4 1.7 0 3 1.1 3 2.6 0 2.2-3 2.3-3 4.4" />
      <circle cx="16.2" cy="17.6" r="1.5" fill="#fff" />
    </svg>
  );
}

// ───────────────────────── component ─────────────────────────

export function MascotDock({
  size = 180,
  side = 'right',
  bubbleWidth = DEFAULT_BUBBLE_WIDTH,
  compactOnLowWindow = false,
  layout = 'corner',
  coach = defaultCoach,
  store = defaultStore,
  initialAskOpen = false,
  soundMute,
}: MascotDockProps): ReactElement {
  const sound = soundMute === undefined ? (coach === defaultCoach ? getAppSoundMute() : null) : soundMute;
  const soundState = useSoundState(sound);
  const pose = store((s) => s.pose);
  const bubbleText = store((s) => s.bubbleText);
  const speaking = store((s) => s.speaking);
  const muted = store((s) => s.muted);
  const micAvailable = store((s) => s.micAvailable);
  const voiceKind = store((s) => s.voiceKind);
  const listening = store((s) => s.listening);
  const needsUserGesture = store((s) => s.needsUserGesture);
  const hasToolHost = store((s) => s.hasToolHost);
  const hintAvailable = store((s) => s.hintAvailable);
  const coachStyle = store((s) => s.coachStyle);
  const asleep = store((s) => s.asleep);
  const micMode = store((s) => s.micMode);
  const micMuted = store((s) => s.micMuted);
  const childSpeaking = store((s) => s.childSpeaking);
  const headphonesConfirmed = store((s) => s.headphonesConfirmed);
  const voiceConnected = store((s) => s.voiceConnected);
  const conversationState = store((s) => s.conversationState);
  const voiceModel = store((s) => s.voiceModel);
  const talkativeness = store((s) => s.talkativeness);
  const voiceDailyLimitMin = store((s) => s.voiceDailyLimitMin);
  const voiceLimitReached = store((s) => s.voiceLimitReached);
  const hearingCheck = store((s) => s.hearingCheck);
  const micHelp = store((s) => s.micHelp);
  const voiceFallback = store((s) => s.voiceFallback);
  const clipLibrary = store((s) => s.clipLibrary);
  const runtimeAi = store((s) => s.runtimeAi);
  const askSuppressed = store((s) => s.askSuppressed);
  const unvoiced = store((s) => s.unvoiced);
  const unvoicedMark = store((s) => s.unvoicedMark);

  const [askOpen, setAskOpen] = useState(initialAskOpen);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const talkRef = useRef<HTMLButtonElement | null>(null);
  const pokeCount = useRef(0);
  const statusId = useId();

  // the dock is self-sufficient: init() is idempotent, so it is fine if the shell already called it. The sound switch is
  // reconciled right after init() read the stored mute: yesterday's «Звук выкл» lifts, «Всегда без звука» holds
  useEffect(() => {
    void coach.init();
    sound?.reconcile();
  }, [coach, sound]);

  // dev server only (e2e screenshots of the conversation states): paints the store, opens nothing
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    return registerDevHook('coach', {
      state: () => ({ ...store.getState() }) as Record<string, unknown>,
      paint: (patch) => store.setState(patch),
    });
  }, [store]);

  // lip-sync and the microphone ring at animation rate without re-rendering the dock
  useEffect(() => {
    setMascotMouth(svgRef.current, store.getState().mouthLevel);
    talkRef.current?.style.setProperty('--gmb-mic-level', store.getState().micLevel.toFixed(2));
    return store.subscribe((state, previous) => {
      if (state.mouthLevel !== previous.mouthLevel) setMascotMouth(svgRef.current, state.mouthLevel);
      if (state.micLevel !== previous.micLevel) talkRef.current?.style.setProperty('--gmb-mic-level', state.micLevel.toFixed(2));
    });
  }, [store]);

  const shownText = needsUserGesture ? GESTURE_PROMPT : bubbleText;
  const lowWindow = useLowWindow(compactOnLowWindow);
  const bar = layout === 'bar';
  // the bar's bubble speaks at 16 px (the corner's at 19): as many characters as the wider bubble would hold, three lines
  const { page, index, count } = useBubblePages(shownText, bar ? bubblePageChars(Math.round((bubbleWidth * 19) / 16), 3) : bubblePageChars(bubbleWidth, lowWindow ? 3 : 4));
  const shownPose = needsUserGesture && pose !== 'listen' ? 'wave' : pose;

  const onMascotClick = useCallback(() => {
    const action = mascotTapAction(store.getState());
    if (action === 'unlock') {
      coach.unlockAudio();
      return;
    }
    if (action === 'wake') {
      coach.wake();
      return;
    }
    if (action === 'interrupt') {
      // he speaks: the tap cuts him off and the microphone opens — the child's turn
      coach.interrupt();
      return;
    }
    coach.noteActivity();
    const phrase = POKE_PHRASES[pokeCount.current % POKE_PHRASES.length];
    pokeCount.current += 1;
    if (!phrase) return;
    // priority 0: silently ignored while he is busy or has just spoken. It is the answer to the child's tap (never filtered
    // by talkativeness); a conversational voice says it in its own words, the catchphrase is the free voices' text.
    void coach.say({
      id: `poke-${Date.now()}`,
      kind: 'answer',
      priority: 0,
      text: phrase.text,
      bubbleText: phrase.text,
      pose: phrase.pose,
      pauseClock: false,
      // «Записи»: one of his recorded catchphrases (the other voices say `text`)
      clip: pokeClip(phrase.pose),
      brief: `Ребёнок нажал на тебя, на маскота. Отзовись коротко и весело, одним предложением, про шахматы или про игру. Можно по мотивам твоей любимой фразы: «${phrase.text}».`,
    });
  }, [coach, store]);

  const onHint = useCallback(() => {
    coach.unlockAudio();
    coach.requestHint();
  }, [coach]);

  // hold-to-talk: pointer and keyboard (Space / Enter)
  const onMicDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      coach.unlockAudio();
      void coach.startListening();
    },
    [coach],
  );
  const onMicUp = useCallback(() => coach.stopListening(), [coach]);
  const onMicKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
        event.preventDefault();
        void coach.startListening();
      }
    },
    [coach],
  );
  const onMicKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        coach.stopListening();
      }
    },
    [coach],
  );

  // «Поговорить»: a tap starts the conversation, a tap while it runs ends it (unlock first: this IS the user gesture);
  // a refused microphone is asked for again; on loudspeakers a tap while he speaks cuts him off (talkTapAction)
  const onTalk = useCallback(() => {
    coach.unlockAudio();
    const action = talkTapAction(store.getState());
    if (action === 'interrupt') {
      coach.interrupt();
      return;
    }
    if (action === 'retryMic') {
      // «Микрофон закрыт»: ask once more on the open session (Chrome shows the prompt again after a dismissal); a site
      // on «Блокировать» (asking cannot work) or a browser that still refuses gets the steps (micHelp) — shown and said
      void coach.retryMicrophone();
      return;
    }
    coach.toggleConversation();
  }, [coach, store]);

  // «Не слышно? Нажми сюда»: play() + AudioContext.resume() must run inside THIS click
  const onHearingCheck = useCallback(() => {
    void coach.recheckHearing();
  }, [coach]);

  // «Спроси» (clips mode): the tap is the gesture — unlock first; the chips close once one is chosen
  const onAskToggle = useCallback(() => {
    coach.unlockAudio();
    setAskOpen((open) => !open);
  }, [coach]);
  const onAsk = useCallback(
    (kind: AskKind) => {
      coach.unlockAudio();
      setAskOpen(false);
      coach.ask(kind);
    },
    [coach],
  );

  // «Поговорить» only where generative AI is allowed in the child's game (docs/TEACHING.md §4.4)
  const showTalk = runtimeAi && isOpenAiVoiceKind(voiceKind) && !muted;
  const talkActive = conversationIsActive(conversationState);
  // push-to-talk (the «Буду нажимать кнопку» choice): while the conversation runs, a hold-to-talk button joins
  const showPushMic = showTalk && micAvailable && micMode === 'push' && talkActive;
  const clipsVoice = voiceKind === 'clips' && !muted;
  // «Спроси»: in every game with every voice — silent and muted too, the answers stay in the bubble (none in an exam,
  // none while the game's quiz card is open)
  const askChips = hasToolHost ? askChipsFor({ coachStyle, hintAvailable }) : [];
  const showAsk = askChips.length > 0 && !needsUserGesture && !askSuppressed;
  // the model spoke (or a recording could not play), the page played nothing: one obvious button
  const showHearingCheck = hearingCheck && (showTalk || clipsVoice) && !needsUserGesture;
  // the chips close when they cannot be used (game over, sound off, another voice)
  useEffect(() => {
    if (!showAsk) setAskOpen(false);
  }, [showAsk]);
  // the site's microphone is blocked: the steps stay on screen (a bubble would be gone before a parent could follow them)
  const showMicHelp = micHelp && showTalk && !micAvailable;
  // the note waits for a quiet moment, so the dock column never grows over a screen while he talks
  const showHeadphonesNote =
    runtimeAi && shouldShowHeadphonesNote({ voiceKind, micAvailable, muted, micMode, headphonesConfirmed }) && !needsUserGesture && page === '' && !showHearingCheck;
  // the speaker button is the game's «Звук» switch too; the parent's «Всегда без звука» locks it off
  const soundLocked = muted && soundState.always;
  const onMute = useCallback(() => {
    if (!sound) {
      coach.toggleMuted();
      return;
    }
    if (store.getState().muted) sound.unmute();
    else sound.muteUntilMidnight();
  }, [coach, sound, store]);
  // a lesson phrase «Записи» has no recording for: the bubble says so (not on the gesture prompt)
  const showUnvoiced = unvoiced && page !== '' && !needsUserGesture;
  const parentStatus = describeVoiceStatus({
    voiceKind,
    voiceConnected,
    muted,
    micAvailable,
    micMode,
    micMuted,
    voiceModel,
    talkativeness,
    dailyLimitMin: voiceDailyLimitMin,
    limitReached: voiceLimitReached,
    fallback: voiceFallback,
    clipLibrary,
  });
  const mascotLabel = needsUserGesture
    ? 'Гамбитик. Нажми, чтобы включить голос'
    : asleep
      ? 'Гамбитик спит. Нажми, чтобы разбудить'
      : 'Гамбитик, твой тренер';
  // the voice is up but the browser refused the microphone: he goes on speaking, the button offers to allow it
  const micBlocked = voiceConnected && !micAvailable;
  const talkCaption = voiceLimitReached ? VOICE_LIMIT_CAPTION : conversationCaption(conversationState, { micBlocked });
  // on loudspeakers a tap while he speaks cuts him off — the label says so
  const cutsIn = talkTapAction({ voiceConnected, micAvailable, conversationState, micMode, headphonesConfirmed }) === 'interrupt';
  const talkLabel = voiceLimitReached ? VOICE_LIMIT_LABEL : conversationButtonLabel(conversationState, { micBlocked, cutsIn });
  // teacher mode: «Совет» (repeats the advice); an exam has no help at all
  const hintText = hintButtonText(coachStyle);
  const showHint = hasToolHost && hintAvailable && coachStyle !== 'exam' && !bar;

  return (
    <aside
      className="gmb-dock"
      data-side={side}
      data-gesture={needsUserGesture ? 'true' : 'false'}
      data-compact={compactOnLowWindow ? 'true' : 'false'}
      data-layout={layout}
      aria-label="Тренер Гамбитик"
      aria-describedby={statusId}
      title={parentStatus}
      data-voice={voiceKind}
      style={{ '--gmb-mascot-size': `${size}px`, '--gmb-bubble-width': `${bubbleWidth}px` } as CSSProperties}
    >
      {/* screen readers get the whole phrase once; the visible bubble shows it page by page */}
      <div className="gmb-visually-hidden" role="status" aria-live="polite">
        {shownText}
      </div>
      {/* for a parent: which voice is active and what the microphone does (also the dock's tooltip) */}
      <span id={statusId} className="gmb-visually-hidden">
        {parentStatus}
      </span>

      {showHearingCheck ? (
        <button type="button" className="gmb-hear" onClick={onHearingCheck} aria-label={HEARING_CHECK_LABEL} title={HEARING_CHECK_LABEL}>
          <SpeakerIcon muted={false} />
          <span className="gmb-hear-text">{HEARING_CHECK_TEXT}</span>
        </button>
      ) : null}

      {showAsk && askOpen ? <AskChips chips={askChips} onAsk={onAsk} /> : null}

      {showMicHelp ? (
        <div className="gmb-note" role="group" aria-label={MIC_HELP_TITLE} data-kind="mic-help">
          <p className="gmb-note-text">
            <strong>{MIC_HELP_TITLE}.</strong> {micHelpStepsRu(currentMicHelpBrowser())}
          </p>
          <div className="gmb-note-actions">
            <button type="button" className="gmb-note-button gmb-note-button-main" onClick={() => coach.dismissMicHelp()}>
              {MIC_HELP_DISMISS}
            </button>
          </div>
        </div>
      ) : null}

      {showHeadphonesNote ? (
        <div className="gmb-note" role="group" aria-label="Наушники">
          <p className="gmb-note-text">{HEADPHONES_NOTE.text}</p>
          <div className="gmb-note-actions">
            <button type="button" className="gmb-note-button gmb-note-button-main" onClick={() => coach.confirmHeadphones()}>
              {HEADPHONES_NOTE.confirm}
            </button>
            <button type="button" className="gmb-note-button" onClick={() => coach.setMicMode('push')}>
              {HEADPHONES_NOTE.usePush}
            </button>
          </div>
        </div>
      ) : null}

      <div
        className="gmb-bubble"
        data-visible={page !== '' ? 'true' : 'false'}
        data-prompt={needsUserGesture ? 'true' : 'false'}
        data-unvoiced={showUnvoiced ? 'true' : 'false'}
        aria-hidden="true"
      >
        <p className="gmb-bubble-text">{page}</p>
        {showUnvoiced ? (
          unvoicedMark === 'recording' ? (
            <span className="gmb-bubble-unvoiced" data-mark="recording">
              {RECORDING_MARK}
            </span>
          ) : (
            <span className="gmb-bubble-unvoiced">{UNVOICED_MARK}</span>
          )
        ) : null}
        {count > 1 ? (
          <span className="gmb-bubble-dots">
            {Array.from({ length: count }, (_, i) => (
              <i key={i} data-on={i === index ? 'true' : 'false'} />
            ))}
          </span>
        ) : null}
      </div>

      <div className="gmb-dock-row">
        <div className="gmb-dock-buttons">
          <button
            type="button"
            className="gmb-round gmb-round-mute"
            aria-label={muted ? 'Включить голос Гамбитика' : 'Выключить голос Гамбитика'}
            title={soundLocked ? 'Звук выключен в настройках для взрослых' : muted ? 'Включить голос' : 'Выключить голос до завтра'}
            aria-pressed={muted}
            disabled={soundLocked}
            onClick={onMute}
          >
            <SpeakerIcon muted={muted} />
          </button>
          {showHint ? (
            <button
              type="button"
              className="gmb-round gmb-round-hint"
              data-style={coachStyle ?? 'none'}
              onClick={onHint}
              aria-label={hintText.caption}
              title={hintText.title}
            >
              <BulbIcon />
              <span className="gmb-round-caption">{hintText.caption}</span>
            </button>
          ) : null}
          {showAsk ? (
            <button
              type="button"
              className="gmb-round gmb-round-ask"
              onClick={onAskToggle}
              aria-expanded={askOpen}
              aria-label={askOpen ? 'Закрыть вопросы' : 'Спроси Гамбитика: почему так, что задумал соперник, повтори'}
              title={ASK_BUTTON_TEXT}
              data-active={askOpen ? 'true' : 'false'}
            >
              <AskIcon />
              <span className="gmb-round-caption">{ASK_BUTTON_TEXT}</span>
            </button>
          ) : null}
          {showPushMic ? (
            <button
              type="button"
              className="gmb-round gmb-round-mic"
              aria-label="Нажми и держи, чтобы говорить с Гамбитиком"
              title="Нажми и держи, чтобы говорить"
              aria-pressed={listening}
              data-active={listening ? 'true' : 'false'}
              onPointerDown={onMicDown}
              onPointerUp={onMicUp}
              onPointerCancel={onMicUp}
              onLostPointerCapture={onMicUp}
              onKeyDown={onMicKeyDown}
              onKeyUp={onMicKeyUp}
              onBlur={onMicUp}
              onContextMenu={(event) => event.preventDefault()}
            >
              <MicIcon />
            </button>
          ) : null}
          {showTalk ? (
            <button
              ref={talkRef}
              type="button"
              className="gmb-talk"
              data-state={conversationState}
              data-active={talkActive ? 'true' : 'false'}
              data-mic-muted={micMuted ? 'true' : 'false'}
              data-mic-blocked={micBlocked ? 'true' : 'false'}
              data-limit={voiceLimitReached ? 'true' : 'false'}
              disabled={voiceLimitReached}
              aria-label={talkLabel}
              aria-pressed={talkActive}
              title={talkLabel}
              onClick={onTalk}
            >
              <span className="gmb-talk-disc">
                <span className="gmb-talk-ring" aria-hidden="true" />
                {conversationState === 'connecting' ? (
                  <span className="gmb-talk-spinner" aria-hidden="true" />
                ) : conversationState === 'thinking' ? (
                  <ThinkingDots />
                ) : (
                  <MicIcon off={(micMuted && talkActive) || micBlocked} />
                )}
              </span>
              <span className="gmb-talk-caption" aria-hidden="true">
                {talkCaption}
              </span>
            </button>
          ) : null}
        </div>

        <button type="button" className="gmb-dock-mascot" onClick={onMascotClick} aria-label={mascotLabel}>
          <Mascot ref={svgRef} pose={shownPose} size={size} talking={speaking} label="" />
        </button>
      </div>
    </aside>
  );
}
