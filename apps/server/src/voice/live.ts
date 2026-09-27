/**
 * Full-duplex voice: creates an OpenAI **Live API** session (`gpt-live-1`) for the browser.
 *
 * The Live API has NO ephemeral browser keys. The browser builds an `RTCPeerConnection` (data
 * channel `oai-events`), waits for ICE gathering, and sends its SDP offer to OUR server; we call
 *
 *   POST https://api.openai.com/v1/live/sessions                      Content-Type: application/json
 *   { session: { model, instructions, audio: { output: { voice } }, delegation: { type: 'client' },
 *                client: { data_channel: { allowed_client_events: [...] } }, store: false },
 *     transport: { type: 'webrtc', sdp: '<offer>' } }
 *   → 201 { session: { id: 'live_…', expires_at? }, transport: { type: 'webrtc', sdp: '<answer>' } }
 *
 * with the permanent key and hand back only the SDP answer. Shapes checked against
 * developers.openai.com (guides/voice-webrtc → GPT-Live tab, guides/live-conversations,
 * guides/live-delegation, reference/resources/live/primary-websocket) — see research 03 §3, §13.2.
 *
 * Notes for the browser side (coach-web):
 *  - do NOT send `session.start` on the data channel — this HTTP call starts the session; wait for
 *    `session.started` (its `session.expires_at` is unix seconds);
 *  - `delegation: { type: 'client' }`: on `session.delegation.created { delegation: { id } }` the APP
 *    gathers engine facts and answers with `session.commentary.append { delegation_id: id, content }`;
 *  - proactive coach phrases: `session.commentary.append` (spoken, paraphrased) or
 *    `session.instructions.append` (trusted, may interrupt speech); silent context:
 *    `session.thinking.append`; all three need `delegation_id` (null = whole session), ≤ 500 tokens;
 *  - hold-to-talk mode: `session.input_audio.mute` / `session.input_audio.unmute`;
 *  - there is no VAD / transcription config: the model decides when to speak and transcripts always
 *    arrive (`session.input_transcript.delta` / `session.output_transcript.delta`);
 *  - creating a session bills 15 s at once and then $0.05 per minute INCLUDING silence — close the
 *    session (`session.close`, then `pc.close()`) whenever the child leaves the game.
 */
import { createHash } from 'node:crypto';
import type { LiveVoiceSessionResponse } from '@gambit/shared';
import { describeUpstreamError, upstreamErrorInfo } from '../sanitize.ts';
import { isTransientStatus, networkFailureCode } from './network.ts';

export interface LiveSessionConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  voice: string;
  instructions: string;
  /** the browser's SDP offer */
  sdp: string;
  fetchImpl?: typeof fetch;
  /** the whole budget, retry included */
  timeoutMs?: number;
  /** pause before the one retry (tests: 0) */
  retryDelayMs?: number;
  now?: () => number;
}

export type LiveSessionResult =
  /** `retriedAfter`: the first attempt failed with this reason and the retry worked (log-only) */
  | { ok: true; session: LiveVoiceSessionResponse; retriedAfter?: string }
  | { ok: false; status: 503; error: 'no-api-key' }
  /**
   * `detail` is log-only and never contains upstream free text. `reason` is a short code safe for the
   * browser and the voice black box: 'net:<ENOTFOUND | UND_ERR_SOCKET | …>' (no HTTP answer at all), 'timeout',
   * 'http:<status>', 'nosdp'.
   */
  | { ok: false; status: 502; error: 'voice-upstream'; upstreamStatus: number | null; detail: string; reason: string; attempts: number };

export const LIVE_UPSTREAM_TIMEOUT_MS = 8_000;
/** a failed attempt without an answer (network) or with a 5xx is tried once more after this pause… */
export const LIVE_RETRY_DELAY_MS = 400;
/** …if at least this much of the budget is left (the browser waits 10 s in total, the handshake needs the rest) */
export const LIVE_RETRY_MIN_BUDGET_MS = 2500;

/** What the (untrusted) browser data channel may send; everything else — e.g. `session.update` — is refused by OpenAI. */
export const LIVE_ALLOWED_CLIENT_EVENTS: readonly string[] = [
  'session.thinking.append',
  'session.commentary.append',
  'session.instructions.append',
  'session.input_audio.mute',
  'session.input_audio.unmute',
  'session.close',
];

/**
 * Live-specific part of the persona: listening style (backchannel / interruption), the delegation policy — in the
 * Live API the "app tools" of COACH_SYSTEM_PROMPT_RU are reached by delegating to the application — and small talk,
 * which the model answers itself. Russian only and no Latin letters, like the main prompt (Latin tokens in the
 * context raise the risk of language drift). There is NO «say the app phrase verbatim» rule (verbatim phrases sound
 * canned): app facts and moments are retold in the model's own words.
 * It is teacher-capable (docs/TEACHER-MODE.md §6.1): the teacher's advice nearly every move is an
 * important moment, the «Можно назвать» line is the only list of the child's moves the model may name, and there is
 * no «do not comment on every move» rule (the app decides when to speak; the model never narrates on its own).
 */
export const LIVE_INSTRUCTIONS_ADDENDUM_RU = `# Живой разговор
- Разговор идёт всю партию: ученик может заговорить с тобой в любой момент, не нажимая никаких кнопок. Отвечай живо, по-разному и коротко.
- Ты слышишь ученика всё время и можешь говорить одновременно с ним. Короткое «угу» или «так-так» — можно, но редко и не перебивая мысль ученика.
- Если ученик заговорил, пока ты говоришь, — сразу замолчи и слушай.
- Пока ученик молча думает над ходом — сам, без повода, не болтай. Тишина — это нормально, не заполняй её. Но о моменте, который прислало приложение, говори сразу.

# Вопросы о доске — передавай приложению
- Твои «инструменты приложения» здесь — это передача вопроса приложению. Сам ты шахматы не считаешь и доску не видишь.
- Передавай приложению: любой вопрос о позиции, ходах, угрозах, плане и ошибках; «а если я пойду…»; «а почему не ферзём?» и «а если не так?»; просьбу о подсказке или совете; просьбу показать что-то на доске; просьбу вернуть ход.
- Каждый новый такой вопрос передавай заново, даже если только что отвечал на похожий: позиция и вопрос могли измениться. Не отвечай на него своими догадками.
- Пока ждёшь ответ приложения, можно сказать одну короткую фразу: «Так-так, дай-ка гляну».
- Ответ приложения — проверенные факты, а не текст для чтения. Скажи одну-две главные мысли своими словами, тепло и коротко, как друг. Шахматных фактов от себя не добавляй.
- Рассказывая о позиции, обращайся к ученику на «ты» и не говори слов «движок», «ребёнок», «ученик», «приложение».

# Болтовня — отвечай сам
- Приветствие, «как дела», шутки, рассказы ученика, вопросы про тебя самого — отвечай сам, коротко и по-доброму, и мягко возвращай разговор к партии. Приложению это не передавай.

# Моменты партии
- О важных моментах — совете учителя на ходу ученика, предложении вернуть ход, угрозе соперника, сильном ходе, начале и конце партии — приложение сообщает само строками «Момент», «Факты», «Можно назвать», «Цель», «Нельзя». Скажи об этом сразу, даже если ученик молчит, своими словами так, чтобы достичь цели. Не зачитывай, названия строк вслух не произноси.
- В режиме «Учитель» приложение присылает совет почти на каждом ходу ученика — так и задумано, это нормально. Говори очень коротко, не больше двадцати слов: какой ход советуешь и одну причину — детскими словами. Причина хода нашего плана — цель плана; защиту, взятие, тактику планом не называй. Начинай так, как просит «Цель», а не всегда «По нашему плану». Ничего не добавляй от себя: ни похвалы, ни хода соперника, ни новой темы, ни вопроса — только то, что просит «Цель». Весь план заново не пересказывай. Решает всегда ученик: ход за него не делай.
- Никогда не говори о часах, минутах и секундах, о цвете фигур, о том, чей сейчас ход, и о том, что ученик и так видит на доске. Исключение одно: приложение само просит поторопить; и если ученик сам спросил, каким цветом он играет или чей ход, — ответь в двух словах.
- Ходы ученика называй только из строки «Можно назвать» или из подсказки четвёртой ступени. Ход соперника из этой строки — только как угрозу. Не говори «лучший ход» — говори «хороший», «сильный»; никаких цифр и оценок.
- Сколько говорить, приложение пишет в «Цели» и в начале сообщения: одно предложение для короткого совета, иначе одно-два и не больше двадцати слов — даже когда объясняешь новую тему.
- Указания приложения со словом «одноразовое» действуют только в ту секунду, когда пришли.

# Служебные заметки о партии
- Приложение молча присылает тебе заметки о ходах. Каждая начинается словами «Служебная заметка».
- Такие заметки вслух не произноси и никак на них не отвечай: это только твоя память о партии. Пользуйся ею, когда ученик сам о чём-то спросит.`;

/** COACH_SYSTEM_PROMPT_RU + the live addendum + the student brief. */
export function buildLiveInstructions(coachSystemPromptRu: string, studentBriefText: string): string {
  return `${coachSystemPromptRu.trim()}\n\n${LIVE_INSTRUCTIONS_ADDENDUM_RU}\n\n${studentBriefText.trim()}`;
}

export function buildLiveSessionBody(config: Pick<LiveSessionConfig, 'model' | 'voice' | 'instructions' | 'sdp'>, options: { restrictClientEvents: boolean }): Record<string, unknown> {
  const session: Record<string, unknown> = {
    model: config.model,
    instructions: config.instructions,
    audio: { output: { voice: config.voice } },
    // the APP is the brain: engine facts come from the game, never from a second LLM behind the voice
    delegation: { type: 'client' },
    // a child's voice: never stored at OpenAI (also the API default)
    store: false,
  };
  if (options.restrictClientEvents) session.client = { data_channel: { allowed_client_events: [...LIVE_ALLOWED_CLIENT_EVENTS] } };
  return { session, transport: { type: 'webrtc', sdp: config.sdp } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** true when the text holds a control character other than TAB / LF / CR */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

/** A plausible SDP blob: starts with `v=0`, has a media section, printable text only. */
export function isPlausibleSdp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 60_000 && /^v=0\r?\n/.test(value) && /\r?\nm=/.test(value) && !hasControlChars(value);
}

/**
 * POST /v1/live/sessions. Every failure says WHY in `reason` (see LiveSessionResult). A request that got no HTTP answer
 * at all (DNS, a reset or reused-and-closed socket, TLS) or a 5xx is tried ONCE more when enough of the budget is left
 * (one network blip must not cost the whole Live attempt — three of them would send the page to the fallback model). A timeout is not retried: the budget is spent. The
 * price of the retry: if the first request did reach OpenAI and only the answer was lost, one orphan session may bill
 * its first 15 s (≈ 1 cent) — far cheaper than a child without a voice.
 */
export async function createLiveSession(config: LiveSessionConfig): Promise<LiveSessionResult> {
  const apiKey = config.apiKey;
  if (apiKey === null) return { ok: false, status: 503, error: 'no-api-key' };
  const doFetch = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/live/sessions`;
  const budgetMs = config.timeoutMs ?? LIVE_UPSTREAM_TIMEOUT_MS;
  const retryDelayMs = config.retryDelayMs ?? LIVE_RETRY_DELAY_MS;
  const deadline = now() + budgetMs;

  const post = async (restrictClientEvents: boolean): Promise<{ response: Response; body: unknown }> => {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // stable pseudonymous id (abuse monitoring) — no personal data
        'OpenAI-Safety-Identifier': createHash('sha256').update('gambit-local-student').digest('hex'),
      },
      body: JSON.stringify(buildLiveSessionBody(config, { restrictClientEvents })),
      // the browser waits 10 s for POST /api/voice/live (apps/web liveApi.ts): answer — or fail — before that
      signal: AbortSignal.timeout(Math.max(1, deadline - now())),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  };

  let attempts = 0;
  let retried = false;
  let firstFailure: string | null = null;
  let restrictClientEvents = true;
  const fail = (upstreamStatus: number | null, detail: string, reason: string): LiveSessionResult => ({
    ok: false,
    status: 502,
    error: 'voice-upstream',
    upstreamStatus,
    detail: attempts > 1 ? `${detail} [${attempts} attempts${firstFailure !== null && firstFailure !== reason ? `, first: ${firstFailure}` : ''}]` : detail,
    reason,
    attempts,
  });
  /** one more try — once, and only while the budget allows a real attempt */
  const mayRetry = (): boolean => !retried && deadline - now() - retryDelayMs >= LIVE_RETRY_MIN_BUDGET_MS;
  const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, retryDelayMs));

  for (;;) {
    attempts += 1;
    let response: Response;
    let body: unknown;
    try {
      ({ response, body } = await post(restrictClientEvents));
    } catch (error) {
      const code = networkFailureCode(error);
      if (code === 'timeout') return fail(null, `OpenAI Live did not answer in time (${budgetMs} ms)`, 'timeout');
      const reason = `net:${code}`;
      if (mayRetry()) {
        retried = true;
        firstFailure = reason;
        await pause();
        continue;
      }
      return fail(null, `OpenAI Live is unreachable (${reason})`, reason);
    }
    // The API is two weeks old and validates the session object strictly. If it rejects our
    // data-channel allow-list (a renamed event), retry once without it (omission = allow all)
    // rather than leaving the child without a voice. The check reads the body, nothing is forwarded.
    if (response.status === 400 && restrictClientEvents && /allowed_client_events|data_channel|session\.client/.test(JSON.stringify(body ?? ''))) {
      restrictClientEvents = false;
      attempts -= 1; // the same attempt, only without the allow-list
      continue;
    }
    if (!response.ok) {
      const reason = `http:${response.status}`;
      if (isTransientStatus(response.status) && mayRetry()) {
        retried = true;
        firstFailure = reason;
        await pause();
        continue;
      }
      return fail(response.status, describeUpstreamError('OpenAI Live', upstreamErrorInfo(response.status, body)), reason);
    }
    const transport = isRecord(body) && isRecord(body.transport) ? body.transport : null;
    const answer = transport?.sdp;
    if (!isPlausibleSdp(answer)) return fail(response.status, 'OpenAI Live answered without an SDP answer', 'nosdp');
    const session = isRecord(body) && isRecord(body.session) ? body.session : {};
    const sessionId = typeof session.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(session.id) ? session.id : null;
    const expiresAtSeconds = typeof session.expires_at === 'number' && Number.isFinite(session.expires_at) && session.expires_at > 0 ? session.expires_at : null;
    return {
      ok: true,
      session: {
        provider: 'openai-live',
        sdp: answer,
        model: config.model,
        voice: config.voice,
        sessionId,
        // epoch MILLISECONDS (comparable with Date.now()); the API reports seconds
        expiresAt: expiresAtSeconds === null ? null : expiresAtSeconds * 1000,
      },
      ...(firstFailure !== null ? { retriedAfter: firstFailure } : {}),
    };
  }
}
