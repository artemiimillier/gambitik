/**
 * Transport-independent half of the OpenAI Realtime voice layer: everything that travels over
 * the `oai-events` data channel (research 03 §4, event names verified against openai@7.20 typings).
 *
 *  - `speakBrief(b)` = conversation.item.create (system: the SITUATION — facts + goal) + response.create whose
 *                      per-response instructions say «in your own words, 1–2 short sentences, every fact exact,
 *                      nothing obvious (clock, colours, whose turn)»;
 *                      the model's running transcript is reported as `onSayProgress` captions (the bubble shows it)
 *  - `speak(text)`   = the same with a verbatim instruction (templates without a brief: shell phrases);
 *                      both resolve on response.done / output_audio_buffer.stopped, with a timeout
 *  - tool calls      = response.done → function_call items → CoachToolHost → function_call_output (FACTS as JSON,
 *                      never a ready phrase) → response.create; the model phrases them itself
 *  - push-to-talk    = turn_detection null; input_audio_buffer.clear … input_audio_buffer.commit + response.create
 *  - open microphone = server semantic VAD (eagerness low) creates the responses; barge-in: on
 *                      input_audio_buffer.speech_started while the coach talks → response.cancel +
 *                      output_audio_buffer.clear at once and the pending `speak` settles as 'interrupted'
 *  - context         = conversation.item.create (system message) WITHOUT response.create — never spoken
 *  - transcripts     = response.output_audio_transcript.* / conversation.item.input_audio_transcription.completed
 *
 * No DOM, no WebRTC: `send` is injected, so the whole protocol is unit-testable.
 * Everything injected into the conversation is Russian without Latin notation (language drift, §6).
 */
import type { AnnotationColor, BoardAnnotations, CoachEvent, CoachToolHost, HintLevel, MicMode } from '@gambit/shared';
import { NOTHING_TO_EXPLAIN_FACTS_RU, briefResponseInstructions, buildBriefItem, explainFacts, hintFacts, isTeacherAdvice } from './coachBrief.ts';
import { compareFacts, moveFacts, positionFacts, withTimeout } from './coachTools.ts';
import { createHintLadder } from './hintLadder.ts';
import { normalizeMoveArgument, parsePieceWord } from './spokenMove.ts';
import { probeVoice } from './voiceProbe.ts';
import type { BriefSpeakOptions, SayProgress, SpeakOutcome } from './voiceTypes.ts';
import { estimateSpeechMs } from './voiceUtils.ts';

export interface RealtimeClientEvent {
  type: string;
  [key: string]: unknown;
}

export interface RealtimeProtocolCallbacks {
  send(event: RealtimeClientEvent): void;
  getToolHost(): CoachToolHost | null;
  onTranscript(who: 'child' | 'coach', text: string): void;
  /** running transcript of a model-originated answer (not of a verbatim `speak` / a brief) */
  onCoachTranscriptDelta?(textSoFar: string): void;
  /** a brief handed to `speakBrief`: sent now / the model's own words so far */
  onSayProgress?(progress: SayProgress): void;
  /** output_audio_buffer.started / .stopped / .cleared */
  onOutputAudio(active: boolean): void;
  onThinking(thinking: boolean): void;
  onToolCoachEvent(event: CoachEvent): void;
  /** open microphone: server VAD heard the child start / stop talking */
  onChildSpeaking?(speaking: boolean): void;
}

export interface RealtimeProtocolOptions {
  toolTimeoutMs?: number;
  /** extra time after the estimated speech length before `speak` gives up */
  speakGraceMs?: number;
  /** how long to wait for audio to start after response.done before resolving */
  audioStartGraceMs?: number;
  /** an app phrase waits this long for the child to finish talking (not for urgent phrases) */
  childWaitMs?: number;
}

export interface RealtimeProtocol {
  /** Registers tools + the turn detection of the microphone mode. Call once the data channel is open. */
  configureSession(micMode?: MicMode): void;
  /** Switches between server VAD (open microphone) and app-driven turns (push-to-talk) at runtime. */
  setMicMode(mode: MicMode): void;
  handleServerEvent(raw: unknown): void;
  /** 'spoken' = said (as far as we can tell), 'interrupted' = barge-in / stop(), 'failed' = the fallback voice must say it. */
  speak(text: string, opts?: { interrupt?: boolean }): Promise<SpeakOutcome>;
  /** The model says the situation in its OWN words (same outcomes as `speak`). */
  speakBrief(brief: string, opts?: BriefSpeakOptions): Promise<SpeakOutcome>;
  /** Stops whatever the model is saying right now; a pending `speak` settles as 'interrupted'. */
  cancelOutput(): void;
  /** Silent facts for the model (position changed, judgement arrived) — never spoken, no response is created. */
  pushContext(note: string): void;
  beginUserTurn(): void;
  endUserTurn(heldMs: number): void;
  /** The connection is gone: settle everything that is pending. */
  reset(): void;
  readonly responseActive: boolean;
  readonly audioPlaying: boolean;
  readonly childSpeaking: boolean;
  readonly micMode: MicMode;
}

/** Open microphone: the server decides when the child has finished; 'low' eagerness suits a child who thinks aloud. */
export const OPEN_MIC_TURN_DETECTION: Readonly<Record<string, unknown>> = {
  type: 'semantic_vad',
  eagerness: 'low',
  create_response: true,
  interrupt_response: true,
};

export function buildContextNote(note: string): string {
  return `[Событие партии — для сведения, вслух не произноси] ${note.replace(/\s+/g, ' ').trim()}`;
}

// ───────────────────────── tools ─────────────────────────

const SQUARE_PATTERN = '^[a-h][1-8]$';
const COLORS: readonly AnnotationColor[] = ['green', 'red', 'yellow', 'blue'];

/**
 * Function tools offered to the model. Descriptions are Russian on purpose and say WHEN to call each tool.
 * Every output is FACTS (JSON) for the model to phrase in its own words — never a ready phrase to read out.
 */
export const REALTIME_TOOLS: readonly Record<string, unknown>[] = [
  {
    type: 'function',
    name: 'analyze_position',
    description:
      'Проверенные факты о текущей позиции: материал, что под боем, угрозы обеих сторон, что сделали последние ходы. Вызывай ПЕРЕД любым утверждением о позиции и на вопросы о ней: что хочет соперник, есть ли угрозы, что под боем, как у меня дела, кто лучше стоит. Сам позицию не оценивай. Ответ перескажи своими словами, коротко, одно–два предложения; очевидное — время на часах, цвет фигур, чей ход — не пересказывай.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'evaluate_move',
    description:
      'Проверить ход, о котором спрашивает ребёнок, не делая его: «а если я пойду конём на эф три?», «можно так?», «это хороший ход?». Возвращает факты: возможен ли ход, безопасен ли он, что может ответить соперник. Вызывай всякий раз, когда ребёнок называет конкретный ход. Если непонятно, какой ход он имеет в виду, сначала переспроси. Лучший ход этот инструмент не называет. Вопрос «а почему не так?» — для compare_move.',
    parameters: {
      type: 'object',
      properties: {
        move: {
          type: 'string',
          description: 'Ход в записи SAN или UCI (например Nf3 или g1f3) либо словами ребёнка по-русски («конь эф три»).',
        },
      },
      required: ['move'],
    },
  },
  {
    type: 'function',
    name: 'compare_move',
    description:
      'Сравнить ход, о котором спрашивает ребёнок, с советом тренера: «а почему не ферзём?», «а почему не конём на цэ три?», «а если не так?», «чем плох такой ход?». Передай ход (move), а если ребёнок назвал только фигуру — фигуру (piece). Возвращает факты: так же ли хорош этот ход или слабее совета, что ответит соперник, какое правило здесь работает. Если непонятно, о каком ходе речь, сначала переспроси.',
    parameters: {
      type: 'object',
      properties: {
        move: {
          type: 'string',
          description: 'Ход в записи SAN или UCI (например Qh5 или d1h5) либо словами ребёнка по-русски («ферзь аш пять»). Не заполняй, если назвали только фигуру.',
        },
        piece: {
          type: 'string',
          enum: ['пешка', 'конь', 'слон', 'ладья', 'ферзь', 'король'],
          description: 'Фигура, если ребёнок назвал только её («а почему не ферзём?»).',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_hint',
    description:
      'Подсказка — только когда ребёнок просит подсказку или спрашивает, какой ход сделать. Вопрос «что хочет соперник?» или «есть ли угрозы?» — это не просьба о подсказке: для него есть analyze_position. Уровень: 1 — наводящий вопрос, 2 — куда смотреть, 3 — какой фигурой, 4 — показать ход. Начинай с 1 и повышай, только если ребёнок просит ещё: приложение само не даст перепрыгнуть через ступень. Возвращает факты подсказки и её ступень; ниже четвёртой ступени не называй ни ход, ни клетку, куда идти. В режиме «Учитель» вместо ступени приходит совет учителя: его ходы из строки «Можно назвать» называть можно.',
    parameters: {
      type: 'object',
      properties: { level: { type: 'integer', minimum: 1, maximum: 4, description: 'Уровень подсказки от 1 до 4' } },
      required: ['level'],
    },
  },
  {
    type: 'function',
    name: 'explain_last_move',
    description: 'Факты о последнем ходе ребёнка: что он упустил и что было сильнее. Вызывай на вопросы «почему это плохо?», «почему это хорошо?», «что я сделал не так?». Ответ перескажи своими словами, не стыди.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'show_on_board',
    description: 'Нарисовать стрелки и подсветить клетки на доске, когда показать нагляднее, чем сказать. Используй только клетки и ходы, которые вернули другие инструменты.',
    parameters: {
      type: 'object',
      properties: {
        arrows: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', pattern: SQUARE_PATTERN },
              to: { type: 'string', pattern: SQUARE_PATTERN },
              color: { type: 'string', enum: COLORS },
            },
            required: ['from', 'to'],
          },
        },
        highlights: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            properties: { square: { type: 'string', pattern: SQUARE_PATTERN }, color: { type: 'string', enum: COLORS } },
            required: ['square'],
          },
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'take_back_move',
    description: 'Вернуть последний ход ребёнка. ТОЛЬКО после того, как ребёнок сам ясно согласился вернуть ход.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'wait_for_user',
    description: 'Вызови и промолчи, если звук не требует ответа: тишина, шум, телевизор, разговор не с тобой, ребёнок просто думает вслух.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

/** Tool outputs tell the model how to use them — Russian, short. */
const OWN_WORDS_OUTPUT_RU = 'своими словами, одно–два коротких предложения, только по этим фактам; время на часах, цвет фигур и чей ход не пересказывай';

const SAY_METADATA_SOURCE = 'gambit-say';
const BRIEF_METADATA_SOURCE = 'gambit-brief';
const SAY_RESPONSE_INSTRUCTIONS =
  'Произнеси вслух дословно реплику из последнего сообщения приложения — ту, что стоит после слов «Скажи ребёнку дословно». ' +
  'Ничего не добавляй, не объясняй и не меняй слова. Говори только по-русски, тёплым, бодрым, юным голосом.';

export function buildSayInstruction(text: string): string {
  return `Скажи ребёнку дословно, тёплым голосом: «${text.replace(/\s+/g, ' ').trim()}»`;
}

// ───────────────────────── helpers ─────────────────────────

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseArguments(raw: unknown): Json {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const SQUARE_RE = /^[a-h][1-8]$/;

function toColor(value: unknown, fallback: AnnotationColor): AnnotationColor {
  return COLORS.find((c) => c === value) ?? fallback;
}

/** Validates model-supplied annotations strictly; anything malformed is dropped. */
export function sanitizeAnnotations(args: unknown): BoardAnnotations {
  const result: BoardAnnotations = { arrows: [], highlights: [] };
  if (!isRecord(args)) return result;
  if (Array.isArray(args.arrows)) {
    for (const arrow of args.arrows.slice(0, 4)) {
      if (!isRecord(arrow)) continue;
      const from = str(arrow.from);
      const to = str(arrow.to);
      if (from && to && SQUARE_RE.test(from) && SQUARE_RE.test(to) && from !== to) {
        result.arrows.push({ from, to, color: toColor(arrow.color, 'green') });
      }
    }
  }
  if (Array.isArray(args.highlights)) {
    for (const highlight of args.highlights.slice(0, 8)) {
      if (!isRecord(highlight)) continue;
      const square = str(highlight.square);
      if (square && SQUARE_RE.test(square)) result.highlights.push({ square, color: toColor(highlight.color, 'yellow') });
    }
  }
  return result;
}

function toHintLevel(value: unknown): HintLevel {
  const n = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value), 10);
  if (n === 2 || n === 3 || n === 4) return n;
  return 1;
}

interface PendingSpeak {
  mode: 'verbatim' | 'brief';
  text: string;
  /** teacher mode: the brief's sentence budget (kept for a retried response.create) */
  maxSentences: number | undefined;
  responseId: string | null;
  audioActive: boolean;
  audioEverStarted: boolean;
  responseDone: boolean;
  retried: boolean;
  settle: (outcome: SpeakOutcome) => void;
  done: Promise<SpeakOutcome>;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

// ───────────────────────── protocol ─────────────────────────

export function createRealtimeProtocol(callbacks: RealtimeProtocolCallbacks, options: RealtimeProtocolOptions = {}): RealtimeProtocol {
  const toolTimeoutMs = options.toolTimeoutMs ?? 2500;
  const speakGraceMs = options.speakGraceMs ?? 8000;
  const audioStartGraceMs = options.audioStartGraceMs ?? 1500;
  const childWaitMs = options.childWaitMs ?? 1500;

  let responseActive = false;
  let activeResponseId: string | null = null;
  let audioPlaying = false;
  let thinking = false;
  let pending: PendingSpeak | null = null;
  let idleWaiters: (() => void)[] = [];
  let micMode: MicMode = 'push';
  let childSpeaking = false;
  let childWaiters: (() => void)[] = [];
  let childSpeakingTimer: ReturnType<typeof setTimeout> | null = null;
  const ladder = createHintLadder();
  let ladderHost: CoachToolHost | null = null;
  /** ids of verbatim `speak` responses — their transcripts are not reported as coach answers */
  const sayResponseIds = new Set<string>();
  /** ids of brief responses — their transcript is the model's own words: caption for the bubble + journal */
  const briefResponseIds = new Set<string>();
  const transcriptByResponse = new Map<string, string>();

  const cancelledResponseIds = new Set<string>();

  function rememberId(set: Set<string>, id: string): void {
    set.add(id);
    if (set.size > 32) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }

  function send(event: RealtimeClientEvent): void {
    try {
      callbacks.send(event);
    } catch (error) {
      console.warn('[coach] realtime send failed', error instanceof Error ? error.message : error);
    }
  }

  function setThinking(next: boolean): void {
    if (thinking === next) return;
    thinking = next;
    callbacks.onThinking(next);
  }

  function setAudioPlaying(next: boolean): void {
    if (audioPlaying === next) return;
    audioPlaying = next;
    callbacks.onOutputAudio(next);
  }

  function releaseIdleWaiters(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  function whenIdle(maxWaitMs: number): Promise<void> {
    if (!responseActive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, maxWaitMs);
      idleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function setChildSpeaking(next: boolean): void {
    if (childSpeakingTimer !== null) {
      clearTimeout(childSpeakingTimer);
      childSpeakingTimer = null;
    }
    if (childSpeaking === next) return;
    childSpeaking = next;
    callbacks.onChildSpeaking?.(next);
    if (next) {
      // a lost `speech_stopped` must not leave him "listening" forever
      childSpeakingTimer = setTimeout(() => setChildSpeaking(false), 30_000);
    } else {
      const waiters = childWaiters;
      childWaiters = [];
      for (const waiter of waiters) waiter();
    }
  }

  function whenChildSilent(maxWaitMs: number): Promise<void> {
    if (!childSpeaking) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, maxWaitMs);
      childWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function sessionUpdate(mode: MicMode, withTools: boolean): void {
    send({
      type: 'session.update',
      session: {
        type: 'realtime',
        ...(withTools ? { tools: REALTIME_TOOLS, tool_choice: 'auto' } : {}),
        // push-to-talk: the app decides when a turn starts and ends (research 03 §4.4, §7, §11);
        // open microphone: semantic VAD creates the responses and lets the child barge in
        audio: { input: { turn_detection: mode === 'open' ? OPEN_MIC_TURN_DETECTION : null } },
      },
    });
  }

  function stopOutput(): void {
    if (responseActive) {
      send({ type: 'response.cancel' });
      // its late `response.done` must not be mistaken for the phrase we are about to request
      if (activeResponseId) rememberId(cancelledResponseIds, activeResponseId);
    }
    // research 03 §4.4: WebRTC keeps an output buffer on the server side that must be cleared too
    if (responseActive || audioPlaying) send({ type: 'output_audio_buffer.clear' });
  }

  function cancelOutput(): void {
    stopOutput();
    pending?.settle('interrupted');
  }

  function responseRequest(mode: 'verbatim' | 'brief', maxSentences?: number): RealtimeClientEvent {
    return {
      type: 'response.create',
      response:
        mode === 'brief'
          ? // the situation already carries the facts: no tool round-trip in the middle of an app moment; a teacher's phrase
            // carries its own sentence budget
            {
              instructions: briefResponseInstructions(maxSentences !== undefined ? { maxSentences } : undefined),
              tool_choice: 'none',
              metadata: { source: BRIEF_METADATA_SOURCE },
            }
          : { instructions: SAY_RESPONSE_INSTRUCTIONS, tool_choice: 'none', metadata: { source: SAY_METADATA_SOURCE } },
    };
  }

  function sendSayRequest(mode: 'verbatim' | 'brief', text: string, maxSentences?: number): void {
    send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: mode === 'brief' ? buildBriefItem(text) : buildSayInstruction(text) }] },
    });
    send(responseRequest(mode, maxSentences));
  }

  async function speak(mode: 'verbatim' | 'brief', text: string, opts?: BriefSpeakOptions): Promise<SpeakOutcome> {
    const phrase = text.replace(/\s+/g, ' ').trim();
    if (phrase === '') return 'spoken';

    if (pending) {
      if (opts?.interrupt) pending.settle('interrupted');
      else await pending.done;
    }
    // the child is in the middle of a sentence: let them finish — unless the phrase is urgent
    if (!opts?.interrupt && childSpeaking) await whenChildSilent(childWaitMs);
    if (responseActive || audioPlaying) {
      if (opts?.interrupt) {
        stopOutput();
      } else {
        await whenIdle(8000);
        if (responseActive) stopOutput();
      }
    }
    // somebody else may have started speaking while we waited
    while (pending) await pending.done;

    let settle: (outcome: SpeakOutcome) => void = () => undefined;
    const done = new Promise<SpeakOutcome>((resolve) => {
      settle = resolve;
    });
    const entry: PendingSpeak = {
      mode,
      text: phrase,
      maxSentences: mode === 'brief' ? opts?.maxSentences : undefined,
      responseId: null,
      audioActive: false,
      audioEverStarted: false,
      responseDone: false,
      retried: false,
      done,
      graceTimer: null,
      settle: (outcome) => {
        if (pending === entry) pending = null;
        clearTimeout(overallTimer);
        if (entry.graceTimer !== null) clearTimeout(entry.graceTimer);
        settle(outcome);
      },
    };
    const overallTimer = setTimeout(() => {
      console.warn('[coach] realtime speak timed out');
      entry.settle(entry.audioEverStarted ? 'spoken' : 'failed');
    }, estimateSpeechMs(phrase, 110) + speakGraceMs);

    pending = entry;
    probeVoice('say', { text: phrase, urgent: opts?.interrupt === true, mode });
    done.then((outcome) => probeVoice('say.done', { outcome, mode }), () => undefined);
    sendSayRequest(mode, phrase, entry.maxSentences);
    if (mode === 'brief') callbacks.onSayProgress?.({ type: 'sent' });
    return done;
  }

  // ───────── tools ─────────

  async function runTool(name: string, args: Json): Promise<{ output: Json; respond: boolean }> {
    if (name === 'wait_for_user') return { output: { готово: true }, respond: false };
    const host = callbacks.getToolHost();
    if (!host) {
      return { output: { факты: 'Сейчас партия не идёт.', как_отвечать: 'Скажи, что про ходы и подсказки поговорим во время игры, и предложи сыграть.' }, respond: true };
    }
    switch (name) {
      case 'analyze_position':
      case 'get_position_summary': // an alias of analyze_position (a session configured with that tool name)
        return { output: { факты: await positionFacts(host, toolTimeoutMs), как_отвечать: OWN_WORDS_OUTPUT_RU }, respond: true };
      case 'evaluate_move': {
        const { understood, facts } = await moveFacts(host, normalizeMoveArgument(args.move), toolTimeoutMs + 500);
        return {
          output: understood ? { факты: facts, как_отвечать: OWN_WORDS_OUTPUT_RU } : { нужно_уточнить: facts },
          respond: true,
        };
      }
      case 'compare_move': {
        // «а почему не ферзём?» — the move (or the piece's best move) against the coach's advice (docs/TEACHER-MODE.md §7.1)
        const move = normalizeMoveArgument(args.move);
        const piece = typeof args.piece === 'string' ? parsePieceWord(args.piece) : null;
        const { understood, facts } = await compareFacts(host, { move, piece }, toolTimeoutMs + 500);
        return {
          output: understood ? { факты: facts, как_отвечать: OWN_WORDS_OUTPUT_RU } : { нужно_уточнить: facts },
          respond: true,
        };
      }
      case 'get_hint': {
        // the ladder is enforced here, not by the prompt: never more than one step above the last hint
        if (host !== ladderHost) {
          ladderHost = host;
          ladder.reset();
        }
        const { event, level } = await withTimeout(ladder.give(host, toHintLevel(args.level)), toolTimeoutMs * 2);
        callbacks.onToolCoachEvent(event);
        if (isTeacherAdvice(event)) {
          // teacher mode: the host answers with its advice — no ladder step, its «Можно назвать» moves may be named
          return {
            output: { факты: hintFacts(event, level), совет_учителя: true, можно_назвать_ход: event.teach?.reveal !== 'later', как_отвечать: OWN_WORDS_OUTPUT_RU },
            respond: true,
          };
        }
        return {
          output: { факты: hintFacts(event, level), ступень_подсказки: level, можно_назвать_ход: level === 4, как_отвечать: OWN_WORDS_OUTPUT_RU },
          respond: true,
        };
      }
      case 'explain_last_move': {
        const event = await withTimeout(host.explainLastMove(), toolTimeoutMs);
        if (!event) return { output: { факты: NOTHING_TO_EXPLAIN_FACTS_RU, как_отвечать: OWN_WORDS_OUTPUT_RU }, respond: true };
        callbacks.onToolCoachEvent(event);
        return { output: { факты: explainFacts(event), как_отвечать: OWN_WORDS_OUTPUT_RU }, respond: true };
      }
      case 'show_on_board': {
        const annotations = sanitizeAnnotations(args);
        host.showOnBoard(annotations);
        return { output: { готово: true, стрелок: annotations.arrows.length, клеток: annotations.highlights.length }, respond: true };
      }
      case 'take_back_move':
        return { output: { ход_возвращён: host.takeBackMove() }, respond: true };
      default:
        return { output: { ошибка: 'Такого инструмента нет.' }, respond: true };
    }
  }

  async function handleFunctionCalls(calls: Json[]): Promise<void> {
    setThinking(true);
    let respond = false;
    for (const call of calls) {
      const name = str(call.name) ?? '';
      const callId = str(call.call_id);
      if (!callId) continue;
      let result: { output: Json; respond: boolean };
      try {
        result = await runTool(name, parseArguments(call.arguments));
      } catch (error) {
        const timedOut = error instanceof Error && error.message === 'tool-timeout';
        result = { output: { ошибка: timedOut ? 'Инструмент не успел ответить.' : 'Инструмент сейчас не работает.' }, respond: true };
      }
      probeVoice('tool', { name, arguments: typeof call.arguments === 'string' ? call.arguments : '', output: JSON.stringify(result.output) });
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result.output) } });
      respond ||= result.respond;
    }
    if (respond) send({ type: 'response.create' });
    else setThinking(false);
  }

  // ───────── server events ─────────

  function onResponseDone(response: Json): void {
    const id = str(response.id);
    if (id === null || id === activeResponseId || activeResponseId === null) {
      responseActive = false;
      activeResponseId = null;
      releaseIdleWaiters();
    }

    const status = str(response.status);
    const output = Array.isArray(response.output) ? response.output.filter(isRecord) : [];
    const calls = output.filter((item) => item.type === 'function_call');

    const entry = pending;
    if (entry && entry.responseId !== null && entry.responseId === id) {
      entry.responseDone = true;
      if (status === 'cancelled') {
        // cancelled by the server's own barge-in handling (interrupt_response) while the child talks
        entry.settle(childSpeaking ? 'interrupted' : 'failed');
      } else if (status === 'failed') {
        entry.settle('failed');
      } else if (entry.audioEverStarted && !entry.audioActive) {
        entry.settle('spoken');
      } else if (!entry.audioEverStarted) {
        // the audio may start a moment after the generation finished
        entry.graceTimer = setTimeout(() => entry.settle(entry.audioEverStarted ? 'spoken' : 'failed'), audioStartGraceMs);
      }
      // else: audio is still playing → wait for output_audio_buffer.stopped
    }

    if (calls.length > 0) void handleFunctionCalls(calls);
    else if (!entry) setThinking(false);
  }

  function handleServerEvent(raw: unknown): void {
    if (!isRecord(raw)) return;
    const type = str(raw.type);
    if (!type) return;

    switch (type) {
      case 'response.created': {
        responseActive = true;
        const response = isRecord(raw.response) ? raw.response : {};
        const id = str(response.id);
        activeResponseId = id;
        const metadata = isRecord(response.metadata) ? response.metadata : null;
        const expected = pending?.mode === 'brief' ? BRIEF_METADATA_SOURCE : SAY_METADATA_SOURCE;
        const isOurs = metadata === null || metadata.source === expected;
        if (pending && pending.responseId === null && id && isOurs && !cancelledResponseIds.has(id)) {
          pending.responseId = id;
          rememberId(pending.mode === 'brief' ? briefResponseIds : sayResponseIds, id);
        }
        break;
      }
      case 'response.done':
        onResponseDone(isRecord(raw.response) ? raw.response : {});
        break;
      case 'output_audio_buffer.started': {
        setAudioPlaying(true);
        setThinking(false);
        if (pending) {
          pending.audioActive = true;
          pending.audioEverStarted = true;
          if (pending.graceTimer !== null) {
            clearTimeout(pending.graceTimer);
            pending.graceTimer = null;
          }
        }
        break;
      }
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared': {
        setAudioPlaying(false);
        if (pending) {
          pending.audioActive = false;
          if (pending.responseDone) pending.settle(type === 'output_audio_buffer.stopped' ? 'spoken' : 'interrupted');
        }
        break;
      }
      case 'input_audio_buffer.speech_started': {
        // only the open microphone has server VAD; in push-to-talk the button is the turn border
        if (micMode !== 'open') break;
        const coachTalking = responseActive || audioPlaying || pending !== null;
        setChildSpeaking(true);
        if (coachTalking) {
          // barge-in: the coach yields immediately, and the interrupted phrase is NOT repeated by another voice
          stopOutput();
          pending?.settle('interrupted');
        }
        break;
      }
      case 'input_audio_buffer.speech_stopped':
        setChildSpeaking(false);
        break;
      case 'response.output_audio_transcript.delta': {
        const id = str(raw.response_id);
        const delta = str(raw.delta);
        if (!id || !delta || sayResponseIds.has(id)) break;
        const soFar = (transcriptByResponse.get(id) ?? '') + delta;
        transcriptByResponse.set(id, soFar);
        // the model's own words for a brief go to the bubble of that phrase, not to a free answer's caption
        if (briefResponseIds.has(id)) callbacks.onSayProgress?.({ type: 'caption', text: soFar.replace(/\s+/g, ' ').trim() });
        else callbacks.onCoachTranscriptDelta?.(soFar);
        break;
      }
      case 'response.output_audio_transcript.done': {
        const id = str(raw.response_id);
        const transcript = str(raw.transcript)?.trim();
        if (id) transcriptByResponse.delete(id);
        if (transcript && id && sayResponseIds.has(id)) probeVoice('say.heard', { heard: transcript });
        if (!transcript || (id && sayResponseIds.has(id))) break;
        if (id && briefResponseIds.has(id)) callbacks.onSayProgress?.({ type: 'caption', text: transcript });
        else callbacks.onCoachTranscriptDelta?.(transcript);
        // the journal gets what was really said: answers AND the model's own words for a brief
        callbacks.onTranscript('coach', transcript);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = str(raw.transcript)?.trim();
        if (transcript) callbacks.onTranscript('child', transcript);
        break;
      }
      case 'error': {
        const error = isRecord(raw.error) ? raw.error : {};
        const code = str(error.code) ?? str(error.type) ?? 'unknown';
        // never log the whole event: keep the console free of anything sensitive
        console.warn('[coach] realtime error:', code, str(error.message) ?? '');
        if (code === 'conversation_already_has_active_response' && pending && pending.responseId === null && !pending.retried) {
          // our response.create raced with a model response: cancel that one and ask again
          pending.retried = true;
          const entry = pending;
          send({ type: 'response.cancel' });
          setTimeout(() => {
            if (pending === entry && entry.responseId === null) send(responseRequest(entry.mode, entry.maxSentences));
          }, 250);
        } else if (code !== 'response_cancel_not_active') {
          setThinking(false);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    configureSession(mode = 'push') {
      micMode = mode;
      sessionUpdate(mode, true);
    },
    setMicMode(mode) {
      if (micMode === mode) return;
      micMode = mode;
      setChildSpeaking(false);
      sessionUpdate(mode, false);
    },
    handleServerEvent,
    speak: (text, opts) => speak('verbatim', text, opts),
    speakBrief: (brief, opts) => speak('brief', brief, opts),
    cancelOutput,
    pushContext(note) {
      if (note.trim() === '') return;
      send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: buildContextNote(note).slice(0, 1200) }] },
      });
    },
    beginUserTurn() {
      // barge-in: the child wants to talk, the coach stops immediately
      cancelOutput();
      send({ type: 'input_audio_buffer.clear' });
    },
    endUserTurn(heldMs) {
      if (heldMs < 350) {
        // an accidental tap: committing an empty buffer is an API error
        send({ type: 'input_audio_buffer.clear' });
        return;
      }
      send({ type: 'input_audio_buffer.commit' });
      send({ type: 'response.create' });
      setThinking(true);
    },
    reset() {
      responseActive = false;
      activeResponseId = null;
      releaseIdleWaiters();
      setAudioPlaying(false);
      setThinking(false);
      setChildSpeaking(false);
      // half-said phrases are not repeated by the fallback voice, unsaid ones are
      pending?.settle(pending.audioEverStarted ? 'interrupted' : 'failed');
      transcriptByResponse.clear();
      ladder.reset();
    },
    get responseActive() {
      return responseActive;
    },
    get audioPlaying() {
      return audioPlaying;
    },
    get childSpeaking() {
      return childSpeaking;
    },
    get micMode() {
      return micMode;
    },
  };
}
