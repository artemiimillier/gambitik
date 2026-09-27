/**
 * Transport-independent half of the OpenAI Live voice layer (full-duplex `gpt-live-1`): everything that
 * travels over the `oai-events` data channel. Event names and payloads follow the
 * official docs (guides: live, live-conversations, live-delegation, live-migration,
 * voice-webrtc?api=live; reference: live/primary-websocket):
 *
 *   client → session.commentary.append | session.thinking.append | session.instructions.append
 *              { type, event_id, delegation_id: string | null, content }          (content ≤ 500 tokens)
 *            session.input_audio.mute | session.input_audio.unmute | session.close { type, event_id }
 *   server → session.started, session.{commentary,thinking,instructions}.appended { client_event_id },
 *            session.input_transcript.delta / session.output_transcript.delta { delta, start_ms, end_ms },
 *            session.delegation.created { offset_ms, delegation: { id, type, target } },
 *            session.input_audio.muted/unmuted, session.usage.updated { usage.seconds },
 *            session.closed { reason, usage.seconds }, error, info, response.event, transport.*
 *
 * What the Live API does NOT have (live-migration guide): no per-response "done" event, no
 * `response.cancel`, no VAD events. So:
 *   - `speak()` decides by itself when the phrase is over: the coach's audio went quiet for ≥ 700 ms after it
 *     had started (or, with a deaf analyser, the output transcript stopped and its timeline ran out), with
 *     a hard 12 s cap. Nothing here can hang the game.
 *   - "the child is talking" is derived from input transcript activity.
 *   - an app phrase never cuts into a conversation (a phrase appended while the child is still asking gets merged
 *     with the question and the question is never answered): a normal phrase waits until
 *     the child has finished AND the model's own answer (filler + delegated answer) is over — bounded, see below.
 *   - stopping the coach = duck the local playback at once + a trusted `session.instructions.append`
 *     (the one event that may interrupt speech in progress).
 *   - barge-in itself is native: the model hears the child while it talks and yields on its own.
 *
 * Words come from the MODEL, chess truth from the app:
 *   - `speakBrief(brief)` hands a SITUATION (engine facts + the goal of the moment) as commentary framed «say it in your
 *     own words» (urgent: a trusted instruction) — the docs: commentary «is trained to paraphrase», «give GPT-Live the
 *     relevant facts and let it choose how to say them». Its running transcript is reported as `onSayProgress` captions,
 *     so the speech bubble shows what is actually said. `speak(text)` (no brief) keeps handing the bare phrase.
 *   - Tools use CLIENT delegation: `session.delegation.created` carries no question text, so the child's latest words
 *     are routed by intent (./spokenMove.ts, classifyChildRequest) to the CoachToolHost — analyzePosition /
 *     evaluateMove / compareMove («а почему не ферзём?», teacher mode) / the hint ladder (teacher mode: the advice) /
 *     explainLastMove — and the FACTS go back as commentary with the same
 *     `delegation_id`, framed «answer in your own words, only from these facts».
 *
 * No DOM, no WebRTC: `send`, the clock and the audio-activity feed are injected → fully unit-testable.
 */
import type { CoachEvent, CoachToolHost, HintLevel, PieceType } from '@gambit/shared';
import {
  CLARIFY_MOVE_FACTS_RU,
  LIVE_APPEND_MAX_CHARS,
  NO_GAME_FACTS_RU,
  NOTHING_TO_EXPLAIN_FACTS_RU,
  TOOL_FAILED_FACTS_RU,
  buildBriefCommentary,
  buildFactsAnswer,
  buildUrgentBriefCommentary,
  explainFacts,
  hintFacts,
  whyNotFacts,
} from './coachBrief.ts';
import { compareFacts, moveFacts, positionFacts, withTimeout } from './coachTools.ts';
import { createHintLadder } from './hintLadder.ts';
import { MOVE_VERB_RE, parsePieceWord, parseSpokenMove } from './spokenMove.ts';
import { probeVoice } from './voiceProbe.ts';
import type { BriefSpeakOptions, SayProgress, SpeakOutcome } from './voiceTypes.ts';
import { estimateSpeechMs } from './voiceUtils.ts';

export interface LiveClientEvent {
  type: string;
  event_id: string;
  [key: string]: unknown;
}

export interface LiveProtocolCallbacks {
  send(event: LiveClientEvent): void;
  getToolHost(): CoachToolHost | null;
  onTranscript(who: 'child' | 'coach', text: string): void;
  /** running transcript of a model-originated answer (not of an app phrase handed to `speak` / `speakBrief`) */
  onCoachTranscriptDelta?(textSoFar: string): void;
  /** a brief handed to `speakBrief`: sent to the model now / the model's own words so far */
  onSayProgress?(progress: SayProgress): void;
  onThinking(thinking: boolean): void;
  onToolCoachEvent(event: CoachEvent): void;
  onChildSpeaking(speaking: boolean): void;
  /** true = mute the local <audio> element right now (the model cannot be cancelled from the client) */
  onDuck?(ducked: boolean): void;
  onSessionStarted?(): void;
  /** the server closed the session (expired, content, hang-up …) */
  onSessionClosed?(reason: string): void;
}

export interface LiveProtocolOptions {
  now?: () => number;
  newId?: () => string;
  /** the coach's audio must stay quiet this long before a phrase counts as finished */
  silenceMs?: number;
  /** hard cap per phrase */
  speakCapMs?: number;
  /** the model has this long (while the child is silent) to start saying an appended phrase */
  startGraceMs?: number;
  /** …a brief needs a moment more: the model composes its own words */
  briefStartGraceMs?: number;
  /** a brief is over after this much quiet (its sentences are the model's own, their number is unknown) */
  briefSilenceMs?: number;
  /** an app phrase waits this long for the child to finish talking (not for urgent phrases) */
  childWaitMs?: number;
  /** …and then this long for the model's own answer to the child to be over (not for urgent phrases) */
  conversationWaitMs?: number;
  /** the conversation counts as over after this much quiet from both sides */
  conversationQuietMs?: number;
  /** after a delegated answer was handed to the model it is still «answering» this long unless audio says otherwise */
  delegationHoldMs?: number;
  /** no input transcript for this long → the child stopped talking */
  childSilenceMs?: number;
  /** transcript deltas further apart than this belong to different utterances */
  segmentGapMs?: number;
  toolTimeoutMs?: number;
  /** how long a delegation waits for the child's words to arrive as a transcript */
  questionWaitMs?: number;
  /**
   * …and then until no new word of the child arrived for this long (bounded by `questionSettleMaxMs`). The input
   * transcript lags the audio: «А если я пойду конём на эф три?» would be routed as «А если я пойду» (a position
   * question) when the delegation comes before the rest of the sentence.
   */
  questionSettleMs?: number;
  questionSettleMaxMs?: number;
  tickMs?: number;
  /**
   * A phrase cannot be over sooner than this many ms per character after its audio started — unless the coach has
   * been quiet for a long time. gpt-live-1 speaks Russian at ≈ 85–90 ms per character and pauses 0.7–1 s between
   * sentences, while the transcript deltas arrive in step with the audio — so «quiet for 700 ms and the transcript
   * timeline has run out» is already true after the FIRST sentence of a three-sentence phrase.
   */
  minSpeechMsPerChar?: number;
}

export interface LiveProtocol {
  handleServerEvent(raw: unknown): void;
  /** Feed from the playback analyser, called at frame rate: true/false = audible or not, null = analyser is deaf. */
  noteOutputLevel(audible: boolean | null): void;
  speak(text: string, opts?: { interrupt?: boolean }): Promise<SpeakOutcome>;
  /**
   * The model says the situation in its OWN words. `fallbackText` = what the fallback voice will say if this fails
   * (the model is then told not to repeat it). `maxSentences` (teacher mode) = the phrase's sentence budget in the frame.
   */
  speakBrief(brief: string, opts?: BriefSpeakOptions): Promise<SpeakOutcome>;
  /** Stops whatever the coach is saying right now (local duck + interrupting instruction). */
  cancelOutput(): void;
  /** Silent facts for the model (position changed, judgement arrived) — never spoken verbatim. */
  pushContext(note: string): void;
  /** `session.input_audio.mute` / `.unmute` */
  setInputMuted(muted: boolean): void;
  /** Resolves true once `session.started` arrived. */
  whenStarted(timeoutMs: number): Promise<boolean>;
  /** Asks the server to end the (billed) session. */
  requestClose(): void;
  /** The connection is gone: settle everything that is pending. */
  reset(): void;
  readonly started: boolean;
  /** the coach is (probably) audible right now — drives the echo guard and the pseudo mouth */
  readonly outputActive: boolean;
  readonly childSpeaking: boolean;
  /** billed seconds as last reported by the server, null when unknown */
  readonly usageSeconds: number | null;
}

// ───────────────────────── texts sent to the model (Russian on purpose: language drift) ─────────────────────────

/**
 * Sent once per session as a trusted instruction. It takes precedence over any «say ready phrases whole and close to the
 * text» rule (so that phrases do not sound pre-programmed): the app sends situations, the model speaks in its
 * own words — short, 1–2 sentences, varied, every fact exact, never what the child already sees (no reading out the
 * clocks or anything else that is visible). It also re-states the
 * child-safety rules in short. Kept under the ~500-token limit of an append (see MAX_APPEND_CHARS).
 */
export const LIVE_SAY_POLICY_RU =
  'Главное правило разговора, оно важнее прежних правил про готовые реплики. Приложение присылает тебе ситуацию: проверенные факты и что сейчас нужно ребёнку. ' +
  'Говори своими словами: коротко, 1–2 предложения, не пересказывай очевидное — время на часах, цвет фигур, чей ход, что видно на доске (если приложение назвало другое число — столько и говори); живо и тепло, каждый раз по-новому. ' +
  'Факты передавай точно и ничего не выдумывай: ни ходов, ни клеток, ни угроз. Свой совет — ход ученика — называй, только если он есть в строке «Можно назвать» или в подсказке четвёртой ступени; название строки вслух не говори. ' +
  'Позицию сам не оценивай: вопрос про позицию, ход, подсказку или ошибку передай приложению. ' +
  'Только по-русски и только о шахматах: на постороннее ответь коротко и верни к доске, личное не спрашивай. ' +
  'Когда приложение присылает ситуацию или важный момент — скажи о нём сразу, даже если ребёнок молчит; в режиме «Учитель» совет приходит почти на каждом ходу, это нормально. Сам, без повода, пока ребёнок молча думает, — не болтай; перебивает — замолчи и слушай. ' +
  'Заметки, которые начинаются словами «Служебная заметка», вслух не произноси и не отвечай на них: это твоя память о партии.';

/**
 * Prefix of every silent context note: a bare fact appended as
 * `session.thinking.append` may be read out loud by gpt-live-1 («Пешка на е четыре — лучший ход…»). The explicit marker
 * (together with the rule in LIVE_SAY_POLICY_RU and in the server's Live instructions) keeps the notes silent.
 */
export const LIVE_CONTEXT_PREFIX_RU = 'Служебная заметка, вслух не произноси и не отвечай на неё:';

export function buildContextNote(note: string): string {
  return `${LIVE_CONTEXT_PREFIX_RU} ${note}`;
}

/**
 * `session.instructions.append` stays in the session for good: the stop is worded as a ONE-TIME order, so it can never
 * turn into «be silent from now on» (after «…потом замолчи и слушай» the model would keep silent).
 */
export const LIVE_STOP_INSTRUCTION_RU =
  'Одноразовое указание, только для этой секунды: фразу, которую ты сейчас говоришь, не договаривай. Потом говори как обычно: отвечай ребёнку и сразу говори о новых ситуациях от приложения.';

/**
 * Urgent phrase WITHOUT a brief (a template of the app): commentary sent at once, said nearly as it is. Like an urgent
 * brief it is NOT an instruction — instructions stay in the session for good.
 */
export function buildUrgentSayCommentary(text: string): string {
  return `Важный момент — скажи ребёнку сразу, как только сможешь, по-русски, почти дословно: «${text}»`;
}

export function buildAlreadySaidNote(text: string): string {
  return `Приложение уже само показало и озвучило ребёнку реплику: «${text}». Не произноси её ещё раз.`;
}

/**
 * A teacher's brief with a budget above three sentences (full = 4, concept = 5) gets this much more time before the hard
 * cap settles it: ≈ one short Russian sentence of gpt-live-1 (≈ 85–90 ms per character).
 */
export const TEACH_BRIEF_EXTRA_MS_PER_SENTENCE = 4000;

/** ~500 tokens is the documented limit of an append (see LIVE_APPEND_MAX_CHARS in coachBrief.ts) */
export const MAX_APPEND_CHARS = LIVE_APPEND_MAX_CHARS;

// ───────────────────────── what did the child ask? ─────────────────────────

export type ChildRequest =
  | { intent: 'hint'; level: HintLevel | null }
  | { intent: 'explain' }
  | { intent: 'position' }
  /** a hypothetical move; null = the child talks about a move but it is unclear which one → the model asks again */
  | { intent: 'evaluate'; move: string | null }
  /**
   * «а почему не ферзём?» / «а почему не конём на цэ три?» / «а если не так?» (docs/TEACHER-MODE.md §7.1): compare with
   * the advice → `CoachToolHost.compareMove` (older games: `evaluateMove`). `move` = the named move (SAN / UCI) or null,
   * `piece` = the piece named in the sentence or null; both null = ask which move is meant.
   */
  | { intent: 'whyNot'; move: string | null; piece: PieceType | null }
  /** «а ещё варианты?» (teacher mode, P1): `repeatAdvice({ more: true })`; a game without advice → the hint ladder */
  | { intent: 'more' };

const SHOW_MOVE_RE = /(покажи|скажи|назови|подскажи)\S*\s+(мне\s+)?(сам\s+|лучший\s+|правильный\s+)?ход|какой\s+(тут\s+|здесь\s+)?(лучший\s+|правильный\s+)?ход|куда\s+(мне\s+)?(по)?ходить|чем\s+(мне\s+)?(по)?ходить|что\s+(мне\s+)?(тут\s+|здесь\s+|теперь\s+)?(с|по)?ходить/i;
const HINT_RE = /подска|помоги|помощ|намек|намёк|не\s+знаю|что\s+(мне\s+)?(тут\s+|здесь\s+|теперь\s+)?делать|как\s+(мне\s+)?(тут\s+|здесь\s+)?(быть|ходить)/i;
const EXPLAIN_RE = /почему|зачем|ошиб|зевн|зевок|что\s+не\s+так|плох|объясни|последн\S*\s+ход|мой\s+ход|(я\s+)?неправильно/i;
/** «я пошёл конём…, почему это плохо?» is about the move already played, not a hypothetical one */
const PAST_MOVE_RE = /пош[её]л|пошла|сходил|походил|сыграл|сделал|пожертвовал|отдал|потерял/i;
/** words that make a named move a question about it («конь эф три — хороший ход?») */
const JUDGE_WORDS_RE = /хорош|нормальн|плох|опасн|безопасн|стоит|лучше|сильн|можно|правильн|ход\b|ход\?/i;
/** position questions («что хочет соперник», «что под боем») are never about a hypothetical move */
const POSITION_RE = /хочет\s+соперник|под\s+бо|под\s+удар|угрож|угроз|напада|напал|защищ|как\s+(у\s+меня\s+)?дела|кто\s+(сейчас\s+)?выигрыва/i;
/**
 * «а почему не ферзём?», «почему бы не конём на цэ три?», «а не лучше слоном?», «чем плох ход пешкой на е четыре?» —
 * a comparison with the advice; needs a named move or piece (otherwise «почему не получилось?» stays an explanation).
 * (`\b` does not work next to Cyrillic letters in JS — hence the explicit look-arounds.)
 */
const WHY_NOT_RE = /почему\s+(?:бы\s+)?не(?![а-я])|(?<![а-я])а\s+не\s+лучше|(?<![а-я])чем\s+плох/;
/** «а если не так?» / «а если не туда?» — a comparison even without a named move (the model then asks which one) */
const WHAT_IF_NOT_RE = /(?<![а-я])а\s+если\s+не(?![а-я])|(?<![а-я])а\s+не\s+лучше/;
/** «а ещё варианты?», «какие ещё ходы?», «а другие ходы есть?» */
const MORE_RE = /ещ[её]\s+(?:есть\s+)?(?:вариант|ход)|други[ех]\s+(?:вариант|ход)|(?<![а-я])а\s+ещ[её]\s+(?:что|как)/;
/** «почему не взять пешку?» names the TARGET of a capture, not the piece that moves — it is not a piece question */
const CAPTURE_VERB_RE = /(?<![а-я])(?:взять|возьм|съесть|съем|забрать|забер|побить|бить|срубить|разменя)/;
/** «чем плох мой ход» is about the move already played */
const OWN_MOVE_RE = /мой\s+ход|моим\s+ход|последн\S*\s+ход/;

/**
 * A deliberately small router over the (unreliable) transcript of a child. It only picks WHICH engine-backed tool
 * answers; it never produces chess content itself. Asking for the move outright requests step 4 — the ladder still
 * allows only one step up at a time. «Why not …?» is checked BEFORE a named move is taken as «а если я пойду…».
 */
export function classifyChildRequest(text: string): ChildRequest {
  const t = text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  if (t === '') return { intent: 'position' };
  if (EXPLAIN_RE.test(t) && PAST_MOVE_RE.test(t)) return { intent: 'explain' };
  const named = parseSpokenMove(t);
  const aboutPosition = POSITION_RE.test(t);
  if (MORE_RE.test(t) && named.kind !== 'move' && !aboutPosition) return { intent: 'more' };
  if ((WHY_NOT_RE.test(t) || WHAT_IF_NOT_RE.test(t)) && !OWN_MOVE_RE.test(t)) {
    const move = named.kind === 'move' ? named.move : null;
    const piece = CAPTURE_VERB_RE.test(t) ? null : parsePieceWord(t);
    // «почему не защищён мой конь?» names a piece but asks about the position
    if (move !== null || (piece !== null && !aboutPosition) || WHAT_IF_NOT_RE.test(t)) return { intent: 'whyNot', move, piece };
  }
  if (named.kind === 'move' && !aboutPosition && (MOVE_VERB_RE.test(t) || JUDGE_WORDS_RE.test(t))) return { intent: 'evaluate', move: named.move };
  if (SHOW_MOVE_RE.test(t)) return { intent: 'hint', level: 4 };
  if (HINT_RE.test(t)) return { intent: 'hint', level: null };
  if (named.kind === 'move' && !aboutPosition && !EXPLAIN_RE.test(t)) return { intent: 'evaluate', move: named.move };
  if (named.kind === 'partial' && !aboutPosition) return { intent: 'evaluate', move: null };
  if (aboutPosition) return { intent: 'position' };
  if (EXPLAIN_RE.test(t)) return { intent: 'explain' };
  return { intent: 'position' };
}

// ───────────────────────── helpers ─────────────────────────

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clip(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= MAX_APPEND_CHARS ? normalized : `${normalized.slice(0, MAX_APPEND_CHARS - 1)}…`;
}

let fallbackIdCounter = 0;
function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  fallbackIdCounter += 1;
  return `gambit-${Date.now().toString(36)}-${fallbackIdCounter}`;
}

/** 'verbatim' = an app phrase (template) handed to `speak`; 'brief' = a situation the model says in its own words */
type SayMode = 'verbatim' | 'brief';

interface PendingSpeak {
  eventId: string;
  mode: SayMode;
  /** the phrase (verbatim) or the brief */
  text: string;
  /** brief: what the fallback voice says if the model does not */
  fallbackText: string | null;
  sentAt: number;
  /** hard cap of this phrase (a teacher's longer brief gets more time, see TEACH_BRIEF_EXTRA_MS_PER_SENTENCE) */
  capMs: number;
  /** time spent waiting for the model to start while the child was NOT talking */
  waitedMs: number;
  startedAt: number | null;
  firstDeltaAt: number | null;
  lastDeltaAt: number | null;
  /** wall-clock time at which the transcript timeline says the speech ends */
  expectedEndAt: number | null;
  firstStartMs: number | null;
  transcript: string;
  settle(outcome: SpeakOutcome): void;
  done: Promise<SpeakOutcome>;
}

interface Segment {
  text: string;
  /**
   * the coach segment started while an app phrase was pending: it is that phrase, not a free answer. A verbatim phrase is
   * journaled by the game itself; the model's own words for a brief ARE reported (the journal gets what was really said).
   */
  sayMode: SayMode | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** when its first word arrived — overlapping utterances are reported in the order they STARTED */
  startedAt: number;
}

// ───────────────────────── protocol ─────────────────────────

export function createLiveProtocol(callbacks: LiveProtocolCallbacks, options: LiveProtocolOptions = {}): LiveProtocol {
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? defaultNewId;
  const silenceMs = options.silenceMs ?? 700;
  const speakCapMs = options.speakCapMs ?? 12_000;
  const startGraceMs = options.startGraceMs ?? 5000;
  const briefStartGraceMs = options.briefStartGraceMs ?? 6000;
  const briefSilenceMs = options.briefSilenceMs ?? 1100;
  const childWaitMs = options.childWaitMs ?? 6000;
  const conversationWaitMs = options.conversationWaitMs ?? 6000;
  const conversationQuietMs = options.conversationQuietMs ?? 1000;
  const delegationHoldMs = options.delegationHoldMs ?? 3500;
  const childSilenceMs = options.childSilenceMs ?? 1200;
  const segmentGapMs = options.segmentGapMs ?? 1200;
  const toolTimeoutMs = options.toolTimeoutMs ?? 2500;
  const questionWaitMs = options.questionWaitMs ?? 800;
  const questionSettleMs = options.questionSettleMs ?? 700;
  const questionSettleMaxMs = options.questionSettleMaxMs ?? 1800;
  const tickMs = options.tickMs ?? 100;
  const minSpeechMsPerChar = options.minSpeechMsPerChar ?? 50;

  let started = false;
  /** session.close was sent: errors about work cut short by the close are expected, not warnings */
  let closing = false;
  let startedWaiters: ((ok: boolean) => void)[] = [];
  let pending: PendingSpeak | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  // audio activity of the coach
  let audioKnown = false;
  let lastAudibleAt = -Infinity;
  let lastOutputDeltaAt = -Infinity;
  /** the model talking on its own (an answer to the child, a backchannel) — not an app phrase */
  let lastFreeTalkAt = -Infinity;
  let delegationHoldUntil = -Infinity;
  /** app phrases waiting for a gap in the conversation, and a counter that cancels them */
  let waitingSays = 0;
  let cancelGeneration = 0;
  /** ends every such wait at once (stop() must not leave a dropped phrase hanging until its timer) */
  let waitAborts: (() => void)[] = [];

  // the child
  let childSpeaking = false;
  let childTimer: ReturnType<typeof setTimeout> | null = null;
  let childWaiters: (() => void)[] = [];
  let lastChildText = '';
  let lastChildTextAt = -Infinity;
  /** the last input-transcript delta (the child's words still coming in) */
  let lastChildDeltaAt = -Infinity;
  let childTextWaiters: (() => void)[] = [];

  const segments: Record<'child' | 'coach', Segment> = {
    child: { text: '', sayMode: null, timer: null, startedAt: 0 },
    coach: { text: '', sayMode: null, timer: null, startedAt: 0 },
  };

  let thinking = false;
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  let ducked = false;
  let duckedAt = 0;
  /** when cancelOutput() last told the model to stop (the child's tap and the app's own stop come together) */
  let lastStopSentAt = -Infinity;
  let duckTimer: ReturnType<typeof setTimeout> | null = null;
  let inputMuted = false;
  let usageSeconds: number | null = null;
  let queuedContext: string[] = [];
  const ladder = createHintLadder();
  let lastHost: CoachToolHost | null = null;

  function send(event: LiveClientEvent): void {
    try {
      callbacks.send(event);
    } catch (error) {
      console.warn('[coach] live send failed', error instanceof Error ? error.message : error);
    }
  }

  function append(kind: 'commentary' | 'thinking' | 'instructions', content: string, delegationId: string | null = null): string {
    const eventId = newId();
    send({ type: `session.${kind}.append`, event_id: eventId, delegation_id: delegationId, content: clip(content) });
    return eventId;
  }

  // ───────── small state setters ─────────

  function setThinking(next: boolean): void {
    if (thinkingTimer !== null) {
      clearTimeout(thinkingTimer);
      thinkingTimer = null;
    }
    if (thinking === next) return;
    thinking = next;
    callbacks.onThinking(next);
  }

  function setDucked(next: boolean): void {
    if (duckTimer !== null) {
      clearTimeout(duckTimer);
      duckTimer = null;
    }
    if (ducked === next) return;
    ducked = next;
    duckedAt = now();
    callbacks.onDuck?.(next);
    // never leave the playback muted: the instruction normally silences the model well within this time
    if (next) duckTimer = setTimeout(() => setDucked(false), 1500);
  }

  function setChildSpeaking(next: boolean): void {
    if (childSpeaking === next) return;
    childSpeaking = next;
    callbacks.onChildSpeaking(next);
    if (!next) {
      const waiters = childWaiters;
      childWaiters = [];
      for (const waiter of waiters) waiter();
    }
  }

  /** the child is talking, or the model is (about to be) answering the child */
  function conversationBusy(): boolean {
    const t = now();
    return childSpeaking || thinking || t < delegationHoldUntil || t - lastFreeTalkAt < conversationQuietMs;
  }

  function whenConversationQuiet(maxWaitMs: number): Promise<void> {
    if (!conversationBusy()) return Promise.resolve();
    const deadline = now() + maxWaitMs;
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearInterval(timer);
        waitAborts = waitAborts.filter((abort) => abort !== finish);
        resolve();
      };
      const timer = setInterval(() => {
        if (!conversationBusy() || now() >= deadline) finish();
      }, tickMs);
      waitAborts.push(finish);
    });
  }

  /** whenChildSilent that stop() can end early */
  function whenChildSilentOrStopped(maxWaitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        waitAborts = waitAborts.filter((abort) => abort !== finish);
        resolve();
      };
      waitAborts.push(finish);
      void whenChildSilent(maxWaitMs).then(finish);
    });
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

  // ───────── transcripts ─────────

  function flushSegment(who: 'child' | 'coach'): void {
    const segment = segments[who];
    // the other side's utterance began earlier and is still open: it goes first (the question before its answer)
    const other = segments[who === 'child' ? 'coach' : 'child'];
    if (segment.text !== '' && other.text !== '' && other.startedAt < segment.startedAt) flushSegment(who === 'child' ? 'coach' : 'child');
    if (segment.timer !== null) {
      clearTimeout(segment.timer);
      segment.timer = null;
    }
    const text = segment.text.replace(/\s+/g, ' ').trim();
    const sayMode = segment.sayMode;
    segment.text = '';
    segment.sayMode = null;
    if (text === '') return;
    // gpt-live-1 transcribes a sound without words (a breath, a chosen silence) as «...»: nothing to show or journal
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    if (who === 'child') {
      lastChildText = text;
      lastChildTextAt = now();
    }
    // a verbatim app phrase is journaled by the game itself; the model's own words (answers, briefs) are reported
    if (!(who === 'coach' && sayMode === 'verbatim')) callbacks.onTranscript(who, text);
  }

  function onTranscriptDelta(who: 'child' | 'coach', raw: Json): void {
    const delta = str(raw.delta);
    if (!delta) return;
    // Each side keeps its own utterance until ITS pause: full duplex means overlap (flushing the
    // other side on every delta would chop «Привет, Гамбитик. Как дела» into «Привет, Гам» / «бит» / «ик. Как» / «дела»).

    const segment = segments[who];
    if (segment.text === '') {
      segment.startedAt = now();
      if (who === 'coach') segment.sayMode = pending?.mode ?? null;
    }
    segment.text += delta;
    if (segment.timer !== null) clearTimeout(segment.timer);
    segment.timer = setTimeout(() => flushSegment(who), segmentGapMs);

    const t = now();
    if (who === 'child') {
      lastChildDeltaAt = t;
      setChildSpeaking(true);
      if (childTimer !== null) clearTimeout(childTimer);
      childTimer = setTimeout(() => {
        childTimer = null;
        setChildSpeaking(false);
      }, childSilenceMs);
      const waiters = childTextWaiters;
      childTextWaiters = [];
      for (const waiter of waiters) waiter();
      return;
    }

    // the coach
    lastOutputDeltaAt = t;
    if (pending === null) lastFreeTalkAt = t;
    setThinking(false);
    // new words after the stop instruction was delivered belong to new speech: let it be heard
    if (ducked && t - duckedAt > 400) setDucked(false);
    const entry = pending;
    if (entry) {
      entry.startedAt ??= t;
      entry.firstDeltaAt ??= t;
      entry.lastDeltaAt = t;
      entry.transcript += delta;
      const startMs = num(raw.start_ms);
      const endMs = num(raw.end_ms);
      if (startMs !== null && endMs !== null && endMs >= startMs) {
        entry.firstStartMs ??= startMs;
        entry.expectedEndAt = entry.firstDeltaAt + (endMs - entry.firstStartMs);
      }
      // the bubble shows the model's own words as they come (a wordless «...» is not a caption)
      const words = entry.transcript.replace(/\s+/g, ' ').trim();
      if (entry.mode === 'brief' && /[\p{L}\p{N}]/u.test(words)) callbacks.onSayProgress?.({ type: 'caption', text: words });
    } else if (segment.sayMode === null) {
      const words = segment.text.replace(/\s+/g, ' ').trim();
      if (/[\p{L}\p{N}]/u.test(words)) callbacks.onCoachTranscriptDelta?.(words);
    }
  }

  // ───────── speak() completion heuristic ─────────

  function stopTicker(): void {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function evaluate(entry: PendingSpeak): void {
    const t = now();
    const brief = entry.mode === 'brief';
    if (t - entry.sentAt >= entry.capMs) {
      entry.settle(entry.startedAt !== null ? 'spoken' : 'failed');
      return;
    }
    if (entry.startedAt === null) {
      // the model rightly holds an appended phrase back while the child is talking
      if (!childSpeaking) entry.waitedMs += tickMs;
      if (entry.waitedMs >= (brief ? briefStartGraceMs : startGraceMs)) entry.settle('failed');
      return;
    }
    // A pause between two sentences is not the end: the whole phrase needs at least this long. The words of a brief are
    // the model's own — how many is unknown — so only a short minimum applies, and a longer silence ends it.
    const expectedChars = brief ? Math.min(entry.text.length, 40) : entry.text.length;
    const longEnough = t - entry.startedAt >= expectedChars * minSpeechMsPerChar;
    const quietNeeded = brief ? briefSilenceMs : silenceMs;
    if (audioKnown) {
      const quietFor = t - Math.max(lastAudibleAt, entry.startedAt);
      if (quietFor < quietNeeded) return;
      // a natural pause between two sentences: the transcript timeline says there is more to come
      const timelineDone = entry.expectedEndAt === null || t >= entry.expectedEndAt - 200;
      if ((timelineDone && longEnough) || quietFor >= silenceMs + 1800) entry.settle('spoken');
      return;
    }
    // deaf analyser: the transcript is all we have
    if (entry.firstDeltaAt === null || entry.lastDeltaAt === null) return;
    // words usually arrive a little ahead of the sound: leave a small margin after the announced end
    const endByTimeline = (entry.expectedEndAt ?? entry.firstDeltaAt + estimateSpeechMs(entry.transcript, 65)) + 300;
    const wordsStoppedFor = t - entry.lastDeltaAt;
    if (wordsStoppedFor >= quietNeeded && t >= endByTimeline && (longEnough || wordsStoppedFor >= silenceMs + 1800)) entry.settle('spoken');
  }

  async function say(mode: SayMode, text: string, opts?: BriefSpeakOptions): Promise<SpeakOutcome> {
    const phrase = text.replace(/\s+/g, ' ').trim();
    if (phrase === '') return 'spoken';
    const urgent = opts?.interrupt === true;
    // teacher mode: the phrase's own sentence budget replaces the frame's «одно–два предложения»
    const frame = opts?.maxSentences !== undefined ? { maxSentences: opts.maxSentences } : undefined;
    const fallbackText = opts?.fallbackText?.replace(/\s+/g, ' ').trim() || null;

    if (pending && urgent) pending.settle('interrupted');
    if (!urgent) {
      // never into the middle of a conversation: first the child finishes, then the model's answer to the child
      const generation = cancelGeneration;
      waitingSays += 1;
      try {
        await whenChildSilentOrStopped(childWaitMs);
        if (generation === cancelGeneration) await whenConversationQuiet(conversationWaitMs);
      } finally {
        waitingSays -= 1;
      }
      // stopped while waiting (stop(), the controller's time cap, an urgent phrase): it is not said at all
      if (generation !== cancelGeneration) return 'interrupted';
    }
    while (pending) await pending.done;
    if (!started) return 'failed';

    let resolveDone: (outcome: SpeakOutcome) => void = () => undefined;
    const done = new Promise<SpeakOutcome>((resolve) => {
      resolveDone = resolve;
    });
    const entry: PendingSpeak = {
      eventId: '',
      mode,
      text: phrase,
      fallbackText,
      sentAt: now(),
      // a teacher's full / concept phrase (up to four / five sentences) may run past the ordinary cap
      capMs: mode === 'brief' ? speakCapMs + 2000 + Math.max(0, (opts?.maxSentences ?? 3) - 3) * TEACH_BRIEF_EXTRA_MS_PER_SENTENCE : speakCapMs,
      waitedMs: 0,
      startedAt: null,
      firstDeltaAt: null,
      lastDeltaAt: null,
      expectedEndAt: null,
      firstStartMs: null,
      transcript: '',
      done,
      settle(outcome) {
        if (pending !== entry) return;
        pending = null;
        stopTicker();
        // context notes held back while the phrase was being said go out now — before the next phrase
        if (started) for (const note of queuedContext.splice(0)) append('thinking', note);
        // the fallback voice says a failed verbatim phrase now — the model must not repeat it a moment later. A brief
        // that the model did not start is NOT re-voiced during a live session (the bubble shows it): if the model gets to
        // it late, in its own words, that is fine.
        if (outcome === 'failed' && started && entry.mode === 'verbatim') append('thinking', buildAlreadySaidNote(entry.text));
        resolveDone(outcome);
      },
    };
    pending = entry;
    // an urgent phrase cuts in on speech that nobody stopped yet (a stop that was just sent is enough)
    const cutIn = urgent && !ducked && outputActive();
    setDucked(false);
    probeVoice('say', { text: phrase, urgent, mode });
    entry.done.then((outcome) => probeVoice('say.done', { outcome, mode, heard: entry.transcript.trim() }), () => undefined);
    // a trusted instruction is the one event that may cut into speech in progress; commentary waits its turn
    if (mode === 'brief') {
      // urgent: whatever he is saying now is cut (one-time stop), then the situation goes in as commentary at once
      if (cutIn) {
        setDucked(true);
        append('instructions', LIVE_STOP_INSTRUCTION_RU);
      }
      // the brief keeps its lines here: fitBrief shortens a long one by its FACTS only when it can still see the
      // «Факты:» / «Цель:» / «Нельзя:» lines (a flattened brief could only be cut hard, losing «Нельзя»)
      const brief = text.trim();
      entry.eventId = append('commentary', urgent ? buildUrgentBriefCommentary(brief, frame) : buildBriefCommentary(brief, frame));
      callbacks.onSayProgress?.({ type: 'sent' });
    } else {
      if (cutIn) {
        setDucked(true);
        append('instructions', LIVE_STOP_INSTRUCTION_RU);
      }
      entry.eventId = append('commentary', urgent ? buildUrgentSayCommentary(phrase) : phrase);
    }
    ticker = setInterval(() => evaluate(entry), tickMs);
    return done;
  }

  function cancelOutput(): void {
    // a phrase that is still waiting for the conversation to end is simply dropped — and the model's answer to the
    // child it was waiting for is NOT cut off
    const onlyWaiting = pending === null && waitingSays > 0;
    cancelGeneration += 1;
    for (const abort of waitAborts.slice()) abort();
    const wasTalking = pending !== null || (!onlyWaiting && outputActive());
    pending?.settle('interrupted');
    if (!started || !wasTalking) return;
    setDucked(true);
    // one stop is enough: a second one a moment later (a tap = the controller's stop + the session's cut) only adds noise
    if (now() - lastStopSentAt < 1000) return;
    lastStopSentAt = now();
    append('instructions', LIVE_STOP_INSTRUCTION_RU);
  }

  function outputActive(): boolean {
    const t = now();
    return audioKnown ? t - lastAudibleAt < 300 : t - lastOutputDeltaAt < 1500;
  }

  // ───────── client delegation ─────────

  function recentChildQuestion(): string {
    const open = segments.child.text.replace(/\s+/g, ' ').trim();
    if (open !== '') return open;
    return now() - lastChildTextAt < 15_000 ? lastChildText : '';
  }

  function waitForChildText(maxWaitMs: number): Promise<void> {
    if (recentChildQuestion() !== '') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, maxWaitMs);
      childTextWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** the child's sentence is complete: no new word for `questionSettleMs` (bounded) */
  function whenChildWordsSettled(): Promise<void> {
    const deadline = now() + questionSettleMaxMs;
    const settled = (): boolean => now() - lastChildDeltaAt >= questionSettleMs || now() >= deadline;
    if (settled()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!settled()) return;
        clearInterval(timer);
        resolve();
      }, Math.max(20, Math.min(tickMs, 100)));
    });
  }

  /** the FACTS that answer the child — the model phrases them («answer in your own words, only from these facts») */
  async function answerFor(request: ChildRequest, host: CoachToolHost): Promise<string> {
    if (host !== lastHost) {
      lastHost = host;
      ladder.reset();
    }
    switch (request.intent) {
      case 'hint': {
        // the ladder is enforced here, not by the prompt: never more than one step above the last hint
        const { event, level } = await withTimeout(ladder.give(host, request.level), toolTimeoutMs * 2);
        callbacks.onToolCoachEvent(event);
        return buildFactsAnswer(hintFacts(event, level));
      }
      case 'explain': {
        const event = await withTimeout(host.explainLastMove(), toolTimeoutMs);
        if (!event) return buildFactsAnswer(NOTHING_TO_EXPLAIN_FACTS_RU);
        callbacks.onToolCoachEvent(event);
        return buildFactsAnswer(explainFacts(event));
      }
      case 'evaluate': {
        const { understood, facts } = await moveFacts(host, request.move, toolTimeoutMs);
        return understood ? buildFactsAnswer(`Про ход, о котором спросил ребёнок: ${facts}`) : CLARIFY_MOVE_FACTS_RU;
      }
      case 'more': {
        // teacher mode: a third candidate within tolerance (the game decides); no advice here → the next hint step
        const advice = host.repeatAdvice ? await withTimeout(host.repeatAdvice({ more: true }), toolTimeoutMs) : null;
        if (advice) {
          callbacks.onToolCoachEvent(advice);
          return buildFactsAnswer(hintFacts(advice, 4));
        }
        const { event, level } = await withTimeout(ladder.give(host, null), toolTimeoutMs * 2);
        callbacks.onToolCoachEvent(event);
        return buildFactsAnswer(hintFacts(event, level));
      }
      case 'whyNot': {
        // compareMove (teacher: the move against the advice) — an older game falls back to evaluateMove
        const { understood, facts } = await compareFacts(host, { move: request.move, piece: request.piece }, toolTimeoutMs);
        return understood ? buildFactsAnswer(whyNotFacts(facts)) : facts;
      }
      case 'position':
        return buildFactsAnswer(`Факты о позиции: ${await positionFacts(host, toolTimeoutMs)}`);
    }
  }

  async function handleDelegation(delegationId: string): Promise<void> {
    setThinking(true);
    let answer: string;
    let question = '';
    let intent = 'none';
    try {
      await waitForChildText(questionWaitMs);
      await whenChildWordsSettled();
      const host = callbacks.getToolHost();
      question = recentChildQuestion();
      const request = classifyChildRequest(question);
      intent = host ? request.intent : 'no-game';
      answer = host ? await answerFor(request, host) : NO_GAME_FACTS_RU;
    } catch (error) {
      console.warn('[coach] live delegation failed', error instanceof Error ? error.message : error);
      answer = TOOL_FAILED_FACTS_RU;
    }
    if (!started) {
      setThinking(false);
      return;
    }
    probeVoice('delegation', { question, intent, answer });
    append('commentary', answer, delegationId);
    // the model says the answer next: app phrases wait for it (audio extends this through lastFreeTalkAt)
    delegationHoldUntil = now() + delegationHoldMs;
    // the spoken answer ends the thinking pose; this is only the safety net
    thinkingTimer = setTimeout(() => setThinking(false), 6000);
  }

  // ───────── server events ─────────

  function onStarted(): void {
    if (started) return;
    started = true;
    append('instructions', LIVE_SAY_POLICY_RU);
    if (inputMuted) send({ type: 'session.input_audio.mute', event_id: newId() });
    for (const note of queuedContext.splice(0)) append('thinking', note);
    const waiters = startedWaiters;
    startedWaiters = [];
    for (const waiter of waiters) waiter(true);
    callbacks.onSessionStarted?.();
  }

  function handleServerEvent(raw: unknown): void {
    if (!isRecord(raw)) return;
    const type = str(raw.type);
    if (!type) return;

    switch (type) {
      case 'session.started':
        onStarted();
        break;
      case 'session.input_transcript.delta':
        onTranscriptDelta('child', raw);
        break;
      case 'session.output_transcript.delta':
        onTranscriptDelta('coach', raw);
        break;
      case 'session.delegation.created': {
        const delegation = isRecord(raw.delegation) ? raw.delegation : {};
        const id = str(delegation.id);
        const target = str(delegation.target);
        // 'responses' delegations are answered by OpenAI's backend, not by us
        if (id && (target === null || target === 'client')) void handleDelegation(id);
        break;
      }
      case 'session.usage.updated': {
        const usage = isRecord(raw.usage) ? raw.usage : {};
        usageSeconds = num(usage.seconds) ?? usageSeconds;
        break;
      }
      case 'session.closed': {
        const usage = isRecord(raw.usage) ? raw.usage : {};
        usageSeconds = num(usage.seconds) ?? usageSeconds;
        callbacks.onSessionClosed?.(str(raw.reason) ?? 'unknown');
        break;
      }
      case 'error': {
        const error = isRecord(raw.error) ? raw.error : {};
        const code = str(error.code) ?? str(error.type) ?? 'unknown';
        // never log the whole event: keep the console free of anything sensitive. After our own session.close the
        // API may still report work it did not finish (e.g. context_injection_incomplete) — not a fault.
        if (closing) console.info('[coach] live error after close:', code);
        else console.warn('[coach] live error:', code);
        const about = str(raw.client_event_id) ?? str(error.client_event_id) ?? str(error.event_id);
        if (pending && about !== null && about === pending.eventId) pending.settle('failed');
        setThinking(false);
        break;
      }
      default:
        // acknowledgements (*.appended, muted/unmuted, updated), info, response.event, transport.*: nothing to do
        break;
    }
  }

  function noteOutputLevel(audible: boolean | null): void {
    if (audible === null) {
      audioKnown = false;
      return;
    }
    audioKnown = true;
    const t = now();
    if (audible) {
      lastAudibleAt = t;
      if (pending === null) lastFreeTalkAt = t;
      if (pending && pending.startedAt === null && t - pending.sentAt >= 100) pending.startedAt = t;
    } else if (ducked && t - lastAudibleAt >= 250 && t - duckedAt >= 250) {
      // the interrupted speech has died down: open the playback again
      setDucked(false);
    }
  }

  return {
    handleServerEvent,
    noteOutputLevel,
    speak: (text, opts) => say('verbatim', text, opts),
    speakBrief: (brief, opts) => say('brief', brief, opts),
    cancelOutput,
    pushContext(note) {
      const text = note.replace(/\s+/g, ' ').trim() === '' ? '' : clip(buildContextNote(note));
      if (text === '') return;
      // Notes appended while the model is about to say an app phrase can replace that phrase
      // («Ничего у тебя сейчас не под боем» instead of the greeting). So a note never lands in the middle of one.
      if (started && pending === null) append('thinking', text);
      else queuedContext = [...queuedContext, text].slice(-3);
    },
    setInputMuted(muted) {
      if (inputMuted === muted) return;
      inputMuted = muted;
      if (started) send({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute', event_id: newId() });
    },
    whenStarted(timeoutMs) {
      if (started) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        startedWaiters.push((ok) => {
          clearTimeout(timer);
          resolve(ok);
        });
      });
    },
    requestClose() {
      if (!started) return;
      closing = true;
      send({ type: 'session.close', event_id: newId() });
    },
    reset() {
      started = false;
      closing = false;
      const waiters = startedWaiters;
      startedWaiters = [];
      for (const waiter of waiters) waiter(false);
      // half-said phrases are not repeated by the fallback voice, unsaid ones are
      pending?.settle(pending.startedAt !== null ? 'interrupted' : 'failed');
      stopTicker();
      for (const who of ['child', 'coach'] as const) flushSegment(who);
      if (childTimer !== null) clearTimeout(childTimer);
      childTimer = null;
      setChildSpeaking(false);
      for (const waiter of childTextWaiters.splice(0)) waiter();
      setThinking(false);
      setDucked(false);
      queuedContext = [];
      ladder.reset();
      lastFreeTalkAt = -Infinity;
      delegationHoldUntil = -Infinity;
    },
    get started() {
      return started;
    },
    get outputActive() {
      return outputActive();
    },
    get childSpeaking() {
      return childSpeaking;
    },
    get usageSeconds() {
      return usageSeconds;
    },
  };
}
