/**
 * Reactive coach state (zustand). Written ONLY by the coach controller; screens and the dock read it.
 * The first eight fields are the public contract from ARCHITECTURE §3, the rest are local extras.
 */
import { create } from 'zustand';
import type { BoardAnnotations, CoachStyle, ConversationState, MascotPose, MicMode, Talkativeness, VoiceLayer } from '@gambit/shared';
import type { VoiceDailyLimitMin, VoicePreference } from './settings.ts';
import type { ClipLibraryStatus } from './voiceTypes.ts';

/**
 * The preferred paid voice gave up at runtime and the next model speaks instead (Live → Realtime) — without this, minutes on
 * the fallback would go unnoticed. Parent-facing only: the dock's status line and Settings.
 */
export interface VoiceFallbackInfo {
  /** the layer that gave up (the preferred one) */
  from: VoiceLayer['kind'];
  /** the layer speaking now */
  to: VoiceLayer['kind'];
  /** 'cannot connect' | 'the model keeps silent' | 'no API key' (a permanent failure has `retryAt` null) */
  reason: string;
  /** short Latin code of the last failure ('502:voice-upstream:net:ENOTFOUND', 'silent:3' …), null = unknown */
  code: string | null;
  /** epoch ms from which the next conversation start tries the preferred voice again; null = not again (permanent) */
  retryAt: number | null;
}

export interface CoachState {
  pose: MascotPose;
  /** 0..1, updated at animation rate while speaking (quantised to 0.02) */
  mouthLevel: number;
  /** current speech-bubble text; '' = no bubble */
  bubbleText: string;
  speaking: boolean;
  /** arrows / highlights the coach wants on the board right now */
  annotations: BoardAnnotations | null;
  voiceKind: VoiceLayer['kind'];
  muted: boolean;
  /** talking to the coach is possible (a conversational voice is active and a microphone can be asked for) */
  micAvailable: boolean;

  // ───── extras ─────
  /** init() finished */
  ready: boolean;
  /** the child holds the mic button */
  listening: boolean;
  /** sound is blocked until the first click — the dock shows «Нажми на меня» */
  needsUserGesture: boolean;
  /** a game registered itself → «Подсказка» button is shown */
  hasToolHost: boolean;
  /** false in an exam game: the round «Подсказка» button is hidden although a game is registered */
  hintAvailable: boolean;
  /**
   * How the coach helps in the running game (`coach.onGameStart({ coachStyle })`), null outside a game. 'teacher' renames
   * the dock's hint button to «Совет» (it repeats the teacher's advice); 'exam' hides it.
   */
  coachStyle: CoachStyle | null;
  asleep: boolean;
  voicePreference: VoicePreference;
  /** 'open' = always-listening microphone (full duplex, barge-in), 'push' = hold the button */
  micMode: MicMode;
  /** «Я в наушниках» was pressed once; false + open mode → the dock shows the headphones note and the echo guard is on */
  headphonesConfirmed: boolean;
  /** open mode: the child switched the microphone off */
  micMuted: boolean;
  /** open mode: the child is talking right now → 'listen' pose, live level ring */
  childSpeaking: boolean;
  /** the paid voice session is open right now (false while the mascot sleeps) — parent-facing status */
  voiceConnected: boolean;

  // ───── the «Поговорить» conversation ─────
  /** state of the conversational voice session for the «Поговорить» control ('off' on free voices) */
  conversationState: ConversationState;
  /** the child (or a game start) switched the conversation on; the «Поговорить» button toggles this */
  conversationOn: boolean;
  /** 0..1 loudness of the child's microphone, at animation rate (quantised to 0.05) — the dock's level ring */
  micLevel: number;
  /**
   * how often the conversational coach speaks up on its own (persisted setting). Teacher mode: the game reads it to pick
   * the LENGTH of the teacher's phrases ('quiet' → always short) — teacher phrases are never filtered by it.
   */
  talkativeness: Talkativeness;
  /** a game start opens the conversation by itself (persisted setting) */
  autoConversation: boolean;
  /** model id of the conversational voice (from /api/health) — parent-facing status only; null on free voices */
  voiceModel: string | null;

  // ───── what the paid voice may cost ─────
  /** the parent's daily budget of paid live voice, minutes per local day (0 = no limit; persisted setting) */
  voiceDailyLimitMin: VoiceDailyLimitMin;
  /** today's minutes are used up: no paid session until local midnight, «Поговорить» shows «Лимит на сегодня» */
  voiceLimitReached: boolean;

  // ───── playback self-check («я его не слышу») ─────
  /** the model spoke but the page could not play it: the dock offers «Не слышно? Нажми сюда» */
  hearingCheck: boolean;
  /**
   * The browser blocks the microphone for this site and «Микрофон закрыт» was tapped: the dock shows the steps to allow
   * it (voiceStatus.ts micHelpStepsRu) until it works, the permission changes, or «Понятно».
   */
  micHelp: boolean;
  /** the preferred paid voice gave up and the fallback model speaks (null = all as preferred) — parent-facing status */
  voiceFallback: VoiceFallbackInfo | null;

  // ───── «Записи»: the pre-recorded voice (docs/voice-clips/SPEC.md §8) ─────
  /** the library the clips layer loaded (null = not the clips voice, or no library) — parent-facing status */
  clipLibrary: ClipLibraryStatus | null;

  // ───── the lesson without runtime AI (docs/TEACHING.md §4.4–§4.5) ─────
  /**
   * The server allows generative AI in the child's game (`health.ai.runtime === true`; absent or offline = false).
   * false: no «Поговорить», no microphone UI, and 'auto' / 'live' / 'realtime' speak with `AI_OFF_VOICE`.
   */
  runtimeAi: boolean;
  /** the game hides «Спроси» while its quiz card is open (`coach.setAskSuppressed`) */
  askSuppressed: boolean;
  /**
   * The bubble shows a lesson phrase that has no recording yet: «Записи» played nothing for it (§4.5), the dock marks
   * the bubble «не озвучено». Cleared with the next bubble.
   */
  unvoiced: boolean;
  /**
   * Which mark an `unvoiced` bubble carries («Дозапись голоса», docs/voice-clips/ONDEMAND.md): 'recording' = every missing sentence of
   * it is being recorded now («записываю голос…» — the next time it is said aloud), 'unrecorded' = «не озвучено»
   * (recording off, paused, over budget, given up, failed). null whenever `unvoiced` is false.
   */
  unvoicedMark: 'unrecorded' | 'recording' | null;
}

export const INITIAL_COACH_STATE: CoachState = {
  pose: 'idle',
  mouthLevel: 0,
  bubbleText: '',
  speaking: false,
  annotations: null,
  voiceKind: 'silent',
  muted: false,
  micAvailable: false,
  ready: false,
  listening: false,
  needsUserGesture: false,
  hasToolHost: false,
  hintAvailable: true,
  coachStyle: null,
  asleep: false,
  voicePreference: 'auto',
  micMode: 'open',
  headphonesConfirmed: false,
  micMuted: false,
  childSpeaking: false,
  voiceConnected: false,
  conversationState: 'off',
  conversationOn: false,
  micLevel: 0,
  talkativeness: 'normal',
  autoConversation: true,
  voiceModel: null,
  voiceDailyLimitMin: 60,
  voiceLimitReached: false,
  hearingCheck: false,
  micHelp: false,
  voiceFallback: null,
  clipLibrary: null,
  runtimeAi: false,
  askSuppressed: false,
  unvoiced: false,
  unvoicedMark: null,
};

/** A fresh store — the app uses the `useCoachStore` singleton, tests create their own. */
export function createCoachStore() {
  return create<CoachState>()(() => ({ ...INITIAL_COACH_STATE }));
}

export type CoachStore = ReturnType<typeof createCoachStore>;

export const useCoachStore: CoachStore = createCoachStore();
