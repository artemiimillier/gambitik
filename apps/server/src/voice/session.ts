/**
 * Mints an ephemeral OpenAI Realtime client secret (research 03):
 *   POST https://api.openai.com/v1/realtime/client_secrets
 *   { expires_after: { anchor: 'created_at', seconds }, session: { type: 'realtime', … } }
 * The permanent key never leaves the server; the browser gets only the short-lived `ek_…` value
 * and sends its SDP offer straight to OpenAI.
 */
import { createHash } from 'node:crypto';
import type { StudentProfile, VoiceSessionResponse } from '@gambit/shared';
import { describeUpstreamError, upstreamErrorInfo } from '../sanitize.ts';
import { networkFailureCode } from './network.ts';

export interface VoiceSessionConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  voice: string;
  transcribeModel: string;
  ttlSeconds: number;
  instructions: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * `detail` is for the SERVER LOG only and is built from the HTTP status + the short `error.type` /
 * `error.code` identifiers — never from upstream free text, which echoes a partly masked API key.
 * The browser gets `{ error: 'voice-upstream', status: upstreamStatus }` and nothing else.
 */
export type VoiceSessionResult =
  | { ok: true; session: VoiceSessionResponse }
  | { ok: false; status: 503; error: 'no-api-key' }
  /** `reason`: a short code for the browser and the voice black box — 'net:<code>' | 'timeout' | 'http:<status>' | 'nosecret' */
  | { ok: false; status: 502; error: 'voice-upstream'; upstreamStatus: number | null; detail: string; reason: string };

/** Transcription model used when the API rejects the preferred one (docs disagree, see research 03 §4.8). */
export const FALLBACK_TRANSCRIBE_MODEL = 'gpt-realtime-whisper';

const CHESS_KEYWORDS = ['ферзь', 'ладья', 'слон', 'конь', 'пешка', 'король', 'рокировка', 'вилка', 'связка', 'шах', 'мат', 'Гамбитик'];

/** A few lines about the student for the voice persona — pseudonym and chess facts only. */
export function studentBrief(profile: StudentProfile): string {
  const lines = [
    '# Об ученике',
    `Псевдоним: ${profile.nickname}. Обращайся в ${profile.address === 'f' ? 'женском' : 'мужском'} роде. Ступень программы: ${profile.stage}.`,
    'Называй ученика по псевдониму изредка, а не в каждой фразе.',
  ];
  if (profile.weaknesses.length > 0) lines.push(`Сейчас работаем над: ${profile.weaknesses.join('; ')}.`);
  if (profile.strengths.length > 0) lines.push(`Сильные стороны: ${profile.strengths.join('; ')}.`);
  return lines.join('\n');
}

export function buildRealtimeSessionBody(config: Pick<VoiceSessionConfig, 'model' | 'voice' | 'ttlSeconds' | 'instructions'>, transcribeModel: string): Record<string, unknown> {
  const transcription: Record<string, unknown> = { model: transcribeModel };
  // gpt-realtime-whisper accepts neither `languages` nor `keywords`
  if (transcribeModel !== FALLBACK_TRANSCRIBE_MODEL) {
    transcription.languages = ['ru'];
    transcription.keywords = CHESS_KEYWORDS;
  }
  const session: Record<string, unknown> = {
    type: 'realtime',
    model: config.model,
    instructions: config.instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        noise_reduction: { type: 'far_field' },
        transcription,
        turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true },
      },
      output: { voice: config.voice, speed: 1.05 },
    },
    truncation: { type: 'retention_ratio', retention_ratio: 0.8, token_limits: { post_instructions: 8000 } },
  };
  // `reasoning.effort` exists on the gpt-realtime-2.x family only
  if (/^gpt-realtime-2/.test(config.model)) session.reasoning = { effort: 'low' };
  return { expires_after: { anchor: 'created_at', seconds: config.ttlSeconds }, session };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function mintVoiceSession(config: VoiceSessionConfig): Promise<VoiceSessionResult> {
  const apiKey = config.apiKey;
  if (apiKey === null) return { ok: false, status: 503, error: 'no-api-key' };
  const doFetch = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/realtime/client_secrets`;

  const post = async (transcribeModel: string): Promise<{ response: Response; body: unknown }> => {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // stable pseudonymous id, bound to the minted token (abuse monitoring) — no personal data
        'OpenAI-Safety-Identifier': createHash('sha256').update('gambit-local-student').digest('hex'),
      },
      body: JSON.stringify(buildRealtimeSessionBody(config, transcribeModel)),
      signal: AbortSignal.timeout(10_000),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  };

  try {
    let { response, body } = await post(config.transcribeModel);
    if (response.status === 400 && config.transcribeModel !== FALLBACK_TRANSCRIBE_MODEL && /transcri/i.test(JSON.stringify(body ?? ''))) {
      ({ response, body } = await post(FALLBACK_TRANSCRIBE_MODEL));
    }
    if (!response.ok) {
      return {
        ok: false,
        status: 502,
        error: 'voice-upstream',
        upstreamStatus: response.status,
        detail: describeUpstreamError('OpenAI', upstreamErrorInfo(response.status, body)),
        reason: `http:${response.status}`,
      };
    }
    if (!isRecord(body) || typeof body.value !== 'string' || body.value === '') {
      return { ok: false, status: 502, error: 'voice-upstream', upstreamStatus: response.status, detail: 'OpenAI answered without a client secret', reason: 'nosecret' };
    }
    const expiresAtSeconds = typeof body.expires_at === 'number' && Number.isFinite(body.expires_at) ? body.expires_at : Math.floor(now() / 1000) + config.ttlSeconds;
    return {
      ok: true,
      session: {
        provider: 'openai-realtime',
        clientSecret: body.value,
        model: config.model,
        voice: config.voice,
        // epoch MILLISECONDS (comparable with Date.now()); the API reports seconds
        expiresAt: expiresAtSeconds * 1000,
        instructionsApplied: true,
      },
    };
  } catch (error) {
    // the cause of «unreachable» (DNS, a closed socket, TLS …) is kept as a code — see ./network.ts
    const code = networkFailureCode(error);
    if (code === 'timeout') return { ok: false, status: 502, error: 'voice-upstream', upstreamStatus: null, detail: 'OpenAI did not answer in time', reason: 'timeout' };
    return { ok: false, status: 502, error: 'voice-upstream', upstreamStatus: null, detail: `OpenAI is unreachable (net:${code})`, reason: `net:${code}` };
  }
}
