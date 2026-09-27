/** Test doubles shared by the coach unit tests (no DOM needed). */
import type { CoachEvent, CoachToolHost, ConversationState, HealthInfo, MicMode, VoiceLayer } from '@gambit/shared';
import type { SettingsStorage } from './settings.ts';
import type { CoachPageLifecycle } from './coachController.ts';
import type { BriefSpeakOptions, CoachVoiceLayer, SayProgress, SuspendOptions, UnavailableDetail, VoiceKind } from './voiceTypes.ts';
import { createEmitter } from './voiceUtils.ts';

export interface FakeVoice extends CoachVoiceLayer {
  readonly spoken: { text: string; interrupt: boolean }[];
  /** conversational fakes: what was handed to speakBrief (it also lands in `spoken` as `brief:<text>`) */
  readonly briefs: { brief: string; interrupt: boolean; fallbackText: string | undefined; maxSentences?: number }[];
  readonly openCalls: number;
  readonly stopCalls: number;
  readonly disposed: boolean;
  /** finishes the phrase that is being "spoken" right now */
  finish(): void;
  emitLevel(level: number): void;
  setNeedsGesture(needs: boolean): void;
  emitCaption(text: string): void;
  emitThinking(thinking: boolean): void;
  emitSpeaking(speaking: boolean): void;
  emitTranscript(who: 'child' | 'coach', text: string): void;
  listenCalls: { start: number; stop: number };
  toolHost: CoachToolHost | null;
  /** conversational fakes: what the controller asked of the session and the microphone */
  readonly sessionCalls: { suspend: number; resume: number };
  /** the options of every suspend() call, in order (`{ pageHide: true }` when the page closed) */
  readonly suspendOptions: (SuspendOptions | undefined)[];
  readonly micCalls: { modes: MicMode[]; muted: boolean[]; echoGuard: boolean[] };
  readonly contextNotes: string[];
  emitChildSpeaking(speaking: boolean): void;
  emitConnected(connected: boolean): void;
  /** the layer gives up (no key, repeated failures); `detail` says whether for good and why */
  emitUnavailable(reason: string, detail?: UnavailableDetail): void;
  /** conversational fakes: how often the child's tap cut the coach off (`interrupt()`) */
  readonly interruptCalls: number;
  emitSayProgress(progress: SayProgress): void;
  emitConversationState(state: ConversationState): void;
  emitMicLevel(level: number): void;
  emitToolCoachEvent(event: CoachEvent): void;
}

export interface FakeVoiceOptions {
  kind?: VoiceKind;
  failInit?: boolean;
  gestureGated?: boolean;
  needsGesture?: boolean;
  conversational?: boolean;
  /** never resolves speak() on its own and ignores stop() — a "broken" voice */
  stuck?: boolean;
  /** init() never settles — a stalled network */
  hangInit?: boolean;
  /** conversational fakes: openConversation() resolves false (could not connect) */
  failOpen?: boolean;
}

export function createFakeVoice(options: FakeVoiceOptions = {}): FakeVoice {
  const level = createEmitter<number>();
  const speaking = createEmitter<boolean>();
  const gesture = createEmitter<boolean>();
  const caption = createEmitter<string>();
  const thinking = createEmitter<boolean>();
  const transcript = createEmitter<{ who: 'child' | 'coach'; text: string }>();
  const childSpeaking = createEmitter<boolean>();
  const connectedChange = createEmitter<boolean>();
  const unavailable = createEmitter<{ reason: string; detail?: UnavailableDetail }>();
  let interruptCalls = 0;
  const sayProgress = createEmitter<SayProgress>();
  const conversationState = createEmitter<ConversationState>();
  const micLevel = createEmitter<number>();
  const toolEvents = createEmitter<CoachEvent>();
  const briefs: { brief: string; interrupt: boolean; fallbackText: string | undefined; maxSentences?: number }[] = [];
  let openCalls = 0;
  const sessionCalls = { suspend: 0, resume: 0 };
  const suspendOptions: (SuspendOptions | undefined)[] = [];
  const micCalls: { modes: MicMode[]; muted: boolean[]; echoGuard: boolean[] } = { modes: [], muted: [], echoGuard: [] };
  const contextNotes: string[] = [];
  let connected = false;
  const spoken: { text: string; interrupt: boolean }[] = [];
  let pending: (() => void)[] = [];
  let needs = options.needsGesture ?? false;
  let stopCalls = 0;
  let disposed = false;
  const listenCalls = { start: 0, stop: 0 };

  const finishAll = (): void => {
    const waiting = pending;
    pending = [];
    for (const done of waiting) done();
  };

  const voice: FakeVoice = {
    kind: options.kind ?? 'browser-tts',
    spoken,
    briefs,
    get openCalls() {
      return openCalls;
    },
    listenCalls,
    toolHost: null,
    sessionCalls,
    suspendOptions,
    micCalls,
    contextNotes,
    emitChildSpeaking: (value) => childSpeaking.emit(value),
    emitConnected(value) {
      connected = value;
      connectedChange.emit(value);
    },
    emitUnavailable: (reason, detail) => unavailable.emit(detail ? { reason, detail } : { reason }),
    get interruptCalls() {
      return interruptCalls;
    },
    emitSayProgress: (progress) => sayProgress.emit(progress),
    emitConversationState: (state) => conversationState.emit(state),
    emitMicLevel: (value) => micLevel.emit(value),
    emitToolCoachEvent: (event) => toolEvents.emit(event),
    get stopCalls() {
      return stopCalls;
    },
    get disposed() {
      return disposed;
    },
    init: () => (options.hangInit ? new Promise<void>(() => undefined) : options.failInit ? Promise.reject(new Error('init failed')) : Promise.resolve()),
    speak(text, opts) {
      spoken.push({ text, interrupt: opts?.interrupt ?? false });
      speaking.emit(true);
      return new Promise<void>((resolve) => {
        pending.push(() => {
          speaking.emit(false);
          resolve();
        });
      });
    },
    stop() {
      stopCalls++;
      if (!options.stuck) finishAll();
    },
    finish: finishAll,
    onLevel: (cb) => level.on(cb),
    onSpeakingChange: (cb) => speaking.on(cb),
    dispose() {
      disposed = true;
    },
    emitLevel: (value) => level.emit(value),
    emitCaption: (text) => caption.emit(text),
    emitThinking: (value) => thinking.emit(value),
    emitSpeaking: (value) => speaking.emit(value),
    emitTranscript: (who, text) => transcript.emit({ who, text }),
    setNeedsGesture(value) {
      needs = value;
      gesture.emit(value);
    },
  };

  if (options.gestureGated) {
    Object.defineProperty(voice, 'needsUserGesture', { get: () => needs });
    voice.onNeedsUserGestureChange = (cb) => gesture.on(cb);
    voice.unlock = () => voice.setNeedsGesture(false);
  }
  if (options.conversational) {
    Object.defineProperty(voice, 'micAvailable', { get: () => true });
    voice.startListening = () => {
      listenCalls.start++;
      return Promise.resolve();
    };
    voice.stopListening = () => {
      listenCalls.stop++;
    };
    voice.onTranscript = (cb) => transcript.on(({ who, text }) => cb(who, text));
    voice.onCoachCaption = (cb) => caption.on(cb);
    voice.onThinkingChange = (cb) => thinking.on(cb);
    voice.setToolHost = (host) => {
      voice.toolHost = host;
    };
    Object.defineProperty(voice, 'connected', { get: () => connected });
    voice.onConnectedChange = (cb) => connectedChange.on(cb);
    voice.onChildSpeakingChange = (cb) => childSpeaking.on(cb);
    voice.onUnavailable = (cb) => unavailable.on(({ reason, detail }) => cb(reason, detail));
    voice.interrupt = () => {
      interruptCalls++;
      // like the real layer: whatever is being said stops
      finishAll();
    };
    voice.suspend = (opts) => {
      sessionCalls.suspend++;
      suspendOptions.push(opts);
      voice.emitConnected(false);
      conversationState.emit('off');
    };
    voice.resume = () => {
      sessionCalls.resume++;
      voice.emitConnected(true);
    };
    voice.openConversation = () => {
      openCalls++;
      if (options.failOpen) {
        conversationState.emit('error');
        return Promise.resolve(false);
      }
      conversationState.emit('connecting');
      voice.emitConnected(true);
      conversationState.emit('listening');
      return Promise.resolve(true);
    };
    voice.speakBrief = (brief, opts) => {
      briefs.push({
        brief,
        interrupt: opts?.interrupt ?? false,
        fallbackText: opts?.fallbackText,
        // teacher mode: the sentence budget (a local extra of speakBrief, see BriefSpeakOptions)
        ...((opts as BriefSpeakOptions | undefined)?.maxSentences !== undefined ? { maxSentences: (opts as BriefSpeakOptions).maxSentences } : {}),
      });
      spoken.push({ text: `brief:${brief}`, interrupt: opts?.interrupt ?? false });
      speaking.emit(true);
      return new Promise<void>((resolve) => {
        pending.push(() => {
          speaking.emit(false);
          resolve();
        });
      });
    };
    voice.onSayProgress = (cb) => sayProgress.on(cb);
    voice.onConversationState = (cb) => conversationState.on(cb);
    voice.onMicLevel = (cb) => micLevel.on(cb);
    voice.onToolCoachEvent = (cb) => toolEvents.on(cb);
    voice.setMicMode = (mode) => {
      micCalls.modes.push(mode);
      return Promise.resolve();
    };
    voice.setMicMuted = (muted) => {
      micCalls.muted.push(muted);
    };
    voice.setEchoGuard = (enabled) => {
      micCalls.echoGuard.push(enabled);
    };
    voice.pushContext = (note) => {
      contextNotes.push(note);
    };
  }
  return voice;
}

/** A page whose visibility, closing and touches the test drives (the coach's `CoachPageLifecycle`). */
export interface FakePage {
  readonly page: CoachPageLifecycle;
  /** document.visibilityState changes (fires 'visibilitychange') */
  setHidden(hidden: boolean): void;
  /** the page goes away: hidden + 'pagehide' */
  pageHide(): void;
  /** a pointerdown / keydown somewhere on the page (outside the dock) */
  touch(): void;
}

export function createFakePage(): FakePage {
  let hidden = false;
  const visibility = createEmitter<undefined>();
  const hide = createEmitter<undefined>();
  const input = createEmitter<undefined>();
  return {
    page: {
      isHidden: () => hidden,
      onVisibilityChange: (cb) => visibility.on(() => cb()),
      onPageHide: (cb) => hide.on(() => cb()),
      onUserInput: (cb) => input.on(() => cb()),
    },
    setHidden(value) {
      hidden = value;
      visibility.emit(undefined);
    },
    pageHide() {
      hidden = true;
      visibility.emit(undefined);
      hide.emit(undefined);
    },
    touch: () => input.emit(undefined),
  };
}

export function createMemoryStorage(initial: Record<string, string> = {}): SettingsStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

/**
 * A /api/health answer. `runtimeAi` (default true — most coach tests exercise the paid voices) is the server's
 * `ai.runtime` (docs/TEACHING.md §4.4); `runtimeAi: null` = an old server without the field.
 */
export function makeHealth(realtime: boolean, live?: { live: boolean; preferred?: 'live' | 'realtime' | 'clips' }, opts: { runtimeAi?: boolean | null } = {}): HealthInfo {
  const runtimeAi = opts.runtimeAi === undefined ? true : opts.runtimeAi;
  return {
    ok: true,
    llm: { codexCli: false, codexLoggedIn: false, openaiKey: realtime || live?.live === true },
    voice: {
      realtime,
      model: 'test-model',
      voice: 'marin',
      ...(live ? { live: live.live, liveModel: 'gpt-live-test', ...(live.preferred ? { preferred: live.preferred } : {}) } : {}),
    },
    puzzles: { count: 0 },
    ...(runtimeAi === null ? {} : { ai: { runtime: runtimeAi } }),
  };
}

let eventCounter = 0;
export function makeEvent(patch: Partial<CoachEvent> = {}): CoachEvent {
  eventCounter += 1;
  return {
    id: `event-${eventCounter}`,
    kind: 'encourage',
    priority: 1,
    text: `Фраза номер ${eventCounter}.`,
    bubbleText: `Фраза ${eventCounter}`,
    pose: 'talk',
    pauseClock: false,
    ...patch,
  };
}

export function isVoiceLayer(value: unknown): value is VoiceLayer {
  return typeof value === 'object' && value !== null && 'speak' in value && 'kind' in value;
}
