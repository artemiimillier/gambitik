/**
 * The coach controller: one voice, one queue, one mascot.
 *
 *   coach.say(event)  → priority queue → voice layer → store (pose / bubble / annotations)
 *
 * Queue rules (contracts.ts `CoachEvent.priority`):
 *   2 — must be said now: interrupts the current phrase, drops queued chatter
 *   1 — normal: waits for its turn
 *   0 — optional chatter: dropped when the coach is busy or spoke less than 4 s ago
 *
 * Words and the conversation (so that he does not talk only when «Подсказка» is pressed, and phrases do not sound
 * pre-programmed):
 *   - a conversational voice (Live / Realtime) gets `event.brief` — engine facts + the goal of the moment — and says it
 *     in its OWN words (`speakBrief`); the template `event.text` is only the fallback. The bubble shows the model's
 *     own transcript as it streams (the template only if no words arrive within ~1.5 s).
 *   - «Поговорить» (startConversation / endConversation / toggleConversation) opens the full-duplex conversation; a game
 *     start opens it by itself (`onGameStart`, not in 1-minute bullet, setting `autoConversation`) and keeps it open
 *     for the whole game. The layer's `onConversationState` drives the button.
 *   - talkativeness ('quiet' | 'normal' | 'chatty') filters what the conversational coach says on its own; urgent
 *     phrases (priority 2) and answers to the child always pass. One gentle nudge after ≥ 60 s of silent thinking
 *     (untimed / 10-minute games), never repeated within 2 min.
 *   - teacher mode (docs/TEACHER-MODE.md, `onGameStart({ coachStyle: 'teacher' })`): the game sends a `teachTurn` nearly
 *     every move. Teacher phrases pass every talkativeness (it sets their LENGTH, chosen by the game from the store);
 *     their style sets the model's sentence budget (short 1 / full 4 / concept 5); the nudge is off; the dock's hint
 *     button reads «Совет» and, with nobody subscribed, repeats the advice (`host.repeatAdvice`). An exam game
 *     (`coachStyle: 'exam'`) never says a teacher phrase and has no nudge.
 *
 * Money (a child who left the game and walked away must not cost anything). Live bills every
 * second the session is OPEN, silence included, so the paid session closes:
 *   - in a game after 2 min without CHILD activity (a move, a tap, the child's speech, «Подсказка», «Поговорить»);
 *     the coach's own phrases, the bot's moves, context notes, timers and the silence nudge never keep it open, and
 *     while the mascot dozes they never reopen it — the child's next move or tap does (the bubble says so, once);
 *   - after 15 s in a hidden tab (another tab, minimised window, locked screen); visible again → only a game with the
 *     conversation on reconnects by itself;
 *   - at once on 'pagehide' (the seconds go out with navigator.sendBeacon);
 *   - for the rest of the local day once the parent's daily minutes are used up (`voiceDailyLimitMin`, default 60):
 *     server total (GET /api/voice/usage, at most once a minute) + this page's sessions; the coach goes on in the bubble.
 *
 * Hearing (the child cannot hear him, or he cannot hear the child):
 *   - a layer that reports a hearing problem (the model spoke, the page played nothing) sets `hearingCheck`: the dock
 *     offers «Не слышно? Нажми сюда» → `recheckHearing()` (play() + AudioContext.resume() inside that click);
 *   - a microphone refused on an OPEN session is not «reconnected» (that would close the working session and open a new
 *     billed one just to show the permission prompt again): the button shows «Микрофон закрыт», a tap asks again on the
 *     same session (`retryMicrophone()`);
 *   - the in-game idle rule never closes the session while the coach is still audible;
 *   - every decision (layers, failover, sleep, stops and why, reconnects, gesture lock) goes to the black box (./voiceDiag.ts).
 *
 * Talking back and the fallback model:
 *   - `interrupt()`: a tap on Гамбитик (or on «Поговорить» on loudspeakers) while he speaks cuts him off at once and opens
 *     the microphone — on loudspeakers the echo guard closes the microphone while he talks, so a tap is the child's way in;
 *   - a paid layer that gave up for a PASSING reason (no connection, the model kept silent) is not written off for the
 *     page's whole life: the next conversation start (a game start or «Поговорить») tries it again after a
 *     growing pause (1 → 2 → 4 … ≤ 15 min); `voiceFallback` in the store tells the parent which model speaks and why.
 *
 * Fast play and a blocked microphone (in a fast 5-minute «Учитель» game remarks would be cut mid-word; the site's
 * microphone may be on «Блокировать»):
 *   - `stopSpeaking({ grace: true })` (the child moved while he speaks): waiting phrases and one not heard yet are
 *     dropped, the phrase he hears ends its sentence (or its last words) within `stopGraceMs`, then the newest one
 *     comes; an urgent phrase still cuts in at once;
 *   - `retryMicrophone()` does not ask a browser that blocks the site (it cannot work): `micHelp` shows the steps and
 *     he says them; the permission changing to «Разрешить» / «Спрашивать» brings the microphone back without a reload.
 *
 * No generative AI in the child's game (docs/TEACHING.md §4.4–§4.5):
 *   - `runtimeAi` = `health.ai.runtime === true` (absent, an old server or no answer = false), in the store and as
 *     `coach.runtimeAi()` for the game (no strategist replans without it);
 *   - without it 'auto' / 'live' / 'realtime' speak with `AI_OFF_VOICE` (./settings.ts — 'clips' now, 'browser' by one
 *     edit); the stored preference is never rewritten; no conversation, no microphone;
 *   - «Записи» and a lesson phrase with no recording (it carries `say`, no `clip`): nothing is played and the bubble
 *     gets `unvoiced` («не озвучено») — never a generic line in its place (./clips/clipVoice.ts);
 *   - `setAskSuppressed(true)` hides «Спроси» while the game's quiz card is open;
 *   - `showPose(pose, ms)`: a pose without words (a quiet turn's nod, the joy over a find) — no bubble, no sound;
 *   - `speaksAloud()`: the phrase being said is really heard (a sounding layer, not muted, no click needed, not
 *     «не озвучено») — without it the game shows the calm advice's arrow after the bubble's reading time (§4.6).
 *
 * «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): a lesson phrase without a twin is voiced from its own recorded units,
 * whole or not at all (./clips/clipVoice.ts). When its plan is silent in a live game turn, the controller asks the local
 * server to record the missing sentences (./clips/clipOnDemand.ts — never under automation, never when muted or on
 * another voice, never outside a game); the bubble says «записываю голос…» only when every missing sentence came back
 * queued / recording and the same bubble is still shown, else «не озвучено». The phrase is never held back for it, the
 * silent timing stays as it was. `voicePolicy()` is the lesson book's live «is it recorded» probe — only while the clip
 * layer really speaks (not muted, not automation).
 *
 * «Дозапись голоса» for every phrase (so that no phrase stays unheard):
 *   - G1: any phrase on «Записи» — a greeting, an encouragement, an answer to «Спроси», a thought reply, a game start —
 *     whose plan names whole catalogue sentences without their exact recording (`ClipPlanInfo.lineMissing`: the
 *     bubble's own wording; a free-worded answer's next wording while its pool has only a few) asks for them (ids only,
 *     the same caps and guards); a silent plan of ANY phrase marks its bubble «не озвучено». Outside a game only while
 *     the recording scope is on (`setRecordingScope`: the child's own screens, never Settings — the parent's
 *     «Послушать» and the demo live there — or the playground); never in an exam, except its own fixed sentences;
 *   - G2: a silent phrase whose recordings can say its bubble whole (not `ClipPlanInfo.partial`) and whose sentences all
 *     came back queued / recording / already voiced becomes the late candidate: the status is polled every 1.5 s, its
 *     bubble stays up to `lateVoiceWindowMs` (30 s), and when the library changes while the SAME bubble is still up,
 *     nothing else is said or waiting and the audio already runs, the layer plays it (`playLate`) — outside the queue:
 *     no `say()` (the game holds the child's clock through `onLateSpeech`), no arrows, no `speaksAloud`, never
 *     interrupting. Any newer phrase, a stop, the child's move or take-back (`noteBoardChange`), mute, a voice change, a
 *     game start / end, the quiz card, a hidden page, the parent's page drop the candidate; one already sounding is cut
 *     by a newer phrase, mute, a hidden page, a voice change or a hard stop — the child's move or a gentle stop treat it
 *     as a phrase said at once (chatter goes on, anything else ends its sentence within `stopGraceMs`). Never under
 *     automation; the black box says how it went (`clip.late`, `clip.gen`, `clip.gen.skip`).
 *
 * The controller is a plain factory with injected dependencies so the queue and the state
 * transitions are unit-testable without a DOM; the app uses the `coach` singleton.
 */
import { TIME_CONTROLS } from '@gambit/shared';
import type {
  BoardAnnotations,
  ClipGenLine,
  ClipGenOutcome,
  CoachEvent,
  CoachEventKind,
  CoachStyle,
  CoachToolHost,
  ConversationState,
  HealthInfo,
  HintLevel,
  MascotPose,
  MicMode,
  Talkativeness,
  TimeControlId,
  VoiceLayer,
} from '@gambit/shared';
import type { LessonVoicePolicy } from '@gambit/core';
import { getClipGenStatus, getHealth, getVoiceUsage, requestClipGen } from '../api/client.ts';
import { automationSilenced, isAutomatedBrowser } from '../automation.ts';
import { installVoiceProbe, probeVoice } from './voiceProbe.ts';
import { createBrowserTtsVoice } from './browserTtsVoice.ts';
import { CONVERSATION_HELLO_BRIEF_RU, CONVERSATION_HELLO_TEXT_RU, SILENCE_NUDGE_BRIEF_RU, SILENCE_NUDGE_TEXT_RU, teachMaxSentences } from './coachBrief.ts';
import { useCoachStore } from './coachStore.ts';
import type { CoachState, CoachStore } from './coachStore.ts';
import { createOpenAiLiveVoice } from './liveVoice.ts';
import { createOpenAiRealtimeVoice } from './realtimeVoice.ts';
import type { HearingProblem } from './rtcSession.ts';
import { hasVoiceHealth } from './sessionVoice.ts';
import { effectiveVoicePreference, getBrowserStorage, loadCoachSettings, saveCoachSettings } from './settings.ts';
import { diag, diagString, micPermissionNow, onMicPermissionChange } from './voiceDiag.ts';
import type { MicPermission } from './voiceDiag.ts';
import { micHelpBrowser, micHelpSpokenRu, micHelpStepsRu } from './voiceStatus.ts';
import type { MicHelpBrowser } from './voiceStatus.ts';
import type { SettingsStorage, VoicePreference } from './settings.ts';
import { createSilentVoice } from './silentVoice.ts';
import { e2eClipsOptIn } from './clips/clipFlags.ts';
import { LESSON_VOICE_MIN, clipGenGrows, createClipOnDemand } from './clips/clipOnDemand.ts';
import type { ClipGenApi, ClipOverlayHandle } from './clips/clipOnDemand.ts';
import { createBrowserClipVoice, isFreeWordedAnswer, isUnrecordedLesson } from './clips/clipVoice.ts';
import type { BriefSpeakOptions, ClipExtras, ClipLateResult, ClipPlanInfo, ClipPrewarmHint, ClipSpeakOptions, CoachVoiceLayer, SayProgress, UnavailableDetail, VoiceKind } from './voiceTypes.ts';
import { isClipLayer, isConversationalLayer, isGestureGated, isOpenAiVoiceKind } from './voiceTypes.ts';
import { createEmitter, estimateSpeechMs } from './voiceUtils.ts';
import type { Unsubscribe } from './voiceUtils.ts';

export interface CoachTimings {
  /** how long the bubble stays after the speech ended */
  bubbleLingerMs: number;
  /** priority-0 chatter is dropped when the last phrase ended less than this ago */
  chatterQuietMs: number;
  /** nothing happened for this long → the mascot falls asleep (free voices: only a pose) */
  sleepAfterMs: number;
  /**
   * Paid conversational voice, no game running: nobody spoke and nothing happened for this long → the mascot falls
   * asleep AND the session + microphone are closed (Live bills every second, silence included).
   */
  voiceIdleMs: number;
  /**
   * Paid voice during a game: this long without CHILD activity (a move, a tap, the child's speech) closes the session,
   * the conversation on or off. The coach talking, the bot moving and timers do not count — an abandoned game must not
   * burn money.
   */
  voiceIdleInGameMs: number;
  /** a phrase of the coach still in flight when the child's time is up may finish — for at most this long */
  idleBusyGraceMs: number;
  /** the tab / window stayed hidden this long → the paid session closes */
  hiddenSuspendMs: number;
  /** the daily limit is re-checked this often while a paid session is open; GET /api/voice/usage at most this often */
  usageCheckMs: number;
  /** `GET /api/health` slower than this → start without it (free voice); the game never waits for the network */
  healthTimeoutMs: number;
  /** a voice layer whose init() takes longer is skipped for the next one in the chain */
  voiceInitTimeoutMs: number;
  /** phrases held back by the "needs a click first" lock are dropped when older than this */
  gestureHoldMaxMs: number;
  /** a free realtime answer is considered over after this long even without a "stopped" signal */
  freeAnswerMaxMs: number;
  /** maximum number of waiting phrases; the oldest normal one is dropped beyond that */
  maxQueue: number;
  /** some poses are animations that need time even when the phrase is one word */
  minPoseMs: Partial<Record<MascotPose, number>>;
  /** a brief said by the model: the bubble shows the template when none of the model's words arrived this long */
  briefCaptionWaitMs: number;
  /** untimed / 10-minute game: the child thought silently this long → one gentle nudge */
  silenceNudgeMs: number;
  /** …never twice within this long */
  silenceNudgeGapMs: number;
  /** the conversation dropped during a game: reconnect after this long (at most three times in a row) */
  reconnectDelayMs: number;
  /** how long «Пока!» stays in the bubble after the conversation was ended */
  goodbyeMs: number;
  /** the preferred paid voice gave up for a passing reason: tried again at a conversation start after this long… */
  voiceRestoreBaseMs: number;
  /** …doubling with every new failure, at most this long */
  voiceRestoreMaxMs: number;
  /**
   * The child moved while a phrase was being said (`stopSpeaking({ grace: true })`, fast play): an audible phrase may go
   * on this long at most — to the end of its sentence, or to its end when that is nearer — instead of being cut mid-word.
   */
  stopGraceMs: number;
  /** a sentence of the model's words that ended in its caption sounds this much longer (the words run a little ahead) */
  sentenceTailMs: number;
  /**
   * «Дозапись голоса» G2: a silent phrase whose recording was asked for may still be played this long after it was shown
   * — its bubble stays up that long (at most `LATE_VOICE_MAX_MS`)
   */
  lateVoiceWindowMs: number;
}

export const DEFAULT_COACH_TIMINGS: CoachTimings = {
  bubbleLingerMs: 6000,
  chatterQuietMs: 4000,
  sleepAfterMs: 60_000,
  voiceIdleMs: 90_000,
  voiceIdleInGameMs: 2 * 60_000,
  idleBusyGraceMs: 45_000,
  hiddenSuspendMs: 15_000,
  usageCheckMs: 60_000,
  healthTimeoutMs: 4000,
  voiceInitTimeoutMs: 4000,
  gestureHoldMaxMs: 45_000,
  freeAnswerMaxMs: 25_000,
  maxQueue: 5,
  minPoseMs: { wave: 2000, cheer: 2400, oops: 1500 },
  briefCaptionWaitMs: 1500,
  silenceNudgeMs: 60_000,
  silenceNudgeGapMs: 120_000,
  reconnectDelayMs: 1500,
  goodbyeMs: 2500,
  voiceRestoreBaseMs: 60_000,
  voiceRestoreMaxMs: 15 * 60_000,
  stopGraceMs: 2000,
  sentenceTailMs: 300,
  lateVoiceWindowMs: 30_000,
};

/** what a game tells the coach when it starts (`coach.onGameStart`; the game may pass a superset) */
export interface CoachGameInfo {
  timeControlId: TimeControlId;
  /** exam games: no hints — the silence nudge (which offers one) stays off */
  examMode?: boolean;
  /**
   * How the coach helps in this game (docs/TEACHER-MODE.md): 'teacher' = the game sends a `teachTurn` nearly every move
   * and the dock's hint button reads «Совет»; 'helper' = help on request; 'exam' = no proactive speech at all (same as
   * `examMode`). Absent (an older game record) = derived from `examMode`.
   */
  coachStyle?: CoachStyle;
}

/** «Поговорить» waits at most this long for today's minutes from the server (a local route: normally a few ms) */
const USAGE_WAIT_MS = 1500;

/** answers to the child are never filtered by talkativeness */
const ANSWER_KINDS: ReadonlySet<CoachEventKind> = new Set(['answer', 'hint']);
/**
 * Teacher mode (docs/TEACHER-MODE.md §2.7, §7.2): the teacher's advice and reactions ARE the mode — talkativeness sets
 * their LENGTH (the game picks the style from `useCoachStore.talkativeness`), never whether they are said.
 */
const TEACH_KINDS: ReadonlySet<CoachEventKind> = new Set(['teachTurn', 'teachReaction']);
/** the long-silence nudge only makes sense where a child has time to think */
const NUDGE_TIME_CONTROLS: ReadonlySet<TimeControlId> = new Set(['training', 'rapid10']);
/** «Дозапись голоса»: the lesson's closing phrase said this soon after the game ended still belongs to that game */
export const GAME_END_RECORD_MS = 60_000;
/** G2: whatever the timings say, a recording never plays later than this after its phrase was shown */
export const LATE_VOICE_MAX_MS = 60_000;
/**
 * «Дозапись голоса» in an exam: nothing of the game is recorded there (it is the child's own game) — except the exam's
 * own fixed sentences, said only there, which would otherwise stay silent for good.
 */
const EXAM_RECORDABLE_LINES: ReadonlySet<string> = new Set(['shell.noHints.exam']);

export const CONVERSATION_GOODBYE_RU = 'Пока! Нажми «Поговорить», когда захочешь.';
/** the bubble (once) when a game's paid session closes because the child went quiet */
export const GAME_SLEEP_BUBBLE_RU = 'Я задремал. Сделай ход или нажми на меня — и я снова с тобой!';
/** the bubble (once a day) when today's minutes of the paid voice are used up */
export const VOICE_LIMIT_BUBBLE_RU = 'На сегодня я наговорился — дальше пишу в облачке. Завтра снова поболтаем!';

/** Why the mascot sleeps: only an 'idle' nap outside a game may be ended by the coach's own phrase. */
type SleepReason = 'idle' | 'gameIdle' | 'hidden';

/** The page around the coach (the browser implementation is wired in the singleton; tests pass a fake). */
export interface CoachPageLifecycle {
  /** document.visibilityState === 'hidden' */
  isHidden(): boolean;
  onVisibilityChange(cb: () => void): Unsubscribe;
  /** 'pagehide': the page is being closed or put away */
  onPageHide(cb: () => void): Unsubscribe;
  /** the child touched the page (pointerdown / keydown), except the dock (it reports its own taps) */
  onUserInput?(cb: () => void): Unsubscribe;
}

/** YYYY-MM-DD of the LOCAL calendar day (the server keeps its usage per local day too) */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function msUntilLocalMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - ms;
}

/**
 * Design D: how often the conversational coach speaks up on its own. Priority 2 (take-back offer …), answers to the
 * child and the teacher's phrases (`teachTurn` / `teachReaction`) always pass; 'quiet' says nothing else, 'normal' drops
 * optional chatter (priority 0), 'chatty' says everything.
 */
export function passesTalkativeness(event: Pick<CoachEvent, 'priority' | 'kind'> & Partial<Pick<CoachEvent, 'teach'>>, talkativeness: Talkativeness): boolean {
  // a teacher moment of any kind (`teach`: the strategy intro that starts a teacher game, a teacher take-back offer) is
  // the substance of «Учитель» — talkativeness sets its length, never whether it is said
  if (event.priority === 2 || ANSWER_KINDS.has(event.kind) || TEACH_KINDS.has(event.kind) || event.teach !== undefined) return true;
  switch (talkativeness) {
    case 'quiet':
      return false;
    case 'normal':
      return event.priority >= 1;
    case 'chatty':
      return true;
  }
}

export interface CoachControllerDeps {
  store: CoachStore;
  getHealth: () => Promise<HealthInfo>;
  createVoice: (kind: VoiceKind) => VoiceLayer;
  /** resolved lazily (at init / on write) so importing the module never touches localStorage */
  getStorage: () => SettingsStorage | null;
  /** true = automation run: only the silent voice layer may be used (default: never silenced) */
  isSilenced?: () => boolean;
  /**
   * An automation run that opted into the real «Записи» layer (`gambit.e2eClips`, ./clips/clipFlags.ts): the silenced
   * chain becomes ['clips', 'silent'] — the layer then plays into a muted GainNode(0). Never a paid or audible layer.
   */
  clipsWhenSilenced?: () => boolean;
  /** GET /api/voice/usage — today's paid seconds on the server (daily limit); absent = only this page's own count */
  getVoiceUsage?: () => Promise<{ todaySeconds: number } | null>;
  /** visibility / pagehide / user input of the page; absent (tests, server render) = always visible */
  page?: CoachPageLifecycle;
  /** the browser's microphone permission, read synchronously inside a click (default: the one voiceDiag watches) */
  micPermission?: () => MicPermission;
  /** later changes of that permission (default: navigator.permissions 'change', see voiceDiag) */
  onMicPermissionChange?: (cb: (state: MicPermission) => void) => Unsubscribe;
  /** which browser the microphone steps are written for (default: from navigator) */
  micHelpBrowser?: () => MicHelpBrowser;
  /**
   * «Дозапись голоса»: the server routes that record a missing lesson phrase (POST request / GET status). Absent (tests,
   * the playground) = nothing is ever requested.
   */
  clipGen?: ClipGenApi;
  /** an automation-driven browser, even one that opted into sound (default `isAutomatedBrowser()`): records nothing */
  isAutomated?: () => boolean;
  now?: () => number;
  timings?: Partial<CoachTimings>;
}

export interface CoachController {
  /** Picks the voice layer from /api/health + settings. Safe to call more than once. */
  init(): Promise<void>;
  /** Queues a phrase; resolves when it was spoken, interrupted or dropped. */
  say(event: CoachEvent): Promise<void>;
  /**
   * Stops the phrase and drops every waiting one. `grace` (the child moved while he speaks — fast play, «Учитель»): a
   * phrase the child already hears is not chopped mid-word — it ends its sentence (or its last words) within
   * `stopGraceMs`; a phrase not heard yet goes at once. An urgent phrase (priority 2) still cuts in at once.
   */
  stopSpeaking(opts?: StopSpeakingOptions): void;
  /** The game registers itself for realtime tools and the «Подсказка» button (null on exit). */
  setToolHost(host: CoachToolHost | null): void;
  onHintRequested(cb: () => void): Unsubscribe;

  // ───── extras beyond ARCHITECTURE §3 ─────
  /** «Подсказка» was pressed (the dock calls this). */
  requestHint(): void;
  /** Exam games have no hints: false hides the dock's «Подсказка» button and makes requestHint() a no-op. */
  setHintAvailable(available: boolean): void;
  setMuted(muted: boolean): void;
  toggleMuted(): void;
  setVoicePreference(preference: VoicePreference): Promise<void>;
  /** Re-reads `gambit.settings` (the Settings screen wrote it) and re-picks the voice layer / mic mode at runtime. */
  applySettings(): Promise<void>;
  /** 'open' = always-listening microphone with barge-in, 'push' = hold the button; persisted */
  setMicMode(mode: MicMode): void;
  /** «Я в наушниках»: persisted, switches the loudspeaker echo guard off */
  confirmHeadphones(): void;
  /** open-mic mode: the child tapped the mic indicator */
  setMicMuted(muted: boolean): void;
  toggleMic(): void;
  /** Silent facts for the conversational model (position changed, judgement arrived) — never spoken, never wakes a sleeping session. */
  pushContext(note: string): void;
  /** push-to-talk (micMode 'push'), conversational voices only; in open mode it just wakes the coach */
  startListening(): Promise<void>;
  stopListening(): void;
  /** call from a click handler: unlocks browser audio and releases held phrases */
  unlockAudio(): void;
  /** any child activity (a move, a click) keeps the mascot awake */
  noteActivity(): void;
  /** wakes a sleeping mascot with a little wave */
  wake(): void;
  showAnnotations(annotations: BoardAnnotations | null): void;
  clearAnnotations(): void;
  /** what the child said / what the realtime coach answered — for the game journal */
  onTranscript(cb: (who: 'child' | 'coach', text: string) => void): Unsubscribe;

  // ───── the «Поговорить» conversation (additive) ─────
  /** Opens the full-duplex conversation (session + microphone) on a conversational voice; resolves once it is open or failed. */
  startConversation(): Promise<void>;
  /** Closes it («Пока!»): the session and the microphone stop; until the next start the coach speaks only in the bubble. */
  endConversation(): void;
  /** the «Поговорить» button: start when off / failed, end otherwise (call from the click handler) */
  toggleConversation(): void;
  /** mirrors `useCoachStore.getState().conversationState` */
  readonly conversationState: ConversationState;
  /** persisted; 'quiet' | 'normal' | 'chatty' */
  setTalkativeness(talkativeness: Talkativeness): void;
  /**
   * mirrors `useCoachStore.getState().talkativeness` (read from `gambit.settings` by init / applySettings). Teacher mode:
   * the game picks the LENGTH of a teacher's phrase from it ('quiet' → always 'short'); it never silences the teacher.
   */
  readonly talkativeness: Talkativeness;
  /** the coach style of the running game (`onGameStart`), null outside a game; mirrors `useCoachStore.coachStyle` */
  readonly coachStyle: CoachStyle | null;
  /** persisted; false = a game start does not open the conversation by itself */
  setAutoConversation(enabled: boolean): void;
  /**
   * The game started (call once per game, after `setToolHost`). Opens the conversation automatically when a
   * conversational voice is available and `autoConversation` is on — never in 1-minute bullet (the coach is silent
   * there, the session is closed) and never under automation. Arms the long-silence nudge (untimed / 10-minute games,
   * helper style only: the teacher speaks every move anyway, an exam is silent). `info.coachStyle` also names the dock's
   * hint button («Совет» for the teacher) and drops teacher phrases in an exam.
   */
  onGameStart(info: CoachGameInfo): void;
  /** The game is over (result card / exit). `setToolHost(null)` implies it too. */
  onGameEnd(): void;

  // ───── hearing self-check (additive) ─────
  /**
   * «Не слышно? Нажми сюда» (call from the click handler): play() + AudioContext.resume() of the voice session inside the
   * gesture, the outcome goes to the black box, `hearingCheck` is cleared. Resolves with what was found (null = no session).
   */
  recheckHearing(): Promise<{ play: string; ctx: string } | null>;
  /**
   * «Микрофон закрыт» tapped: ask for the microphone again on the open session (no new session). true = it works now.
   * When the browser has the site's microphone on «Блокировать» (asking again cannot work) or still refuses, the dock
   * shows the steps to allow it (`micHelp`) and he says them.
   */
  retryMicrophone(): Promise<boolean>;
  /** «Понятно» on the microphone steps */
  dismissMicHelp(): void;

  // ───── talking back on loudspeakers (additive) ─────
  /**
   * The child tapped Гамбитик (or «Поговорить» on loudspeakers) while he speaks: he stops at once, whatever was queued
   * is dropped and the microphone opens now (call from the click handler).
   */
  interrupt(): void;

  // ───── «Записи»: no microphone, the child asks with big chips (docs/voice-clips/SPEC.md §8.2, additive) ─────
  /**
   * A «Спроси» chip was tapped (call from the click handler): the game answers it (`onAsk`) through its own `sayEvent`,
   * so the child's clock is held while the answer plays. Without a listener: 'hint' is `requestHint()`, 'repeat' says
   * the last phrase again, 'why' / 'opponent' ask the tool host (`explainLastMove`) — or do nothing.
   */
  ask(question: CoachAsk): void;
  onAsk(cb: (question: CoachAsk) => void): Unsubscribe;
  /** the last phrase that was voiced (for «Повтори»); null before any */
  readonly lastSpoken: CoachEvent | null;
  /**
   * true while «Записи» speaks: the game's builders then add their clip twins (`CoachEvent.clip`, SPEC §3.4); every
   * other voice ignores `clip`, so setting it is always safe.
   */
  readonly clipVoice: boolean;
  /** «Записи»: decode what is likely to be said next (candidate moves, the next events) — a no-op for other voices */
  prewarmClips(hint: ClipPrewarmHint): void;

  // ───── the lesson: no generative AI in the child's game (docs/TEACHING.md §4.4, additive) ─────
  /**
   * The server allows generative AI in the child's game (`health.ai.runtime === true`); false before /api/health
   * answered, for an old server and offline. The game asks it before strategist replans; the dock hides «Поговорить».
   */
  runtimeAi(): boolean;
  /** true while the game's quiz card is open: the dock hides «Спроси» (a game end clears it) */
  setAskSuppressed(suppressed: boolean): void;
  /**
   * A pose without words (docs/TEACHING.md §2.2 — a quiet turn's short nod; the joy over a find when the praise cap is
   * reached): held for `ms` (at least the pose's own animation time, `minPoseMs`), no bubble, no sound, no queue. A
   * phrase being said keeps its own pose (the rest of the hold shows after it); a sleeping mascot is not woken by it.
   */
  showPose(pose: MascotPose, ms: number): void;
  /**
   * The phrase being said now is really played aloud (docs/TEACHING.md §4.6): a sounding voice layer (not the silent
   * one, not muted, not a paused / blocked conversation), no click still needed, the page can play (no «Не слышно?»),
   * and not a lesson phrase «не озвучено». false = the child only reads the bubble — nothing being said at all is false
   * too. The game times the calm advice's arrow by the reading time then, not by the silent layer's end (up to 9 s).
   */
  speaksAloud(): boolean;
  /**
   * «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): the lesson book's policy, asked on EVERY pick — prefer wordings that already
   * play (P(3)), grow the recorded set with the cheapest wordings while the server records. null (the default book) when
   * the clip layer does not really speak: another voice, muted, an automated browser, no library loaded.
   */
  voicePolicy(): LessonVoicePolicy | null;
  /**
   * «Дозапись голоса» outside a game: the app turns it on for the child's own screens (home, the new-game wizard,
   * onboarding, the path, puzzles, review, progress) and off for Settings (the parent's «Послушать», the demo) and the
   * playground. Off by default; a live game records whatever the scope (never an exam).
   */
  setRecordingScope(on: boolean): void;
  /**
   * The game's board changed (every ply, every take-back): a late play of an earlier phrase (G2) never starts after
   * that — the moment it belonged to is over; one already sounding ends as a phrase said at once would (never mid-word).
   */
  noteBoardChange(): void;
  /**
   * A phrase played late (G2) starts (true) / stops (false) sounding: it is outside `say()`, so the game holds the
   * child's clock itself meanwhile (5 and 10 minutes: the clock stands while Гамбитик speaks).
   */
  onLateSpeech(cb: (speaking: boolean) => void): Unsubscribe;
  dispose(): void;
}

/** The «Спроси» chips of the clips mode: «Почему так?», «Что задумал соперник?», «Совет»/«Подсказка», «Повтори». */
export type CoachAsk = 'why' | 'opponent' | 'hint' | 'repeat';

export interface StopSpeakingOptions {
  clearBubble?: boolean;
  /** the child moved on while he speaks: let a nearly finished sentence end (see CoachController.stopSpeaking) */
  grace?: boolean;
}

interface QueueItem {
  event: CoachEvent;
  seq: number;
  enqueuedAt: number;
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * What the child has heard of the phrase being said — for a gentle stop. `words` = the model's own words so far (its
 * caption) or the whole text a voice reads; `inStep` = those words come in step with the sound (Live), so the end of a
 * sentence can be seen in them; otherwise only the remaining time can be estimated.
 */
interface HeardPhrase {
  item: QueueItem;
  /** the real voice says it (the silent layer only keeps the bubble's timing) */
  voiced: boolean;
  /** the model's own words for a brief: audible from its first caption on */
  ownWords: boolean;
  /** when the child could first hear it (null = nothing yet) */
  audibleAt: number | null;
  words: string;
  wordsAt: number;
  inStep: boolean;
}

/** the clip layer a late phrase plays on («Дозапись голоса» G2) */
type LateLayer = CoachVoiceLayer & ClipExtras;

/** «Дозапись голоса» G2: a silent phrase on screen whose recording may still arrive while its bubble is up */
interface LateCandidate {
  event: CoachEvent;
  layer: LateLayer;
  /** when its recording was asked for (≈ when it was shown) */
  at: number;
  /** `lateEpoch` / `boardEpoch` then: any change = its moment is over */
  lateEpoch: number;
  boardEpoch: number;
  /** what its bubble read then (it must still read the same) */
  bubble: string;
  /** its recording landed while its own silent timing still ran: tried again when that ends */
  landed: boolean;
}

const isRecordingOutcome = (outcome: ClipGenOutcome): boolean => outcome === 'queued' || outcome === 'recording';

/** a phrase going on after `stopSpeaking({ grace: true })`: to its sentence end ('sentence') or to its end ('finish') */
interface GraceStop {
  item: QueueItem;
  mode: 'sentence' | 'finish';
  since: number;
  timer: ReturnType<typeof setTimeout>;
  tailTimer: ReturnType<typeof setTimeout> | null;
}

/** «…конь.» / «…выбирай!» / «…так?»» — the model's caption ends a sentence */
const SENTENCE_END_RE = /[.!?…]["»”)]*\s*$/u;
/** the microphone steps are said again on another tap only after this long (they stay on screen anyway) */
const MIC_HELP_REPEAT_MS = 20_000;

/**
 * Which voice layer to try first.
 * `silenced` (an automation-driven browser without an explicit opt-in, see ../automation.ts) always wins: no
 * speechSynthesis through the family's speakers, no paid realtime session, no microphone — whatever the settings say.
 */
export function selectVoiceKind(preference: VoicePreference, health: HealthInfo | null, silenced = false, opts: VoiceChainOptions = {}): VoiceKind {
  return selectVoiceChain(preference, health, silenced, opts)[0] ?? 'silent';
}

export interface VoiceChainOptions {
  /** an automation run opted into the real clips layer (muted GainNode, see clips/clipFlags.ts) */
  clipsWhenSilenced?: boolean;
}

/**
 * Generative AI may be used in the child's game (docs/TEACHING.md §4.4): only when the server says so explicitly.
 * An old server without the field, a server that did not answer, or `runtime: false` — no.
 */
export function runtimeAiOf(health: HealthInfo | null | undefined): boolean {
  return health?.ai?.runtime === true;
}

/**
 * The whole order in which voice layers are tried — at start-up and again at runtime when a layer gives up:
 *   'auto'     → what the server prefers (`health.voice.preferred`, 'live' by default) → the other OpenAI voice → browser → silent
 *   'live'     → live → realtime → browser → silent          'realtime' → realtime → live → browser → silent
 *   'browser'  → browser → silent                             'off'      → silent
 *   'clips'    → clips → silent («Записи»: the pre-recorded voice; the robot voice only when the parent picks it)
 * Without the server's runtime AI (`runtimeAiOf`) 'auto' / 'live' / 'realtime' are `AI_OFF_VOICE` (./settings.ts):
 * no OpenAI layer at all. An OpenAI layer is only in the chain when /api/health says the server can open it. Under
 * automation only the silent layer — or, with the e2e opt-in, the clips layer into a muted output (`opts.clipsWhenSilenced`).
 */
export function selectVoiceChain(requested: VoicePreference, health: HealthInfo | null, silenced = false, opts: VoiceChainOptions = {}): VoiceKind[] {
  if (silenced) return opts.clipsWhenSilenced === true ? ['clips', 'silent'] : ['silent'];
  const preference = effectiveVoicePreference(requested, runtimeAiOf(health));
  if (preference === 'off') return ['silent'];
  if (preference === 'clips') return ['clips', 'silent'];
  if (preference === 'browser') return ['browser-tts', 'silent'];
  const first = preference === 'auto' ? (health?.voice.preferred ?? 'live') : preference;
  if (first === 'clips') return ['clips', 'silent'];
  const available = { live: health?.voice.live === true, realtime: health?.voice.realtime === true };
  const kinds = { live: 'openai-live', realtime: 'openai-realtime' } as const;
  const order = first === 'live' ? (['live', 'realtime'] as const) : (['realtime', 'live'] as const);
  return [...order.filter((name) => available[name]).map((name) => kinds[name]), 'browser-tts', 'silent'];
}

export function createCoachController(deps: CoachControllerDeps): CoachController {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());
  const timings: CoachTimings = { ...DEFAULT_COACH_TIMINGS, ...deps.timings, minPoseMs: { ...DEFAULT_COACH_TIMINGS.minPoseMs, ...deps.timings?.minPoseMs } };

  const hintRequested = createEmitter<void>();
  const transcripts = createEmitter<{ who: 'child' | 'coach'; text: string }>();

  let voice: CoachVoiceLayer | null = null;
  let voiceUnsubs: Unsubscribe[] = [];
  const silent = deps.createVoice('silent');
  let health: HealthInfo | null = null;
  let initPromise: Promise<void> | null = null;
  let disposed = false;
  /** the order of layers for the current preference, and where in it the active layer sits */
  let chain: VoiceKind[] = ['silent'];
  let chainIndex = 0;
  /** the active layer gave up while a phrase was playing: the swap happens right after it */
  let failoverPending = false;
  /**
   * The preferred paid layer gave up at runtime (see the file header): where it sits in the chain, how often it failed,
   * when it may be tried again (null = never: a permanent failure), whether a try runs now / it came back.
   */
  let degraded: { index: number; kind: VoiceKind; failures: number; retryAt: number | null; reason: string; code: string | null; trying: boolean; back: boolean } | null =
    null;
  /** the preferred layer is being set up again: the queue waits for it (bounded by the layer's init timeout) */
  let restoring: Promise<void> | null = null;
  let resumeAfterUnmute = false;
  let settingUp: Promise<void> | null = null;

  // queue state
  let queue: QueueItem[] = [];
  let current: QueueItem | null = null;
  /** the phrase being said goes to a sounding layer (the real voice, not the silent one) — see speaksAloud() */
  let currentOnVoice = false;
  let interruptCurrent: (() => void) | null = null;
  let pumping = false;
  let seq = 0;
  let lastSpeechEndedAt = -Infinity;
  /** stopSpeaking() shortens how long the bubble of the interrupted phrase stays */
  let lingerOverrideMs: number | null = null;
  /** what the child has heard of the current phrase (a gentle stop decides by it) */
  let heard: HeardPhrase | null = null;
  /** the current phrase ends its sentence after the child moved (`stopSpeaking({ grace: true })`) */
  let graceStop: GraceStop | null = null;

  // pose state
  let listening = false;
  let childSpeaking = false;
  let thinking = false;
  let freeAnswer = false;
  let asleep = false;
  /** why he sleeps (null while awake) — decides who may wake him, see SleepReason */
  let sleepReason: SleepReason | null = null;
  let poseHold: { pose: MascotPose; until: number } | null = null;

  // money: who was active last, and what the layer reports while WE close it
  /** the last thing the CHILD did (a move, a tap, speech); the game's idle limit counts from here */
  let lastChildActivityAt = now();
  /** «Я задремал…» was shown for this child-activity stamp: once per dozing off, not again without the child */
  let sleepNoticeFor = -Infinity;
  /** true while the controller itself closes the session: what the layer emits then is not the child's activity */
  let suspending = false;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  let pageUnsubs: Unsubscribe[] = [];
  // the daily limit
  /** the server's total for a local day, and when it was asked for (sessions closed here after that are added) */
  let serverUsage: { day: string; seconds: number; requestedAt: number } | null = null;
  let lastUsageFetchAt = -Infinity;
  let usageFetch: Promise<void> | null = null;
  /** paid sessions that closed on this page (the layer reported them to the server) */
  let closedSessions: { day: string; at: number; seconds: number }[] = [];
  /** the paid session open right now: since when (null = none) */
  let sessionOpenedAt: number | null = null;
  /** the local day whose minutes are used up (null = not reached) */
  let limitDay: string | null = null;
  let limitAnnouncedDay: string | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let midnightTimer: ReturnType<typeof setTimeout> | null = null;

  // speaking flags of the two layers that can talk
  let voiceSpeaking = false;
  let silentSpeaking = false;

  let toolHost: CoachToolHost | null = null;
  let fallbackHintLevel: HintLevel = 1;
  /** «Записи»: the «Спроси» chips — the game answers them; the last phrase said is «Повтори»'s */
  const asks = createEmitter<CoachAsk>();
  /** G2: a late phrase sounds (true) / stopped (false) — the game holds the child's clock meanwhile */
  const lateSpeech = createEmitter<boolean>();
  let lastSpoken: CoachEvent | null = null;
  let repeatSeq = 0;

  // the conversation
  /** the child (or a game start) wants the conversation: kept open during a game, reopened after a drop */
  let conversationOn = false;
  /** the child ended it («Пока!»): phrases stay in the bubble until the next start (no session, no microphone) */
  let conversationPaused = false;
  /** the running game (null outside one): `examMode` and `coachStyle` are normalised by onGameStart */
  let gameInfo: { timeControlId: TimeControlId; examMode: boolean; coachStyle: CoachStyle } | null = null;
  /**
   * the game that just ended (until the next start): the game store tells the coach about the end BEFORE it says the
   * lesson's closing phrase (the outcome + the one takeaway), which is still that game's own turn («Дозапись голоса»)
   */
  let endedGame: { examMode: boolean; at: number } | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let lastHelloAt = -Infinity;
  // the long-silence nudge
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastNudgeAt = -Infinity;
  let nudgedSinceActivity = false;
  // the phrase being said by the model in its own words
  let briefItem: QueueItem | null = null;
  let briefCaptionShown = false;
  let briefBubbleTimer: ReturnType<typeof setTimeout> | null = null;
  /** a tool answer's template bubble, shown only when the model's own words do not come */
  let toolBubbleTimer: ReturnType<typeof setTimeout> | null = null;

  let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  let freeAnswerTimer: ReturnType<typeof setTimeout> | null = null;
  let poseTimer: ReturnType<typeof setTimeout> | null = null;
  let sleepTimer: ReturnType<typeof setTimeout> | null = null;

  /** the event whose bubble carries the «не озвучено» / «записываю голос…» mark (null = none) */
  let markFor: string | null = null;
  /** «Дозапись голоса» outside a game: the child's own screens (App.tsx) — off by default */
  let recordingScope = false;
  /** G2: bumped by everything that ends the moment of the bubble on screen (a newer phrase, a stop, mute …) */
  let lateEpoch = 0;
  /** G2: bumped on every ply and take-back (`noteBoardChange`) */
  let boardEpoch = 0;
  /** G2: the silent phrase on screen whose recording may still arrive in time (null = none) */
  let late: LateCandidate | null = null;
  let lateTimer: ReturnType<typeof setTimeout> | null = null;
  /** G2: the layer playing (or loading) a late phrase now (null = none), and that phrase */
  let latePlaying: LateLayer | null = null;
  let lateEvent: CoachEvent | null = null;
  /** G2: a late phrase ending its sentence after the child moved — the safety cut (`stopGraceMs`) */
  let lateGraceTimer: ReturnType<typeof setTimeout> | null = null;

  const set = (patch: Partial<CoachState>): void => {
    // «не озвучено» belongs to one bubble: any other bubble text (a new phrase, a caption, a clear) drops the mark
    if (patch.bubbleText !== undefined && patch.unvoiced === undefined && store.getState().unvoiced) {
      markFor = null;
      store.setState({ ...patch, unvoiced: false, unvoicedMark: null });
    } else store.setState(patch);
  };

  const isAutomated = deps.isAutomated ?? (() => isAutomatedBrowser());

  /** the recorded overlay of the clip layer speaking now (the poller reloads it when the server publishes a phrase) */
  function overlayHandle(): ClipOverlayHandle | null {
    const layer = voice;
    if (!isClipLayer(layer) || typeof layer.reloadOverlay !== 'function') return null;
    const reload = layer.reloadOverlay.bind(layer);
    return {
      async reload() {
        const changed = await reload();
        // the parent's library line follows the merged library; the bubble on screen may have its voice now (G2)
        if (changed && voice === layer && !disposed) {
          set({ clipLibrary: layer.libraryStatus() });
          tryLate();
        }
        return changed;
      },
      // the poller counts a published version as seen only once the library holds it (a failed reload is retried)
      version: () => (voice === layer ? (layer.overlayVersion?.() ?? null) : null),
    };
  }

  const onDemand = deps.clipGen ? createClipOnDemand({ api: deps.clipGen, isAutomated, overlay: overlayHandle, now }) : null;

  /** the layers to try for a preference (automation: silent — or the muted clips layer when a test opted in) */
  function chainFor(preference: VoicePreference): VoiceKind[] {
    const silenced = deps.isSilenced?.() ?? false;
    return selectVoiceChain(preference, health, silenced, { clipsWhenSilenced: silenced && (deps.clipsWhenSilenced?.() ?? false) });
  }

  // ───────────────────────── pose ─────────────────────────

  function computePose(): MascotPose {
    if (listening || childSpeaking) return 'listen';
    if (current) return current.event.pose;
    if (poseHold && now() < poseHold.until) return poseHold.pose;
    if (thinking) return 'think';
    if (freeAnswer) return 'talk';
    if (asleep) return 'sleep';
    return 'idle';
  }

  function refreshPose(): void {
    const pose = computePose();
    const state = store.getState();
    if (state.pose !== pose || state.asleep !== asleep || state.listening !== listening) set({ pose, asleep, listening });
  }

  function holdPose(pose: MascotPose, ms: number): void {
    if (poseTimer !== null) clearTimeout(poseTimer);
    poseHold = { pose, until: now() + ms };
    poseTimer = setTimeout(() => {
      poseTimer = null;
      poseHold = null;
      refreshPose();
    }, ms);
  }

  /** a game's pose longer than this is a mistake: the mascot must never freeze in one pose */
  const SHOW_POSE_MAX_MS = 10_000;

  /**
   * A pose without words (a quiet turn's nod, the joy over a find over the praise cap). No bubble, no sound, not the
   * queue: the bubble of an earlier phrase keeps its own timer, a phrase being said keeps its pose (play() drops the
   * hold when the next phrase starts), a nap is not ended by it (only the child wakes a game that dozed off).
   */
  function showPose(pose: MascotPose, ms: number): void {
    if (disposed || asleep || !Number.isFinite(ms) || ms <= 0) return;
    // listening is the child's turn to speak: nothing to show over it
    if (listening || childSpeaking) return;
    holdPose(pose, Math.min(SHOW_POSE_MAX_MS, Math.max(ms, timings.minPoseMs[pose] ?? 0)));
    refreshPose();
  }

  /** see CoachController.speaksAloud */
  function speaksAloud(): boolean {
    if (disposed || current === null || !currentOnVoice || voice === null || voice.kind === 'silent') return false;
    const state = store.getState();
    return !state.muted && !state.unvoiced && !state.hearingCheck && !gestureLocked();
  }

  // ───────────────────────── idle / sleep ─────────────────────────

  function isBusy(): boolean {
    return current !== null || queue.length > 0 || listening || childSpeaking || thinking || freeAnswer || latePlaying !== null;
  }

  /** the layer can close a paid session (Live / Realtime) */
  function hasPaidSession(): boolean {
    return typeof voice?.suspend === 'function';
  }

  /** the paid session is open right now */
  function sessionOpen(): boolean {
    return voice?.connected === true;
  }

  /** a game screen is up with a paid voice: the 2-minute rule counted from the CHILD's last activity applies */
  function gameIdleRule(): boolean {
    return hasPaidSession() && toolHost !== null;
  }

  /**
   * A free voice only naps for show (60 s). A paid voice sleeps for real — the session and the microphone close:
   * outside a game after 90 s without any activity; in a game 2 min after the CHILD's last activity, whatever the
   * coach or the bot did in between (see onIdleTimer).
   */
  function idleDelayMs(): number {
    if (gameIdleRule()) return Math.max(0, lastChildActivityAt + timings.voiceIdleInGameMs - now());
    return hasPaidSession() ? timings.voiceIdleMs : timings.sleepAfterMs;
  }

  function armIdleTimers(): void {
    if (sleepTimer !== null) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (disposed || asleep) return;
    sleepTimer = setTimeout(onIdleTimer, idleDelayMs());
  }

  function onIdleTimer(): void {
    sleepTimer = null;
    if (disposed || asleep) return;
    if (gameIdleRule()) {
      const idleFor = now() - lastChildActivityAt;
      if (idleFor < timings.voiceIdleInGameMs) {
        armIdleTimers();
        return;
      }
      // the child is gone; a phrase already in flight — or the model's own words still audible — may end first
      // (a session closed mid-utterance cuts the coach off mid-word; a cut phrase would go to the robot voice) — bounded
      if ((isBusy() || voiceSpeaking) && idleFor < timings.voiceIdleInGameMs + timings.idleBusyGraceMs) {
        sleepTimer = setTimeout(onIdleTimer, 1000);
        return;
      }
      fallAsleep('gameIdle');
      return;
    }
    if (isBusy()) {
      armIdleTimers();
      return;
    }
    fallAsleep('idle');
  }

  /**
   * Closes the paid session ourselves. Whatever the layer emits while closing (a flushed transcript, «child stopped
   * speaking», connected=false) is NOT activity — such an echo would reopen the session at once.
   */
  function suspendVoice(opts?: { pageHide?: boolean }): void {
    if (!voice?.suspend) return;
    // the self-check was about the session that closes now
    clearHearingCheck();
    suspending = true;
    try {
      voice.suspend(opts?.pageHide ? { pageHide: true } : undefined);
    } finally {
      suspending = false;
    }
  }

  function fallAsleep(reason: SleepReason): void {
    // something paid was running or wanted: worth a word to the child
    const sessionWanted = sessionOpen() || conversationOn;
    diag('sleep', { reason, session: sessionOpen(), speaking: voiceSpeaking, busy: isBusy(), idleS: Math.round((now() - lastChildActivityAt) / 1000) });
    asleep = true;
    sleepReason = reason;
    cancelReconnect();
    clearNudge();
    suspendVoice();
    if (reason === 'gameIdle' && sessionWanted && !store.getState().muted && sleepNoticeFor !== lastChildActivityAt && !current) {
      sleepNoticeFor = lastChildActivityAt;
      cancelBubbleTimer();
      set({ bubbleText: GAME_SLEEP_BUBBLE_RU });
    }
    refreshPose();
  }

  function clearSleepNotice(): void {
    if (!current && store.getState().bubbleText === GAME_SLEEP_BUBBLE_RU) {
      cancelBubbleTimer();
      set({ bubbleText: '' });
    }
  }

  /** the mascot wakes up and — when allowed — the session reconnects right away (< 2 s), so an open microphone hears the child again */
  function wakeUp(by: 'child' | 'coach'): void {
    diag('wake', { by });
    asleep = false;
    sleepReason = null;
    clearSleepNotice();
    if (!store.getState().muted && !conversationPaused && mayOpenSession(by)) voice?.resume?.();
    refreshPose();
  }

  /**
   * The COACH did something (a phrase, his own words, thinking): the mascot stays awake outside a game. It never wakes
   * a game that dozed off or a hidden page — only the child does — and in a game it does not move the idle limit.
   */
  function keepAwake(): void {
    if (suspending) return;
    if (asleep) {
      if (sleepReason !== 'idle') return;
      wakeUp('coach');
    }
    armIdleTimers();
  }

  /** the CHILD did something (a move, a tap, speech): awake, the idle clock and the silence nudge start over */
  function noteActivity(): void {
    if (suspending || disposed) return;
    lastChildActivityAt = now();
    if (asleep) wakeUp('child');
    armIdleTimers();
    nudgedSinceActivity = false;
    armSilenceNudge();
  }

  // ───────────────────────── the page: hidden tab, closing ─────────────────────────

  function pageHidden(): boolean {
    return deps.page?.isHidden() ?? false;
  }

  function cancelHiddenTimer(): void {
    if (hiddenTimer !== null) {
      clearTimeout(hiddenTimer);
      hiddenTimer = null;
    }
  }

  function onVisibilityChange(): void {
    if (disposed) return;
    diag('page.visible', { visible: !pageHidden() });
    if (pageHidden()) {
      // nobody looks at the bubble now: it never gets its voice later
      invalidateLate('hidden');
      hiddenTimer ??= setTimeout(onHiddenLong, timings.hiddenSuspendMs);
      return;
    }
    cancelHiddenTimer();
    if (!asleep || sleepReason !== 'hidden') return;
    // back: a game with the conversation on is there again by itself; anything else sleeps on until it is needed
    if (toolHost !== null && gameInfo !== null && conversationOn) noteActivity();
    else sleepReason = gameIdleRule() ? 'gameIdle' : 'idle';
  }

  function onHiddenLong(): void {
    hiddenTimer = null;
    if (disposed || !pageHidden() || asleep || !hasPaidSession()) return;
    fallAsleep('hidden');
  }

  function onPageHide(): void {
    if (disposed) return;
    cancelHiddenTimer();
    diag('pagehide', { session: sessionOpen() });
    if (!hasPaidSession()) return;
    asleep = true;
    sleepReason = 'hidden';
    cancelReconnect();
    clearNudge();
    suspendVoice({ pageHide: true });
    refreshPose();
  }

  function installPageListeners(): void {
    const page = deps.page;
    if (!page || pageUnsubs.length > 0) return;
    pageUnsubs = [
      page.onVisibilityChange(onVisibilityChange),
      page.onPageHide(onPageHide),
      // any touch in a game says «the child is here» (the board, the take-back buttons …); outside a game only the
      // screens' own calls count, so a stray click on the home screen never reopens a paid session
      ...(page.onUserInput ? [page.onUserInput(() => toolHost !== null && noteActivity())] : []),
    ];
    if (pageHidden()) onVisibilityChange();
  }

  // ───────────────────────── the daily limit ─────────────────────────

  function dailyLimitSeconds(): number {
    const minutes = store.getState().voiceDailyLimitMin;
    return minutes > 0 ? minutes * 60 : 0;
  }

  /** paid seconds of today as far as this page knows: the server's total + sessions closed here since + the open one */
  function usedSecondsToday(): number {
    const t = now();
    const day = localDayKey(t);
    const server = serverUsage?.day === day ? serverUsage : null;
    let seconds = server?.seconds ?? 0;
    for (const closed of closedSessions) if (closed.day === day && (server === null || closed.at >= server.requestedAt)) seconds += closed.seconds;
    if (sessionOpenedAt !== null) seconds += Math.max(0, t - sessionOpenedAt) / 1000;
    return seconds;
  }

  /** GET /api/voice/usage at most once per `usageCheckMs`; a failure keeps the last answer (the local count goes on) */
  function refreshUsage(): Promise<void> {
    const fetchUsage = deps.getVoiceUsage;
    if (!fetchUsage || disposed || dailyLimitSeconds() === 0 || !hasPaidSession()) return Promise.resolve();
    if (usageFetch) return usageFetch;
    const requestedAt = now();
    if (requestedAt - lastUsageFetchAt < timings.usageCheckMs) return Promise.resolve();
    lastUsageFetchAt = requestedAt;
    const day = localDayKey(requestedAt);
    usageFetch = Promise.resolve()
      .then(fetchUsage)
      .then(
        (usage) => {
          if (usage && Number.isFinite(usage.todaySeconds)) serverUsage = { day, seconds: Math.max(0, usage.todaySeconds), requestedAt };
        },
        () => undefined,
      )
      .finally(() => {
        usageFetch = null;
        if (!disposed) enforceLimit();
      });
    return usageFetch;
  }

  function clearLimitTimer(): void {
    if (limitTimer !== null) {
      clearTimeout(limitTimer);
      limitTimer = null;
    }
  }

  /** while a paid session is open: look again when the minutes would run out, at the latest in `usageCheckMs` */
  function armLimitCheck(): void {
    clearLimitTimer();
    const limit = dailyLimitSeconds();
    if (disposed || limit === 0 || sessionOpenedAt === null) return;
    const remainingMs = (limit - usedSecondsToday()) * 1000;
    limitTimer = setTimeout(
      () => {
        limitTimer = null;
        if (!enforceLimit()) void refreshUsage();
      },
      Math.max(1000, Math.min(timings.usageCheckMs, remainingMs)),
    );
  }

  function resetLimit(): void {
    limitDay = null;
    if (midnightTimer !== null) {
      clearTimeout(midnightTimer);
      midnightTimer = null;
    }
    if (store.getState().voiceLimitReached) set({ voiceLimitReached: false });
  }

  /** once a day, in the bubble: why the coach writes instead of talking */
  function announceLimit(): void {
    const day = localDayKey(now());
    if (limitAnnouncedDay === day || disposed) return;
    limitAnnouncedDay = day;
    void say({ id: `voice-limit-${day}`, kind: 'answer', priority: 1, text: VOICE_LIMIT_BUBBLE_RU, bubbleText: VOICE_LIMIT_BUBBLE_RU, pose: 'talk', pauseClock: false });
  }

  /**
   * true = today's paid minutes are used up: the session (open or opening) is closed, the conversation is off, the
   * coach goes on in the bubble, and nothing paid opens again before local midnight.
   */
  function enforceLimit(): boolean {
    if (disposed) return false;
    const day = localDayKey(now());
    if (limitDay !== null && limitDay !== day) resetLimit(); // a new day
    const limit = dailyLimitSeconds();
    if (limit === 0 || !isConversationalLayer(voice) || (limitDay !== day && usedSecondsToday() < limit)) {
      armLimitCheck();
      return false;
    }
    if (limitDay !== day) {
      limitDay = day;
      diag('limit', { limitMin: store.getState().voiceDailyLimitMin, usedS: Math.round(usedSecondsToday()) });
      set({ voiceLimitReached: true });
      midnightTimer = setTimeout(
        () => {
          midnightTimer = null;
          resetLimit();
        },
        msUntilLocalMidnight(now()) + 1000,
      );
    }
    clearLimitTimer();
    const open = sessionOpen() || store.getState().conversationState === 'connecting';
    const wanted = conversationOn;
    if (wanted) setConversationOn(false);
    cancelReconnect();
    if (open) suspendVoice();
    if (open || wanted) announceLimit();
    return true;
  }

  /**
   * May a paid session be opened now, and for whom? Never in a hidden tab, never once today's minutes are used up;
   * the coach's own phrase never ends the nap of a game that dozed off (only the child does).
   */
  function mayOpenSession(by: 'child' | 'coach'): boolean {
    if (disposed || pageHidden()) return false;
    if (by === 'coach' && asleep && sleepReason !== 'idle') return false;
    if (dailyLimitSeconds() > 0) {
      void refreshUsage();
      if (enforceLimit()) return false;
    }
    return true;
  }

  /** the paid session opened / closed (the layer's connected flag): the local half of today's count */
  function noteSessionConnected(connected: boolean): void {
    const t = now();
    if (connected) {
      sessionOpenedAt ??= t;
      // a connect that was already in flight when the limit was reached is closed again at once
      enforceLimit();
      void refreshUsage();
      return;
    }
    if (sessionOpenedAt === null) return;
    const day = localDayKey(t);
    closedSessions = [...closedSessions.filter((closed) => closed.day === day), { day, at: t, seconds: Math.max(0, t - sessionOpenedAt) / 1000 }];
    sessionOpenedAt = null;
    clearLimitTimer();
  }

  // ───────────────────────── the long-silence nudge (design D) ─────────────────────────

  function clearNudge(): void {
    if (nudgeTimer !== null) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
  }

  function nudgeAllowed(): boolean {
    return (
      !disposed &&
      gameInfo !== null &&
      gameInfo.examMode !== true &&
      // teacher mode: the teacher speaks every move — the 60 s nudge is off (P0; P1 = a reminder of the advice, by the game)
      gameInfo.coachStyle !== 'teacher' &&
      NUDGE_TIME_CONTROLS.has(gameInfo.timeControlId) &&
      conversationOn &&
      !asleep &&
      isConversationalLayer(voice) &&
      !store.getState().muted
    );
  }

  /** (re)starts the 60 s silence clock */
  function armSilenceNudge(): void {
    clearNudge();
    if (!nudgeAllowed() || nudgedSinceActivity) return;
    nudgeTimer = setTimeout(fireNudge, timings.silenceNudgeMs);
  }

  function fireNudge(): void {
    nudgeTimer = null;
    if (!nudgeAllowed() || nudgedSinceActivity) return;
    if (isBusy() || store.getState().childSpeaking) {
      armSilenceNudge();
      return;
    }
    const since = now() - lastNudgeAt;
    if (since < timings.silenceNudgeGapMs) {
      nudgeTimer = setTimeout(fireNudge, timings.silenceNudgeGapMs - since);
      return;
    }
    lastNudgeAt = now();
    nudgedSinceActivity = true;
    void say({
      id: `silence-nudge-${lastNudgeAt}`,
      kind: 'encourage',
      priority: 1,
      text: SILENCE_NUDGE_TEXT_RU,
      bubbleText: SILENCE_NUDGE_TEXT_RU,
      pose: 'talk',
      pauseClock: false,
      brief: SILENCE_NUDGE_BRIEF_RU,
    });
  }

  // ───────────────────────── bubble ─────────────────────────

  function cancelBubbleTimer(): void {
    if (bubbleTimer !== null) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
  }

  function scheduleBubbleClear(ms: number): void {
    cancelBubbleTimer();
    bubbleTimer = setTimeout(() => {
      bubbleTimer = null;
      if (!current && !freeAnswer) set({ bubbleText: '' });
    }, ms);
  }

  /**
   * How long a bubble stays after its phrase: while its recording may still arrive (G2) up to the end of that window —
   * the silent timing (1.2–9 s) plus the usual 6 s is shorter than a recording (≈ 10–25 s), it would never be heard.
   */
  function lingerMs(base: number): number {
    const c = late;
    if (c === null || markFor !== c.event.id) return base;
    return Math.max(base, c.at + lateWindowMs() - now());
  }

  function cancelToolBubble(): void {
    if (toolBubbleTimer !== null) {
      clearTimeout(toolBubbleTimer);
      toolBubbleTimer = null;
    }
  }

  // ───────────────────────── the bubble of a brief: the model's own words ─────────────────────────

  function cancelBriefBubbleTimer(): void {
    if (briefBubbleTimer !== null) {
      clearTimeout(briefBubbleTimer);
      briefBubbleTimer = null;
    }
  }

  /** no words from the model within ~1.5 s: the template's bubble text, so the child is never left without text */
  function armBriefBubbleFallback(item: QueueItem): void {
    cancelBriefBubbleTimer();
    briefBubbleTimer = setTimeout(() => {
      briefBubbleTimer = null;
      if (current === item && briefItem === item && !briefCaptionShown) set({ bubbleText: item.event.bubbleText });
    }, timings.briefCaptionWaitMs);
  }

  function onSayProgress(progress: SayProgress): void {
    const item = briefItem;
    if (!item || current !== item) return;
    switch (progress.type) {
      case 'sent':
        // the wait for a gap in the conversation is over only now: the 1.5 s start from here
        if (!briefCaptionShown) armBriefBubbleFallback(item);
        break;
      case 'caption':
        if (progress.text === '') break;
        briefCaptionShown = true;
        cancelBriefBubbleTimer();
        set({ bubbleText: progress.text });
        keepAwake();
        noteHeardWords(item, progress.text);
        break;
      case 'fallback':
        // the free voice says the template now: the bubble shows the template too
        cancelBriefBubbleTimer();
        briefCaptionShown = false;
        set({ bubbleText: item.event.bubbleText });
        // …and what the child hears is that template, from the moment the free voice sounds
        if (heard?.item === item) heard = { ...heard, ownWords: false, audibleAt: null, words: item.event.text, wordsAt: now(), inStep: false };
        break;
    }
  }

  // ───────────────────────── a gentle stop: the child moved while he speaks ─────────────────────────
  //
  // In a fast 5-minute «Учитель» game the child often moves while Гамбитик is still talking, and a plain stop would cut
  // most teacher remarks mid-word. `stopSpeaking({ grace: true })` drops what is waiting (stale)
  // and a phrase not heard yet, but lets the one he hears end its sentence (Live: seen in its caption, which runs in step
  // with the voice) or its last words (a text read whole: by the time left) — within `stopGraceMs`, then it is cut.

  /** the real voice started to sound: a phrase read whole is audible from now on (a brief — from its first words) */
  function noteVoiceAudible(): void {
    const h = heard;
    if (!h || h.item !== current || !h.voiced || h.ownWords || h.audibleAt !== null) return;
    h.audibleAt = now();
  }

  /** the model's own words so far (its caption): the phrase is audible, and a gentle stop may wait for this sentence end */
  function noteHeardWords(item: QueueItem, text: string): void {
    const h = heard;
    if (!h || h.item !== item || !h.ownWords) return;
    h.audibleAt ??= now();
    h.words = text;
    h.wordsAt = now();
    // Live: the caption comes in step with the voice; Realtime sends its words ahead of the sound
    h.inStep = voice?.kind === 'openai-live';
    checkSentenceEnd();
  }

  /** how the current phrase may end after the child moved: null = cut it now (nothing heard yet, or far from its end) */
  function graceModeFor(item: QueueItem): GraceStop['mode'] | null {
    const h = heard;
    if (!h || h.item !== item || !h.voiced || h.audibleAt === null) return null;
    // «Записи» knows the truth (SPEC §5.5): the exact ms to the end of the sentence being heard. Near it → the layer
    // cancels the later sentences and ends there by itself ('finish'; the stopGraceMs timer stays the safety cut)
    if (isClipLayer(voice)) {
      const left = voice.msToSentenceEnd();
      return left !== null && left <= timings.stopGraceMs && voice.endAfterSentence() ? 'finish' : null;
    }
    if (h.inStep) return 'sentence';
    const left = estimateSpeechMs(h.words) - (now() - h.audibleAt);
    return left <= timings.stopGraceMs ? 'finish' : null;
  }

  function armGrace(item: QueueItem, mode: GraceStop['mode']): void {
    if (graceStop?.item === item) return; // already ending: the first deadline stands
    finishGrace('stop');
    graceStop = { item, mode, since: now(), timer: setTimeout(() => cutGrace('timeout'), timings.stopGraceMs), tailTimer: null };
    checkSentenceEnd();
  }

  /** 'sentence': the caption has just ended a sentence → cut once its last word has sounded */
  function checkSentenceEnd(): void {
    const g = graceStop;
    const h = heard;
    if (!g || g.mode !== 'sentence' || g.tailTimer !== null || !h || h.item !== g.item || !SENTENCE_END_RE.test(h.words)) return;
    const wait = timings.sentenceTailMs - (now() - h.wordsAt);
    if (wait <= 0) cutGrace('sentence');
    else g.tailTimer = setTimeout(() => cutGrace('sentence'), wait);
  }

  function cutGrace(how: 'sentence' | 'timeout'): void {
    const g = graceStop;
    if (!g || current !== g.item) return;
    finishGrace(how);
    interruptCurrent?.();
  }

  /** the gentle stop is over (its phrase ended by itself, was cut, or an urgent phrase / a hard stop came): to the black box */
  function finishGrace(how: 'self' | 'sentence' | 'timeout' | 'urgent' | 'stop'): void {
    const g = graceStop;
    if (!g) return;
    graceStop = null;
    clearTimeout(g.timer);
    if (g.tailTimer !== null) clearTimeout(g.tailTimer);
    diag('coach.grace', { end: how, mode: g.mode, ms: now() - g.since, phrase: g.item.event.kind });
  }

  // ───────────────────────── free answers of the realtime coach ─────────────────────────

  function endFreeAnswer(): void {
    if (freeAnswerTimer !== null) {
      clearTimeout(freeAnswerTimer);
      freeAnswerTimer = null;
    }
    cancelToolBubble();
    if (!freeAnswer) return;
    freeAnswer = false;
    lastSpeechEndedAt = now();
    scheduleBubbleClear(timings.bubbleLingerMs);
    armIdleTimers();
    armSilenceNudge();
    refreshPose();
  }

  function beginFreeAnswer(): void {
    freeAnswer = true;
    cancelBubbleTimer();
    // safety net: a lost "stopped speaking" signal must not leave him talking forever
    if (freeAnswerTimer !== null) clearTimeout(freeAnswerTimer);
    freeAnswerTimer = setTimeout(endFreeAnswer, timings.freeAnswerMaxMs);
  }

  // ───────────────────────── mouth / speaking ─────────────────────────

  function setMouth(level: number): void {
    const quantised = Math.round(Math.min(1, Math.max(0, level)) * 50) / 50;
    if (store.getState().mouthLevel !== quantised) set({ mouthLevel: quantised });
  }

  function publishSpeaking(): void {
    const speaking = voiceSpeaking || silentSpeaking;
    if (store.getState().speaking !== speaking) set({ speaking });
    if (!speaking) setMouth(0);
  }

  silent.onLevel(setMouth);
  silent.onSpeakingChange((value) => {
    silentSpeaking = value;
    publishSpeaking();
  });

  // ───────────────────────── gesture lock ─────────────────────────

  function gestureLocked(): boolean {
    return !store.getState().muted && voice !== null && isGestureGated(voice) && voice.needsUserGesture;
  }

  function publishGesture(): void {
    const needs = gestureLocked();
    if (store.getState().needsUserGesture !== needs) {
      diag('gesture', { needs });
      set({ needsUserGesture: needs });
    }
    if (!needs) void pump();
  }

  // ───────────────────────── hearing self-check ─────────────────────────

  /** after a click on «Не слышно?» the page cannot measure better: 'noMeter' is not offered again */
  let noMeterDismissed = false;

  function onHearingProblem(layer: CoachVoiceLayer, problem: HearingProblem): void {
    if (voice !== layer || disposed) return;
    if (problem === 'noMeter' && noMeterDismissed) return;
    if (store.getState().muted) return;
    if (!store.getState().hearingCheck) {
      diag('hear.offer', { why: problem });
      set({ hearingCheck: true });
    }
  }

  function clearHearingCheck(): void {
    if (store.getState().hearingCheck) set({ hearingCheck: false });
  }

  async function recheckHearing(): Promise<{ play: string; ctx: string } | null> {
    noteActivity();
    const layer = voice;
    noMeterDismissed = true;
    clearHearingCheck();
    // also the plain gesture unlock (browser voice, held phrases) — all of it inside this click
    if (layer && isGestureGated(layer) && !hasVoiceHealth(layer)) layer.unlock();
    if (!hasVoiceHealth(layer)) {
      diag('hear.check', { play: 'nosession', ctx: 'none' });
      publishGesture();
      return null;
    }
    const pending = layer.recheckAudio();
    publishGesture();
    let result: { play: string; ctx: string } | null = null;
    try {
      result = await pending;
    } catch (error) {
      diag('hear.check', { play: 'error', ctx: diagString(error instanceof Error ? error.name : 'Error') });
      return null;
    }
    diag('hear.check', { play: result?.play ?? 'nosession', ctx: result?.ctx ?? 'none' });
    publishGesture();
    return result;
  }

  async function retryMicrophone(): Promise<boolean> {
    noteActivity();
    const layer = voice;
    // «Записи» has no microphone at all: nothing to ask for, no steps to show
    if (!hasVoiceHealth(layer) || layer.kind === 'clips') return false;
    // The site's microphone on «Блокировать»: every retry fails at once (NotAllowedError) and nothing tells the user
    // why. Asking again cannot work then: the steps to allow it instead.
    const permission = readMicPermission();
    if (permission === 'denied') {
      diag('mic.retry.skip', { perm: permission });
      showMicHelp();
      return false;
    }
    diag('mic.retry.tap', { perm: permission });
    const ok = await layer.retryMicrophone();
    diag('mic.retry.done', { ok });
    if (!ok && !disposed) showMicHelp();
    return ok;
  }

  // ───────────────────────── the microphone steps (a blocked site) ─────────────────────────

  let lastMicHelpSaidAt = -Infinity;
  let unwatchMicPermission: Unsubscribe | null = null;

  /** the dock shows where to allow the microphone (until it works, or «Понятно»); he says it too, not on every tap */
  function showMicHelp(): void {
    watchMicPermission();
    if (!store.getState().micHelp) {
      diag('mic.help', { browser: helpBrowser() });
      set({ micHelp: true });
    }
    if (now() - lastMicHelpSaidAt < MIC_HELP_REPEAT_MS) return;
    lastMicHelpSaidAt = now();
    const browser = helpBrowser();
    void say({
      id: `mic-help-${lastMicHelpSaidAt}`,
      kind: 'answer',
      priority: 1,
      text: micHelpSpokenRu(browser),
      bubbleText: micHelpStepsRu(browser),
      pose: 'oops',
      pauseClock: false,
    });
  }

  function dismissMicHelp(): void {
    noteActivity();
    if (store.getState().micHelp) set({ micHelp: false });
  }

  /**
   * The parent changed the site setting: 'granted' — the open session attaches the microphone by itself (rtcSession),
   * 'prompt' — it asks again at once; either way the steps are done with. No reload needed.
   */
  function watchMicPermission(): void {
    if (unwatchMicPermission !== null || disposed) return;
    unwatchMicPermission = (deps.onMicPermissionChange ?? onMicPermissionChange)((state) => {
      if (disposed || (state !== 'granted' && state !== 'prompt')) return;
      diag('mic.help.done', { perm: state });
      if (store.getState().micHelp) set({ micHelp: false });
    });
  }

  function readMicPermission(): MicPermission {
    try {
      return (deps.micPermission ?? micPermissionNow)();
    } catch {
      return 'unknown';
    }
  }

  function helpBrowser(): MicHelpBrowser {
    try {
      return deps.micHelpBrowser ? deps.micHelpBrowser() : micHelpBrowser(typeof navigator === 'undefined' ? undefined : navigator);
    } catch {
      return 'other';
    }
  }

  /**
   * The child's tap while Гамбитик speaks (on loudspeakers the echo guard keeps the microphone closed while he talks —
   * he cannot be talked over): the layer cuts the phrase, hushes the playback and opens the microphone at once; the
   * queue and the bubble stop like any other stop. Nothing is said instead.
   */
  function interrupt(): void {
    if (disposed) return;
    noteActivity();
    const layer = voice;
    diag('coach.interrupt', { kind: layer?.kind ?? 'none', phrase: current?.event.kind ?? null, audible: voiceSpeaking || silentSpeaking });
    layer?.interrupt?.();
    stopSpeaking({}, 'tap');
    if (isConversationalLayer(layer) && sessionOpen()) holdPose('listen', 1500);
    refreshPose();
  }

  // ───────────────────────── voice set-up ─────────────────────────

  function detachVoice(): void {
    // another voice (a failover, a new setting): what the old one might have said late is history
    invalidateLate('voice');
    for (const unsub of voiceUnsubs.splice(0)) unsub();
    voice?.dispose();
    voice = null;
    // the layer closed (and reported) its session while we no longer listened: count it for today's limit
    noteSessionConnected(false);
    voiceSpeaking = false;
    thinking = false;
    listening = false;
    childSpeaking = false;
    cancelReconnect();
    set({ childSpeaking: false, voiceConnected: false, conversationState: 'off', micLevel: 0, hearingCheck: false, clipLibrary: null });
    endFreeAnswer();
  }

  function modelOf(kind: VoiceKind): string | null {
    if (kind === 'openai-live') return health?.voice.liveModel ?? 'gpt-live-1';
    if (kind === 'openai-realtime') return health?.voice.model ?? null;
    // «Записи»: the recorded voice's key (giselle-mm1) — parent-facing status only
    if (kind === 'clips' && isClipLayer(voice)) return voice.libraryStatus()?.voiceKey ?? null;
    return null;
  }

  // ───────────────────────── keeping the conversation of a game open ─────────────────────────

  function cancelReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function onLayerConversationState(layer: CoachVoiceLayer, state: ConversationState): void {
    if (voice !== layer) return;
    if (store.getState().conversationState !== state) set({ conversationState: state });
    if (state === 'listening' || state === 'childSpeaking' || state === 'coachSpeaking' || state === 'thinking') {
      reconnectAttempts = 0;
      return;
    }
    // A connected session in 'error' is a refused microphone, not a dropped session: «reconnecting» closed the working
    // session and opened a new billed one only to show the permission prompt again (Chrome counts dismissals and
    // blocks the site after three). The button says «Микрофон закрыт»; the child's tap asks again on this session.
    if (state === 'error' && layer.connected === true) {
      diag('reconnect.skip', { why: 'mic' });
      return;
    }
    // a game with the conversation on: a dropped (or expired) session is opened again — bounded, never in a loop
    const wanted = conversationOn && toolHost !== null && !asleep && !suspending && !store.getState().muted && !conversationPaused;
    if ((state === 'off' || state === 'error') && wanted && reconnectTimer === null && reconnectAttempts < 3) {
      reconnectAttempts += 1;
      diag('reconnect', { attempt: reconnectAttempts, after: state });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (voice === layer && conversationOn && !asleep && !store.getState().muted && mayOpenSession('child')) void layer.openConversation?.();
      }, timings.reconnectDelayMs);
    }
  }

  /** microphone mode, the loudspeaker echo guard and the child's own mic switch → the active layer */
  function applyMicSettings(): void {
    const state = store.getState();
    const layer = voice;
    if (!layer) return;
    layer.setEchoGuard?.(state.micMode === 'open' && !state.headphonesConfirmed);
    layer.setMicMuted?.(state.micMuted);
    void layer.setMicMode?.(state.micMode)?.catch((error: unknown) => console.warn('[coach] mic mode failed', error instanceof Error ? error.message : error));
  }

  function attachVoice(layer: CoachVoiceLayer): void {
    voice = layer;
    voiceUnsubs = [
      layer.onLevel(setMouth),
      layer.onSpeakingChange((value) => {
        voiceSpeaking = value;
        if (value) noteVoiceAudible();
        publishSpeaking();
        // the realtime coach finished an answer of its own
        if (!value) endFreeAnswer();
      }),
    ];
    if (layer.onTranscript) {
      voiceUnsubs.push(
        layer.onTranscript((who, text) => {
          // speech from either side keeps the session awake; the child talking also counts as activity
          if (who === 'child') noteActivity();
          else {
            keepAwake();
            armSilenceNudge();
          }
          transcripts.emit({ who, text });
        }),
      );
    }
    if (layer.onChildSpeakingChange) {
      voiceUnsubs.push(
        layer.onChildSpeakingChange((value) => {
          // Only a real change is the child's activity: closing an idle session re-announces «child not speaking»,
          // which would count as activity, wake the mascot and REOPEN the session at once.
          const changed = childSpeaking !== value;
          childSpeaking = value;
          if (store.getState().childSpeaking !== value) set({ childSpeaking: value });
          if (changed) noteActivity();
          refreshPose();
        }),
      );
    }
    if (layer.onConversationState) voiceUnsubs.push(layer.onConversationState((state) => onLayerConversationState(layer, state)));
    if (layer.onSayProgress) voiceUnsubs.push(layer.onSayProgress(onSayProgress));
    if (layer.onMicLevel) {
      voiceUnsubs.push(
        layer.onMicLevel((level) => {
          const quantised = Math.round(Math.min(1, Math.max(0, level)) * 20) / 20;
          if (store.getState().micLevel !== quantised) set({ micLevel: quantised });
        }),
      );
    }
    if (layer.onConnectedChange) {
      voiceUnsubs.push(
        layer.onConnectedChange((connected) => {
          set({ voiceConnected: connected });
          if (voice === layer) noteSessionConnected(connected);
          if (connected && voice === layer) notePreferredBack();
        }),
      );
    }
    if (layer.onUnavailable) {
      voiceUnsubs.push(
        layer.onUnavailable((reason, detail) => {
          if (voice !== layer) return;
          console.info(`[coach] voice layer "${chain[chainIndex] ?? layer.kind}" gave up (${reason}) — moving down the chain`);
          noteLayerGaveUp(layer, reason, detail);
          if (current) failoverPending = true;
          else void failover();
        }),
      );
    }
    if (isGestureGated(layer)) voiceUnsubs.push(layer.onNeedsUserGestureChange(publishGesture));
    if (hasVoiceHealth(layer)) {
      voiceUnsubs.push(
        layer.onHearingProblem((problem) => onHearingProblem(layer, problem)),
        layer.onHearingOk(() => voice === layer && clearHearingCheck()),
      );
    }
    if (layer.onKindChange) voiceUnsubs.push(layer.onKindChange((kind) => set({ voiceKind: kind, voiceModel: modelOf(kind) })));
    // the microphone works again (allowed in the site settings, no reload): the steps are done with
    if (layer.onMicAvailableChange) voiceUnsubs.push(layer.onMicAvailableChange((available) => set(available ? { micAvailable: true, micHelp: false } : { micAvailable: false })));
    if (layer.onThinkingChange) {
      voiceUnsubs.push(
        layer.onThinkingChange((value) => {
          thinking = value;
          if (value) keepAwake();
          refreshPose();
        }),
      );
    }
    if (layer.onCoachCaption) {
      voiceUnsubs.push(
        layer.onCoachCaption((text) => {
          if (current) return;
          beginFreeAnswer();
          // the model's own words replace the template of a tool answer
          cancelToolBubble();
          set({ bubbleText: text });
          keepAwake();
          refreshPose();
        }),
      );
    }
    if (layer.onToolCoachEvent) {
      voiceUnsubs.push(
        layer.onToolCoachEvent((event) => {
          // the model phrases the facts itself: arrows at once, the template's bubble only if its words do not come
          if (current) return;
          beginFreeAnswer();
          if (event.board) set({ annotations: event.board });
          cancelToolBubble();
          toolBubbleTimer = setTimeout(() => {
            toolBubbleTimer = null;
            if (!current && freeAnswer) set({ bubbleText: event.bubbleText });
          }, timings.briefCaptionWaitMs);
          refreshPose();
        }),
      );
    }
    layer.setToolHost?.(toolHost);
    applyMicSettings();
  }

  /** a layer's init() is bounded: a stalled network must never keep `ready` false and the queue stuck */
  function initWithTimeout(layer: VoiceLayer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('init timed out')), timings.voiceInitTimeoutMs);
      layer.init().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async function runSetUp(fromIndex: number): Promise<void> {
    if (fromIndex === 0) chain = chainFor(store.getState().voicePreference);
    // a set-up that was queued behind another one must not leave that one's layer attached (and its session open)
    if (voice) detachVoice();
    for (let index = fromIndex; index < chain.length; index++) {
      const kind = chain[index];
      if (kind === undefined) continue;
      const layer: CoachVoiceLayer = deps.createVoice(kind);
      chainIndex = index;
      attachVoice(layer);
      try {
        await initWithTimeout(layer);
        if (disposed) {
          detachVoice();
          return;
        }
        // a layer that already fell back to another voice while starting is not the layer that was asked for
        if (layer.kind !== kind && index < chain.length - 1 && !(deps.isSilenced?.() ?? false)) throw new Error(`came up as "${layer.kind}"`);
        set({
          voiceKind: layer.kind,
          voiceModel: modelOf(layer.kind),
          micAvailable: layer.micAvailable ?? false,
          voiceConnected: layer.connected ?? false,
          clipLibrary: isClipLayer(layer) ? layer.libraryStatus() : null,
        });
        // «Записи»: a game already running when the layer came up counts its utterances from now
        if (isClipLayer(layer) && gameInfo) layer.setGame({ timeControlId: gameInfo.timeControlId });
        diag('layer', { kind: layer.kind, index, pref: store.getState().voicePreference, micMode: store.getState().micMode, headphones: store.getState().headphonesConfirmed });
        publishGesture();
        armIdleTimers();
        return;
      } catch (error) {
        console.warn(`[coach] voice layer "${kind}" is unavailable`, error instanceof Error ? error.message : error);
        diag('layer.fail', { kind, err: diagString(error instanceof Error ? error.message.slice(0, 64) : 'Error') });
        detachVoice();
      }
    }
  }

  /** set-ups never overlap: a settings change during a failover waits for it */
  function setUpVoice(fromIndex = 0): Promise<void> {
    const previous = settingUp ?? Promise.resolve();
    const run = previous.then(() => (disposed ? undefined : runSetUp(fromIndex)));
    settingUp = run.catch(() => undefined);
    return run;
  }

  // ───────────────────────── the preferred voice: given up, told, tried again ─────────────────────────

  function restoreDelayMs(failures: number): number {
    return Math.min(timings.voiceRestoreMaxMs, timings.voiceRestoreBaseMs * 2 ** Math.max(0, failures - 1));
  }

  /** a paid layer gave up: remember the preferred one (the first to give up) with its reason and when to try it again */
  function noteLayerGaveUp(layer: CoachVoiceLayer, reason: string, detail?: UnavailableDetail): void {
    const kind = chain[chainIndex] ?? layer.kind;
    if (!isOpenAiVoiceKind(kind)) return;
    // the fallback gave up too: the preferred one stays the one to come back to
    if (degraded !== null && chainIndex > degraded.index) return;
    const permanent = detail?.permanent === true || reason === 'no API key';
    const failures = degraded !== null && degraded.index === chainIndex ? degraded.failures + 1 : 1;
    const retryAt = permanent ? null : now() + restoreDelayMs(failures);
    degraded = { index: chainIndex, kind, failures, retryAt, reason, code: detail?.code ?? null, trying: false, back: false };
    diag('voice.degraded', { from: kind, reason: diagString(reason), code: detail?.code ?? null, failures, retryS: retryAt === null ? null : Math.round((retryAt - now()) / 1000) });
  }

  /** what the parent sees (dock status line, Settings): which model speaks instead, why, when the preferred one is tried again */
  function publishFallback(): void {
    const d = degraded;
    const speaking = voice?.kind ?? 'silent';
    const info = d === null || d.back || chainIndex <= d.index ? null : { from: d.kind, to: speaking, reason: d.reason, code: d.code, retryAt: d.retryAt };
    const before = store.getState().voiceFallback;
    if (JSON.stringify(before) !== JSON.stringify(info)) set({ voiceFallback: info });
  }

  /** the preferred layer is up and connected again */
  function notePreferredBack(): void {
    const d = degraded;
    if (d === null || chainIndex !== d.index || d.back) return;
    d.back = true;
    d.trying = false;
    diag('voice.restored', { kind: d.kind, failures: d.failures });
    publishFallback();
  }

  /**
   * At a conversation start (a game start, «Поговорить»): the preferred paid layer that gave up for a passing reason is
   * tried again once its pause is over — never in the middle of a phrase or of a turn of the conversation. Returns the
   * set-up in flight (the caller waits for it), or null.
   */
  function restorePreferredVoice(why: 'gameStart' | 'talk'): Promise<void> | null {
    const d = degraded;
    if (d === null || d.back || d.trying || d.retryAt === null || now() < d.retryAt || restoring !== null) return null;
    if (disposed || (deps.isSilenced?.() ?? false) || chainIndex <= d.index) return null;
    if (current !== null || voiceSpeaking || childSpeaking || thinking) return null;
    // the settings changed the chain meanwhile: nothing to come back to
    if (chain[d.index] !== d.kind) {
      degraded = null;
      publishFallback();
      return null;
    }
    d.trying = true;
    diag('voice.restore', { to: d.kind, why, failures: d.failures });
    const run = setUpVoice(d.index).then(() => {
      // it did not even start (init failed → the chain moved on again): wait for the next pause
      if (voice !== null && chainIndex !== d.index) {
        d.trying = false;
        d.failures += 1;
        d.retryAt = now() + restoreDelayMs(d.failures);
      }
      publishFallback();
      refreshPose();
    });
    restoring = run.finally(() => {
      restoring = null;
    });
    return restoring;
  }

  /** the active layer declared itself unavailable at runtime: next one in the same order */
  async function failover(): Promise<void> {
    failoverPending = false;
    if (disposed || !voice) return;
    const next = chainIndex + 1;
    if (next >= chain.length) return;
    diag('failover', { from: chain[chainIndex] ?? voice.kind, to: chain[next] ?? 'none', conversation: conversationOn });
    detachVoice();
    set({ micAvailable: false, listening: false });
    await setUpVoice(next);
    publishFallback();
    refreshPose();
    // a conversation that was running goes on with the next conversational voice (Live → Realtime)
    if (conversationOn) {
      if (isConversationalLayer(voice)) void openConversationOn(voice);
      else setConversationOn(false);
    }
    void pump();
  }

  function withTimeoutOrNull<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        },
      );
    });
  }

  function init(): Promise<void> {
    initPromise ??= (async () => {
      const settings = loadCoachSettings(deps.getStorage());
      set({
        muted: settings.muted,
        voicePreference: settings.voice,
        micMode: settings.micMode,
        headphonesConfirmed: settings.headphonesConfirmed,
        talkativeness: settings.talkativeness,
        autoConversation: settings.autoConversation,
        voiceDailyLimitMin: settings.voiceDailyLimitMin,
      });
      installPageListeners();
      // server down or slow: the free browser voice still works, and the greeting must not wait for the network
      health = await withTimeoutOrNull(Promise.resolve().then(deps.getHealth), timings.healthTimeoutMs);
      if (disposed) return;
      // no answer, an old server, or the flag off: no generative AI in the child's game (docs/TEACHING.md §4.4)
      const runtimeAi = runtimeAiOf(health);
      if (store.getState().runtimeAi !== runtimeAi) set({ runtimeAi });
      diag('ai', { runtime: runtimeAi });
      onDemand?.setHealth(health?.clipGen);
      await setUpVoice();
      if (disposed) return;
      set({ ready: true });
      // «Дозапись голоса»: is the server still recording what an earlier load of this page asked for (never awaited)
      if (isClipLayer(voice)) void onDemand?.check();
      armIdleTimers();
      // today's paid minutes, before anything paid is opened (never awaited: the first phrase must not wait)
      void refreshUsage();
      void pump();
    })();
    return initPromise;
  }

  // ───────────────────────── queue ─────────────────────────

  /**
   * Talkativeness filters what the coach says on his own: on the conversational voices (design D) and on «Записи»
   * (SPEC §5.2). INTERPRETATION for «Записи»: only «Тихо» filters there — at «Обычно» the recorded coach keeps his
   * short praise (priority 0, still rate-limited by the chatter rule): he must sound lively, and a recording is free.
   * The robot and silent voices say everything.
   */
  function passesVoiceTalkativeness(event: CoachEvent): boolean {
    const talkativeness = store.getState().talkativeness;
    if (isConversationalLayer(voice)) return passesTalkativeness(event, talkativeness);
    if (voice?.kind === 'clips') return passesTalkativeness(event, talkativeness === 'quiet' ? 'quiet' : 'chatty');
    return true;
  }

  function makeItem(event: CoachEvent): QueueItem {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { event, seq: seq++, enqueuedAt: now(), promise, resolve };
  }

  function enqueue(item: QueueItem): void {
    queue.push(item);
    queue.sort((a, b) => b.event.priority - a.event.priority || a.seq - b.seq);
    while (queue.length > timings.maxQueue) {
      // drop the oldest of the least important waiting phrases
      const lowest = Math.min(...queue.map((q) => q.event.priority));
      const index = queue.findIndex((q) => q.event.priority === lowest);
      const [dropped] = queue.splice(index, 1);
      dropped?.resolve();
    }
  }

  /** tools/voice-smoke: what the app wanted to say (template + brief) and what became of it — a no-op for real users */
  function probeSay(event: CoachEvent, outcome: 'queued' | 'filtered' | 'dropped'): void {
    probeVoice('coach.say', {
      id: event.id,
      kind: event.kind,
      priority: event.priority,
      outcome,
      talkativeness: store.getState().talkativeness,
      text: event.text,
      brief: event.brief ?? null,
      hintLevel: event.hintLevel ?? null,
      // teacher mode: what was advised (tools/voice-smoke checks the moves the model names against it)
      teach: event.teach ?? null,
    });
  }

  function say(event: CoachEvent): Promise<void> {
    if (disposed) return Promise.resolve();
    const duplicate = current?.event.id === event.id ? current : queue.find((q) => q.event.id === event.id);
    if (duplicate) return duplicate.promise;

    // an exam is silent until the end: a teacher's phrase is never said there (the game does not send one either)
    if (TEACH_KINDS.has(event.kind) && gameInfo?.examMode === true) {
      probeSay(event, 'filtered');
      return Promise.resolve();
    }
    // teacher mode: advice for a newer position makes advice still waiting for an older one stale (docs §2.1)
    if (event.teach) dropStaleAdvice(event.teach.ply);

    // design D: the conversational coach does not narrate every move — only what the talkativeness allows
    if (!passesVoiceTalkativeness(event)) {
      probeSay(event, 'filtered');
      return Promise.resolve();
    }

    if (event.priority === 0) {
      const tooSoon = now() - lastSpeechEndedAt < timings.chatterQuietMs;
      if (isBusy() || tooSoon || store.getState().needsUserGesture) {
        probeSay(event, 'dropped');
        return Promise.resolve();
      }
    }
    probeSay(event, 'queued');
    // a newer phrase: the one on screen never gets its voice late (G2)
    invalidateLate('say');

    keepAwake();
    const item = makeItem(event);

    if (event.priority === 2) {
      // urgent: waiting chatter is stale now, and whatever is being said gets cut off
      queue = queue.filter((q) => {
        if (q.event.priority > 0) return true;
        q.resolve();
        return false;
      });
      enqueue(item);
      if (interruptCurrent) diag('coach.stop', { why: 'priority', phrase: current?.event.kind ?? null, next: event.kind });
      // a phrase that was ending its sentence after the child's move is cut too: the urgent one cannot wait
      finishGrace('urgent');
      interruptCurrent?.();
    } else {
      enqueue(item);
    }

    if (initPromise === null) void init();
    void pump();
    return item.promise;
  }

  /**
   * Why the recordings a phrase misses are not asked for now (a Latin code for the black box), null = they may be.
   * The clip layer really speaks here (the caller: not muted, not another voice); an automated browser is refused here
   * and again inside the requester, before any fetch. In a game: always, except an exam (there only its own fixed
   * sentences, `EXAM_RECORDABLE_LINES`). Outside one: the lesson's
   * closing phrase right after its game ended, and anything while the recording scope is on (the child's own screens) —
   * never a demo, the parent's «Послушать» (Settings) or the playground.
   */
  function recordingRefusal(event: CoachEvent, ask: { lesson: readonly number[]; lines: readonly ClipGenLine[] }): string | null {
    if (onDemand === null) return 'no-api';
    if ((deps.isSilenced?.() ?? false) || isAutomated()) return 'automation';
    const examOwn = ask.lesson.length === 0 && ask.lines.length > 0 && ask.lines.every((l) => EXAM_RECORDABLE_LINES.has(l.id));
    if (gameInfo?.examMode === true && !examOwn) return 'exam';
    // the lesson's closing phrase comes right after the game store ended the game: still that game's own turn
    const justEnded = event.kind === 'gameEnd' && endedGame !== null && now() - endedGame.at < GAME_END_RECORD_MS;
    if (justEnded && endedGame?.examMode === true) return 'exam';
    if (gameInfo === null && !justEnded && !recordingScope) return 'scope';
    return onDemand.refusal();
  }

  /**
   * «Дозапись голоса»: what a phrase's plan could not say goes to the server — a lesson's missing sentences (by their
   * parts), else a twin's whole catalogue sentences without their exact wording. The phrase is never held back: the
   * answer only changes the bubble's mark, if the same bubble is still shown — and a silent phrase whose every sentence
   * is on its way becomes the late candidate (G2).
   */
  function requestRecording(event: CoachEvent, ask: { lesson: readonly number[]; lines: readonly ClipGenLine[] }, silentPlan: boolean, sayableWhole = true): void {
    if (onDemand === null) return;
    const src = ask.lesson.length > 0 ? 'lesson' : 'line';
    const n = src === 'lesson' ? ask.lesson.length : ask.lines.length;
    const refused = recordingRefusal(event, ask);
    if (refused !== null) {
      diag('clip.gen.skip', { kind: event.kind, src, why: refused });
      return;
    }
    const id = event.id;
    const layer = voice;
    const asked = { at: now(), lateEpoch, boardEpoch };
    const sent = src === 'lesson' ? onDemand.request(event, ask.lesson) : onDemand.requestLines(event.kind, ask.lines);
    void sent.then((outcomes) => {
      if (disposed) return;
      if (outcomes === null) {
        // nothing went out: a lesson sentence that can never be recorded, a failed POST, recording off meanwhile
        diag('clip.gen.skip', { kind: event.kind, src, why: onDemand.refusal() ?? 'unsent' });
        return;
      }
      const recording = outcomes.length === n && outcomes.every(isRecordingOutcome);
      diag('clip.gen', { kind: event.kind, src, n, recording });
      const state = store.getState();
      const shown = markFor === id && state.unvoiced;
      if (recording && shown && state.unvoicedMark === 'unrecorded') set({ unvoicedMark: 'recording' });
      const coming = outcomes.length === n && outcomes.every((o) => isRecordingOutcome(o) || o === 'voiced');
      const sameMoment = asked.lateEpoch === lateEpoch && asked.boardEpoch === boardEpoch;
      // (a twin that can only say part of its bubble would never be played late: its bubble does not wait for it)
      if (!silentPlan || !sayableWhole || !shown || !coming || !sameMoment || layer !== voice || !isClipLayer(layer) || typeof layer.playLate !== 'function') return;
      armLate({ event, layer, at: asked.at, lateEpoch, boardEpoch, bubble: state.bubbleText, landed: false });
      // «already recorded» (this page's overlay is older than the server's): the requester re-reads it — try after that
      if (outcomes.includes('voiced')) reloadThenTryLate();
    });
  }

  // ───────────────────────── «Дозапись голоса» G2: the recording lands while its bubble is up ─────────────────────────

  function lateWindowMs(): number {
    return Math.min(LATE_VOICE_MAX_MS, Math.max(0, timings.lateVoiceWindowMs));
  }

  function armLate(c: LateCandidate): void {
    dropLate(late !== null && late.event.id !== c.event.id ? 'replaced' : null);
    const left = holdLate(c);
    // the status every 1.5 s while the bubble waits: a recording lands ≈ 10–25 s after the request
    onDemand?.hurry(left);
    // the phrase already ended and its bubble is counting down: it stays up while its voice may still come
    if (current === null && !freeAnswer && bubbleTimer !== null) scheduleBubbleClear(lingerMs(timings.bubbleLingerMs));
  }

  /** `c` is the candidate until its window ends; returns the ms left */
  function holdLate(c: LateCandidate): number {
    late = c;
    const left = Math.max(0, c.at + lateWindowMs() - now());
    lateTimer = setTimeout(() => {
      lateTimer = null;
      if (late === c) dropLate('window');
    }, left);
    return left;
  }

  /** the candidate is gone (`why` null = consumed, nothing to report) */
  function dropLate(why: string | null): void {
    if (lateTimer !== null) {
      clearTimeout(lateTimer);
      lateTimer = null;
    }
    const c = late;
    if (c === null) return;
    late = null;
    if (why !== null) diag('clip.late', { kind: c.event.kind, ok: false, waitMs: Math.round(now() - c.at), why });
  }

  /** a late play running (or loading) now is cut: the moment it belonged to is over */
  function stopLate(): void {
    if (lateGraceTimer !== null) {
      clearTimeout(lateGraceTimer);
      lateGraceTimer = null;
    }
    const layer = latePlaying;
    if (layer === null) return;
    latePlaying = null;
    lateEvent = null;
    if (voice === layer) layer.stop();
  }

  /** the moment of the bubble on screen is over: no late voice for it, and a late one sounding now stops */
  function invalidateLate(why: string): void {
    lateEpoch += 1;
    dropLate(why);
    stopLate();
  }

  /**
   * The child moved (or the game asked for a gentle stop) while a late phrase sounds: exactly what a phrase said at
   * once would get (in fast games most remarks would otherwise be chopped mid-word) — `chatter` that held nothing (a
   * greeting, praise) goes on to its end; anything else ends its sentence when that is near (≤ `stopGraceMs`, the layer
   * cancels the rest; the grace is the safety cut), else it is cut now. No late play STARTS after that either way (the
   * caller bumped the epoch).
   */
  function easeLate(chatterGoesOn: boolean): void {
    const layer = latePlaying;
    const event = lateEvent;
    if (layer === null || event === null || lateGraceTimer !== null) return;
    if (chatterGoesOn && event.pauseClock !== true && !TEACH_KINDS.has(event.kind)) return;
    const left = voice === layer ? layer.msToSentenceEnd() : null;
    if (left !== null && left <= timings.stopGraceMs && layer.endAfterSentence()) {
      lateGraceTimer = setTimeout(() => {
        lateGraceTimer = null;
        if (latePlaying === layer) stopLate();
      }, timings.stopGraceMs);
      return;
    }
    stopLate();
  }

  /**
   * Why the candidate may not play now: null = it may; 'wait' = not yet (its own silent timing still runs) — anything
   * else drops it for good.
   */
  function lateRefusal(c: LateCandidate): string | null {
    if (now() - c.at > lateWindowMs()) return 'window';
    if (c.lateEpoch !== lateEpoch) return 'stale';
    if (c.boardEpoch !== boardEpoch) return 'board';
    if (voice !== c.layer) return 'voice';
    const state = store.getState();
    if (state.muted) return 'muted';
    if ((deps.isSilenced?.() ?? false) || isAutomated()) return 'automation';
    if (gestureLocked()) return 'gesture';
    if (pageHidden()) return 'hidden';
    if (asleep) return 'asleep';
    if (markFor !== c.event.id || !state.unvoiced || state.bubbleText !== c.bubble) return 'bubble';
    // the recording was quicker than the phrase's own silent timing: try again when it ends
    if (current !== null && current.event.id === c.event.id) return 'wait';
    if (current !== null || queue.length > 0 || graceStop !== null || freeAnswer || listening || childSpeaking || voiceSpeaking || silentSpeaking) return 'busy';
    return null;
  }

  function tryLate(): void {
    const c = late;
    if (c === null || disposed || latePlaying !== null) return;
    const refused = lateRefusal(c);
    if (refused === 'wait') {
      c.landed = true;
      return;
    }
    if (refused !== null) dropLate(refused);
    else void playLateNow(c);
  }

  /** a 'voiced' answer: the overlay is re-read first (a no-op when the requester already did it), then tried */
  function reloadThenTryLate(): void {
    const handle = overlayHandle();
    if (handle === null) return;
    // a changed library already tried inside the handle
    void handle.reload().then(
      (changed) => {
        if (!changed) tryLate();
      },
      () => undefined,
    );
  }

  /**
   * Plays the candidate outside the queue: no `say()`, no item promise (the game holds the child's clock itself while
   * `onLateSpeech` says it sounds), no arrows, no
   * `speaksAloud`. The mark goes when the first sample is scheduled; the bubble lingers as after any phrase.
   */
  async function playLateNow(c: LateCandidate): Promise<void> {
    const layer = c.layer;
    const playLate = layer.playLate?.bind(layer);
    if (playLate === undefined) {
      dropLate('layer');
      return;
    }
    // taken: whatever becomes of this try is reported once, below (a stop meanwhile only cuts it)
    dropLate(null);
    latePlaying = layer;
    lateEvent = c.event;
    const triedAt = now();
    let started = false;
    const result: ClipLateResult = await playLate(c.event, {
      blitz: gameInfo?.timeControlId === 'blitz5',
      // the same checks once more right before the first sample: its takes may have taken a moment to load
      stillCurrent: () => !disposed && latePlaying === layer && lateRefusal(c) === null,
      onStart: (heard) => {
        started = true;
        if (disposed) return;
        lateSpeech.emit(true);
        cancelBubbleTimer();
        markFor = null;
        // an answer twin says one of its wordings: the bubble shows the words really heard
        const words = heard.trim();
        const rewrite = isFreeWordedAnswer(c.event) && words !== '' && words !== store.getState().bubbleText;
        set(rewrite ? { bubbleText: words, unvoiced: false, unvoicedMark: null } : { unvoiced: false, unvoicedMark: null });
      },
    }).catch((): ClipLateResult => 'no-audio');
    const stillMine = latePlaying === layer;
    if (stillMine) {
      latePlaying = null;
      lateEvent = null;
      if (lateGraceTimer !== null) {
        clearTimeout(lateGraceTimer);
        lateGraceTimer = null;
      }
    }
    if (started) lateSpeech.emit(false);
    if (disposed) return;
    // a sentence of it is still on its way (or a take failed to load): the next publish tries again — while the moment
    // lasts and nothing else took its place
    if (result === 'not-voiced' && stillMine && late === null && lateRefusal(c) === null) {
      holdLate(c);
      return;
    }
    diag('clip.late', { kind: c.event.kind, ok: result === 'played', waitMs: Math.round(triedAt - c.at), why: result });
    if (!started) return;
    lastSpeechEndedAt = now();
    if (current === null && queue.length === 0 && !freeAnswer) scheduleBubbleClear(timings.bubbleLingerMs);
    armIdleTimers();
  }

  function setRecordingScope(on: boolean): void {
    if (recordingScope === on || disposed) return;
    recordingScope = on;
    diag('clip.gen.scope', { on });
    // the parent's page (Settings) or the playground: a phrase of the child's screen never sounds late there
    if (!on && gameInfo === null) invalidateLate('scope');
  }

  function noteBoardChange(): void {
    if (disposed) return;
    boardEpoch += 1;
    dropLate('board');
    // one already sounding is not chopped mid-word: as a phrase said at once would be treated
    easeLate(true);
  }

  /** see CoachController.voicePolicy */
  function voicePolicy(): LessonVoicePolicy | null {
    const layer = voice;
    if (disposed || !isClipLayer(layer) || store.getState().muted) return null;
    // automation (the muted e2e clips layer included): the default book, byte for byte
    if ((deps.isSilenced?.() ?? false) || isAutomated()) return null;
    const probe = layer.lessonProbe?.() ?? null;
    if (probe === null) return null;
    return {
      voiced: probe.voiced,
      blocked: probe.blocked,
      minVoiced: LESSON_VOICE_MIN,
      // growing the recorded set by the cheapest wordings only helps while phrases can be recorded; otherwise it would
      // only bias the wordings (fewer piece names) for nothing
      growCheap: clipGenGrows(onDemand?.health() ?? health?.clipGen ?? null),
    };
  }

  /** waiting `teachTurn`s for an earlier position than `ply` are dropped (the child has moved on) */
  function dropStaleAdvice(ply: number): void {
    queue = queue.filter((q) => {
      const teach = q.event.teach;
      if (q.event.kind !== 'teachTurn' || teach === undefined || teach.ply >= ply) return true;
      q.resolve();
      return false;
    });
  }

  async function play(item: QueueItem): Promise<void> {
    const { event } = item;
    current = item;
    endFreeAnswer();
    cancelBubbleTimer();
    if (poseTimer !== null) {
      clearTimeout(poseTimer);
      poseTimer = null;
    }
    poseHold = null;
    const muted = store.getState().muted;
    // ended by the child: no session and no microphone until the next «Поговорить» — the bubble still speaks
    const paused = conversationPaused && isConversationalLayer(voice);
    // a game that dozed off, a hidden tab, today's minutes used up: the coach's own phrase opens no paid session —
    // the bubble says it (never the robot voice), and a dozing mascot sleeps on after it
    const blocked = !muted && !paused && isConversationalLayer(voice) && !sessionOpen() && !mayOpenSession('coach');
    if (!asleep || sleepReason === 'idle') {
      asleep = false;
      sleepReason = null;
    }
    const layer: CoachVoiceLayer = muted || paused || blocked || !voice ? silent : voice;
    currentOnVoice = layer === voice && layer.kind !== 'silent';
    const brief = event.brief?.trim() ?? '';
    // the model says the situation in its own words; the template is the fallback (and the bubble until its words come)
    const ownWords = brief !== '' && layer === voice && isConversationalLayer(layer) && typeof layer.speakBrief === 'function';
    briefItem = ownWords ? item : null;
    briefCaptionShown = false;
    // nothing of it is heard yet: a gentle stop decides by what comes (the voice sounding, the model's words)
    heard = { item, voiced: layer === voice, ownWords, audibleAt: null, words: ownWords ? '' : event.text, wordsAt: now(), inStep: false };
    cancelBriefBubbleTimer();
    // «Записи» and a lesson phrase not recorded yet (docs/TEACHING.md §4.5): it plays nothing — the bubble says so.
    // A layer that plans lessons from recorded units tells at once whether this one will be voiced (a dry run); its
    // real plan confirms or corrects the mark below
    const lessonOnClips = layer === voice && isClipLayer(layer) && event.say !== undefined;
    const unrecorded = lessonOnClips && isUnrecordedLesson(event) && !(layer.canVoiceLesson?.(event) ?? false);
    markFor = unrecorded ? event.id : null;
    set({ bubbleText: ownWords ? '' : event.bubbleText, annotations: event.board ?? null, unvoiced: unrecorded, unvoicedMark: unrecorded ? 'unrecorded' : null });
    if (ownWords) armBriefBubbleFallback(item);
    probeVoice('coach.play', { id: event.id, kind: event.kind, layer: layer.kind, ownWords });
    refreshPose();
    const startedAt = now();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const interrupted = new Promise<void>((resolve) => {
      interruptCurrent = () => {
        layer.stop();
        resolve();
      };
      // a broken voice must never block the queue; the model's own words may first wait for a gap in the conversation
      // and take a moment to compose, so a brief gets at least 30 s
      const capMs = estimateSpeechMs(event.text, 140) + 8000;
      timer = setTimeout(
        () => {
          console.warn('[coach] voice did not finish in time — moving on');
          layer.stop();
          resolve();
        },
        Math.min(45_000, ownWords ? Math.max(capMs, 30_000) : capMs),
      );
    });
    const interrupt = event.priority === 2;
    // teacher mode: the style of the phrase sets how many sentences the model may use (short 1, full 4, concept 5)
    const briefOptions: BriefSpeakOptions = { interrupt, fallbackText: event.text };
    const maxSentences = teachMaxSentences(event);
    if (maxSentences !== undefined) briefOptions.maxSentences = maxSentences;
    // «Записи» needs the whole event (its clip twin, kind, teach, pose) and the game's pace (5 minutes: gaps × 0.75)
    const eventOptions: ClipSpeakOptions = { interrupt, blitz: gameInfo?.timeControlId === 'blitz5' };
    if (event.priority > 0) lastSpoken = event;
    // «Записи»: what the plan of this phrase really became (the bubble's words, its mark, what may be recorded)
    const offPlan = layer === voice && isClipLayer(layer) ? layer.onPlan((info) => onClipPlan(item, info)) : null;
    try {
      const speaking =
        ownWords && layer.speakBrief
          ? layer.speakBrief(brief, briefOptions)
          : typeof layer.speakEvent === 'function'
            ? layer.speakEvent(event, eventOptions)
            : layer.speak(event.text, { interrupt });
      await Promise.race([speaking, interrupted]);
    } catch (error) {
      console.warn('[coach] voice failed to speak', error instanceof Error ? error.message : error);
    } finally {
      offPlan?.();
      if (timer !== null) clearTimeout(timer);
      interruptCurrent = null;
      // it ended by itself while it was allowed to finish (a cut already closed the gentle stop)
      if (graceStop?.item === item) finishGrace('self');
      if (heard?.item === item) heard = null;
    }

    // nothing of the model's words arrived at all (interrupted early): the template stays readable
    if (ownWords && !briefCaptionShown && store.getState().bubbleText === '' && lingerOverrideMs === null) set({ bubbleText: event.bubbleText });
    cancelBriefBubbleTimer();
    briefItem = null;
    current = null;
    currentOnVoice = false;
    lastSpeechEndedAt = now();
    item.resolve();
    armIdleTimers();
    armSilenceNudge();

    if (queue.length === 0) {
      const minPose = timings.minPoseMs[event.pose] ?? 0;
      const remaining = minPose - (now() - startedAt);
      if (remaining > 0 && lingerOverrideMs === null) holdPose(event.pose, remaining);
      scheduleBubbleClear(lingerOverrideMs ?? lingerMs(timings.bubbleLingerMs));
    }
    lingerOverrideMs = null;
    refreshPose();
    // its recording landed while its own silent timing still ran (G2): it may be heard now
    if (late !== null && late.event.id === event.id && late.landed) tryLate();
  }

  /**
   * «Записи»: the plan of the phrase being said (the layer reports every real plan once). An answer twin's bubble shows
   * the words really heard; a silent plan of ANY phrase gets «не озвучено» (a voiced one drops it — a lesson's first mark
   * came from the dry run); what could be recorded goes to the server («Дозапись голоса»): a lesson's missing sentences,
   * a twin's whole sentences without their exact wording.
   */
  function onClipPlan(item: QueueItem, info: ClipPlanInfo): void {
    const { event } = item;
    if (info.eventId !== event.id || current !== item) return;
    const voiced = info.clips > 0;
    // an answer from recordings (a poke, a «Спроси» answer, a thought reply): the planner picks any take of its pools,
    // `text` is only the first wording. A move in notation, or a plan that fell to the moment's generic line, keeps the
    // event's own bubble (SPEC §6.1 L5)
    const ownWords = voiced && isFreeWordedAnswer(event) && info.src !== 'generic' && info.level < 5;
    if (ownWords) {
      const words = info.heard.trim();
      if (words !== '' && store.getState().bubbleText !== words) set({ bubbleText: words });
    }
    if (voiced) {
      if (store.getState().unvoiced) {
        markFor = null;
        set({ unvoiced: false, unvoicedMark: null });
      }
    } else if (!store.getState().unvoiced) {
      markFor = event.id;
      set({ unvoiced: true, unvoicedMark: 'unrecorded' });
    }
    const lesson = info.lessonMissing ?? [];
    // (a free-worded answer's layer names one more wording while its pool has only a few: its variety grows even while
    // it is voiced); `v3.*` wordings are recorded as lesson parts only (the server refuses them as whole lines)
    const lines = (info.lineMissing ?? []).filter((l) => !l.id.startsWith('v3.'));
    if (lesson.length > 0 || lines.length > 0) requestRecording(event, { lesson, lines }, !voiced, info.partial !== true);
  }

  async function pump(): Promise<void> {
    if (pumping || disposed || !store.getState().ready) return;
    pumping = true;
    try {
      while (queue.length > 0 && !disposed) {
        // the preferred voice is coming back (restorePreferredVoice): the phrase goes to it, not to the one leaving
        if (restoring) await restoring;
        if (gestureLocked()) break; // resumed by publishGesture() after the first click
        const item = queue.shift();
        if (!item) break;
        if (now() - item.enqueuedAt > timings.gestureHoldMaxMs) {
          item.resolve(); // waited too long behind the gesture lock — stale by now
          continue;
        }
        // queued before init() picked the voice: the talkativeness of a conversational coach applies here too
        if (!passesVoiceTalkativeness(item.event)) {
          item.resolve();
          continue;
        }
        await play(item);
        if (failoverPending) await failover();
      }
    } finally {
      pumping = false;
    }
  }

  /** `why` only feeds the black box: 'stopSpeaking' = the game / a screen asked (the child moved, took a move back …) */
  function stopSpeaking(opts?: StopSpeakingOptions, why = 'stopSpeaking'): void {
    // the bubble on screen is done with: no late voice for it (G2); one already sounding ends its sentence on a gentle
    // stop (as the phrase being said does), and is cut on any other
    if (opts?.grace === true && opts.clearBubble !== true) {
      lateEpoch += 1;
      dropLate('stop');
      easeLate(false);
    } else invalidateLate('stop');
    // the child moved on (`grace`): what he already hears may end its sentence; the rest is stale and goes at once
    let gentle: GraceStop['mode'] | null = null;
    if (opts?.grace === true && opts.clearBubble !== true && current !== null) gentle = graceStop?.item === current ? graceStop.mode : graceModeFor(current);
    if (current !== null || voiceSpeaking) diag('coach.stop', { why, phrase: current?.event.kind ?? null, audible: voiceSpeaking, ...(opts?.grace === true ? { grace: gentle ?? 'none' } : {}) });
    cancelBriefBubbleTimer();
    cancelToolBubble();
    for (const item of queue.splice(0)) item.resolve();
    if (current) lingerOverrideMs = opts?.clearBubble ? 0 : Math.min(2000, timings.bubbleLingerMs);
    if (gentle !== null && current !== null) {
      armGrace(current, gentle);
    } else {
      finishGrace('stop');
      interruptCurrent?.();
    }
    if (!current) {
      // (a late phrase ending its sentence is the layer's only sound: it is not cut here)
      if (latePlaying === null || latePlaying !== voice) voice?.stop();
      silent.stop();
    }
    endFreeAnswer();
    if (opts?.clearBubble) {
      cancelBubbleTimer();
      set({ bubbleText: '' });
    } else if (store.getState().bubbleText !== '') {
      scheduleBubbleClear(Math.min(2000, timings.bubbleLingerMs));
    }
    refreshPose();
  }

  // ───────────────────────── hints / tools ─────────────────────────

  function setToolHost(host: CoachToolHost | null): void {
    toolHost = host;
    // the child opened a game: its idle clock starts now (a game left alone never inherits an old stamp)
    if (host !== null) lastChildActivityAt = now();
    fallbackHintLevel = 1;
    voice?.setToolHost?.(host);
    // a game that left without saying so must not keep the next screen's hint button hidden
    set(host === null ? { hasToolHost: false, hintAvailable: true } : { hasToolHost: true });
    if (host === null) endGame();
    // a game started / ended: the idle rule of a paid session changes (2 min without the child ↔ 90 s)
    if (initPromise !== null) armIdleTimers();
    if (host !== null) void refreshUsage();
  }

  function setHintAvailable(available: boolean): void {
    if (store.getState().hintAvailable !== available) set({ hintAvailable: available });
  }

  function requestHint(): void {
    noteActivity();
    if (!store.getState().hintAvailable) return;
    if (hintRequested.size > 0) {
      hintRequested.emit();
      return;
    }
    const host = toolHost;
    if (!host) return;
    // nobody listens (yet), teacher mode: «Совет» repeats the current advice (arrows again), there is no ladder
    if (gameInfo?.coachStyle === 'teacher' && host.repeatAdvice) {
      host.repeatAdvice().then(
        (event) => {
          if (event) void say(event);
        },
        (error: unknown) => console.warn('[coach] advice failed', error instanceof Error ? error.message : error),
      );
      return;
    }
    // …otherwise a simple ladder straight against the tool host
    const level = fallbackHintLevel;
    fallbackHintLevel = level < 4 ? ((level + 1) as HintLevel) : 4;
    host.getHint(level).then(
      (event) => void say(event),
      (error: unknown) => console.warn('[coach] hint failed', error instanceof Error ? error.message : error),
    );
  }

  // ───────────────────────── settings ─────────────────────────

  function applyMuted(muted: boolean): void {
    if (store.getState().muted === muted) return;
    diag('mute', { muted });
    set({ muted });
    if (muted) {
      invalidateLate('muted');
      clearHearingCheck();
      // cut the sound right away; the bubble keeps the text readable
      if (listening) stopListening();
      voice?.stop();
      // a coach who may not speak needs no paid session and no open microphone
      resumeAfterUnmute = voice?.connected === true;
      suspendVoice();
    } else if (resumeAfterUnmute && !asleep) {
      // the conversation was running when the sound was switched off: be there again, ears included
      resumeAfterUnmute = false;
      if (mayOpenSession('child')) voice?.resume?.();
    }
    publishGesture();
  }

  function setMuted(muted: boolean): void {
    if (store.getState().muted === muted) return;
    saveCoachSettings(deps.getStorage(), { muted });
    applyMuted(muted);
  }

  async function repickVoice(): Promise<void> {
    if (initPromise === null) return; // init() will pick it up
    await initPromise;
    stopSpeaking({ clearBubble: true }, 'settings');
    // new settings, a new chain: an earlier fallback is history
    degraded = null;
    set({ voiceFallback: null });
    detachVoice();
    set({ micAvailable: false, listening: false });
    conversationPaused = false;
    await setUpVoice();
    refreshPose();
    if (conversationOn) {
      if (isConversationalLayer(voice)) void openConversationOn(voice);
      else setConversationOn(false);
    }
    void pump();
  }

  async function setVoicePreference(preference: VoicePreference): Promise<void> {
    saveCoachSettings(deps.getStorage(), { voice: preference });
    set({ voicePreference: preference });
    await repickVoice();
  }

  async function applySettings(): Promise<void> {
    const settings = loadCoachSettings(deps.getStorage());
    const before = store.getState();
    set({
      voicePreference: settings.voice,
      micMode: settings.micMode,
      headphonesConfirmed: settings.headphonesConfirmed,
      talkativeness: settings.talkativeness,
      autoConversation: settings.autoConversation,
      voiceDailyLimitMin: settings.voiceDailyLimitMin,
    });
    // a new daily limit: judged again at once (a higher one lets the voice back today, a lower one may end it now)
    if (settings.voiceDailyLimitMin !== before.voiceDailyLimitMin) {
      resetLimit();
      void refreshUsage();
      enforceLimit();
    }
    applyMuted(settings.muted);
    if (initPromise === null) return;
    await initPromise;
    const wanted = chainFor(settings.voice);
    const sameChain = wanted.length === chain.length && wanted.every((kind, index) => kind === chain[index]);
    if (settings.voice !== before.voicePreference || !sameChain) await repickVoice();
    else applyMicSettings();
  }

  function setMicMode(mode: MicMode): void {
    if (store.getState().micMode === mode) return;
    saveCoachSettings(deps.getStorage(), { micMode: mode });
    if (listening) stopListening();
    set({ micMode: mode, micMuted: false });
    applyMicSettings();
    noteActivity();
  }

  function confirmHeadphones(): void {
    saveCoachSettings(deps.getStorage(), { headphonesConfirmed: true });
    set({ headphonesConfirmed: true });
    applyMicSettings();
    noteActivity();
  }

  function setMicMuted(micMuted: boolean): void {
    if (store.getState().micMuted !== micMuted) set({ micMuted });
    applyMicSettings();
    noteActivity();
  }

  function pushContext(note: string): void {
    if (disposed) return;
    // the game sends a note after every bot move / judgement: the position changed, the silence clock starts over
    nudgedSinceActivity = false;
    armSilenceNudge();
    if (store.getState().muted) return;
    voice?.pushContext?.(note);
  }

  function setTalkativeness(talkativeness: Talkativeness): void {
    saveCoachSettings(deps.getStorage(), { talkativeness });
    if (store.getState().talkativeness !== talkativeness) set({ talkativeness });
  }

  function setAutoConversation(enabled: boolean): void {
    saveCoachSettings(deps.getStorage(), { autoConversation: enabled });
    if (store.getState().autoConversation !== enabled) set({ autoConversation: enabled });
  }

  // ───────────────────────── the «Поговорить» conversation ─────────────────────────

  function setConversationOn(on: boolean): void {
    conversationOn = on;
    if (store.getState().conversationOn !== on) set({ conversationOn: on });
    if (!on) {
      cancelReconnect();
      clearNudge();
    }
    armIdleTimers();
  }

  async function openConversationOn(layer: CoachVoiceLayer): Promise<boolean> {
    reconnectAttempts = 0;
    if (!mayOpenSession('child')) return false;
    if (layer.openConversation) return layer.openConversation();
    layer.resume?.();
    return true;
  }

  /** today's minutes are used up (as far as this page knows now) */
  function limitHolds(): boolean {
    return dailyLimitSeconds() > 0 && isConversationalLayer(voice) && enforceLimit();
  }

  async function startConversation(opts?: { auto?: boolean }): Promise<void> {
    // under automation there is no conversation: no session, no microphone, no money
    if (disposed || (deps.isSilenced?.() ?? false)) return;
    await init();
    // no generative AI in the child's game: no conversation and no microphone, whatever layer is up
    if (!store.getState().runtimeAi) return;
    // the preferred voice gave up earlier for a passing reason: a conversation start is the moment to try it again
    const restore = restorePreferredVoice(opts?.auto === true ? 'gameStart' : 'talk');
    if (restore) await restore;
    if (settingUp) await settingUp;
    const layer = voice;
    if (disposed || !isConversationalLayer(layer) || store.getState().muted) return;
    // the child's tap (or a game start): the idle clock starts over
    lastChildActivityAt = now();
    // today's minutes: a fresh server count first (bounded — the button already says «connecting»)
    if (dailyLimitSeconds() > 0) await withTimeoutOrNull(refreshUsage(), USAGE_WAIT_MS);
    if (disposed || voice !== layer || store.getState().muted) return;
    if (limitHolds()) {
      announceLimit();
      return;
    }
    conversationPaused = false;
    diag('conv.start', { auto: opts?.auto === true, kind: layer.kind });
    setConversationOn(true);
    // «Поговорить» means «hear me»: a microphone switched off earlier is on again
    if (store.getState().micMuted) setMicMuted(false);
    if (asleep) {
      asleep = false;
      sleepReason = null;
      clearSleepNotice();
      refreshPose();
    }
    armSilenceNudge();
    const opened = await openConversationOn(layer);
    if (!opened || disposed || voice !== layer || !conversationOn) return;
    // a tap outside the game's own greeting: a short hello, so the child knows he is listening (not again within a minute)
    if (opts?.auto !== true && current === null && queue.length === 0 && now() - lastHelloAt > 60_000) {
      lastHelloAt = now();
      void say({
        id: `conversation-hello-${lastHelloAt}`,
        kind: 'answer',
        priority: 1,
        text: CONVERSATION_HELLO_TEXT_RU,
        bubbleText: CONVERSATION_HELLO_TEXT_RU,
        pose: 'wave',
        pauseClock: false,
        brief: CONVERSATION_HELLO_BRIEF_RU,
      });
    }
  }

  function endConversation(): void {
    if (disposed) return;
    const conversational = isConversationalLayer(voice);
    diag('conv.end', {});
    setConversationOn(false);
    conversationPaused = conversational;
    clearHearingCheck();
    stopSpeaking({ clearBubble: true }, 'endConversation');
    if (conversational) suspendVoice();
    // «Пока!» — in the bubble only: the session is already closed
    set({ bubbleText: CONVERSATION_GOODBYE_RU, conversationState: conversational ? 'off' : store.getState().conversationState });
    holdPose('wave', timings.minPoseMs.wave ?? 2000);
    scheduleBubbleClear(timings.goodbyeMs);
    refreshPose();
  }

  function toggleConversation(): void {
    const state = store.getState().conversationState;
    if (state === 'off' || state === 'error') void startConversation();
    else endConversation();
  }

  function onGameStart(info: CoachGameInfo): void {
    if (disposed) return;
    invalidateLate('game');
    endedGame = null;
    const coachStyle: CoachStyle = info.coachStyle ?? (info.examMode === true ? 'exam' : 'helper');
    gameInfo = { timeControlId: info.timeControlId, examMode: info.examMode === true || coachStyle === 'exam', coachStyle };
    diag('game.start', { tc: info.timeControlId, style: coachStyle, voice: voice?.kind ?? 'none', auto: store.getState().autoConversation, muted: store.getState().muted });
    // the dock names its hint button after the style («Совет» for the teacher)
    if (store.getState().coachStyle !== coachStyle) set({ coachStyle });
    // «Записи»: counts this game's utterances (Settings: «прошлая партия: 96 % записями»); a phrase recorded since the
    // page loaded joins the library now («Дозапись голоса», one status check)
    if (isClipLayer(voice)) {
      voice.setGame({ timeControlId: info.timeControlId });
      void onDemand?.check();
    }
    lastNudgeAt = -Infinity;
    nudgedSinceActivity = false;
    const control = TIME_CONTROLS[info.timeControlId] as (typeof TIME_CONTROLS)[TimeControlId] | undefined;
    if (control?.coachMode === 'off') {
      // 1-minute bullet: the coach is silent until the end — no conversation, no open microphone, no bill, and no
      // «Спроси» chips (their answers would run while the clock does; the game end clears the suppression)
      if (!store.getState().askSuppressed) set({ askSuppressed: true });
      clearNudge();
      if (conversationOn) {
        setConversationOn(false);
        suspendVoice();
      }
      return;
    }
    lastChildActivityAt = now();
    if (initPromise !== null) armIdleTimers();
    armSilenceNudge();
    if (!store.getState().autoConversation || (deps.isSilenced?.() ?? false)) return;
    // the lesson without runtime AI: the game never opens a conversation (and never asks for the microphone)
    if (!store.getState().runtimeAi) return;
    if (limitHolds()) {
      // today's minutes are used up: the game goes on with the coach in the bubble
      announceLimit();
      return;
    }
    // Say «connecting» at once: the game journals its opening phrases right after this call, and they will be said by
    // the model in its own words (else they would be journaled as templates while the connect is in flight).
    const state = store.getState();
    if (isConversationalLayer(voice) && !state.muted && (state.conversationState === 'off' || state.conversationState === 'error')) set({ conversationState: 'connecting' });
    void startConversation({ auto: true }).finally(settleConnectingState);
  }

  /** a start that gave up before the layer took over must not leave the button spinning */
  function settleConnectingState(): void {
    if (disposed || store.getState().conversationState !== 'connecting') return;
    const layer = voice;
    if (!isConversationalLayer(layer) || store.getState().muted || !conversationOn) set({ conversationState: 'off' });
  }

  function endGame(): void {
    invalidateLate('game');
    if (gameInfo !== null && isClipLayer(voice)) voice.setGame(null);
    if (gameInfo !== null) endedGame = { examMode: gameInfo.examMode, at: now() };
    gameInfo = null;
    if (store.getState().coachStyle !== null) set({ coachStyle: null });
    // a game that left with its quiz card open must not keep «Спроси» hidden on the next screen
    if (store.getState().askSuppressed) set({ askSuppressed: false });
    clearNudge();
    cancelReconnect();
  }

  function onGameEnd(): void {
    if (disposed) return;
    diag('game.end', {});
    endGame();
    // outside a game the ordinary idle rules apply again (90 s)
    if (initPromise !== null) armIdleTimers();
  }

  // ───────────────────────── push-to-talk ─────────────────────────

  async function startListening(): Promise<void> {
    const layer = voice;
    if (!layer?.startListening || store.getState().muted || listening) return;
    noteActivity();
    // open microphone: there is nothing to hold — touching the button only wakes the coach up
    if (store.getState().micMode === 'open' && layer.setMicMode) return;
    if (isConversationalLayer(layer) && !sessionOpen() && !mayOpenSession('child')) return;
    stopSpeaking({ clearBubble: true });
    listening = true;
    refreshPose();
    try {
      await layer.startListening();
    } catch (error) {
      console.warn('[coach] microphone is unavailable', error instanceof Error ? error.message : error);
      listening = false;
      refreshPose();
    }
  }

  function stopListening(): void {
    if (!listening) return;
    listening = false;
    voice?.stopListening?.();
    armIdleTimers();
    refreshPose();
  }

  // ───────────────────────── misc ─────────────────────────

  function unlockAudio(): void {
    noteActivity();
    if (voice && isGestureGated(voice)) voice.unlock();
    publishGesture();
  }

  function wake(): void {
    const wasAsleep = asleep;
    noteActivity();
    // awake but not connected (nothing was said yet, or the session dropped): a deliberate poke opens the session
    if (!wasAsleep && !store.getState().muted && !conversationPaused && mayOpenSession('child')) voice?.resume?.();
    if (wasAsleep && !current) holdPose('wave', timings.minPoseMs.wave ?? 2000);
    refreshPose();
  }

  // ───────────────────────── «Спроси»: the no-microphone questions (docs/voice-clips/SPEC.md §8.2) ─────────────────────────

  function ask(question: CoachAsk): void {
    if (disposed) return;
    noteActivity();
    diag('coach.ask', { q: question, game: toolHost !== null, listeners: asks.size });
    // the game answers through its own sayEvent: the child's clock is held while the answer plays
    if (asks.size > 0) {
      asks.emit(question);
      return;
    }
    switch (question) {
      case 'hint':
        requestHint();
        return;
      case 'repeat': {
        const again = lastSpoken;
        if (again) void say({ ...again, id: `${again.id}-again-${++repeatSeq}`, priority: 1 });
        return;
      }
      case 'why':
      case 'opponent': {
        // without a game there is nothing to explain; a game without a listener gets the last move explained
        const host = toolHost;
        if (!host || question === 'opponent') return;
        host.explainLastMove().then(
          (event) => {
            if (event) void say(event);
          },
          (error: unknown) => console.warn('[coach] explain failed', error instanceof Error ? error.message : error),
        );
        return;
      }
    }
  }

  function prewarmClips(hint: ClipPrewarmHint): void {
    if (disposed || !isClipLayer(voice)) return;
    try {
      voice.prewarm(hint);
    } catch (error) {
      console.warn('[coach] clip prewarm failed', error instanceof Error ? error.message : error);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    endedGame = null;
    for (const item of queue.splice(0)) item.resolve();
    finishGrace('stop');
    interruptCurrent?.();
    invalidateLate('dispose');
    unwatchMicPermission?.();
    unwatchMicPermission = null;
    for (const timer of [bubbleTimer, poseTimer, sleepTimer, freeAnswerTimer, nudgeTimer, reconnectTimer, briefBubbleTimer, toolBubbleTimer, hiddenTimer, limitTimer, midnightTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    for (const unsub of pageUnsubs.splice(0)) unsub();
    onDemand?.dispose();
    detachVoice();
    silent.dispose();
    hintRequested.clear();
    transcripts.clear();
    asks.clear();
  }

  return {
    init,
    say,
    stopSpeaking,
    setToolHost,
    onHintRequested: (cb) => hintRequested.on(cb),
    requestHint,
    setHintAvailable,
    setMuted,
    toggleMuted: () => setMuted(!store.getState().muted),
    setVoicePreference,
    applySettings,
    setMicMode,
    confirmHeadphones,
    setMicMuted,
    toggleMic: () => setMicMuted(!store.getState().micMuted),
    pushContext,
    startListening,
    stopListening,
    unlockAudio,
    noteActivity,
    wake,
    showAnnotations: (annotations) => set({ annotations }),
    clearAnnotations: () => set({ annotations: null }),
    onTranscript: (cb) => transcripts.on(({ who, text }) => cb(who, text)),
    startConversation: () => startConversation(),
    endConversation,
    toggleConversation,
    get conversationState() {
      return store.getState().conversationState;
    },
    setTalkativeness,
    get talkativeness() {
      return store.getState().talkativeness;
    },
    get coachStyle() {
      return store.getState().coachStyle;
    },
    setAutoConversation,
    onGameStart,
    onGameEnd,
    recheckHearing,
    retryMicrophone,
    dismissMicHelp,
    interrupt,
    ask,
    onAsk: (cb) => asks.on(cb),
    get lastSpoken() {
      return lastSpoken;
    },
    get clipVoice() {
      return voice?.kind === 'clips';
    },
    prewarmClips,
    runtimeAi: () => store.getState().runtimeAi,
    setAskSuppressed(suppressed: boolean) {
      if (disposed || store.getState().askSuppressed === suppressed) return;
      set({ askSuppressed: suppressed });
      // the quiz card opened or closed: the moment of the bubble on screen is over (G2)
      invalidateLate('quiz');
    },
    showPose,
    speaksAloud,
    voicePolicy,
    setRecordingScope,
    noteBoardChange,
    onLateSpeech: (cb) => lateSpeech.on(cb),
    dispose,
  };
}

// ───────────────────────── app singleton ─────────────────────────

function createBrowserVoice(kind: VoiceKind): VoiceLayer {
  // second lock on the same door: under automation no code path can build a layer that makes sound or costs money —
  // the one exception is the opted-in e2e clips layer, and it plays into a muted GainNode(0)
  if (automationSilenced()) return kind === 'clips' && e2eClipsOptIn() ? createBrowserClipVoice({ muted: true }) : createSilentVoice();
  switch (kind) {
    case 'openai-live':
      return createOpenAiLiveVoice();
    case 'openai-realtime':
      return createOpenAiRealtimeVoice();
    case 'browser-tts':
      return createBrowserTtsVoice();
    case 'silent':
      return createSilentVoice();
    case 'clips':
      // «Записи» (docs/voice-clips/SPEC.md): the pre-recorded voice; without a library its init() rejects → silent
      return createBrowserClipVoice();
  }
}

/**
 * The browser page as the coach sees it: visibility, 'pagehide' and the child's touches. Listeners are added only when
 * `coach.init()` runs (never at import), and only in a real document.
 */
function browserPageLifecycle(): CoachPageLifecycle | undefined {
  if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
  const listen = (target: EventTarget, type: string, cb: () => void, options?: AddEventListenerOptions): Unsubscribe => {
    const handler = (): void => cb();
    target.addEventListener(type, handler, options);
    return () => target.removeEventListener(type, handler, options);
  };
  return {
    isHidden: () => document.visibilityState === 'hidden',
    onVisibilityChange: (cb) => listen(document, 'visibilitychange', cb),
    onPageHide: (cb) => listen(window, 'pagehide', cb),
    onUserInput(cb) {
      // the dock reports its own taps (a tap on a sleeping mascot is a «wake», not a poke)
      const handler = (event: Event): void => {
        const target = event.target;
        if (typeof Element !== 'undefined' && target instanceof Element && target.closest('.gmb-dock')) return;
        cb();
      };
      const options: AddEventListenerOptions = { capture: true, passive: true };
      window.addEventListener('pointerdown', handler, options);
      window.addEventListener('keydown', handler, options);
      return () => {
        window.removeEventListener('pointerdown', handler, options);
        window.removeEventListener('keydown', handler, options);
      };
    },
  };
}

const timeoutOption = (ms: number): { signal: AbortSignal } | undefined =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(ms) } : undefined;

/** The one coach of the app. Nothing touches the DOM or the network until `coach.init()` / `coach.say()`. */
export const coach: CoachController = createCoachController({
  store: useCoachStore,
  getHealth: () => getHealth(timeoutOption(4000)),
  createVoice: createBrowserVoice,
  getStorage: getBrowserStorage,
  isSilenced: () => automationSilenced(),
  clipsWhenSilenced: () => e2eClipsOptIn(),
  // the daily limit: today's paid seconds on the server (a failure is tolerated by the controller)
  getVoiceUsage: () => getVoiceUsage(timeoutOption(4000)),
  // «Дозапись голоса»: the local server records a missing lesson phrase (never from an automated browser)
  clipGen: { request: (body) => requestClipGen(body), status: () => getClipGenStatus() },
  page: browserPageLifecycle(),
});

// tools/voice-smoke: a log of what the voice does — only in an automation run that opted into real voice
installVoiceProbe(coach, useCoachStore);
