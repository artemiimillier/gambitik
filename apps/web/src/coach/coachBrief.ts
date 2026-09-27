/**
 * The Russian texts that hand a SITUATION (not a script) to a conversational voice model — shared by the Live and the
 * Realtime layer. The app decides WHAT is true and WHAT the moment needs (engine facts, goal); the model decides HOW
 * to say it: its own words, one or two short sentences (a teacher's phrase carries its own budget: short 1, otherwise
 * 2 — short and clear, not too talkative), different every time, every fact exact,
 * nothing the child already sees (the clock, the colours, whose turn it is).
 *
 * Docs (live-delegation): «Give GPT-Live the relevant facts and let it choose how to say them»;
 * `session.commentary.append` «is trained to paraphrase the text». Everything here is Russian without Latin letters
 * (language drift, research 03 §6).
 */
import type { CoachEvent, HintLevel, PieceType, TeachSummary } from '@gambit/shared';

/**
 * What the child sees anyway and must never hear read out (e.g. «у тебя осталось четыре минуты пятьдесят девять
 * секунд, у него четыре минуты» while his clock runs). No digits: the model reads it.
 */
export const NO_OBVIOUS_RU = 'не пересказывай очевидное — время на часах, цвет фигур, чей ход и то, что и так видно на доске';

/** How every brief / tool answer must be spoken. Deliberately NOT «verbatim» and NOT «close to the text». */
export const OWN_WORDS_RULE_RU =
  `Скажи это своими словами: одно–два коротких предложения, живо и тепло, как весёлый старший друг; ${NO_OBVIOUS_RU}. ` +
  'Каждый раз говори по-новому, не повторяй прошлые фразы. Все факты передай точно и ничего не добавляй от себя — ни ходов, ни клеток, ни угроз, которых здесь нет.';

/**
 * Longest `content` of one Live append. The documented limit is 500 tokens; Russian text runs at ≈ 3.5–4 characters per
 * token with the o200k tokenizer, so 1200 characters stay near 300–350 tokens. A take-back brief — up to 1100
 * characters — plus its frame must fit without losing its «Цель»/«Нельзя» lines to the clip.
 */
export const LIVE_APPEND_MAX_CHARS = 1200;

const COMMENTARY_FRAME_RU = `Сейчас скажи ребёнку своими словами, коротко — одно–два предложения; ${NO_OBVIOUS_RU}. Не зачитывай это дословно: факты передай точно, ничего не добавляй от себя. Ситуация: `;
/**
 * An urgent brief sent as `session.instructions.append` («Срочно… потом замолчи и слушай») is acknowledged but NEVER
 * spoken — and since instructions stay in the session for good, the model would keep silent on later briefs too. An urgent brief is therefore COMMENTARY with an urgent frame (no «замолчи»).
 */
const URGENT_FRAME_RU = `Важный момент — скажи ребёнку сразу, как только сможешь, своими словами одно–два коротких предложения; ${NO_OBVIOUS_RU}; факты передай точно, ничего не добавляй от себя. Ситуация: `;

/**
 * A brief that must fit `maxChars` loses FACTS first — whole sentences from the end of the «Факты:» line — and never its
 * «Момент», «Можно назвать» (teacher mode: the only moves the model may name), «Цель» or «Нельзя» lines (what not to say
 * is the safety part). Only a brief whose other lines alone are too long is cut hard. Returns one line.
 */
export function fitBrief(brief: string, maxChars: number): string {
  const whole = oneLine(brief);
  if (whole.length <= maxChars) return whole;
  const lines = brief
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
  const factsIndex = lines.findIndex((line) => line.startsWith('Факты:'));
  const join = (parts: readonly string[]): string => oneLine(parts.join(' '));
  if (factsIndex >= 0) {
    const sentences = (lines[factsIndex] ?? '').slice('Факты:'.length).trim().split(/(?<=[.!?…])\s+/u).filter((s) => s !== '');
    while (sentences.length > 1) {
      sentences.pop();
      const candidate = join(lines.map((line, i) => (i === factsIndex ? `Факты: ${sentences.join(' ')}` : line)));
      if (candidate.length <= maxChars) return candidate;
    }
    const withoutFacts = join(lines.filter((_, i) => i !== factsIndex));
    const room = maxChars - withoutFacts.length - ' Факты: '.length - 1;
    if (room >= 40) {
      const first = sentences[0] ?? '';
      const cut = first.length <= room ? first : `${first.slice(0, room - 1).trimEnd()}…`;
      return join(lines.map((line, i) => (i === factsIndex ? `Факты: ${cut}` : line)));
    }
    if (withoutFacts.length <= maxChars) return withoutFacts;
  }
  return `${whole.slice(0, maxChars - 1).trimEnd()}…`;
}

// ───────────────────────── how long a phrase may be (teacher mode) ─────────────────────────

/**
 * Teacher mode: the length of a teacher's phrase comes from its style — `short` = one sentence, every other one = at
 * most TWO short sentences, the strategy intro and a new topic included — short and clear: the start is ONE line («В этот раз разыграем … Начни …»), a move is one or two
 * sentences (≤ 25 words) — the move and why it serves the plan.
 */
export const TEACH_MAX_SENTENCES: Readonly<Record<TeachSummary['style'], number>> = { short: 1, full: 2, concept: 2 };

/** The sentence budget of an event for the voice model: only teacher phrases (`event.teach`) carry one. */
export function teachMaxSentences(event: Pick<CoachEvent, 'teach'>): number | undefined {
  return event.teach ? TEACH_MAX_SENTENCES[event.teach.style] : undefined;
}

/** «одно короткое предложение» … «до пяти коротких предложений» (Russian, no digits: the model reads it). */
export function sentenceBudgetRu(maxSentences: number): string {
  const n = Math.max(1, Math.min(5, Math.round(maxSentences)));
  switch (n) {
    case 1:
      return 'одно короткое предложение';
    case 2:
      return 'одно–два коротких предложения';
    case 3:
      return 'одно–три коротких предложения';
    case 4:
      return 'до четырёх коротких предложений';
    default:
      return 'до пяти коротких предложений';
  }
}

/**
 * The teacher's word cap in the frame (Russian words, no digits). The live model keeps the sentence count but may
 * stretch a sentence to 30 words; the budget is ≤ 25 words, so the frame asks for less.
 */
export function wordCapRu(maxSentences: number): string {
  return Math.round(maxSentences) <= 1 ? 'всего не больше пятнадцати слов' : 'всего не больше двадцати слов';
}

/** The live model tends to end teacher lines with «Какой ход выберешь?» even when the brief did not ask for it. */
export const NO_EXTRA_QUESTION_RU = 'вопрос задай, только если его просит «Цель»';

/**
 * What gpt-live-1 adds past the budget is nearly always something the brief ALSO carried — the opponent's move, an
 * approval, a topic, a question. The briefs therefore carry less (the move + one reason
 * + at most one extra) and list what not to add («Нельзя: … ни хода соперника, ни похвалы …»); the frame says it outright
 * too: only what «Цель» asks, nothing of its own.
 */
export const ONLY_THE_GOAL_RU = 'скажи только то, что просит «Цель», — ничего от себя';

/**
 * A teacher's remark leads with its point (in a fast 5-minute game the child often moves while Гамбитик is still
 * talking). Cut after its first words, it has still said the move and why. Not in the urgent
 * frame: an urgent phrase is never cut by the child's move.
 */
export const MAIN_FIRST_RU = 'начни с главного';

/**
 * The closing line of a teacher's frame — the hard cap once more AFTER the situation («не больше 20 слов, одна-две
 * фразы, ничего не добавляй от себя»; no digits: the model reads it). The Live API has no output-length
 * control for the spoken model (`max_output_tokens` / `verbosity` exist only for the Responses
 * delegation backend), so the words are the only lever.
 */
export function teachTailRu(maxSentences: number): string {
  return Math.round(maxSentences) <= 1 ? ' Помни: не больше пятнадцати слов, одна фраза, ничего не добавляй от себя.' : ' Помни: не больше двадцати слов, одна-две фразы, ничего не добавляй от себя.';
}

export interface BriefFrameOptions {
  /** teacher mode: the phrase's sentence budget (see TEACH_MAX_SENTENCES); absent = the ordinary one or two */
  maxSentences?: number;
}

function commentaryFrame(opts?: BriefFrameOptions): string {
  if (opts?.maxSentences === undefined) return COMMENTARY_FRAME_RU;
  // (the budget already says «коротких» — the room goes to MAIN_FIRST_RU; a full teacher brief still fits whole)
  return `Сейчас скажи ребёнку своими словами ${sentenceBudgetRu(opts.maxSentences)}, не больше; ${wordCapRu(opts.maxSentences)}; ${NO_OBVIOUS_RU}; ${ONLY_THE_GOAL_RU}; ${MAIN_FIRST_RU}. Не зачитывай это дословно: факты передай точно. Ситуация: `;
}

function urgentFrame(opts?: BriefFrameOptions): string {
  if (opts?.maxSentences === undefined) return URGENT_FRAME_RU;
  return `Важный момент — скажи ребёнку сразу, как только сможешь, своими словами ${sentenceBudgetRu(opts.maxSentences)}, не больше; ${wordCapRu(opts.maxSentences)}; ${NO_OBVIOUS_RU}; факты передай точно, ${ONLY_THE_GOAL_RU}. Ситуация: `;
}

function frameTail(opts?: BriefFrameOptions): string {
  return opts?.maxSentences === undefined ? '' : teachTailRu(opts.maxSentences);
}

/**
 * Live, normal moment: `session.commentary.append` (waits for a gap in the conversation). The frame is short and comes
 * FIRST, the situation last; a long situation is shortened by its facts (fitBrief), never by what must not be said.
 * `maxSentences` (teacher mode) replaces the frame's «одно–два предложения» with the phrase's own budget.
 */
export function buildBriefCommentary(brief: string, opts?: BriefFrameOptions): string {
  const frame = commentaryFrame(opts);
  const tail = frameTail(opts);
  return `${frame}${fitBrief(brief, LIVE_APPEND_MAX_CHARS - frame.length - tail.length)}${tail}`;
}

/** Live, urgent moment (take-back offer, end of the game): `session.commentary.append` sent at once, without waiting for a gap. */
export function buildUrgentBriefCommentary(brief: string, opts?: BriefFrameOptions): string {
  const frame = urgentFrame(opts);
  const tail = frameTail(opts);
  return `${frame}${fitBrief(brief, LIVE_APPEND_MAX_CHARS - frame.length - tail.length)}${tail}`;
}

/** Realtime: the system item that carries the situation (followed by a `response.create`). */
export function buildBriefItem(brief: string): string {
  return `[Ситуация в партии — скажи о ней ребёнку своими словами] ${oneLine(brief)}`;
}

/** Realtime: per-response instructions of a brief. */
export const BRIEF_RESPONSE_INSTRUCTIONS_RU =
  `Отреагируй на последнюю «Ситуацию в партии» от приложения: скажи ребёнку о ней по-русски своими словами, одно–два коротких предложения, живо и тепло, как весёлый старший друг; ${NO_OBVIOUS_RU}. ` +
  'Не зачитывай сообщение и не повторяй прошлые фразы. Все факты передай точно, ничего не добавляй от себя: ни ходов, ни клеток, ни угроз, которых там нет. Если сказано чего-то не называть — не называй.';

/** Realtime: per-response instructions of a brief with the phrase's own sentence budget (teacher mode). */
export function briefResponseInstructions(opts?: BriefFrameOptions): string {
  if (opts?.maxSentences === undefined) return BRIEF_RESPONSE_INSTRUCTIONS_RU;
  return `${BRIEF_RESPONSE_INSTRUCTIONS_RU.replace('одно–два коротких предложения', `${sentenceBudgetRu(opts.maxSentences)}, не больше`)} ${capFirst(ONLY_THE_GOAL_RU)}; ${MAIN_FIRST_RU}.${teachTailRu(opts.maxSentences)}`;
}

function capFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Live client delegation: the engine facts that answer the child's question, for the model to phrase. */
export function buildFactsAnswer(facts: string): string {
  return `Ответь ребёнку своими словами, опираясь только на эти факты. Одно–два коротких предложения, на «ты»; слова «движок» и «ребёнок» не говори; ${NO_OBVIOUS_RU}; ничего не добавляй от себя. Факты: ${oneLine(facts)}`;
}

/**
 * The teacher's advice came back for a hint request (teacher mode: `getHint` → a `teachTurn`, docs/TEACHER-MODE.md
 * §1.4, §7.1): the moves of its «Можно назвать» line may be named — there is no ladder, and no step caveat.
 */
export function isTeacherAdvice(event: Pick<CoachEvent, 'kind'>): boolean {
  return event.kind === 'teachTurn';
}

/**
 * Facts of a hint of the ladder — below step 4 the model must not name the move or the target square. A teacher's
 * advice (`teachTurn`) is not a ladder step: its «Можно назвать» moves may be named (unless it is a «treasure» the child
 * should find first).
 */
export function hintFacts(event: CoachEvent, level: HintLevel): string {
  const facts = oneLine(event.brief ?? event.text);
  if (isTeacherAdvice(event)) {
    return event.teach?.reveal === 'later'
      ? `Совет учителя: ${facts} Тут подарок — ход и клетку, куда идти, не называй: пусть ребёнок найдёт сам.`
      : `Совет учителя, ребёнок попросил его ещё раз: ${facts} Ходы из строки «Можно назвать» называть можно — это совет, а выбирает ход сам ребёнок.`;
  }
  return level < 4
    ? `Подсказка ступени ${level} из четырёх: ${facts} На этой ступени не называй ни ход, ни клетку, куда идти, — пусть ребёнок найдёт сам.`
    : `Подсказка четвёртой, последней ступени — теперь ход можно назвать: ${facts}`;
}

// ───────────────────────── «а почему не ферзём?» ─────────────────────────

const PIECE_INSTRUMENTAL_RU: Readonly<Record<PieceType, string>> = {
  p: 'пешкой',
  n: 'конём',
  b: 'слоном',
  r: 'ладьёй',
  q: 'ферзём',
  k: 'королём',
};

/** «а почему не конём?» without a square, and the game cannot pick the piece's move itself: ask where to. */
export function clarifyPieceMoveFacts(piece: PieceType): string {
  return `Ребёнок спросил про ход ${PIECE_INSTRUMENTAL_RU[piece]}, но куда именно — непонятно. Коротко переспроси, на какую клетку он хочет пойти. Сам ход не угадывай и не оценивай.`;
}

/** Live delegation: the facts of a comparison with the advice (`CoachToolHost.compareMove` / `evaluateMove`). */
export function whyNotFacts(facts: string): string {
  return `Ребёнок спросил про свой вариант хода — сравни его с советом. Факты: ${oneLine(facts)} Объясни честно и по-доброму, без слова «ошибка»; ходы называй только те, что есть в этих фактах.`;
}

export function explainFacts(event: CoachEvent): string {
  return `Разбор последнего хода: ${oneLine(event.brief ?? event.text)} Скажи главное: что случилось и что можно было сделать иначе. Не стыди.`;
}

export const NOTHING_TO_EXPLAIN_FACTS_RU = 'Последний ход нормальный, ничего плохого он не теряет. Можно играть дальше.';
export const NO_GAME_FACTS_RU = 'Сейчас партия не идёт, поэтому про позицию и ходы сказать нечего. Предложи сыграть — во время игры ты поможешь.';
export const TOOL_FAILED_FACTS_RU = 'Посмотреть позицию сейчас не получилось. Честно скажи, что не успел, и попроси спросить ещё раз. Ничего не выдумывай.';
export const CLARIFY_MOVE_FACTS_RU =
  'Ребёнок спросил про какой-то ход, но какой именно — непонятно. Коротко переспроси: какой фигурой и на какую клетку он хочет пойти? Сам ход не угадывай и не оценивай.';

/** The long-silence nudge (design D): one gentle word after ≥ 60 s of silent thinking, never a move. */
export const SILENCE_NUDGE_BRIEF_RU =
  'Ребёнок давно молча думает над ходом. Мягко и коротко подбодри: торопиться не нужно. Можно предложить подумать вместе — что хочет соперник — или попросить подсказку. Ход и клетки не называй, про время и часы не говори.';
export const SILENCE_NUDGE_TEXT_RU = 'Думай спокойно, я рядом. Хочешь — подумаем вместе?';

/** «Поговорить» pressed outside the auto-start: a short hello so the child knows he is listening. */
export const CONVERSATION_HELLO_BRIEF_RU =
  'Ребёнок только что нажал кнопку «Поговорить». Коротко и тепло скажи, что слушаешь, и спроси, о чём поговорим или помочь ли с партией. Одно-два предложения.';
export const CONVERSATION_HELLO_TEXT_RU = 'Я тебя слушаю! О чём поговорим?';

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t === '' || /[.!?…»]$/.test(t) ? t : `${t}.`;
}
