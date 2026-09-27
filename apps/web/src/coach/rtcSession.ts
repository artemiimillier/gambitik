/**
 * The WebRTC plumbing shared by both OpenAI voice layers (Live and Realtime):
 *
 *   RTCPeerConnection + data channel `oai-events` → SDP offer → (layer-specific exchange) → SDP answer
 *
 *  - Remote audio plays through a hidden <audio> element (keeps the browser's echo cancellation working)
 *    and is tapped — never routed — by an AnalyserNode for the RMS mouth level. If the analyser is deaf,
 *    the protocol's own "output is active" signal drives a pseudo envelope.
 *  - The connection always starts with a placeholder outgoing track (a barely-there comfort noise, never pure digital
 *    silence — gpt-live-1 stalls on that), so the handshake never waits for a permission prompt. The real microphone
 *    replaces it (`replaceTrack`, no renegotiation):
 *      open mode  — right after connecting (full duplex, barge-in)
 *      push mode  — on the first `startListening()`; sent only while the button is held
 *  - ONE microphone gate decides whether the child's audio leaves the computer:
 *      open:  !micMuted && !(echoGuard && the coach is audible)      push:  the button is held
 *    While the gate is closed the sender carries the comfort noise again (not a disabled microphone = digital silence),
 *    the microphone track is disabled and — where the API has it (Live) — `session.input_audio.mute` is sent.
 *  - The echo guard is the software half-duplex for loudspeakers (e.g. laptop speakers): the coach
 *    counts as audible from the FIRST sign of his speech (an output transcript word, the server's «audio buffer started»,
 *    the adapter's own transcript timeline, the analyser) — evaluated on every server event, not only per frame, so the
 *    mute goes out before / with the first sound — and until the local playback has been silent for `echoTailMs` (≥ 400 ms)
 *    AND the protocol says the output is over. A protocol flag that never ends cannot keep the child unheard for long
 *    (`echoStuckMs` 4 s after the last real sign of speech — sound on the analyser or a new word; 12 s with a deaf
 *    analyser). Muted playback (the app's own stop, the child's tap) cannot reach the microphone: it opens.
 *  - `interrupt()` (the child taps Гамбитик or «Поговорить» while he speaks on loudspeakers, where he cannot be talked
 *    over): the response is cancelled, the playback is hushed at once and the microphone opens in the same tick.
 *  - A refused microphone is attached by itself as soon as the browser reports the permission as granted (the parent
 *    allowed it in the site settings) — on the same session, no tap needed.
 *  - Playback health: every `play()` outcome is checked (also the one inside the unlock gesture — a refusal there is
 *    never swallowed), a suspended AudioContext / a paused element is recovered on the next touch of the page, and every
 *    utterance of the model is metered (RMS peak on the remote stream + was the element really playing). When the model
 *    produced speech but nothing could be heard, `onHearingProblem` lets the dock offer «Не слышно? Нажми сюда».
 *  - Every step goes to the voice black box (./voiceDiag.ts): no words, codes only.
 *  - Every await of the handshake is bounded: SDP exchange, data channel, session start.
 *  - The child's microphone is tapped (never routed) by a second AnalyserNode: its loudness drives the level ring of the
 *    dock's «Поговорить» button while the child talks (0 whenever the gate is closed).
 */
import type { MicMode } from '@gambit/shared';
import { probeVoice, probeWireEvent } from './voiceProbe.ts';
import { diag, diagString, errorName, onMicPermissionChange, queryMicPermission } from './voiceDiag.ts';
import type { BriefSpeakOptions, SpeakOutcome } from './voiceTypes.ts';
import { computeRms, createFrameLoop, createMouthEnvelope, rmsToMouthTarget, smoothLevel } from './voiceUtils.ts';

/** What a wire protocol (liveProtocol / realtimeProtocol) offers to the connection. */
export interface RtcProtocol {
  handleServerEvent(raw: unknown): void;
  speak(text: string, opts?: { interrupt?: boolean }): Promise<SpeakOutcome>;
  /** the model says a situation in its own words (`fallbackText` is only used for the «already said» note) */
  speakBrief(brief: string, opts?: BriefSpeakOptions): Promise<SpeakOutcome>;
  cancelOutput(): void;
  pushContext(note: string): void;
  reset(): void;
  /** The data channel is open: configure the session / wait for it to start. Rejects when it never does. */
  onChannelOpen(micMode: MicMode): Promise<void>;
  setMicMode(mode: MicMode): void;
  /** the API's own "ignore my microphone" event, where one exists (Live) */
  setInputMuted?(muted: boolean): void;
  /** push-to-talk turn borders, where the API needs them (Realtime) */
  beginUserTurn?(): void;
  endUserTurn?(heldMs: number): void;
  /** analyser feed at frame rate: audible or not, null = the analyser is deaf */
  noteOutputLevel?(audible: boolean | null): void;
  /** politely end the billed session before the peer connection goes away */
  requestClose?(): void;
  /** the model's audio is (believed to be) playing */
  readonly outputActive: boolean;
  /**
   * The adapter's extra reason to keep the echo guard closed (Live: the output transcript's own timeline says the model
   * is still speaking — words arrive with the sound, the analyser may be deaf). Never drives the mouth.
   */
  readonly echoHold?: boolean;
  /** grows with every sign that the model really produced speech (transcript words, «audio buffer started») */
  readonly speechEvidence?: number;
  /** billed seconds as reported by the server, null when the API does not say */
  readonly usageSeconds: number | null;
}

export interface RtcProtocolHooks {
  send(event: Record<string, unknown>): void;
  /** mute / unmute the local playback at once */
  setDucked(ducked: boolean): void;
  /** the server ended the session by itself */
  onSessionClosed(reason: string): void;
}

/**
 * Why an utterance of the model was not heard:
 *  'notPlaying' — the <audio> element was paused / muted / at zero volume for most of it
 *  'silent'     — the element played, but the remote stream carried no sound at all (RMS peak ≈ 0)
 *  'noMeter'    — the AudioContext is not running, the page cannot even measure (a click resumes it)
 */
export type HearingProblem = 'notPlaying' | 'silent' | 'noMeter';

export interface RtcSessionEvents {
  onLevel(level: number): void;
  onSpeaking(speaking: boolean): void;
  onLost(reason: string): void;
  onMicDenied(): void;
  onMicReady(): void;
  onPlaybackBlocked(): void;
  /** 0..1 loudness of the child's microphone at frame rate (0 while the microphone gate is closed) */
  onMicLevel?(level: number): void;
  /** the model produced speech, but the page played none of it (see HearingProblem) */
  onHearingProblem?(problem: HearingProblem): void;
  /** an utterance was really audible: an earlier suspicion is over */
  onHearingOk?(): void;
}

export interface RtcSessionConfig {
  /** builds the wire protocol on top of the data channel */
  createProtocol(hooks: RtcProtocolHooks): RtcProtocol;
  /** turns the SDP offer into the SDP answer (through our server, or straight to OpenAI with an ephemeral secret) */
  exchangeSdp(offerSdp: string): Promise<string>;
  /** Live: the offer must carry the ICE candidates (docs: wait for gathering to finish) */
  waitForIceGathering: boolean;
  micMode: MicMode;
  micMuted: boolean;
  echoGuard: boolean;
  /** safety stop for a stuck push-to-talk button */
  maxListenMs: number;
  events: RtcSessionEvents;
  /** which layer this is — for the black box only */
  kind?: string;
}

export type RtcSessionState = 'connecting' | 'connected' | 'closed';

/** what `unlockAudio()` found: the play() outcome ('ok' | an error name | 'nosrc') and the AudioContext state */
export interface AudioUnlockResult {
  play: string;
  ctx: string;
}

export interface RtcSession {
  readonly state: RtcSessionState;
  readonly protocol: RtcProtocol;
  /** true when `audio.play()` was refused by the autoplay policy */
  readonly playbackBlocked: boolean;
  /** seconds since the connection was established (billing estimate) */
  readonly connectedSeconds: number;
  /** resume playback + AudioContext; must run inside a user gesture. A refusal locks the playback again. */
  unlockAudio(): Promise<AudioUnlockResult>;
  setMicMode(mode: MicMode): void;
  setMicMuted(muted: boolean): void;
  setEchoGuard(enabled: boolean): void;
  startListening(): Promise<void>;
  stopListening(): void;
  /** the microphone was refused / dismissed: ask again on THIS session (no new, billed session). true = attached. */
  retryMicrophone(): Promise<boolean>;
  /**
   * The child cut in by a tap (loudspeakers: he cannot be talked over): cancel what the coach says, hush the playback at
   * once and open the microphone now.
   */
  interrupt(): void;
  close(): void;
}

export class SessionUnavailableError extends Error {
  /** true = retrying cannot help (no WebRTC, key refused) */
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'SessionUnavailableError';
    this.permanent = permanent;
  }
}

export const RTC_TIMEOUTS = {
  iceGatheringMs: 3000,
  sdpExchangeMs: 10_000,
  dataChannelMs: 8000,
  disconnectGraceMs: 5000,
  /** how long the peer connection outlives close() so the goodbye event can still leave */
  closeFlushMs: 300,
  /**
   * The microphone opens only after the coach has been silent this long — measured on the LOCAL playback (analyser)
   * and on the protocol's own signals. ≥ 400 ms: the room and the jitter buffer must go quiet first.
   */
  echoTailMs: 450,
  /**
   * A protocol «still speaking» flag with no real sign of speech (sound on the analyser, a new transcript word, a new
   * «audio started») for this long is treated as stuck — a lost «stopped» event opens the microphone after a few
   * seconds, so the child is not left unheard…
   */
  echoStuckMs: 4000,
  /** …the same with a deaf analyser (only the protocol's words tell; they may run ahead of the sound) */
  echoStuckDeafMs: 12_000,
  /** after a tap cut the coach off, the playback stays muted this long (the jitter buffer's last words) */
  interruptHushMs: 600,
  /** a permission prompt nobody answered: noted in the black box after this long */
  micPendingMs: 3000,
} as const;

/** the self-check of the playback (see HearingProblem) */
export const HEARING_CHECK = {
  /** an utterance shorter than this is not judged */
  minUtteranceMs: 1200,
  /** an RMS peak below this on the remote stream = nothing audible arrived */
  silentPeakRms: 0.003,
  /** the element must have been playing for at least this share of the utterance */
  playingShare: 0.5,
} as const;

export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  return typeof AudioContext !== 'undefined' ? AudioContext : (w.webkitAudioContext ?? null);
}

function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SessionUnavailableError(message, false)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function waitForIce(pc: RTCPeerConnection, maxMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    // a slow STUN answer must not hold the child up: the candidates gathered so far are usually enough
    const timer = setTimeout(done, maxMs);
    function done(): void {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check(): void {
      if (pc.iceGatheringState === 'complete') done();
    }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

type Listenable = { addEventListener?: (type: string, listener: () => void) => void };

/** addEventListener where the object has one (test fakes do not) */
function listen(target: unknown, type: string, listener: () => void): void {
  const t = target as Listenable | null;
  if (t && typeof t.addEventListener === 'function') t.addEventListener(type, listener);
}

type MicGateReason = 'open' | 'echo' | 'muted' | 'push' | 'idle';

export async function openRtcSession(config: RtcSessionConfig): Promise<RtcSession> {
  if (typeof RTCPeerConnection === 'undefined' || typeof document === 'undefined') {
    throw new SessionUnavailableError('WebRTC is not available in this browser', true);
  }
  const { events } = config;
  const kind = diagString(config.kind ?? 'rtc');

  let state: RtcSessionState = 'connecting';
  let playbackBlocked = false;
  let lostReported = false;
  let connectedAt = 0;
  let closedAt = 0;
  const openedAt = Date.now();
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** `state` changes behind the type checker's back (close() from an event handler during an await) */
  const isClosed = (): boolean => state === 'closed';

  probeVoice('rtc.connecting');
  diag('rtc.open', { kind, mic: config.micMode, guard: config.echoGuard, micMuted: config.micMuted });
  const pc = new RTCPeerConnection();
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.setAttribute('playsinline', '');
  audioEl.style.display = 'none';
  audioEl.dataset.gambit = 'coach-voice';
  document.body.appendChild(audioEl);

  // Keep every WebAudio node referenced for the lifetime of the connection: Chrome garbage-collects
  // dangling nodes and the analyser silently goes deaf (research 08 §2.4 #7).
  const AudioContextCtor = getAudioContextCtor();
  let audioCtx: AudioContext | null = null;
  try {
    audioCtx = AudioContextCtor ? new AudioContextCtor() : null;
  } catch (error) {
    diag('ctx.fail', { err: errorName(error) });
    audioCtx = null;
  }
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let analyserBuffer: Float32Array<ArrayBuffer> | null = null;
  let silentDestination: MediaStreamAudioDestinationNode | null = null;
  let comfortSource: AudioBufferSourceNode | null = null;
  let comfortTrack: MediaStreamTrack | null = null;
  let micSourceNode: MediaStreamAudioSourceNode | null = null;
  let micAnalyser: AnalyserNode | null = null;
  let micBuffer: Float32Array<ArrayBuffer> | null = null;
  let micLevel = 0;
  if (audioCtx) {
    const ctx = audioCtx;
    diag('ctx', { state: ctx.state, created: true });
    listen(ctx, 'statechange', () => {
      if (isClosed()) return;
      diag('ctx', { state: ctx.state });
      // running again: the comfort noise can go back on the wire while the gate is closed
      if (state === 'connected') applyMicGate();
      armGestureRecovery();
    });
  }

  // ───── microphone gate ─────
  let micMode: MicMode = config.micMode;
  let micMuted = config.micMuted;
  let echoGuard = config.echoGuard;
  let micStream: MediaStream | null = null;
  let micTrack: MediaStreamTrack | null = null;
  let micRequest: Promise<MediaStreamTrack> | null = null;
  let pushHeld = false;
  let listenToken = 0;
  let listenStartedAt = 0;
  let listenTimer: ReturnType<typeof setTimeout> | null = null;
  let gateOpen: boolean | null = null;
  /** the outgoing audio sender (set up below, before the handshake) and the track on the wire right now */
  let sender: RTCRtpSender | null = null;
  let sentTrack: MediaStreamTrack | null = null;

  // ───── echo guard (time-based, see the file header) ─────
  let coachAudible = false;
  let lastLoudAt = -Infinity;
  let lastCoachSignalAt = -Infinity;
  let protocolSince: number | null = null;
  let protocolStuck = false;
  let updatingGuard = false;
  /** the last time the protocol's speech evidence grew (a transcript word, «audio started») */
  let lastEvidenceSeen = 0;
  let lastEvidenceAt = -Infinity;
  /** the child's tap: the playback is muted until then (0 = no hush) */
  let hushUntil = 0;

  function gateDecision(): { open: boolean; why: MicGateReason } {
    if (state !== 'connected') return { open: false, why: 'idle' };
    if (micMode === 'push') return pushHeld ? { open: true, why: 'open' } : { open: false, why: 'push' };
    if (micMuted) return { open: false, why: 'muted' };
    if (echoGuard && coachAudible) return { open: false, why: 'echo' };
    return { open: true, why: 'open' };
  }

  /**
   * The comfort noise whenever the gate is closed (never digital silence), the microphone when it is open. A suspended
   * AudioContext produces no frames at all — then the disabled microphone (zeros, but frames) stays on the wire.
   */
  function syncSender(open: boolean): void {
    const comfort = comfortTrack !== null && audioCtx !== null && audioCtx.state === 'running' ? comfortTrack : null;
    const desired = open && micTrack ? micTrack : (comfort ?? micTrack ?? comfortTrack);
    if (!sender || !desired || desired === sentTrack) return;
    sentTrack = desired;
    try {
      void Promise.resolve(sender.replaceTrack(desired)).catch((error: unknown) => diag('rtc.replace.fail', { err: errorName(error) }));
    } catch (error) {
      diag('rtc.replace.fail', { err: errorName(error) });
    }
  }

  function applyMicGate(): void {
    const { open, why } = gateDecision();
    if (micTrack) micTrack.enabled = open;
    syncSender(open);
    if (gateOpen === open) return;
    gateOpen = open;
    probeVoice('rtc.mic-gate', { open });
    diag('mic.gate', { open, why });
    protocol.setInputMuted?.(!open);
  }

  /**
   * Is the coach (about to be) audible? Called per frame AND after every server event / sent event, so the microphone
   * closes on the first word of the transcript or the server's «audio started», not a frame later.
   */
  /** the local playback is muted (the app's own stop = ducked, or the child's tap = hushed): nothing reaches the room */
  function playbackSilenced(t: number): boolean {
    return ducked || t < hushUntil;
  }

  function updateEchoGuard(): void {
    if (state !== 'connected' || updatingGuard) return;
    updatingGuard = true;
    try {
      const t = Date.now();
      if (hushUntil !== 0 && t >= hushUntil) {
        // the tap's hush is over: the element follows the protocol's own ducking again
        hushUntil = 0;
        audioEl.muted = ducked;
      }
      const evidence = protocol.speechEvidence ?? 0;
      if (evidence !== lastEvidenceSeen) {
        lastEvidenceSeen = evidence;
        lastEvidenceAt = t;
        // he really speaks again: a flag that was written off as stuck counts again
        protocolStuck = false;
      }
      const protocolSays = protocol.outputActive || protocol.echoHold === true;
      if (protocolSays) protocolSince ??= t;
      else {
        protocolSince = null;
        protocolStuck = false;
      }
      if (protocolSays && !protocolStuck && protocolSince !== null) {
        // a lost «stopped» event must not keep the child unheard: a few seconds after the last real sign of speech
        const quietFor = t - Math.max(lastLoudAt, lastEvidenceAt, protocolSince);
        // an analyser that has heard him in this session measures the silence too; one that never did may be deaf
        const deaf = analyser === null || lastLoudAt === -Infinity;
        if (quietFor > (deaf ? RTC_TIMEOUTS.echoStuckDeafMs : RTC_TIMEOUTS.echoStuckMs)) {
          protocolStuck = true;
          diag('mic.guard.stuck', { ms: t - protocolSince, quiet: quietFor, deaf });
        }
      }
      // muted playback cannot reach the microphone: no reason to keep the child unheard
      const silenced = playbackSilenced(t);
      const heard = !silenced && t - lastLoudAt < 60;
      if (heard || (!silenced && protocolSays && !protocolStuck)) lastCoachSignalAt = t;
      const audible = !silenced && t - lastCoachSignalAt < RTC_TIMEOUTS.echoTailMs;
      if (audible === coachAudible) return;
      coachAudible = audible;
      if (audible) beginUtterance(t);
      else endUtterance(t, false);
      applyMicGate();
    } finally {
      updatingGuard = false;
    }
  }

  // ───── playback health: one utterance of the model, metered ─────
  interface Utterance {
    startedAt: number;
    evidenceAtStart: number;
    frames: number;
    meterFrames: number;
    loudFrames: number;
    playingFrames: number;
    duckedFrames: number;
    peak: number;
  }
  let utterance: Utterance | null = null;
  /** the speech evidence when the previous utterance ended: the word that STARTS an utterance belongs to it */
  let evidenceMark = 0;
  let ducked = false;
  let noMeterReported = false;

  function elementAudible(): boolean {
    const el = audioEl as HTMLAudioElement & { paused?: boolean; volume?: number };
    if (el.srcObject === null || el.srcObject === undefined) return false;
    if (el.paused === true || el.muted) return false;
    return typeof el.volume === 'number' ? el.volume > 0.05 : true;
  }

  function meterRunning(): boolean {
    return analyser !== null && audioCtx !== null && audioCtx.state === 'running';
  }

  function beginUtterance(t: number): void {
    utterance = { startedAt: t, evidenceAtStart: evidenceMark, frames: 0, meterFrames: 0, loudFrames: 0, playingFrames: 0, duckedFrames: 0, peak: 0 };
  }

  function sampleUtterance(rms: number, audible: boolean): void {
    const u = utterance;
    if (!u) return;
    u.frames += 1;
    if (meterRunning()) {
      u.meterFrames += 1;
      if (rms > u.peak) u.peak = rms;
      if (audible) u.loudFrames += 1;
    }
    if (playbackSilenced(Date.now())) u.duckedFrames += 1;
    else if (elementAudible()) u.playingFrames += 1;
  }

  /** `skip`: the utterance ended by our own hand ('closed' session, the child's 'tap') — it is logged, never judged */
  function endUtterance(t: number, skip: false | 'closed' | 'tap'): void {
    const closing = skip !== false;
    const u = utterance;
    utterance = null;
    if (!u) return;
    const ms = t - u.startedAt;
    const evidenceNow = protocol.speechEvidence ?? 0;
    const evidence = evidenceNow - u.evidenceAtStart;
    evidenceMark = evidenceNow;
    const judged = u.frames - u.duckedFrames;
    const playShare = judged > 0 ? u.playingFrames / judged : 1;
    let problem: HearingProblem | null = null;
    if (!closing && evidence > 0 && ms >= HEARING_CHECK.minUtteranceMs && judged >= 3) {
      if (playShare < HEARING_CHECK.playingShare) problem = 'notPlaying';
      else if (u.meterFrames === 0) problem = noMeterReported ? null : 'noMeter';
      else if (u.peak < HEARING_CHECK.silentPeakRms) problem = 'silent';
    }
    const el = audioEl as HTMLAudioElement & { paused?: boolean; volume?: number };
    diag('utt', {
      kind,
      ms,
      ev: evidence,
      peak: Math.round(u.peak * 10_000) / 10_000,
      loud: u.loudFrames,
      frames: u.frames,
      meter: u.meterFrames,
      play: Math.round(playShare * 100),
      paused: el.paused ?? null,
      muted: el.muted,
      vol: typeof el.volume === 'number' ? el.volume : null,
      ctx: audioCtx?.state ?? 'none',
      why: skip !== false ? skip : (problem ?? 'ok'),
    });
    if (problem) {
      if (problem === 'noMeter') noMeterReported = true;
      events.onHearingProblem?.(problem);
      armGestureRecovery();
    } else if (!closing && evidence > 0 && u.loudFrames > 0 && playShare >= HEARING_CHECK.playingShare) {
      events.onHearingOk?.();
    }
  }

  // ───── mouth level ─────
  let speaking = false;
  let level = 0;
  let zeroFrames = 0;
  let quietFrames = 0;
  let loudFrames = 0;
  let envelope = createMouthEnvelope();
  let envelopeStartedAt = 0;
  let envelopeActive = false;

  function setSpeaking(next: boolean): void {
    if (speaking === next) return;
    speaking = next;
    probeVoice('rtc.coach-audible', { audible: next });
    events.onSpeaking(next);
  }

  const loop = createFrameLoop((now) => {
    let target = 0;
    let rms = 0;
    if (analyser && analyserBuffer) {
      analyser.getFloatTimeDomainData(analyserBuffer);
      rms = computeRms(analyserBuffer);
    }
    zeroFrames = rms === 0 ? zeroFrames + 1 : 0;
    const deaf = !analyser || zeroFrames > 45;
    const audible = !deaf && rmsToMouthTarget(rms) > 0.06;
    if (audible) lastLoudAt = Date.now();
    protocol.noteOutputLevel?.(deaf ? null : audible);
    const active = protocol.outputActive;

    if (deaf) {
      // analyser gives exact zeros (suspended AudioContext, Chromium quirk): fake it from the protocol's signal
      if (active && !envelopeActive) {
        envelope = createMouthEnvelope();
        envelopeStartedAt = now;
      }
      envelopeActive = active;
      target = active ? envelope.sample(now - envelopeStartedAt) : 0;
    } else {
      target = rmsToMouthTarget(rms);
    }
    level = smoothLevel(level, target);
    events.onLevel(level < 0.01 ? 0 : level);

    loudFrames = audible ? loudFrames + 1 : 0;
    quietFrames = audible ? 0 : quietFrames + 1;
    if (active || loudFrames >= 3) setSpeaking(true);
    else if (quietFrames > 12) setSpeaking(false);

    updateEchoGuard();
    sampleUtterance(rms, audible);

    // the child's loudness for the level ring — nothing is heard while the gate is closed
    if (events.onMicLevel && micAnalyser && micBuffer) {
      let micTarget = 0;
      if (gateOpen === true) {
        micAnalyser.getFloatTimeDomainData(micBuffer);
        micTarget = rmsToMouthTarget(computeRms(micBuffer), 0.008, 5);
      }
      const next = smoothLevel(micLevel, micTarget);
      const shown = next < 0.02 ? 0 : next;
      if (shown !== micLevel) events.onMicLevel(shown);
      micLevel = shown;
    }
  });

  function reportLost(reason: string): void {
    if (lostReported || state === 'closed') return;
    lostReported = true;
    probeVoice('rtc.lost', { reason });
    diag('rtc.lost', { kind, reason });
    close();
    events.onLost(reason);
  }

  // ───── playback: play(), unlock, recovery on the next touch ─────

  /** 'ok' | an error name | 'nosrc'; a refusal (not an abort by our own teardown) locks the playback until a gesture */
  function tryPlay(source: string): Promise<string> {
    if (!audioEl.srcObject) return Promise.resolve('nosrc');
    let attempt: Promise<void>;
    try {
      attempt = Promise.resolve(audioEl.play());
    } catch (error) {
      attempt = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return attempt.then(
      () => {
        diag('out.play', { kind, ok: true, src: source });
        return 'ok';
      },
      (error: unknown) => {
        const name = errorName(error);
        diag('out.play', { kind, ok: false, err: name, src: source });
        if (!isClosed() && name !== 'AbortError') {
          playbackBlocked = true;
          events.onPlaybackBlocked();
          armGestureRecovery();
        }
        return name;
      },
    );
  }

  function resumeContext(): Promise<string> {
    const ctx = audioCtx;
    if (!ctx) return Promise.resolve('none');
    if (ctx.state === 'running' || ctx.state === 'closed') return Promise.resolve(ctx.state);
    try {
      return Promise.resolve(ctx.resume()).then(
        () => ctx.state,
        (error: unknown) => errorName(error),
      );
    } catch (error) {
      return Promise.resolve(errorName(error));
    }
  }

  let recoveryArmed = false;
  let disarmRecovery: (() => void) | null = null;

  function needsRecovery(): boolean {
    if (state !== 'connected') return false;
    const el = audioEl as HTMLAudioElement & { paused?: boolean };
    return (audioCtx !== null && audioCtx.state === 'suspended') || playbackBlocked || (el.srcObject !== null && el.srcObject !== undefined && el.paused === true);
  }

  /** a suspended AudioContext / a refused or paused playback comes back on the child's next touch anywhere on the page */
  function armGestureRecovery(): void {
    if (recoveryArmed || typeof window === 'undefined' || typeof window.addEventListener !== 'function' || !needsRecovery()) return;
    recoveryArmed = true;
    const names = ['pointerdown', 'keydown', 'touchend'] as const;
    const onGesture = (): void => {
      disarmRecovery?.();
      if (state !== 'connected') return;
      const el = audioEl as HTMLAudioElement & { paused?: boolean };
      const wasBlocked = playbackBlocked;
      playbackBlocked = false;
      const play = el.paused === true || wasBlocked ? tryPlay('gesture') : Promise.resolve('playing');
      void Promise.all([play, resumeContext()]).then(([p, c]) => diag('out.recover', { kind, play: p, ctx: c }));
    };
    disarmRecovery = () => {
      recoveryArmed = false;
      disarmRecovery = null;
      for (const name of names) window.removeEventListener(name, onGesture, true);
    };
    for (const name of names) window.addEventListener(name, onGesture, true);
  }

  // ───── protocol over the data channel ─────
  const dc = pc.createDataChannel('oai-events');
  const protocol = config.createProtocol({
    send(event) {
      probeWireEvent('out', event);
      if (dc.readyState === 'open') dc.send(JSON.stringify(event));
    },
    setDucked(next) {
      if (next !== ducked) diag('out.duck', { kind, ducked: next });
      ducked = next;
      // a tap's hush outlives the protocol's own unducking
      audioEl.muted = next || Date.now() < hushUntil;
    },
    onSessionClosed: (reason) => reportLost(`session-${reason}`),
  });

  dc.addEventListener('message', (message: MessageEvent) => {
    if (typeof message.data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    probeWireEvent('in', parsed);
    protocol.handleServerEvent(parsed);
    // the first word / «audio started» closes the microphone now, not a frame later
    updateEchoGuard();
  });
  dc.addEventListener('close', () => reportLost('data-channel-closed'));

  pc.addEventListener('connectionstatechange', () => {
    const cs = pc.connectionState;
    if (cs !== 'connected' && cs !== 'connecting' && cs !== 'new') diag('rtc.peer', { kind, state: cs });
    if (cs === 'failed' || cs === 'closed') reportLost(`peer-${cs}`);
    else if (cs === 'disconnected') {
      disconnectTimer ??= setTimeout(() => {
        if (pc.connectionState !== 'connected') reportLost('peer-disconnected');
      }, RTC_TIMEOUTS.disconnectGraceMs);
    } else if (cs === 'connected' && disconnectTimer !== null) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  });

  pc.addEventListener('track', (event: RTCTrackEvent) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    const remote = event.track as MediaStreamTrack | undefined;
    diag('out.track', { kind, muted: remote?.muted ?? null, ctx: audioCtx?.state ?? 'none' });
    if (remote) {
      for (const type of ['mute', 'unmute', 'ended'] as const) listen(remote, type, () => !isClosed() && diag(`out.track.${type}`, { kind }));
    }
    // 1) playback through a media element — this is what keeps echo cancellation working
    audioEl.srcObject = stream;
    void tryPlay('track');
    // 2) analyser is a tap only — never connect it to audioCtx.destination (double audio, broken AEC)
    if (audioCtx) {
      try {
        sourceNode = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0;
        analyserBuffer = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
        sourceNode.connect(analyser);
      } catch (error) {
        console.warn('[coach] analyser unavailable, using protocol events for the mouth', error);
        diag('out.meter.fail', { kind, err: errorName(error) });
        analyser = null;
      }
    }
  });

  // what the element does on its own (paused by the browser, volume) — our own ducking is marked
  for (const type of ['pause', 'playing', 'volumechange'] as const) {
    listen(audioEl, type, () => {
      if (isClosed()) return;
      const el = audioEl as HTMLAudioElement & { paused?: boolean; volume?: number };
      diag(`out.el.${type}`, { kind, paused: el.paused ?? null, muted: el.muted, vol: typeof el.volume === 'number' ? el.volume : null, duck: ducked });
      if (type === 'pause') armGestureRecovery();
    });
  }

  // ───── outgoing audio: comfort noise until (and whenever) the real microphone is not sent ─────
  if (audioCtx) {
    try {
      silentDestination = audioCtx.createMediaStreamDestination();
      comfortSource = startComfortNoise(audioCtx, silentDestination);
      comfortTrack = silentDestination.stream.getAudioTracks()[0] ?? null;
      if (comfortTrack) {
        sender = pc.addTrack(comfortTrack, silentDestination.stream);
        sentTrack = comfortTrack;
      }
    } catch (error) {
      diag('rtc.comfort.fail', { err: errorName(error) });
      comfortTrack = null;
    }
  }
  sender ??= pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;

  let micState: 'none' | 'pending' | 'ready' | 'denied' = 'none';
  let unwatchPermission: (() => void) | null = null;

  /**
   * after a refusal: the moment the browser reports the permission as granted, the microphone is attached (same session);
   * a site setting put back to «Спрашивать» ('prompt') asks again at once — the parent is looking at the page right then
   */
  function watchMicPermission(): void {
    if (unwatchPermission || isClosed()) return;
    unwatchPermission = onMicPermissionChange((permission) => {
      if ((permission !== 'granted' && permission !== 'prompt') || isClosed() || micState !== 'denied') return;
      diag('mic.perm.regained', { kind, state: permission });
      void ensureMic().catch(() => undefined);
    });
  }

  function ensureMic(): Promise<MediaStreamTrack> {
    if (micTrack && micTrack.readyState !== 'ended') return Promise.resolve(micTrack);
    micRequest ??= (async () => {
      const askedAt = Date.now();
      micState = 'pending';
      void queryMicPermission().then((permission) => diag('mic.perm', { state: permission }));
      const pendingTimer = setTimeout(() => {
        // Chrome: a prompt nobody answered keeps getUserMedia pending — the child talks, nobody listens
        if (micState === 'pending' && !isClosed()) diag('mic.gum.pending', { kind, ms: RTC_TIMEOUTS.micPendingMs });
      }, RTC_TIMEOUTS.micPendingMs);
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new Error('microphone is not available');
        const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        const track = stream.getAudioTracks()[0] ?? null;
        if (!track) {
          stream.getTracks().forEach((t) => t.stop());
          throw new Error('no microphone track');
        }
        if (state === 'closed') {
          // the connection went away while the permission prompt was open
          stream.getTracks().forEach((t) => t.stop());
          throw new Error('connection closed');
        }
        diag('mic.gum', { kind, ok: true, ms: Date.now() - askedAt });
        track.enabled = false;
        micStream = stream;
        micTrack = track;
        micState = 'ready';
        listen(track, 'ended', () => {
          // the permission was taken back / the device went away mid-session: the child cannot be heard any more
          if (isClosed() || micTrack !== track) return;
          diag('mic.ended', { kind });
          micTrack = null;
          micStream = null;
          micState = 'denied';
          applyMicGate();
          events.onMicDenied();
          watchMicPermission();
        });
        if (audioCtx && events.onMicLevel) {
          try {
            // a tap only — never connected to the destination (the child must not hear himself)
            micSourceNode = audioCtx.createMediaStreamSource(stream);
            micAnalyser = audioCtx.createAnalyser();
            micAnalyser.fftSize = 512;
            micAnalyser.smoothingTimeConstant = 0;
            micBuffer = new Float32Array(new ArrayBuffer(micAnalyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
            micSourceNode.connect(micAnalyser);
          } catch {
            micAnalyser = null;
          }
        }
        probeVoice('rtc.mic-ready');
        applyMicGate();
        diag('mic.attached', { kind, gate: gateOpen === true });
        events.onMicReady();
        return track;
      } catch (error) {
        if (state !== 'closed') {
          micState = 'denied';
          diag('mic.gum', { kind, ok: false, err: errorName(error), ms: Date.now() - askedAt });
          events.onMicDenied();
          watchMicPermission();
        }
        throw error instanceof Error ? error : new Error('microphone permission denied');
      } finally {
        clearTimeout(pendingTimer);
        micRequest = null;
      }
    })();
    return micRequest;
  }

  async function startListening(): Promise<void> {
    if (state !== 'connected') throw new Error('voice session is not connected');
    if (micMode === 'open') return; // the microphone is open anyway
    const token = ++listenToken;
    await ensureMic();
    // the button may have been released (or the connection closed) while the permission prompt was open
    if (token !== listenToken || state !== 'connected') return;
    protocol.beginUserTurn?.();
    if (!protocol.beginUserTurn) protocol.cancelOutput();
    pushHeld = true;
    applyMicGate();
    listenStartedAt = Date.now();
    listenTimer = setTimeout(stopListening, config.maxListenMs);
  }

  function stopListening(): void {
    listenToken++;
    if (listenTimer !== null) {
      clearTimeout(listenTimer);
      listenTimer = null;
    }
    if (!pushHeld) return;
    pushHeld = false;
    applyMicGate();
    protocol.endUserTurn?.(Date.now() - listenStartedAt);
  }

  function teardown(): void {
    // the element first: whatever else fails, no orphan <audio> stays behind
    try {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
    } catch (error) {
      console.warn('[coach] voice teardown problem', error);
    }
    try {
      sourceNode?.disconnect();
      micSourceNode?.disconnect();
      if (dc.readyState !== 'closed') dc.close();
      pc.close();
      if (audioCtx && audioCtx.state !== 'closed') void audioCtx.close();
    } catch (error) {
      console.warn('[coach] voice teardown problem', error);
    }
    sourceNode = null;
    analyser = null;
    analyserBuffer = null;
    silentDestination = null;
    comfortSource = null;
    comfortTrack = null;
    micSourceNode = null;
    micAnalyser = null;
    micBuffer = null;
  }

  function close(): void {
    if (state === 'closed') return;
    const wasConnected = state === 'connected';
    endUtterance(Date.now(), 'closed');
    state = 'closed';
    closedAt = Date.now();
    listenToken++;
    disarmRecovery?.();
    unwatchPermission?.();
    unwatchPermission = null;
    for (const timer of [listenTimer, disconnectTimer]) if (timer !== null) clearTimeout(timer);
    loop.stop();
    // privacy first: the microphone stops NOW, whatever happens to the rest
    try {
      micStream?.getTracks().forEach((track) => track.stop());
      comfortSource?.stop();
      silentDestination?.stream.getTracks().forEach((track) => track.stop());
    } catch {
      /* already stopped */
    }
    micStream = null;
    micTrack = null;
    audioEl.muted = true;
    if (wasConnected && dc.readyState === 'open') protocol.requestClose?.();
    protocol.reset();
    // the reset may unduck the element: this one is going away, it stays silent
    audioEl.muted = true;
    setSpeaking(false);
    events.onLevel(0);
    if (micLevel !== 0) events.onMicLevel?.(0);
    micLevel = 0;
    // give the goodbye a moment to leave, then drop the (billed) connection for real
    if (wasConnected && protocol.requestClose) setTimeout(teardown, RTC_TIMEOUTS.closeFlushMs);
    else teardown();
  }

  // ───── SDP handshake ─────
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (config.waitForIceGathering) await waitForIce(pc, RTC_TIMEOUTS.iceGatheringMs);
    const offerSdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
    const answerSdp = await bounded(config.exchangeSdp(offerSdp), RTC_TIMEOUTS.sdpExchangeMs, 'the SDP exchange timed out');
    if (isClosed()) throw new SessionUnavailableError('closed while connecting', false);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    if (dc.readyState !== 'open') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new SessionUnavailableError('data channel did not open', false)), RTC_TIMEOUTS.dataChannelMs);
        dc.addEventListener(
          'open',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    await protocol.onChannelOpen(micMode);
    if (isClosed()) throw new SessionUnavailableError('closed while connecting', false);
  } catch (error) {
    lostReported = true; // a failed handshake is reported through the rejection, not onLost
    const reason = error instanceof Error ? error.message : String(error);
    probeVoice('rtc.connect-failed', { reason });
    diag('rtc.fail', { kind, reason: diagString(reason.slice(0, 64)), ms: Date.now() - openedAt });
    close();
    throw error;
  }

  state = 'connected';
  connectedAt = Date.now();
  probeVoice('rtc.connected');
  diag('rtc.connected', { kind, ms: connectedAt - openedAt, ctx: audioCtx?.state ?? 'none', comfort: comfortTrack !== null });
  loop.start();
  if (audioCtx?.state === 'suspended') void resumeContext().then((ctxState) => diag('ctx.resume', { kind, state: ctxState }));
  applyMicGate();
  armGestureRecovery();
  // full duplex needs the microphone from the start; a refusal only costs the listening half
  if (micMode === 'open') void ensureMic().catch(() => undefined);

  return {
    get state() {
      return state;
    },
    protocol,
    get playbackBlocked() {
      return playbackBlocked;
    },
    get connectedSeconds() {
      return connectedAt === 0 ? 0 : Math.max(0, ((state === 'closed' ? closedAt : Date.now()) - connectedAt) / 1000);
    },
    unlockAudio() {
      // inside the gesture: both calls happen synchronously here; a refusal is NOT swallowed (it locks again)
      playbackBlocked = false;
      const ctx = resumeContext();
      const play = tryPlay('unlock');
      return Promise.all([play, ctx]).then(([p, c]) => ({ play: p, ctx: c }));
    },
    setMicMode(mode) {
      if (micMode === mode) return;
      micMode = mode;
      if (pushHeld) stopListening();
      protocol.setMicMode(mode);
      applyMicGate();
      if (mode === 'open' && state === 'connected') void ensureMic().catch(() => undefined);
    },
    setMicMuted(muted) {
      micMuted = muted;
      applyMicGate();
    },
    setEchoGuard(enabled) {
      echoGuard = enabled;
      applyMicGate();
    },
    startListening,
    stopListening,
    async retryMicrophone() {
      if (state !== 'connected') return false;
      diag('mic.retry', { kind });
      try {
        await ensureMic();
        return true;
      } catch {
        return false;
      }
    },
    interrupt() {
      if (state !== 'connected') return;
      const t = Date.now();
      diag('out.stop', { kind, why: 'tap', audible: coachAudible });
      // cut on purpose: logged, never judged by the hearing check
      endUtterance(t, 'tap');
      protocol.cancelOutput();
      // whatever is still in the jitter buffer / the server's output buffer is not heard any more…
      hushUntil = t + RTC_TIMEOUTS.interruptHushMs;
      audioEl.muted = true;
      // …so the microphone opens in this very tick
      updateEchoGuard();
      applyMicGate();
    },
    close,
  };
}

/** Level of the placeholder noise: ≈ −60 dBFS — inaudible for the model's VAD, but real audio frames. */
export const COMFORT_NOISE_GAIN = 0.001;

/**
 * gpt-live-1 stalls on PURE digital silence (no input frames → the model stops speaking too).
 * Until the real microphone replaces it — whenever the microphone is refused (e.g. an embedded preview window), and
 * whenever the microphone gate is closed (echo guard, the child's mute, push-to-talk) — the outgoing track carries a
 * barely-there room noise instead, like a real microphone would. Returns null when the browser cannot build it (the
 * plain destination then stays silent).
 */
export function startComfortNoise(ctx: BaseAudioContext, destination: AudioNode): AudioBufferSourceNode | null {
  try {
    const seconds = 2;
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = COMFORT_NOISE_GAIN;
    source.connect(gain);
    gain.connect(destination);
    source.start();
    return source;
  } catch {
    return null;
  }
}
