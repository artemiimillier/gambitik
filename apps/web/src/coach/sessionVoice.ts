/**
 * The part both paid OpenAI voice layers share: a `VoiceLayer` on top of a WebRTC session that is
 *
 *   LAZY      — `init()` opens nothing. The (billed) session and the microphone start on the first need:
 *               the first phrase, `resume()` after a click on the sleeping mascot, or the mic button.
 *   BOUNDED   — `speak()` can never hang the game: a missing session is awaited for at most
 *               `reconnectWaitMs` (6 s — a cold connect takes ≈ 4 s); after that — or at once for an urgent phrase — the warm browser voice
 *               says the phrase (or, when even that is impossible, the silent layer keeps the bubble's timing).
 *   FRUGAL    — `suspend()` closes session + microphone (the controller calls it when the mascot falls
 *               asleep, the tab stays hidden, the page closes or today's minutes are used up); every closed session
 *               is reported to `POST /api/voice/usage` (best effort; `suspend({ pageHide: true })` uses sendBeacon).
 *   HONEST    — when the layer cannot work at all (no key, no WebRTC, repeated failures) it says so through
 *               `onUnavailable`, so the controller can move down the chain live → realtime → browser.
 *               Until it is replaced it keeps talking through its own fallback voice, never silence.
 *   ALIVE     — `speakBrief(brief)` lets the model say a situation in its own words; only when it cannot does the
 *               fallback voice say the template (`fallbackText`). `onConversationState` drives the «Поговорить» button,
 *               `openConversation()` opens session + microphone on the child's tap (or a game start).
 *   AUDIBLE   — `onHearingProblem` / `onHearingOk` report
 *               whether the model's speech really played; `recheckAudio()` re-unlocks it inside a click; a refused
 *               microphone is asked for again on the SAME session (`retryMicrophone`, never a new billed one). Every
 *               step goes to the black box (./voiceDiag.ts).
 *               A refused microphone is NOT a broken conversation: the state follows what the coach does
 *               ('listening', 'coachSpeaking' …) and `micAvailable` = false tells the dock to show «Микрофон закрыт —
 *               нажми, чтобы разрешить»; granted later (a tap, or the site settings) it is back to normal by itself.
 *   INTERRUPTIBLE — `interrupt()`: the child tapped while the coach speaks — the phrase is cancelled, the playback hushed
 *               and the microphone opened at once (loudspeakers: he cannot be talked over).
 *   HONEST ABOUT WHY — `onUnavailable(reason, { permanent, code })`: the controller shows the parent why the fallback
 *               model speaks and tries this layer again later unless the failure is permanent (no key, key refused).
 */
import type { CoachEvent, CoachToolHost, ConversationState, MicMode, VoiceLayer } from '@gambit/shared';
import { isApiError } from '../api/client.ts';
import { createBrowserTtsVoice } from './browserTtsVoice.ts';
import { createGestureGate } from './gestureGate.ts';
import type { GestureGate } from './gestureGate.ts';
import { reportVoiceUsage, upstreamReason } from './liveApi.ts';
import { SessionUnavailableError } from './rtcSession.ts';
import type { AudioUnlockResult, HearingProblem, RtcSession, RtcSessionEvents } from './rtcSession.ts';
import { createSilentVoice } from './silentVoice.ts';
import { diag, diagString, errorName } from './voiceDiag.ts';
import type { BriefSpeakOptions, ConversationalExtras, GestureGated, OpenAiVoiceKind, SayProgress, SpeakOutcome, UnavailableDetail, VoiceKind } from './voiceTypes.ts';
import { isGestureGated } from './voiceTypes.ts';
import { createEmitter } from './voiceUtils.ts';
import type { Unsubscribe } from './voiceUtils.ts';

/** What the wire protocol reports upwards, whichever API it speaks. */
export interface SessionProtocolEvents {
  getToolHost(): CoachToolHost | null;
  onTranscript(who: 'child' | 'coach', text: string): void;
  onCoachTranscriptDelta(textSoFar: string): void;
  onThinking(thinking: boolean): void;
  onToolCoachEvent(event: CoachEvent): void;
  onChildSpeaking(speaking: boolean): void;
  onSayProgress(progress: SayProgress): void;
}

export interface SessionOpenArgs {
  micMode: MicMode;
  micMuted: boolean;
  echoGuard: boolean;
  maxListenMs: number;
  rtc: RtcSessionEvents;
  protocol: SessionProtocolEvents;
}

export interface SessionVoiceOptions {
  /** factory of the layer used while the session is unavailable; defaults to browser TTS */
  createFallback?: () => VoiceLayer;
  /** how long a normal phrase waits for a (re)connect before the fallback says it (default 6 s); urgent phrases never wait */
  reconnectWaitMs?: number;
  /** consecutive failed connects after which the layer declares itself unavailable */
  maxConnectFailures?: number;
  /** consecutive phrases the model failed to say after which the layer declares itself unavailable */
  maxSpeakFailures?: number;
  /** safety stop for a stuck push-to-talk button */
  maxListenMs?: number;
  /** best-effort cost bookkeeping; defaults to `POST /api/voice/usage` (`beacon`: the page is closing — navigator.sendBeacon) */
  reportUsage?: (provider: OpenAiVoiceKind, seconds: number, opts?: { beacon?: boolean }) => void;
}

export interface SessionVoiceConfig extends SessionVoiceOptions {
  kind: OpenAiVoiceKind;
  /** opens the WebRTC session (layer-specific handshake + protocol) */
  open(args: SessionOpenArgs): Promise<RtcSession>;
}

/**
 * Playback / microphone health of a conversational layer (local extension, feature-detected by the controller with
 * `hasVoiceHealth`): the dock's «Не слышно? Нажми сюда» and «Микрофон закрыт» work through it.
 */
export interface VoiceHealthExtras {
  /** the model produced speech but nothing could be heard (see rtcSession HearingProblem) */
  onHearingProblem(cb: (problem: HearingProblem) => void): Unsubscribe;
  /** an utterance was really heard: an earlier suspicion is over */
  onHearingOk(cb: () => void): Unsubscribe;
  /** call INSIDE a click: play() + AudioContext.resume() of the open session (and the fallback voice's unlock) */
  recheckAudio(): Promise<AudioUnlockResult | null>;
  /** the microphone was refused / dismissed: ask again on the open session. true = the microphone is attached now. */
  retryMicrophone(): Promise<boolean>;
}

export function hasVoiceHealth(voice: unknown): voice is VoiceHealthExtras {
  const v = voice as Partial<VoiceHealthExtras> | null;
  return v !== null && typeof v === 'object' && typeof v.recheckAudio === 'function' && typeof v.onHearingProblem === 'function';
}

export type SessionVoice = VoiceLayer & GestureGated & ConversationalExtras & VoiceHealthExtras;

/**
 * A short, Latin-only code of a connect failure for the black box and the parent's status line
 * ('502:voice-upstream:net:ENOTFOUND', '0:network', 'the SDP exchange timed out'): the server's `reason` says WHY.
 */
export function failureCode(error: unknown): string {
  if (isApiError(error)) {
    const reason = upstreamReason(error.body);
    return diagString(`${error.status}:${String(error.code).slice(0, 24)}${reason !== null ? `:${reason}` : ''}`.slice(0, 64));
  }
  if (error instanceof Error) return diagString(error.message.slice(0, 64));
  return errorName(error);
}

/** how long a normal (non-urgent) phrase waits for a session that is being opened before the fallback voice says it */
export const DEFAULT_RECONNECT_WAIT_MS = 6000;

function isPermanentConnectError(error: unknown): { permanent: boolean; noKey: boolean } {
  const noKey = isApiError(error) && (error.code === 'no-api-key' || error.status === 503);
  const refused = isApiError(error) && (error.status === 401 || error.status === 403);
  const permanent = noKey || refused || (error instanceof SessionUnavailableError && error.permanent);
  return { permanent, noKey };
}

export function createSessionVoice(config: SessionVoiceConfig): SessionVoice {
  const { kind } = config;
  const createFallback = config.createFallback ?? (() => createBrowserTtsVoice());
  // A cold connect takes 3.6–3.9 s (ICE gathering + session creation + DTLS + session start). With a 2 s wait every
  // first phrase — the greeting — would be said by the robotic browser voice and only the second one by the live voice. 6 s lets the greeting wait for the real voice; urgent phrases
  // still never wait, and a connect that FAILS settles at once (the wait only covers a connect that is in flight).
  const reconnectWaitMs = config.reconnectWaitMs ?? DEFAULT_RECONNECT_WAIT_MS;
  const maxConnectFailures = config.maxConnectFailures ?? 3;
  const maxSpeakFailures = config.maxSpeakFailures ?? 3;
  const maxListenMs = config.maxListenMs ?? 30_000;
  const reportUsage = config.reportUsage ?? ((provider, seconds, opts) => reportVoiceUsage(provider, seconds, { beacon: opts?.beacon === true }));

  const level = createEmitter<number>();
  const speakingChange = createEmitter<boolean>();
  const transcript = createEmitter<{ who: 'child' | 'coach'; text: string }>();
  const kindChange = createEmitter<VoiceKind>();
  const micChange = createEmitter<boolean>();
  const thinkingChange = createEmitter<boolean>();
  const toolCoachEvent = createEmitter<CoachEvent>();
  const caption = createEmitter<string>();
  const gestureChange = createEmitter<boolean>();
  const connectedChange = createEmitter<boolean>();
  const childSpeakingChange = createEmitter<boolean>();
  const unavailable = createEmitter<{ reason: string; detail: UnavailableDetail }>();
  const sayProgress = createEmitter<SayProgress>();
  const conversationStateChange = createEmitter<ConversationState>();
  const micLevelChange = createEmitter<number>();
  const hearingProblem = createEmitter<HearingProblem>();
  const hearingOk = createEmitter<void>();

  let session: RtcSession | null = null;
  /**
   * Retires the callbacks of the open session once it is closed. The data channel stays open a moment for the goodbye
   * and the protocol is reset, so a late server event (the child's voice activity, a transcript) would otherwise still
   * reach the controller after WE closed the session — and count as the child's activity, reopening a paid session.
   */
  let retireSession: (() => void) | null = null;
  let connecting: Promise<RtcSession | null> | null = null;
  let fallback: VoiceLayer | null = null;
  let fallbackReady: Promise<VoiceLayer | null> | null = null;
  let gate: GestureGate | null = null;
  let toolHost: CoachToolHost | null = null;
  let permanentFallback = false;
  let connectFailures = 0;
  let speakFailures = 0;
  /** the last connect failure (code + permanent?) — what the parent is told when the layer gives up */
  let lastFailure: UnavailableDetail | null = null;
  /** bumped by stop(): a phrase still waiting for the connection when it changes is dropped */
  let stopGeneration = 0;
  let micDenied = false;
  let disposed = false;
  let usingFallbackNow = false;
  let micMode: MicMode = 'open';
  let micMuted = false;
  let echoGuard = true;
  let pendingContext: string[] = [];
  /** the controller put the session to sleep: a connect that was still in flight must not open it behind its back */
  let suspended = false;
  // what the «Поговорить» button shows
  let lastConnectFailed = false;
  let coachAudible = false;
  let childSpeakingNow = false;
  let thinkingNow = false;
  let lastConversationState: ConversationState = 'off';

  function computeConversationState(): ConversationState {
    if (session?.state === 'connected') {
      // A refused microphone is not a broken conversation (it stayed 'error' for a whole game while the voice worked):
      // the state follows the coach, `micAvailable` = false tells the dock «Микрофон закрыт — нажми, чтобы разрешить».
      if (childSpeakingNow) return 'childSpeaking';
      if (coachAudible) return 'coachSpeaking';
      if (thinkingNow) return 'thinking';
      return 'listening';
    }
    if (connecting !== null) return 'connecting';
    if (lastConnectFailed || permanentFallback) return 'error';
    return 'off';
  }

  function publishConversation(): void {
    if (disposed) return;
    const next = computeConversationState();
    if (next === lastConversationState) return;
    lastConversationState = next;
    diag('conv.state', { kind, state: next, micDenied });
    conversationStateChange.emit(next);
  }

  /** stays on the OpenAI kind until the fallback layer is really up, so the kind never flickers */
  const currentKind = (): VoiceKind => (permanentFallback && fallback ? fallback.kind : kind);
  const micAvailable = (): boolean =>
    !permanentFallback && !micDenied && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';

  let lastKind: VoiceKind = kind;
  let lastMic = false;
  function publishStatus(): void {
    const next = currentKind();
    if (next !== lastKind) {
      lastKind = next;
      kindChange.emit(next);
    }
    const mic = micAvailable();
    if (mic !== lastMic) {
      lastMic = mic;
      micChange.emit(mic);
    }
  }

  function ensureFallback(): Promise<VoiceLayer | null> {
    fallbackReady ??= (async () => {
      let layer = createFallback();
      try {
        await layer.init();
      } catch (error) {
        console.warn('[coach] fallback voice failed to start', error instanceof Error ? error.message : error);
        layer.dispose();
        // no browser voice either (no Russian voice, blocked, broken): the bubble keeps its natural timing
        layer = createSilentVoice();
      }
      if (disposed) {
        layer.dispose();
        return null;
      }
      layer.onLevel((value) => usingFallbackNow && level.emit(value));
      layer.onSpeakingChange((value) => usingFallbackNow && speakingChange.emit(value));
      if (isGestureGated(layer)) layer.onNeedsUserGestureChange(() => gestureChange.emit(needsGesture()));
      fallback = layer;
      return layer;
    })();
    return fallbackReady;
  }

  function needsGesture(): boolean {
    if (permanentFallback && fallback && isGestureGated(fallback)) return fallback.needsUserGesture;
    return (gate?.needsUserGesture ?? false) || (session?.playbackBlocked ?? false);
  }

  function closeSession(opts?: { beacon?: boolean }, why = 'close'): void {
    const closing = session;
    if (!closing) return;
    session = null;
    diag('sess.close', { kind, why, secs: Math.round(closing.connectedSeconds) });
    // close() flushes the last words synchronously (they still reach the journal); anything later is dropped
    closing.close();
    retireSession?.();
    retireSession = null;
    accountFor(closing, opts);
    connectedChange.emit(false);
    // only what really changes: a «child stopped speaking» that was never «speaking» must not count as activity
    if (childSpeakingNow) childSpeakingChange.emit(false);
    if (thinkingNow) thinkingChange.emit(false);
    coachAudible = false;
    childSpeakingNow = false;
    thinkingNow = false;
    publishConversation();
  }

  function accountFor(closed: RtcSession, opts?: { beacon?: boolean }): void {
    const seconds = Math.max(closed.protocol.usageSeconds ?? 0, closed.connectedSeconds);
    if (seconds >= 1) {
      try {
        if (opts?.beacon) reportUsage(kind, seconds, { beacon: true });
        else reportUsage(kind, seconds);
      } catch {
        /* bookkeeping only */
      }
    }
  }

  function goUnavailable(reason: string, detail: UnavailableDetail = { permanent: false, code: null }): void {
    if (permanentFallback) return;
    permanentFallback = true;
    console.info(`[coach] ${kind} voice is off (${reason}${detail.code !== null ? `: ${detail.code}` : ''})`);
    diag('layer.off', { kind, reason: diagString(reason), code: detail.code, permanent: detail.permanent });
    closeSession(undefined, 'unavailable');
    publishConversation();
    void ensureFallback().then(() => {
      if (disposed) return;
      publishStatus();
      gestureChange.emit(needsGesture());
      unavailable.emit({ reason, detail });
    });
  }

  function connect(): Promise<RtcSession | null> {
    if (disposed || permanentFallback) return Promise.resolve(null);
    if (session?.state === 'connected') return Promise.resolve(session);
    const alreadyConnecting = connecting !== null;
    connecting ??= (async () => {
      // this connect's callbacks; false once its session is closed (see retireSession)
      let live = true;
      const retire = (): void => {
        live = false;
      };
      const startedAt = Date.now();
      diag('sess.open', { kind, attempt: connectFailures + 1 });
      try {
        const opened = await config.open({
          micMode,
          micMuted,
          echoGuard,
          maxListenMs,
          rtc: {
            onLevel: (value) => live && !usingFallbackNow && level.emit(value),
            onSpeaking: (value) => {
              if (!live) return;
              coachAudible = value;
              publishConversation();
              if (!usingFallbackNow) speakingChange.emit(value);
            },
            onLost: (reason) => {
              if (!live) return;
              retire();
              console.info(`[coach] ${kind} connection lost (${reason})`);
              diag('sess.lost', { kind, reason: diagString(reason) });
              const lost = session;
              if (lost) {
                session = null;
                retireSession = null;
                accountFor(lost);
              }
              connectedChange.emit(false);
              childSpeakingChange.emit(false);
              thinkingChange.emit(false);
              coachAudible = false;
              childSpeakingNow = false;
              thinkingNow = false;
              publishConversation();
            },
            onMicDenied: () => {
              if (!live) return;
              micDenied = true;
              publishStatus();
              publishConversation();
            },
            onMicReady: () => {
              if (!live) return;
              micDenied = false;
              publishStatus();
              publishConversation();
            },
            onMicLevel: (value) => live && micLevelChange.emit(value),
            onPlaybackBlocked: () => {
              if (!live) return;
              diag('out.blocked', { kind });
              gate?.lock();
              gestureChange.emit(needsGesture());
            },
            onHearingProblem: (problem) => {
              if (!live) return;
              diag('hear.problem', { kind, why: problem });
              hearingProblem.emit(problem);
            },
            onHearingOk: () => live && hearingOk.emit(),
          },
          protocol: {
            getToolHost: () => toolHost,
            onTranscript: (who, text) => {
              if (!live) return;
              // the model talks: it is not «keeping silent», whatever happened to an earlier phrase
              if (who === 'coach') speakFailures = 0;
              transcript.emit({ who, text });
            },
            onCoachTranscriptDelta: (text) => live && caption.emit(text),
            onThinking: (value) => {
              if (!live) return;
              thinkingNow = value;
              publishConversation();
              thinkingChange.emit(value);
            },
            onToolCoachEvent: (event) => live && toolCoachEvent.emit(event),
            onChildSpeaking: (value) => {
              if (!live) return;
              childSpeakingNow = value;
              publishConversation();
              childSpeakingChange.emit(value);
            },
            onSayProgress: (progress) => live && sayProgress.emit(progress),
          },
        });
        if (disposed || permanentFallback || suspended) {
          diag('sess.close', { kind, why: suspended ? 'suspended-while-connecting' : 'unwanted', secs: 0 });
          opened.close();
          retire();
          accountFor(opened);
          return null;
        }
        session = opened;
        retireSession = retire;
        connectFailures = 0;
        lastConnectFailed = false;
        diag('sess.up', { kind, ms: Date.now() - startedAt });
        for (const note of pendingContext.splice(0)) opened.protocol.pushContext(note);
        connectedChange.emit(true);
        return opened;
      } catch (error) {
        retire();
        connectFailures++;
        lastConnectFailed = true;
        const { permanent, noKey } = isPermanentConnectError(error);
        const code = failureCode(error);
        lastFailure = { permanent, code };
        diag('sess.fail', { kind, code, permanent, failures: connectFailures, ms: Date.now() - startedAt });
        if (permanent || connectFailures >= maxConnectFailures) goUnavailable(noKey ? 'no API key' : 'cannot connect', lastFailure);
        else console.info(`[coach] ${kind} connect failed, will retry later`);
        return null;
      } finally {
        connecting = null;
        publishConversation();
      }
    })();
    if (!alreadyConnecting) publishConversation();
    return connecting;
  }

  async function speakWithFallback(text: string, opts?: { interrupt?: boolean }): Promise<void> {
    const layer = await ensureFallback();
    if (!layer || disposed) return;
    diag('say.fallback', { kind, voice: layer.kind });
    usingFallbackNow = true;
    try {
      await layer.speak(text, opts);
    } finally {
      usingFallbackNow = false;
    }
  }

  /** the session a phrase can go to now — a normal phrase waits a moment for a (re)connect, an urgent one never */
  async function sessionForPhrase(urgent: boolean): Promise<RtcSession | null> {
    suspended = false;
    let active = session?.state === 'connected' ? session : null;
    if (!active && !permanentFallback) {
      const connected = connect();
      active = urgent
        ? null
        : await Promise.race([
            connected,
            new Promise<null>((resolve) => {
              setTimeout(() => resolve(null), reconnectWaitMs);
            }),
          ]);
    }
    if (active && active.state === 'connected' && active.playbackBlocked) diag('say.skip', { kind, why: 'playbackBlocked' });
    return active && active.state === 'connected' && !active.playbackBlocked ? active : null;
  }

  /** true = the model took care of it; false = the fallback voice must say it */
  function settleOutcome(outcome: SpeakOutcome, mode: 'brief' | 'verbatim', startedAt: number): boolean {
    diag('say.end', { kind, mode, outcome, ms: Date.now() - startedAt, failures: outcome === 'failed' ? speakFailures + 1 : 0 });
    if (outcome !== 'failed') {
      if (outcome === 'spoken') speakFailures = 0;
      return true;
    }
    speakFailures++;
    if (speakFailures >= maxSpeakFailures) goUnavailable('the model keeps silent', { permanent: false, code: `silent:${speakFailures}` });
    return false;
  }

  async function speak(text: string, opts?: { interrupt?: boolean }): Promise<void> {
    if (disposed) return;
    if (opts?.interrupt && usingFallbackNow) fallback?.stop();
    const generation = stopGeneration;
    const startedAt = Date.now();
    const active = await sessionForPhrase(opts?.interrupt === true);
    // stopped while it waited for the connection: it is not said at all (else the wizard's prompts, interrupted long
    // ago, would be voiced after the connect and push the first advice back by ~15 s)
    if (disposed || generation !== stopGeneration) return;
    if (active) diag('say', { kind, mode: 'verbatim', urgent: opts?.interrupt === true, waited: Date.now() - startedAt });
    if (active && settleOutcome(await active.protocol.speak(text, opts), 'verbatim', startedAt)) return;
    if (disposed) return;
    await speakWithFallback(text, opts);
  }

  /** asks for the microphone again on an open session; the button shows «Микрофон закрыт» again if it is refused */
  async function retryMic(open: RtcSession): Promise<boolean> {
    micDenied = false;
    publishStatus();
    publishConversation();
    const ok = await open.retryMicrophone();
    // a refusal already set micDenied through onMicDenied; a closed session says nothing
    if (!ok && session === open && !micDenied) {
      micDenied = true;
      publishStatus();
      publishConversation();
    }
    return ok;
  }

  async function speakBrief(brief: string, opts?: BriefSpeakOptions): Promise<void> {
    if (disposed) return;
    const fallbackText = opts?.fallbackText?.trim() ?? '';
    if (brief.trim() === '') {
      if (fallbackText !== '') await speak(fallbackText, { interrupt: opts?.interrupt });
      return;
    }
    if (opts?.interrupt && usingFallbackNow) fallback?.stop();
    const generation = stopGeneration;
    const startedAt = Date.now();
    const active = await sessionForPhrase(opts?.interrupt === true);
    if (disposed || generation !== stopGeneration) return;
    if (active) {
      diag('say', { kind, mode: 'brief', urgent: opts?.interrupt === true, waited: Date.now() - startedAt });
      // teacher mode: the phrase's sentence budget travels with it (the frame the model gets says how long to speak)
      const briefOpts: BriefSpeakOptions = { interrupt: opts?.interrupt, fallbackText };
      if (opts?.maxSentences !== undefined) briefOpts.maxSentences = opts.maxSentences;
      if (settleOutcome(await active.protocol.speakBrief(brief, briefOpts), 'brief', startedAt)) return;
      // A robot voice cutting into a live conversation is worse than silence — while the session
      // is up, a brief the model did not voice stays in the bubble (template) only.
      if (!disposed && fallbackText !== '' && session === active && active.state === 'connected') {
        diag('say.bubble', { kind });
        sayProgress.emit({ type: 'fallback' });
        return;
      }
    }
    if (disposed || fallbackText === '') return;
    // no session: the template goes to the free voice (and to the bubble)
    sayProgress.emit({ type: 'fallback' });
    await speakWithFallback(fallbackText, { interrupt: opts?.interrupt });
  }

  return {
    get kind() {
      return currentKind();
    },
    async init() {
      if (disposed) throw new Error(`${kind} voice was disposed`);
      gate = createGestureGate({
        onUnlock: () => {
          session?.unlockAudio();
          if (fallback && isGestureGated(fallback)) fallback.unlock();
        },
      });
      gate.onChange(() => gestureChange.emit(needsGesture()));
      // Nothing paid is opened here. The free voice is warmed up so that a slow or failed connect never means silence.
      await ensureFallback();
      publishStatus();
    },
    speak,
    speakBrief,
    stop() {
      stopGeneration += 1;
      if (session?.protocol.outputActive) diag('out.stop', { kind, why: 'app' });
      session?.protocol.cancelOutput();
      fallback?.stop();
    },
    interrupt() {
      // the child's tap: whatever was waiting is dropped, what sounds now is cut, the microphone opens at once
      stopGeneration += 1;
      fallback?.stop();
      if (session?.state === 'connected') session.interrupt();
      else session?.protocol.cancelOutput();
    },
    onLevel: (cb) => level.on(cb),
    onSpeakingChange: (cb) => speakingChange.on(cb),
    async startListening() {
      if (disposed || permanentFallback) throw new Error(`${kind} voice is not available`);
      fallback?.stop();
      suspended = false;
      const active = session?.state === 'connected' ? session : await connect();
      if (!active) throw new Error(`${kind} voice is not connected`);
      await active.startListening();
    },
    stopListening() {
      session?.stopListening();
    },
    setMicMode(mode) {
      micMode = mode;
      session?.setMicMode(mode);
      publishConversation();
      return Promise.resolve();
    },
    pushContext(note) {
      if (disposed || permanentFallback || note.trim() === '') return;
      if (session?.state === 'connected') session.protocol.pushContext(note);
      // a sleeping session is not woken up (and billed) for a note: the latest facts travel with the next connect
      else pendingContext = [...pendingContext, note].slice(-3);
    },
    onTranscript: (cb) => transcript.on(({ who, text }) => cb(who, text)),
    dispose() {
      if (disposed) return;
      closeSession(undefined, 'dispose');
      disposed = true;
      fallback?.dispose();
      fallback = null;
      gate?.dispose();
      hearingProblem.clear();
      hearingOk.clear();
      for (const emitter of [level, speakingChange, kindChange, micChange, thinkingChange, gestureChange, connectedChange, childSpeakingChange, micLevelChange]) emitter.clear();
      sayProgress.clear();
      conversationStateChange.clear();
      transcript.clear();
      toolCoachEvent.clear();
      caption.clear();
      unavailable.clear();
    },

    // GestureGated
    get needsUserGesture() {
      return needsGesture();
    },
    onNeedsUserGestureChange: (cb) => gestureChange.on(cb),
    unlock() {
      if (gate?.needsUserGesture) gate.unlock();
      else {
        session?.unlockAudio();
        if (fallback && isGestureGated(fallback)) fallback.unlock();
        gestureChange.emit(needsGesture());
      }
    },

    // ConversationalExtras
    setToolHost(host) {
      toolHost = host;
    },
    onKindChange: (cb) => kindChange.on(cb),
    get micAvailable() {
      return micAvailable();
    },
    onMicAvailableChange: (cb) => micChange.on(cb),
    onThinkingChange: (cb) => thinkingChange.on(cb),
    onToolCoachEvent: (cb) => toolCoachEvent.on(cb),
    onCoachCaption: (cb) => caption.on(cb),
    suspend(opts) {
      suspended = true;
      lastConnectFailed = false;
      // the page is closing: a keepalive fetch may not survive it — the seconds go out with a beacon
      closeSession({ beacon: opts?.pageHide === true }, opts?.pageHide === true ? 'pagehide' : 'suspend');
      publishConversation();
    },
    resume() {
      suspended = false;
      if (!disposed && !permanentFallback) void connect();
    },
    async openConversation() {
      if (disposed || permanentFallback) return false;
      suspended = false;
      const open = session?.state === 'connected' ? session : null;
      if (open && micDenied && micMode === 'open') {
        // The microphone was refused / the prompt dismissed: ask again on THIS session (not a new
        // one — a new billed Live session, 15 s up front, for nothing but a permission prompt).
        await retryMic(open);
        return session === open && open.state === 'connected';
      }
      return (await connect()) !== null;
    },
    onSayProgress: (cb) => sayProgress.on(cb),
    onConversationState: (cb) => conversationStateChange.on(cb),
    onMicLevel: (cb) => micLevelChange.on(cb),
    get connected() {
      return session?.state === 'connected';
    },
    onConnectedChange: (cb) => connectedChange.on(cb),
    onChildSpeakingChange: (cb) => childSpeakingChange.on(cb),
    setMicMuted(muted) {
      micMuted = muted;
      session?.setMicMuted(muted);
    },
    setEchoGuard(enabled) {
      echoGuard = enabled;
      session?.setEchoGuard(enabled);
    },
    onUnavailable: (cb) => unavailable.on(({ reason, detail }) => cb(reason, detail)),

    // VoiceHealthExtras
    onHearingProblem: (cb) => hearingProblem.on(cb),
    onHearingOk: (cb) => hearingOk.on(cb),
    recheckAudio() {
      // both unlocks run synchronously inside the click that called us
      if (fallback && isGestureGated(fallback)) fallback.unlock();
      if (gate?.needsUserGesture) gate.unlock();
      const open = session;
      const result = open ? open.unlockAudio() : Promise.resolve(null);
      gestureChange.emit(needsGesture());
      return result.then((checked) => {
        if (!disposed) gestureChange.emit(needsGesture());
        return checked;
      });
    },
    async retryMicrophone() {
      const open = session?.state === 'connected' ? session : null;
      if (!open || disposed) return false;
      return retryMic(open);
    },
  };
}
