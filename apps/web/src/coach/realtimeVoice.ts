/**
 * OpenAI Realtime voice layer (`gpt-realtime-2.x`) over WebRTC (research 03 §4 + §13.1, verification included).
 *
 *   POST /api/voice/session (our server, mints an ephemeral secret; model/voice are SERVER config)
 *     → RTCPeerConnection + data channel `oai-events`            (./rtcSession.ts)
 *     → POST https://api.openai.com/v1/realtime/calls  (Bearer ek_…, application/sdp)
 *
 *  - Two microphone modes (contracts `MicMode`):
 *      'open' — the mic track is enabled continuously, the server's semantic VAD creates the responses and
 *               the child can barge in: on `input_audio_buffer.speech_started` while the coach talks the
 *               playback is cleared at once and the pending `speak()` resolves (./realtimeProtocol.ts);
 *      'push' — hold-to-talk: no server VAD, the track is enabled only while the button is held.
 *  - Lazy session, idle suspend, usage report, bounded `speak()` and the automatic browser-voice fallback
 *    live in ./sessionVoice.ts and are shared with the Live layer.
 *  - The black box (./voiceDiag.ts) gets the playback-relevant server events: response created / done (+ status),
 *    output audio buffer started / stopped / cleared, the server VAD's speech start / stop — a start while the coach
 *    talks is logged as a barge-in (`out.stop` why 'bargeIn': the coach's own voice leaking into an open microphone
 *    shows up exactly like this), one `child.heard` per transcribed utterance of the child, and API error codes.
 */
import type { VoiceSessionResponse } from '@gambit/shared';
import { createVoiceSession } from '../api/client.ts';
import { createRealtimeProtocol } from './realtimeProtocol.ts';
import { openRtcSession, SessionUnavailableError } from './rtcSession.ts';
import type { RtcProtocol } from './rtcSession.ts';
import { createSessionVoice } from './sessionVoice.ts';
import type { SessionVoice, SessionVoiceOptions } from './sessionVoice.ts';
import { diag, diagString } from './voiceDiag.ts';

export const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** minting the secret and the SDP call are each bounded, so a stalled network cannot hold a phrase */
const SESSION_MINT_TIMEOUT_MS = 8000;
const CALLS_TIMEOUT_MS = 8000;

export interface RealtimeVoiceOptions extends SessionVoiceOptions {
  /** mints the ephemeral secret; defaults to `POST /api/voice/session` through the api client */
  createSession?: () => Promise<VoiceSessionResponse>;
  callsUrl?: string;
  fetchImpl?: typeof fetch;
}

export type OpenAiRealtimeVoice = SessionVoice;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

export function createOpenAiRealtimeVoice(options: RealtimeVoiceOptions = {}): OpenAiRealtimeVoice {
  const createSession = options.createSession ?? (() => createVoiceSession({ signal: timeoutSignal(SESSION_MINT_TIMEOUT_MS) }));
  const callsUrl = options.callsUrl ?? OPENAI_REALTIME_CALLS_URL;

  return createSessionVoice({
    ...options,
    kind: 'openai-realtime',
    open: (args) =>
      openRtcSession({
        kind: 'openai-realtime',
        waitForIceGathering: false,
        micMode: args.micMode,
        micMuted: args.micMuted,
        echoGuard: args.echoGuard,
        maxListenMs: args.maxListenMs,
        events: args.rtc,
        async exchangeSdp(offerSdp) {
          const session = await createSession();
          let answer: Response;
          try {
            answer = await (options.fetchImpl ?? fetch)(callsUrl, {
              method: 'POST',
              body: offerSdp,
              // the ephemeral secret lives only in this header — it is never logged or stored
              headers: { Authorization: `Bearer ${session.clientSecret}`, 'Content-Type': 'application/sdp' },
              signal: timeoutSignal(CALLS_TIMEOUT_MS),
            });
          } catch {
            throw new SessionUnavailableError('could not reach the realtime endpoint', false);
          }
          if (!answer.ok) {
            const permanent = answer.status === 401 || answer.status === 403;
            throw new SessionUnavailableError(`realtime call was refused (${answer.status})`, permanent);
          }
          return answer.text();
        },
        createProtocol(hooks): RtcProtocol {
          const protocol = createRealtimeProtocol({
            send: hooks.send,
            getToolHost: args.protocol.getToolHost,
            onTranscript: args.protocol.onTranscript,
            onCoachTranscriptDelta: args.protocol.onCoachTranscriptDelta,
            onThinking: args.protocol.onThinking,
            onToolCoachEvent: args.protocol.onToolCoachEvent,
            onChildSpeaking: args.protocol.onChildSpeaking,
            onSayProgress: args.protocol.onSayProgress,
            onOutputAudio: () => undefined, // the session polls `outputActive` every frame (and after every event)
          });
          let speechEvidence = 0;
          function handleServerEvent(raw: unknown): void {
            const event = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
            const type = typeof event?.type === 'string' ? event.type : '';
            switch (type) {
              case 'output_audio_buffer.started':
                speechEvidence += 1;
                diag('out.buf', { state: 'started' });
                break;
              case 'output_audio_buffer.stopped':
              case 'output_audio_buffer.cleared':
                diag('out.buf', { state: type.slice('output_audio_buffer.'.length) });
                break;
              case 'response.output_audio_transcript.delta':
                speechEvidence += 1;
                break;
              case 'input_audio_buffer.speech_started':
                // the server VAD heard «speech» while the coach talks → it cuts the coach: a barge-in (or his own echo)
                if (protocol.audioPlaying || protocol.responseActive) diag('out.stop', { kind: 'openai-realtime', why: 'bargeIn' });
                diag('vad', { speech: true });
                break;
              case 'input_audio_buffer.speech_stopped':
                diag('vad', { speech: false });
                break;
              case 'conversation.item.input_audio_transcription.completed':
                diag('child.heard', { kind: 'openai-realtime' });
                break;
              case 'response.created':
                diag('resp', { state: 'created' });
                break;
              case 'response.done': {
                const response = event && typeof event.response === 'object' && event.response !== null ? (event.response as Record<string, unknown>) : {};
                diag('resp', { state: 'done', status: diagString(typeof response.status === 'string' ? response.status.slice(0, 32) : 'unknown') });
                break;
              }
              case 'error': {
                const error = event && typeof event.error === 'object' && event.error !== null ? (event.error as Record<string, unknown>) : {};
                const code = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : 'unknown';
                diag('srv.error', { kind: 'openai-realtime', code: diagString(code.slice(0, 64)) });
                break;
              }
              case 'session.created':
              case 'session.updated':
                diag('srv', { kind: 'openai-realtime', type });
                break;
              default:
                break;
            }
            protocol.handleServerEvent(raw);
          }
          return {
            handleServerEvent,
            speak: protocol.speak,
            speakBrief: protocol.speakBrief,
            cancelOutput: protocol.cancelOutput,
            pushContext: protocol.pushContext,
            reset: protocol.reset,
            onChannelOpen(micMode) {
              protocol.configureSession(micMode);
              return Promise.resolve();
            },
            setMicMode: protocol.setMicMode,
            beginUserTurn: protocol.beginUserTurn,
            endUserTurn: protocol.endUserTurn,
            get outputActive() {
              return protocol.audioPlaying;
            },
            get speechEvidence() {
              return speechEvidence;
            },
            // the Realtime API reports tokens, not seconds: the session's own clock is the estimate
            usageSeconds: null,
          };
        },
      }),
  });
}
