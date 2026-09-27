/**
 * OpenAI Live voice layer — full-duplex `gpt-live-1`: the coach listens and speaks at the same time.
 *
 *   RTCPeerConnection + data channel `oai-events` → createOffer → wait for ICE gathering
 *     → POST /api/voice/live { sdp }   (OUR server creates the session with the real key: POST /v1/live/sessions,
 *                                       transport webrtc — the browser never sees a key or a client secret)
 *     → setRemoteDescription(answer) → wait for `session.started` on the data channel
 *       (never send `session.start` over WebRTC: the HTTP request starts the session)
 *
 *  - The wire protocol (briefs the model says in its own words, silent context, client delegation → engine FACTS
 *    from the CoachToolHost, the "is the phrase over?" heuristic, transcripts) lives in ./liveProtocol.ts.
 *  - Barge-in is native: the model hears the child while it talks. The local playback is ducked only when the
 *    APP stops the coach (there is no client-side cancel in the Live API).
 *  - Loudspeakers without headphones: the echo guard mutes the input (`session.input_audio.mute` + the comfort noise
 *    instead of the microphone) while the coach is audible — see ./rtcSession.ts. This adapter adds what only the Live
 *    wire knows: the output transcript's own timeline (`start_ms` / `end_ms`) says how long the model still speaks, so
 *    the microphone closes on the FIRST word and stays closed until the sound is really over, even with a deaf analyser.
 *  - The black box (./voiceDiag.ts) gets the TYPE of every server event except the word deltas, the acknowledgements of
 *    the input mute, API error codes, and one `child.heard` per utterance of the child (proof the model hears him).
 *  - Lazy session, idle suspend (billing is per second, silence included!), usage report, bounded `speak()`
 *    and the automatic fallback are shared with the Realtime layer in ./sessionVoice.ts.
 */
import type { LiveVoiceSessionResponse } from '@gambit/shared';
import { createLiveVoiceSession } from './liveApi.ts';
import { createLiveProtocol } from './liveProtocol.ts';
import type { LiveProtocolOptions } from './liveProtocol.ts';
import { openRtcSession, SessionUnavailableError } from './rtcSession.ts';
import type { RtcProtocol } from './rtcSession.ts';
import { createSessionVoice } from './sessionVoice.ts';
import type { SessionVoice, SessionVoiceOptions } from './sessionVoice.ts';
import { diag, diagString } from './voiceDiag.ts';

/** `session.started` normally follows the SDP answer within a second */
export const LIVE_SESSION_START_TIMEOUT_MS = 8000;

/**
 * The echo guard's view of the Live output transcript: after a word arrived the coach counts as audible at least this
 * long (the words come with the sound, the sound of the last word is still playing)…
 */
export const LIVE_TRANSCRIPT_TAIL_MS = 900;
/** …and until the transcript timeline's end, but never longer than this after the last word (a wrong timeline) */
export const LIVE_TRANSCRIPT_MAX_AHEAD_MS = 4000;
/** words further apart than this belong to a new utterance (its timeline starts again) */
const LIVE_UTTERANCE_GAP_MS = 2500;
/** the child's words further apart than this = a new utterance of the child (`child.heard` in the black box) */
const LIVE_CHILD_GAP_MS = 1500;

/** server events that are too frequent (or too boring) for the black box */
const QUIET_SERVER_EVENTS: ReadonlySet<string> = new Set([
  'session.output_transcript.delta',
  'session.input_transcript.delta',
  'session.usage.updated',
  'session.thinking.appended',
]);

export interface LiveVoiceOptions extends SessionVoiceOptions {
  /** sends the SDP offer to our server; defaults to `POST /api/voice/live` */
  createSession?: (offerSdp: string) => Promise<LiveVoiceSessionResponse>;
  protocol?: LiveProtocolOptions;
  sessionStartTimeoutMs?: number;
  /** clock of the echo hold (tests) */
  now?: () => number;
}

export type OpenAiLiveVoice = SessionVoice;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The echo hold of the Live output: the coach is still audible while the transcript's own timeline says so. Pure
 * bookkeeping over the server events, exported for the tests.
 */
export function createLiveEchoHold(now: () => number = () => Date.now()) {
  let spokenUntil = -Infinity;
  let lastDeltaAt = -Infinity;
  let firstWallAt: number | null = null;
  let firstStartMs: number | null = null;
  let evidence = 0;
  return {
    /** an output transcript delta arrived */
    noteOutputDelta(raw: Json): void {
      evidence += 1;
      const t = now();
      if (t - lastDeltaAt > LIVE_UTTERANCE_GAP_MS) {
        firstWallAt = null;
        firstStartMs = null;
      }
      lastDeltaAt = t;
      let until = t + LIVE_TRANSCRIPT_TAIL_MS;
      const start = num(raw.start_ms);
      const end = num(raw.end_ms);
      if (start !== null && end !== null && end >= start) {
        firstWallAt ??= t;
        firstStartMs ??= start;
        until = Math.max(until, firstWallAt + (end - firstStartMs));
      }
      spokenUntil = Math.min(Math.max(spokenUntil, until), t + LIVE_TRANSCRIPT_MAX_AHEAD_MS);
    },
    reset(): void {
      spokenUntil = -Infinity;
      lastDeltaAt = -Infinity;
      firstWallAt = null;
      firstStartMs = null;
    },
    get holding(): boolean {
      return now() < spokenUntil;
    },
    get evidence(): number {
      return evidence;
    },
  };
}

export function createOpenAiLiveVoice(options: LiveVoiceOptions = {}): OpenAiLiveVoice {
  const createSession = options.createSession ?? ((offerSdp: string) => createLiveVoiceSession(offerSdp));
  const startTimeoutMs = options.sessionStartTimeoutMs ?? LIVE_SESSION_START_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  return createSessionVoice({
    ...options,
    kind: 'openai-live',
    open: (args) =>
      openRtcSession({
        kind: 'openai-live',
        waitForIceGathering: true,
        micMode: args.micMode,
        micMuted: args.micMuted,
        echoGuard: args.echoGuard,
        maxListenMs: args.maxListenMs,
        events: args.rtc,
        async exchangeSdp(offerSdp) {
          const session = await createSession(offerSdp);
          return session.sdp;
        },
        createProtocol(hooks): RtcProtocol {
          const hold = createLiveEchoHold(now);
          let lastChildDeltaAt = -Infinity;
          const protocol = createLiveProtocol(
            {
              send(event) {
                const type = event.type;
                if (type === 'session.input_audio.mute' || type === 'session.input_audio.unmute') diag('mic.mute.sent', { muted: type.endsWith('.mute') });
                else if (type === 'session.commentary.append') diag('say.sent', { deleg: event.delegation_id !== null && event.delegation_id !== undefined });
                else if (type === 'session.instructions.append' || type === 'session.close') diag('wire.out', { type });
                hooks.send(event);
              },
              getToolHost: args.protocol.getToolHost,
              onTranscript: args.protocol.onTranscript,
              onCoachTranscriptDelta: args.protocol.onCoachTranscriptDelta,
              onThinking: args.protocol.onThinking,
              onToolCoachEvent: args.protocol.onToolCoachEvent,
              onChildSpeaking: args.protocol.onChildSpeaking,
              onSayProgress: args.protocol.onSayProgress,
              onDuck: hooks.setDucked,
              onSessionClosed: hooks.onSessionClosed,
            },
            options.protocol,
          );

          function handleServerEvent(raw: unknown): void {
            if (isRecord(raw) && typeof raw.type === 'string') {
              const type = raw.type;
              if (type === 'session.output_transcript.delta') hold.noteOutputDelta(raw);
              else if (type === 'session.input_transcript.delta') {
                const t = now();
                if (t - lastChildDeltaAt > LIVE_CHILD_GAP_MS) diag('child.heard', { kind: 'openai-live' });
                lastChildDeltaAt = t;
              } else if (type === 'session.input_audio.muted' || type === 'session.input_audio.unmuted') diag('mic.mute.ack', { muted: type.endsWith('.muted') });
              else if (type === 'error') {
                const error = isRecord(raw.error) ? raw.error : {};
                const code = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : 'unknown';
                diag('srv.error', { kind: 'openai-live', code: diagString(code.slice(0, 64)) });
              } else if (type === 'session.closed') diag('srv.closed', { reason: diagString(typeof raw.reason === 'string' ? raw.reason.slice(0, 64) : 'unknown') });
              else if (!QUIET_SERVER_EVENTS.has(type)) diag('srv', { kind: 'openai-live', type: diagString(type.slice(0, 64)) });
            }
            protocol.handleServerEvent(raw);
          }

          return {
            handleServerEvent,
            speak: protocol.speak,
            speakBrief: protocol.speakBrief,
            cancelOutput: protocol.cancelOutput,
            pushContext: protocol.pushContext,
            reset() {
              hold.reset();
              protocol.reset();
            },
            async onChannelOpen() {
              if (!(await protocol.whenStarted(startTimeoutMs))) throw new SessionUnavailableError('the live session did not start', false);
            },
            // turn taking is the model's own business in both modes; the mode only moves the microphone gate
            setMicMode: () => undefined,
            setInputMuted: protocol.setInputMuted,
            noteOutputLevel: protocol.noteOutputLevel,
            requestClose: protocol.requestClose,
            get outputActive() {
              return protocol.outputActive;
            },
            get echoHold() {
              return hold.holding;
            },
            get speechEvidence() {
              return hold.evidence;
            },
            get usageSeconds() {
              return protocol.usageSeconds;
            },
          };
        },
      }),
  });
}
