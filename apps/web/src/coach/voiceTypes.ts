/**
 * Local extensions of the `VoiceLayer` contract. The coach controller accepts ANY plain
 * `VoiceLayer` and feature-detects these optional extras, so a minimal fake layer works too.
 */
import type { ClipGenLine, CoachEvent, CoachEventKind, CoachToolHost, ConversationState, TimeControlId, VoiceLayer } from '@gambit/shared';
import type { Unsubscribe } from './voiceUtils.ts';

export type VoiceKind = VoiceLayer['kind'];

/** The two paid, conversational OpenAI layers. */
export type OpenAiVoiceKind = 'openai-live' | 'openai-realtime';

export function isOpenAiVoiceKind(kind: VoiceKind): kind is OpenAiVoiceKind {
  return kind === 'openai-live' || kind === 'openai-realtime';
}

/**
 * How a phrase handed to a conversational model ended:
 *  'spoken'      — it was said (as far as we can tell)
 *  'interrupted' — the child barged in or the app stopped it: do NOT say it again with another voice
 *  'failed'      — the model never said it: the fallback voice takes over
 */
export type SpeakOutcome = 'spoken' | 'interrupted' | 'failed';

/**
 * What happens to a brief handed to a conversational model (`speakBrief`), for the speech bubble:
 *  'sent'     — the brief really went to the model now (after waiting for a gap in the conversation)
 *  'caption'  — the model's OWN words so far (the bubble shows what is actually said)
 *  'fallback' — the model could not say it: the fallback voice says the template text now
 */
export type SayProgress = { type: 'sent' } | { type: 'caption'; text: string } | { type: 'fallback' };

/** Browsers only let a page make sound after a click / key press. */
export interface GestureGated {
  /** true while audio output is blocked until the child touches the page */
  readonly needsUserGesture: boolean;
  onNeedsUserGestureChange(cb: (needs: boolean) => void): Unsubscribe;
  /** Call synchronously from a user-gesture handler (click, keydown, pointerdown). */
  unlock(): void;
}

/**
 * Options of a brief handed to a conversational model: contracts `VoiceLayer.speakBrief` plus one local extra.
 * `maxSentences` (teacher mode, docs/TEACHER-MODE.md §2.7) = how many short sentences the model may use for THIS brief:
 * 1 for a short advice, 4 for a full one, 5 for a new concept. Absent = the ordinary «one to three sentences».
 */
export interface BriefSpeakOptions {
  interrupt?: boolean;
  fallbackText?: string;
  maxSentences?: number;
}

/** Why a conversational layer gave up (`onUnavailable`): may it be tried again later, and the failure's short code. */
export interface UnavailableDetail {
  /** true = trying again cannot help (no key, the key refused, no WebRTC) */
  permanent: boolean;
  /** Latin-only code: '502:voice-upstream:net:ENOTFOUND', 'silent:3', 'the SDP exchange timed out' … (null = unknown) */
  code: string | null;
}

export interface SuspendOptions {
  /** the page is being closed / hidden for good ('pagehide'): report the usage with a beacon that outlives the page */
  pageHide?: boolean;
}

/** Extras of the conversational (OpenAI Live / Realtime) layers. */
export interface ConversationalExtras {
  setToolHost(host: CoachToolHost | null): void;
  /** `kind` may change at runtime when the connection falls back to browser TTS. */
  onKindChange(cb: (kind: VoiceKind) => void): Unsubscribe;
  /** true while the microphone can (still) be used */
  readonly micAvailable: boolean;
  onMicAvailableChange(cb: (available: boolean) => void): Unsubscribe;
  /** the model is busy running a tool / composing an answer */
  onThinkingChange(cb: (thinking: boolean) => void): Unsubscribe;
  /** running subtitle of a free (model-originated) answer, e.g. a reply to the child's question */
  onCoachCaption(cb: (textSoFar: string) => void): Unsubscribe;
  /** a tool produced a ready CoachEvent (hint, explanation): show its bubble/arrows, the model speaks it */
  onToolCoachEvent(cb: (event: CoachEvent) => void): Unsubscribe;
  /**
   * Close the paid connection (and the microphone) while the mascot sleeps; the next speak()/resume() reconnects.
   * `pageHide`: the page is going away — the seconds of the closed session are reported with `navigator.sendBeacon`.
   */
  suspend(opts?: SuspendOptions): void;
  /** Reconnect now (the mascot was woken up) instead of waiting for the next phrase. */
  resume(): void;
  /** true while the paid session is open */
  readonly connected: boolean;
  onConnectedChange(cb: (connected: boolean) => void): Unsubscribe;
  /** open-mic mode: the child is talking right now (server VAD / input transcript activity) */
  onChildSpeakingChange(cb: (speaking: boolean) => void): Unsubscribe;
  /** open-mic mode: the child tapped the mic indicator — stop / resume sending microphone audio */
  setMicMuted(muted: boolean): void;
  /**
   * Software half-duplex for loudspeakers: while the coach's audio plays, the microphone is closed,
   * so the coach can never answer his own voice. Off when the child wears headphones.
   */
  setEchoGuard(enabled: boolean): void;
  /**
   * The layer gave up (no key, WebRTC missing, repeated failures): the controller moves down the chain — and, when the
   * detail says it is not permanent, tries this layer again later (at a conversation start, with a growing pause).
   */
  onUnavailable(cb: (reason: string, detail?: UnavailableDetail) => void): Unsubscribe;
  /**
   * The child tapped while the coach speaks (loudspeakers: he cannot be talked over): cancel the phrase, hush the
   * playback, open the microphone at once.
   */
  interrupt(): void;
  /**
   * contracts `VoiceLayer.speakBrief`: the model says the situation in its OWN words; `fallbackText` if it cannot;
   * `maxSentences` sets the length of a teacher's phrase (BriefSpeakOptions)
   */
  speakBrief(brief: string, opts?: BriefSpeakOptions): Promise<void>;
  /** progress of the brief being said right now (see SayProgress) */
  onSayProgress(cb: (progress: SayProgress) => void): Unsubscribe;
  /** contracts `VoiceLayer.onConversationState` */
  onConversationState(cb: (state: ConversationState) => void): Unsubscribe;
  /**
   * «Поговорить»: open the session + microphone NOW and resolve true once connected (false = could not).
   * A session whose microphone was refused is reopened, so the permission is asked again.
   */
  openConversation(): Promise<boolean>;
  /** 0..1 loudness of the child's microphone at animation rate (only while a session is open) */
  onMicLevel(cb: (level: number) => void): Unsubscribe;
}

/** true for a layer that can hold a real conversation (the two OpenAI layers, or a fake of them in tests) */
export function isConversationalLayer(voice: VoiceLayer | null): voice is VoiceLayer & Pick<ConversationalExtras, 'suspend' | 'resume'> {
  const v = voice as (VoiceLayer & Partial<ConversationalExtras>) | null;
  return v !== null && isOpenAiVoiceKind(v.kind) && typeof v.resume === 'function' && typeof v.suspend === 'function';
}

// ───────────────────────── «Записи»: the pre-recorded clips layer (docs/voice-clips/SPEC.md §3.6, §5) ─────────────────────────

/** `speakEvent` options of the clips layer: the contract's `interrupt`, plus the 5-minute game (gaps × 0.75, short caps). */
export interface ClipSpeakOptions {
  interrupt?: boolean;
  blitz?: boolean;
}

/** What one planned utterance became — for the black box and the journal (the bubble keeps the event's exact text). */
export interface ClipPlanInfo {
  eventId: string;
  kind: CoachEventKind;
  /** 'clip' twin · 'text' compiled · 'generic' only the moment's generic line · 'lesson' exact keys · 'none' nothing voiced (silent timing) */
  src: 'clip' | 'text' | 'generic' | 'lesson' | 'none';
  /** worst ladder level (1 as written … 5 generic, 6 nothing) */
  level: number;
  /** exactly what is heard */
  heard: string;
  ms: number;
  clips: number;
  /**
   * The lesson, a silent plan («Дозапись голоса»): indexes into the event's sentences (`saySentences`) that have no
   * recording and may be requested. Absent / [] = voiced, or nothing may be requested.
   */
  lessonMissing?: number[];
  /**
   * An older event's clip twin («Дозапись голоса» for every phrase): its whole catalogue sentences (W items) whose exact
   * wording has no recording and may be requested (core `ClipPlan.lineMissing`) — even when the plan is voiced by
   * another wording of the pool. Absent / [] = nothing to record.
   */
  lineMissing?: ClipGenLine[];
  /**
   * The recordings can never say this bubble whole — a twin that voices only part of it (an opener that names the
   * opponent, the game end's practice idea, words no wording has): what it misses is still recorded, but a late play
   * (G2) would never happen, so its bubble never waits for one. Absent = it can be said whole.
   */
  partial?: true;
}

/**
 * How a late play of a recorded phrase ended (`ClipExtras.playLate`, «Дозапись голоса» G2):
 *  'played'     — heard to its end (or to the end of its sentence)
 *  'stopped'    — cut (a new phrase, a stop, the moment passed before its first sample)
 *  'busy'       — the layer was saying or loading something else: nothing played
 *  'not-voiced' — the library does not say it whole yet (a sentence still missing): nothing played, may be tried again
 *  'no-audio'   — the audio is not running (never resumed, never a gesture asked for, no silent timing): nothing played
 */
export type ClipLateResult = 'played' | 'stopped' | 'busy' | 'not-voiced' | 'no-audio';

export interface ClipLateOptions {
  /** the 5-minute game's gaps (× 0.75) */
  blitz?: boolean;
  /** asked right before the first sample is scheduled: false = the moment has passed, nothing plays ('stopped') */
  stillCurrent?: () => boolean;
  /** the first sample is scheduled; `heard` = exactly what will be heard */
  onStart?: (heard: string) => void;
}

/**
 * «Дозапись голоса»: what the lesson book asks the clip layer on every pick (read live — never a captured index):
 * a unit that already plays, a unit that will never be recorded.
 */
export interface LessonTakeProbe {
  /** the unit (`lessonUnitKey`) has a take saying exactly `text` that has not failed to load */
  voiced(unitKey: string, text: string): boolean;
  /** the overlay's `blocked[]` */
  blocked(unitKey: string): boolean;
}

/** The library the layer loaded — the parent's status line («1 240 фраз, версия 3»). */
export interface ClipLibraryStatus {
  voiceKey: string;
  libraryVersion: number;
  /** distinct recorded units (lines, moves, fragments) */
  phrases: number;
  /** recorded takes */
  units: number;
}

/** What to decode ahead of time (SPEC §5.4): candidate moves, the next utterances, whole pools. Decode only. */
export interface ClipPrewarmHint {
  moves?: readonly { san: string; fen: string }[];
  events?: readonly CoachEvent[];
  pools?: readonly string[];
}

/** Extras of the clips layer (feature-detected with `isClipLayer`). */
export interface ClipExtras {
  /** ms until the sentence being heard ends; null while nothing is audible (the gentle stop decides by it) */
  msToSentenceEnd(): number | null;
  /** cut the later sentences, let the one being heard finish; false = nothing audible (cut instead) */
  endAfterSentence(): boolean;
  /** «Повтори»: the last utterance again, the same takes (free) */
  replayLast(): Promise<void>;
  /** every planned utterance: heard text + source (journal, black box) */
  onPlan(cb: (info: ClipPlanInfo) => void): Unsubscribe;
  prewarm(hint: ClipPrewarmHint): void;
  libraryStatus(): ClipLibraryStatus | null;
  /** a game starts (its time control) / ends (null): per-game coverage stats («прошлая партия: 96 % записями») */
  setGame(game: { timeControlId: TimeControlId } | null): void;

  // ── «Дозапись голоса» (optional: a layer without them simply never records anything) ──
  /** the book's probe against the library speaking now; null before the library loaded */
  lessonProbe?(): LessonTakeProbe | null;
  /**
   * A dry run of the lesson planner for a lesson phrase without a twin: true = it will be voiced (every sentence has a
   * take now). Consumes no randomness; the bubble's first mark is decided by it, the real plan confirms it.
   */
  canVoiceLesson?(event: CoachEvent): boolean;
  /** re-read the recorded overlay; true = the library changed */
  reloadOverlay?(): Promise<boolean>;
  /** the loaded overlay's version (null = none) */
  overlayVersion?(): number | null;
  /**
   * G2: an utterance that was silent a moment ago, played now that its recording arrived — only when nothing else is
   * said or loading, the audio already runs, and the library says it whole, exactly as its bubble reads (an answer twin
   * may use any wording: its bubble takes the heard words). Never reported as a plan (no double stats, nothing to
   * request), never a bark, never the silent timing. The layer's `stop()` and its next `speakEvent` cut it.
   */
  playLate?(event: CoachEvent, opts?: ClipLateOptions): Promise<ClipLateResult>;
}

export function isClipLayer(voice: VoiceLayer | null | undefined): voice is VoiceLayer & ClipExtras {
  const v = voice as (VoiceLayer & Partial<ClipExtras>) | null | undefined;
  return !!v && v.kind === 'clips' && typeof v.msToSentenceEnd === 'function' && typeof v.endAfterSentence === 'function';
}

export type CoachVoiceLayer = VoiceLayer & Partial<GestureGated> & Partial<ConversationalExtras>;

export function isGestureGated(voice: VoiceLayer): voice is VoiceLayer & GestureGated {
  const v = voice as Partial<GestureGated>;
  return typeof v.unlock === 'function' && typeof v.onNeedsUserGestureChange === 'function';
}
