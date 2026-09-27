/**
 * Markdown journal of one game — written for a parent and for an LLM:
 * header table, move list in Russian notation with quality marks, timeline of every coach
 * interaction, the child's thoughts after the game, taken-back attempts, key moments with FEN, and the coach review.
 *
 * Rendering is a pure function of (record, review, persona); the file is regenerated as a whole
 * when the review arrives. Only the parent-notes block is carried over from the previous file.
 */
import { Chess } from 'chess.js';
import { TIME_CONTROLS } from '@gambit/shared';
import type { CoachStyle, GameEvent, GameExclusion, GameRecord, GameReview, GameThought, MotifId, MoveJudgement, Persona } from '@gambit/shared';
import { neutraliseMarkers, parentNotesBlock } from './files.ts';
import {
  COLOR_RU,
  MOVE_CLASS_RU,
  OUTCOME_RU,
  TERMINATION_RU,
  childOutcome,
  formatClock,
  formatDateTimeRu,
  mdInline,
  moveNumberOfPly,
  pluralRu,
  pvToRu,
  qualityMark,
  round1,
  sanToRu,
  toLocalIso,
} from './notation.ts';

export const REVIEW_START = '<!-- review:start -->';
export const REVIEW_END = '<!-- review:end -->';

export interface JournalReview {
  status: GameReview['status'];
  provider: GameReview['provider'];
  markdown: string;
  keyTakeaways: string[];
  suggestedThemeTitle: string | null;
}

export interface JournalInput {
  record: GameRecord;
  persona: Persona;
  nickname: string;
  review: JournalReview | null;
  /** file name of the PGN next to the journal */
  pgnFileName: string;
  motifTitleRu: (motif: MotifId) => string;
  /** inner text of the parent block of the previous version of this file */
  parentNotes: string | null;
  /** title of a concept card by id (teacher mode: «новая тема: …»); absent / null = the topic is not named */
  conceptTitleRu?: (conceptId: string) => string | null;
  /** why the game does not count in the child's progress; null / absent = it counts */
  excluded?: GameExclusion | null;
  /** the child's thoughts that arrived after the game was saved (POST /games/:id/thoughts), in the order they were said */
  thoughts?: readonly JournalThought[];
}

export type JournalThought = Pick<GameThought, 'source' | 'question' | 'text' | 'at'>;

// ───────────────────────── main line ─────────────────────────

export interface MainLineMove {
  /** 1-based */
  ply: number;
  color: 'w' | 'b';
  san: string;
  fenBefore: string | null;
}

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/** Main line from the PGN (authoritative); falls back to the 'move' events, then to nothing. */
export function extractMainLine(record: GameRecord): MainLineMove[] {
  if (record.pgn.trim() !== '') {
    try {
      const chess = new Chess();
      chess.loadPgn(record.pgn);
      const history = chess.history({ verbose: true });
      if (history.length > 0) {
        return history.map((move, index) => ({ ply: index + 1, color: move.color, san: move.san, fenBefore: move.before }));
      }
    } catch {
      // malformed PGN: fall through to the event journal
    }
  }
  const fromEvents: MainLineMove[] = [];
  for (const event of record.events) {
    if (event.type !== 'move') continue;
    const sanValue = event.data.san;
    if (typeof sanValue !== 'string' || sanValue === '') continue;
    if (event.data.takenBack === true) continue;
    const ply = event.ply ?? fromEvents.length + 1;
    const existing = fromEvents.findIndex((m) => m.ply === ply);
    const fenBefore = typeof event.data.fenBefore === 'string' ? event.data.fenBefore : null;
    const move: MainLineMove = { ply, color: ply % 2 === 1 ? 'w' : 'b', san: sanValue, fenBefore };
    // a later move at the same ply replaces a taken-back attempt
    if (existing >= 0) fromEvents[existing] = move;
    else fromEvents.push(move);
  }
  return fromEvents.sort((a, b) => a.ply - b.ply);
}

export interface JudgedLine {
  /** judgement of each main-line ply (child's moves only) */
  byPly: Map<number, MoveJudgement>;
  /** judged attempts that did not stay on the board */
  takenBack: MoveJudgement[];
}

/** Splits the judgements into "stayed on the board" and "taken back". */
export function matchJudgements(mainLine: MainLineMove[], judgements: MoveJudgement[]): JudgedLine {
  const byPly = new Map<number, MoveJudgement>();
  const used = new Set<MoveJudgement>();
  for (const move of mainLine) {
    const candidates = judgements.filter((j) => !used.has(j) && j.san === move.san && j.color === move.color);
    // the LAST matching judgement is the one that stayed (earlier identical attempts were taken back)
    const byPosition = move.fenBefore !== null ? candidates.filter((j) => positionKey(j.fenBefore) === positionKey(move.fenBefore ?? '')) : [];
    const chosen = byPosition[byPosition.length - 1] ?? candidates.filter((j) => j.ply === move.ply).pop();
    if (chosen !== undefined) {
      byPly.set(move.ply, chosen);
      used.add(chosen);
    }
  }
  return { byPly, takenBack: judgements.filter((j) => !used.has(j)) };
}

// ───────────────────────── event helpers ─────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First non-empty string under one of `keys`, looking into common nested containers too. */
function pickString(data: Record<string, unknown>, keys: readonly string[]): string | null {
  const containers: Record<string, unknown>[] = [data];
  for (const nestedKey of ['event', 'coachEvent', 'judgement', 'move']) {
    const nested = data[nestedKey];
    if (isRecord(nested)) containers.push(nested);
  }
  for (const container of containers) {
    for (const key of keys) {
      const value = container[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }
  return null;
}

function pickNumber(data: Record<string, unknown>, keys: readonly string[]): number | null {
  const containers: Record<string, unknown>[] = [data];
  for (const nestedKey of ['event', 'coachEvent']) {
    const nested = data[nestedKey];
    if (isRecord(nested)) containers.push(nested);
  }
  for (const container of containers) {
    for (const key of keys) {
      const value = container[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  return null;
}

const TEXT_KEYS = ['bubbleText', 'text', 'phrase', 'said', 'transcript', 'message'] as const;

const COACH_KIND_RU: Record<string, string> = {
  greeting: 'приветствие',
  gameStart: 'начало партии',
  praise: 'похвала',
  takebackOffer: 'предложение вернуть ход',
  hint: 'подсказка',
  explainBest: 'объяснение лучшего хода',
  threatWarning: 'предупреждение об угрозе',
  botMoveComment: 'комментарий к ходу соперника',
  gameEnd: 'конец партии',
  reviewMoment: 'разбор момента',
  encourage: 'поддержка',
  thinkingRoutine: 'напоминание, как думать',
  answer: 'ответ на вопрос',
  teachTurn: 'совет учителя',
  teachReaction: 'учитель о ходе ученика',
};

// ───────────────────────── teacher mode (docs/TEACHER-MODE.md §7.5) ─────────────────────────

export const COACH_STYLE_RU: Record<CoachStyle, string> = {
  teacher: '«Учитель» — сам показывал хорошие ходы стрелками и объяснял, выбирал ученик',
  helper: '«Подсказчик» — помогал, когда просили',
  exam: '«Экзамен» — молчал до конца партии',
};

const TEACH_MOMENT_RU: Record<string, string> = {
  openingPlan: 'план дебюта',
  repeat: 'совет ещё раз',
  reveal: 'показал подарок',
  reaction: 'о ходе ученика',
  // the lesson model (docs/TEACHING.md §4.1)
  theme: 'тема партии',
  quiz: 'вопрос с кнопками',
  answer: 'после ответа на вопрос',
  mini: 'мини-урок',
  takeaway: 'главный вывод партии',
};

/**
 * The buttons of a lesson question (`coachSaid.quiz`, a LessonQuiz — docs/TEACHING.md §2.4), the proven answer
 * marked: « Варианты: «Нападает» (верный), «Хочет съесть», «Выводит фигуру».». Empty for anything malformed.
 */
function quizOptionsRu(data: Record<string, unknown>): string {
  const nested = [data.quiz, isRecord(data.event) ? data.event.quiz : undefined, isRecord(data.coachEvent) ? data.coachEvent.quiz : undefined];
  const quiz = nested.find(isRecord);
  if (quiz === undefined || !Array.isArray(quiz.options)) return '';
  const correctId = typeof quiz.correctId === 'string' ? quiz.correctId : null;
  const labels: string[] = [];
  for (const option of quiz.options.slice(0, 5)) {
    if (!isRecord(option) || typeof option.label !== 'string' || option.label.trim() === '') continue;
    labels.push(`${quote(option.label.trim())}${correctId !== null && option.id === correctId ? ' (верный)' : ''}`);
  }
  return labels.length > 0 ? ` Варианты: ${labels.join(', ')}.` : '';
}

/** The child's answer to a lesson question (`childSaid.correct`): « — верно» / « — не угадал». */
function quizVerdictRu(data: Record<string, unknown>): string {
  if (pickString(data, ['about']) !== 'quiz') return '';
  return data.correct === true ? ' — верно' : data.correct === false ? ' — не угадал' : '';
}

/** The question a child's words answer: the event's own `question` (a lesson quiz), else the known question of `about`. */
function childQuestion(data: Record<string, unknown>): string | undefined {
  const own = pickString(data, ['question']);
  if (own !== null) return own;
  const about = pickString(data, ['about']);
  return about !== null ? CHILD_QUESTION_RU[about] : undefined;
}

export interface AdviceItem {
  san: string;
  arrow: 'green' | 'blue';
}

/**
 * The advised moves of a journal event: `string[]` of SAN (a `move` event, the first one is the green arrow) or
 * `TeachAdvice[]` (a `coachSaid` / `takebackOffered` event's `teach.advice`). Anything malformed is skipped.
 */
export function adviceItems(value: unknown): AdviceItem[] {
  if (!Array.isArray(value)) return [];
  const items: AdviceItem[] = [];
  for (const item of value.slice(0, 10)) {
    if (items.length >= 3) break;
    const fallbackArrow = items.length === 0 ? 'green' : 'blue';
    if (typeof item === 'string' && item.trim() !== '') items.push({ san: item.trim(), arrow: fallbackArrow });
    else if (isRecord(item) && typeof item.san === 'string' && item.san.trim() !== '') {
      items.push({ san: item.san.trim(), arrow: item.arrow === 'green' || item.arrow === 'blue' ? item.arrow : fallbackArrow });
    }
  }
  return items;
}

/** «Кf3 (зел.), Кc3 (син.)» */
export function renderAdviceRu(items: readonly AdviceItem[]): string {
  return items.map((item) => `${sanToRu(item.san)} (${item.arrow === 'green' ? 'зел.' : 'син.'})`).join(', ');
}

export type AdviceFollowed = 'primary' | 'alternative' | 'own';

/** Whether the child's move followed the advice: the game's own `followed`, else derived from the SANs. */
export function adviceFollowed(data: Record<string, unknown>, san: string | null, advice: readonly AdviceItem[]): AdviceFollowed | null {
  const given = data.followed;
  if (given === 'primary' || given === 'alternative' || given === 'own') return given;
  if (san === null || advice.length === 0) return null;
  const hit = advice.find((item) => item.san === san);
  if (hit === undefined) return 'own';
  return hit.arrow === 'green' ? 'primary' : 'alternative';
}

const FOLLOWED_RU: Record<AdviceFollowed, string> = {
  primary: ' ✓ (по совету)',
  alternative: ' ✓ (по запасному совету)',
  own: ' — свой ход',
};

function teachOf(data: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(data.teach) ? data.teach : null;
}

const HINT_LEVEL_RU: Record<number, string> = {
  1: 'вопрос-подсказка',
  2: 'зона доски или тема',
  3: 'какая фигура',
  4: 'показан ход',
};

function quote(text: string): string {
  return `«${mdInline(text)}»`;
}

function moveRef(event: GameEvent): string {
  return event.ply !== undefined ? ` · ход ${moveNumberOfPly(event.ply)}` : '';
}

export interface TimelineOptions {
  /** title of a concept card by id (a teacher's new topic) */
  conceptTitleRu?: (conceptId: string) => string | null;
}

/** A teacher's phrase: «Тренер (совет учителя, план дебюта): советует e4 (зел.), d4 (син.) — «…»». null = nothing to show. */
function renderTeachLine(at: string, data: Record<string, unknown>, words: SpokenWords, options: TimelineOptions): string | null {
  const kind = pickString(data, ['kind']);
  const teach = teachOf(data);
  const labels: string[] = [COACH_KIND_RU[kind ?? 'teachTurn'] ?? COACH_KIND_RU.teachTurn ?? 'совет учителя'];
  const moment = typeof teach?.moment === 'string' ? TEACH_MOMENT_RU[teach.moment] : undefined;
  if (moment !== undefined && !(kind === 'teachReaction' && teach?.moment === 'reaction')) labels.push(moment);
  if (teach?.reveal === 'later') labels.push('подарок: ученик ищет ход сам');
  const conceptId = typeof teach?.conceptId === 'string' ? teach.conceptId : null;
  if (conceptId !== null) {
    const title = options.conceptTitleRu?.(conceptId) ?? null;
    labels.push(title !== null && title.trim() !== '' ? `новая тема «${mdInline(title)}»` : 'новая тема');
  }
  if (words.voiced) labels.push('голосом');
  const advice = adviceItems(teach?.advice);
  if (words.said === null && advice.length === 0 && words.missing === '') return null;
  const adviceText = advice.length > 0 ? ` советует ${renderAdviceRu(advice)}` : '';
  const spoken = words.said !== null ? `${adviceText !== '' ? ' —' : ''} ${quote(words.said)}` : `${adviceText !== '' ? '.' : ''}${words.missing}`;
  const quizText = teach?.moment === 'quiz' ? quizOptionsRu(data) : '';
  return `- ${at} — Тренер (${labels.join(', ')}):${adviceText}${spoken}${words.heard}${quizText}`;
}

// ───────────────────────── the smart strategist («Учитель»: one strategy per game, re-plans) ─────────────────────────

/** Only known provider ids are shown (the event comes from the browser). */
const STRATEGIST_PROVIDER_RU: Record<string, string> = { codex: 'Codex', openrouter: 'OpenRouter', 'openai-api': 'OpenAI API', template: 'без модели' };
const REPLAN_TRIGGER_RU: Record<string, string> = { leftLine: 'соперник ушёл от плана', phase: 'новая стадия партии', cadence: 'пора обновить план' };
const REPLAN_DROPPED_RU: Record<string, string> = { stale: 'устарел', invalid: 'не прошёл проверку', failed: 'не пришёл' };

/** « (Codex, 2,1 с)» — who answered and how long it took; empty when unknown. */
function strategistNote(data: Record<string, unknown>, extra: readonly string[] = []): string {
  const provider = pickString(data, ['provider']);
  const ms = pickNumber(data, ['latencyMs']);
  const parts = [...extra];
  if (provider !== null && STRATEGIST_PROVIDER_RU[provider] !== undefined) parts.push(STRATEGIST_PROVIDER_RU[provider]);
  if (ms !== null && ms >= 0) parts.push(`${(ms / 1000).toFixed(1).replace('.', ',')} с`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** «Стратегия партии: Итальянская партия — быстро выводим фигуры… (Codex, 2,1 с)» */
function renderStrategyLine(at: string, data: Record<string, unknown>): string | null {
  if (data.failed === true) return `- ${at} — Стратегия партии не пришла вовремя — учитель вёл по правилам${strategistNote(data)}.`;
  const title = pickString(data, ['titleRu']);
  if (title === null) return null;
  const idea = pickString(data, ['ideaRu']);
  return `- ${at} — **Стратегия партии: ${mdInline(title)}**${idea !== null ? ` — ${mdInline(idea)}` : ''}${strategistNote(data, data.late === true ? ['пришла с опозданием'] : [])}.`;
}

/** «Новый план (соперник ушёл от плана, OpenRouter, 2,4 с): «…» Почему этот ход: «…»» */
function renderReplanLine(at: string, data: Record<string, unknown>): string | null {
  const trigger = pickString(data, ['trigger']);
  const why = trigger !== null && REPLAN_TRIGGER_RU[trigger] !== undefined ? [REPLAN_TRIGGER_RU[trigger]] : [];
  const dropped = pickString(data, ['dropped']);
  if (dropped !== null) return `- ${at} — Новый план не использован: ${REPLAN_DROPPED_RU[dropped] ?? 'не подошёл'}${strategistNote(data, why)}.`;
  const plan = pickString(data, ['planRu']);
  if (plan === null) return null;
  const moveWhy = pickString(data, ['whyRu']);
  return `- ${at} — Новый план${strategistNote(data, why)}: ${quote(plan)}${moveWhy !== null ? ` Почему этот ход: ${quote(moveWhy)}` : ''}`;
}

// ───────────────────────── who said what, and was it heard ─────────────────────────

/** The words of a coach line as they will be quoted, and how honest the journal can be about them. */
interface SpokenWords {
  /** the words to quote: the template, the voice transcript, or the model's own words paired with the event */
  said: string | null;
  /** the quoted words are what the voice model really said (its transcript), not a prepared phrase */
  voiced: boolean;
  /** « Расшифровки нет — могло не прозвучать. Смысл: «…»» when the model had to say it in its own words and no transcript came */
  missing: string;
  /** « (прозвучало)» / « (не прозвучало)» when the client reported it, else empty */
  heard: string;
}

/** Context of one event inside the whole game (see `renderTimeline`). */
export interface LineContext {
  /** the voice model's transcript that belongs to this event (it said the moment in its own words) */
  modelWords?: string;
}

/** A transcript of live speech (the child's microphone, or the voice model's own audio). */
function isVoiceTranscript(data: Record<string, unknown>): boolean {
  return data.source === 'voice' && pickString(data, ['kind']) === null;
}

function spokenWords(data: Record<string, unknown>, context: LineContext): SpokenWords {
  const text = pickString(data, TEXT_KEYS);
  const heard = data.heard === true ? ' (прозвучало)' : data.heard === false ? ' (не прозвучало)' : '';
  if (text !== null) return { said: text, voiced: isVoiceTranscript(data), missing: '', heard };
  if (pickString(data, ['spokenBy']) !== 'model') return { said: null, voiced: false, missing: '', heard };
  // a live conversation: the model said the moment IN ITS OWN WORDS — its transcript, when it came, is paired here
  const own = context.modelWords !== undefined && context.modelWords.trim() !== '' ? context.modelWords.trim() : null;
  if (own !== null) return { said: own, voiced: true, missing: '', heard };
  const template = pickString(data, ['template']);
  return { said: null, voiced: false, missing: ` Расшифровки нет — могло не прозвучать.${template !== null ? ` Смысл: ${quote(template)}` : ''}`, heard };
}

/** How the child's words reached the journal. */
const CHILD_SOURCE_RU: Record<string, string> = { voice: 'голосом', typed: 'написал', choice: 'выбрал ответ' };

/** The questions of the game screen a typed / chosen answer belongs to (`childSaid.about`). */
export const CHILD_QUESTION_RU: Record<string, string> = { hardestMoment: 'Что было самым трудным в этой партии?' };

/**
 * One timeline line per interaction; plain moves and empty events are skipped. Teacher mode: a child's move that was
 * advised shows «Совет: Кf3 (зел.), Кc3 (син.) → сыграно Кf3 ✓ (по совету)», a teacher's phrase shows its advice;
 * the strategy of the game and every re-plan show what was chosen, by which model and how fast. A coach line says
 * whether its words are what the voice model really said («голосом»), a prepared phrase, or — the model had to say it
 * in its own words and no transcript came — possibly never heard.
 */
export function renderTimelineLine(event: GameEvent, childName: string, options: TimelineOptions = {}, context: LineContext = {}): string | null {
  const at = `\`${formatClock(event.t)}\`${moveRef(event)}`;
  const data = event.data;
  const sanValue = pickString(data, ['san', 'playedSan']);
  const moveText = sanValue !== null ? ` ${sanToRu(sanValue)}` : '';
  const words = spokenWords(data, context);
  const said = words.said;
  switch (event.type) {
    case 'takebackOffered': {
      const loss = pickNumber(data, ['winPctLoss']);
      const lossText = loss !== null ? ` (шансы упали на ${Math.round(loss)}%)` : '';
      // teacher mode: the offer reminds what was advised before
      const advice = adviceItems(teachOf(data)?.advice ?? data.advice);
      const adviceText = advice.length > 0 ? ` Раньше советовал: ${renderAdviceRu(advice)}.` : '';
      return `- ${at} — **Тренер предложил вернуть ход**${moveText}${lossText}.${adviceText}${said !== null ? ` Сказал${words.voiced ? ' голосом' : ''}: ${quote(said)}` : words.missing}${words.heard}`;
    }
    case 'takebackAccepted':
      return `- ${at} — **${childName}: «Верну ход и подумаю»** — ход${moveText} возвращён.`;
    case 'takebackDeclined':
      return `- ${at} — **${childName}: «Оставлю свой ход»** — ход${moveText} остался на доске.`;
    case 'hintRequested':
      return `- ${at} — ${childName} просит подсказку.`;
    case 'hintGiven': {
      const level = pickNumber(data, ['level', 'hintLevel']);
      const levelText = level !== null ? ` уровня ${level}${HINT_LEVEL_RU[level] !== undefined ? ` (${HINT_LEVEL_RU[level]})` : ''}` : '';
      return `- ${at} — **Подсказка${levelText}**${said !== null ? `${words.voiced ? ' голосом' : ''}: ${quote(said)}` : `.${words.missing}`}${words.heard}`;
    }
    case 'coachSaid': {
      const kind = pickString(data, ['kind']);
      if (kind === 'strategy') return renderStrategyLine(at, data);
      if (kind === 'replan') return renderReplanLine(at, data);
      if (kind === 'teachTurn' || kind === 'teachReaction' || teachOf(data) !== null) return renderTeachLine(at, data, words, options);
      const labels = kind !== null && COACH_KIND_RU[kind] !== undefined ? [COACH_KIND_RU[kind]] : [];
      if (words.voiced) labels.push('голосом');
      const kindText = labels.length > 0 ? ` (${labels.join(', ')})` : '';
      if (said !== null) return `- ${at} — Тренер${kindText}: ${quote(said)}${words.heard}`;
      if (words.missing === '') return null;
      return `- ${at} — Тренер${kindText}:${words.missing.replace(' Расшифровки', ' расшифровки')}${words.heard}`;
    }
    case 'childSaid': {
      if (said === null) return null;
      const how = CHILD_SOURCE_RU[pickString(data, ['source']) ?? ''];
      // a lesson question (about: 'quiz') carries its own question and whether the answer was right
      const question = childQuestion(data);
      return `- ${at} — ${question !== undefined ? `На вопрос ${quote(question)} ` : ''}${childName}${how !== undefined ? ` (${how})` : ''}: ${quote(said)}${quizVerdictRu(data)}`;
    }
    case 'gameStart':
      return `- ${at} — Партия началась.`;
    case 'gameEnd':
      return `- ${at} — Партия закончилась.`;
    case 'move': {
      // teacher mode: the advice the child saw for this move, and whether it was followed
      const advice = adviceItems(data.advice);
      if (advice.length === 0) return null;
      const followed = adviceFollowed(data, sanValue, advice);
      const played = sanValue !== null ? ` → сыграно ${sanToRu(sanValue)}${followed !== null ? FOLLOWED_RU[followed] : ''}` : '';
      const takenBack = data.takenBack === true ? ' (ход возвращён)' : '';
      return `- ${at} — Совет: ${renderAdviceRu(advice)}${played}${takenBack}`;
    }
  }
}

/** A live transcript arrives in pieces now and then: «…на це четыре» + «. Потом ферзь» is ONE utterance. */
const SPLIT_GAP_MS = 8_000;
/** How long after its event the model's own words may still arrive (it speaks when the line before it is over). */
const MODEL_WORDS_WINDOW_MS = 30_000;

function voiceText(event: GameEvent): string | null {
  return (event.type === 'childSaid' || event.type === 'coachSaid') && isVoiceTranscript(event.data) ? pickString(event.data, TEXT_KEYS) : null;
}

/** The second piece continues the first: it starts with a punctuation mark or a small letter. */
function continuesUtterance(next: string): boolean {
  return /^[.,;:!?…)»\-–—]/.test(next) || /^\p{Ll}/u.test(next);
}

function joinPieces(first: string, next: string): string {
  return /^[.,;:!?…)»]/.test(next) ? `${first.trimEnd()}${next}` : `${first.trimEnd()} ${next}`;
}

/** Glues the pieces of one utterance of the same speaker back together («второй кусок начинается с точки»). */
export function mergeSplitUtterances(events: readonly GameEvent[]): GameEvent[] {
  const out: GameEvent[] = [];
  for (const event of events) {
    const text = voiceText(event);
    const previous = out[out.length - 1];
    const previousText = previous !== undefined ? voiceText(previous) : null;
    if (text !== null && previous !== undefined && previousText !== null && previous.type === event.type && event.t - previous.t <= SPLIT_GAP_MS && continuesUtterance(text)) {
      out[out.length - 1] = { ...previous, data: { ...previous.data, text: joinPieces(previousText, text) } };
      continue;
    }
    out.push(event);
  }
  return out;
}

export interface PlannedTimeline {
  events: GameEvent[];
  /** index in `events` → the voice model's own words for that event */
  modelWords: Map<number, string>;
  /** indexes of transcripts folded into their event (not rendered on their own) */
  folded: Set<number>;
}

/**
 * Pairs every «the model says it in its own words» event with the transcript of what it then really said: the first
 * coach voice transcript after it, within 30 s, in order. The transcript is shown IN that line; when it never came, the line says so
 * honestly instead of promising words «(ниже)» that are not there.
 */
export function planTimeline(events: readonly GameEvent[]): PlannedTimeline {
  const merged = mergeSplitUtterances(events);
  const modelWords = new Map<number, string>();
  const folded = new Set<number>();
  const pending: number[] = [];
  merged.forEach((event, index) => {
    const data = event.data;
    if (event.type !== 'childSaid' && pickString(data, TEXT_KEYS) === null && pickString(data, ['spokenBy']) === 'model') {
      pending.push(index);
      return;
    }
    if (event.type !== 'coachSaid') return;
    const text = voiceText(event);
    if (text === null) return;
    while (pending.length > 0 && event.t - (merged[pending[0] ?? 0]?.t ?? 0) > MODEL_WORDS_WINDOW_MS) pending.shift();
    const owner = pending.shift();
    if (owner === undefined) return;
    modelWords.set(owner, text);
    folded.add(index);
  });
  return { events: merged, modelWords, folded };
}

const TIMELINE_LEGEND =
  '_«Голосом» — слова, которые на самом деле прозвучали: расшифровка речи голосовой модели или того, что ребёнок сказал в микрофон. Реплики без этой пометки — заготовки тренера: они показаны в облачке и прочитаны голосом, если он был включён. «Расшифровки нет» — модель должна была сказать это своими словами, но что прозвучало, неизвестно._';

/**
 * The «Общение с тренером» section: every interaction up to the end of the game and the coach's words after it. The
 * child's own words after the game are «Мысли после партии» (see `renderThoughts`), not repeated here.
 */
export function renderTimeline(events: readonly GameEvent[], childName: string, options: TimelineOptions = {}): string[] {
  const plan = planTimeline(events);
  const endIndex = plan.events.findIndex((event) => event.type === 'gameEnd');
  const lines: string[] = [];
  let voiceLines = false;
  plan.events.forEach((event, index) => {
    if (plan.folded.has(index)) return;
    if (endIndex >= 0 && index > endIndex && event.type === 'childSaid') return;
    const words = plan.modelWords.get(index);
    const line = renderTimelineLine(event, childName, options, words !== undefined ? { modelWords: words } : {});
    if (line === null) return;
    if (words !== undefined || isVoiceTranscript(event.data) || pickString(event.data, ['spokenBy']) === 'model') voiceLines = true;
    lines.push(line);
  });
  return voiceLines ? [TIMELINE_LEGEND, '', ...lines] : lines;
}

// ───────────────────────── the child's thoughts after the game ─────────────────────────

/** 21:48 in the machine's local time. */
function localClock(iso: string): string | null {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The last question in a coach line: «Отличная партия! Как тебе удалось найти мат?» → «Как тебе удалось найти мат?» */
export function lastQuestion(text: string): string | null {
  const sentences = text.split(/(?<=[.!?…])\s+/).map((part) => part.trim());
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i] ?? '';
    if (sentence.endsWith('?')) return sentence;
  }
  return null;
}

/** How long after a coach question the child's words still answer it. */
const ANSWER_WINDOW_MS = 90_000;

/**
 * The child's words after the end of the game — the ones in the record (the diary, the talk right after the game) and
 * the ones appended later — each with the question it answers when there was one.
 */
export function collectThoughts(record: GameRecord, appended: readonly JournalThought[] = []): JournalThought[] {
  const events = mergeSplitUtterances(record.events);
  const endIndex = events.findIndex((event) => event.type === 'gameEnd');
  const start = Date.parse(record.startedAt);
  const fromRecord: JournalThought[] = [];
  if (endIndex >= 0 && Number.isFinite(start)) {
    let asked: { question: string; t: number } | null = null;
    for (const event of events.slice(endIndex + 1)) {
      const text = pickString(event.data, TEXT_KEYS);
      if (event.type === 'coachSaid' && text !== null) {
        const question = lastQuestion(text);
        if (question !== null) asked = { question, t: event.t };
        continue;
      }
      if (event.type !== 'childSaid' || text === null) continue;
      const question = childQuestion(event.data) ?? (asked !== null && event.t - asked.t <= ANSWER_WINDOW_MS ? asked.question : undefined);
      const source = pickString(event.data, ['source']) === 'voice' ? 'voice' : 'typed';
      fromRecord.push({ source, text, at: new Date(start + event.t).toISOString(), ...(question !== undefined ? { question } : {}) });
    }
  }
  return [...fromRecord, ...appended].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function renderThoughts(thoughts: readonly JournalThought[], childName: string): string[] {
  const lines = ['## Мысли после партии', ''];
  if (thoughts.length === 0) {
    lines.push('_После партии ребёнок пока ничего не сказал и не написал. Всё, что он скажет Гамбитику после игры или напишет в дневник, появится здесь._', '');
    return lines;
  }
  for (const thought of thoughts) {
    const clock = localClock(thought.at);
    const question = thought.question !== undefined && thought.question.trim() !== '' ? `На вопрос ${quote(thought.question)} ` : '';
    lines.push(`- ${clock !== null ? `\`${clock}\` — ` : ''}${question}${childName} (${thought.source === 'voice' ? 'голосом' : 'написал'}): ${quote(thought.text)}`);
  }
  lines.push('');
  return lines;
}

export interface QuizStats {
  /** lesson questions asked (coachSaid with teach.moment 'quiz') */
  asked: number;
  /** answered with a button (childSaid about 'quiz' with `correct`) */
  answered: number;
  right: number;
}

/** The lesson questions of a game (docs/TEACHING.md §2.4): «верно 3 из 4». null = none asked or answered. */
export function quizStats(record: GameRecord): QuizStats | null {
  const stats: QuizStats = { asked: 0, answered: 0, right: 0 };
  for (const event of record.events) {
    if (event.type === 'coachSaid' && teachOf(event.data)?.moment === 'quiz') stats.asked += 1;
    else if (event.type === 'childSaid' && pickString(event.data, ['about']) === 'quiz' && typeof event.data.correct === 'boolean') {
      stats.answered += 1;
      if (event.data.correct) stats.right += 1;
    }
  }
  stats.asked = Math.max(stats.asked, stats.answered);
  return stats.asked > 0 ? stats : null;
}

export interface AdviceStats {
  /** the child's moves that stayed on the board and had advice */
  advised: number;
  primary: number;
  alternative: number;
  own: number;
  /** own moves the engine rated good or better (best / excellent / good) */
  ownGood: number;
}

/** Teacher mode for a parent: how often the child followed the advice and how many of his own moves were good. */
export function adviceStats(record: GameRecord, judged: JudgedLine): AdviceStats | null {
  const stats: AdviceStats = { advised: 0, primary: 0, alternative: 0, own: 0, ownGood: 0 };
  for (const event of record.events) {
    if (event.type !== 'move' || event.data.takenBack === true) continue;
    const advice = adviceItems(event.data.advice);
    if (advice.length === 0) continue;
    const san = typeof event.data.san === 'string' ? event.data.san : null;
    const followed = adviceFollowed(event.data, san, advice);
    if (followed === null) continue;
    stats.advised += 1;
    stats[followed] += 1;
    if (followed === 'own' && event.ply !== undefined) {
      const j = judged.byPly.get(event.ply);
      if (j !== undefined && (j.classification === 'best' || j.classification === 'excellent' || j.classification === 'good')) stats.ownGood += 1;
    }
  }
  return stats.advised > 0 ? stats : null;
}

// ───────────────────────── sections ─────────────────────────

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function moveLabelFromFen(fen: string, fallbackPly: number): string {
  const parts = fen.split(' ');
  const number = Number.parseInt(parts[5] ?? '', 10);
  const side = parts[1];
  if (Number.isFinite(number) && (side === 'w' || side === 'b')) return side === 'w' ? `${number}.` : `${number}…`;
  return `${moveNumberOfPly(fallbackPly)}.`;
}

function judgementNote(j: MoveJudgement, motifTitleRu: (m: MotifId) => string): string {
  const bad = j.classification === 'inaccuracy' || j.classification === 'mistake' || j.classification === 'blunder' || j.classification === 'missedWin';
  if (bad) {
    const parts = [`${MOVE_CLASS_RU[j.classification]}: шансы ${Math.round(j.winPctBefore)}% → ${Math.round(j.winPctAfter)}%`];
    if (j.bestSan !== '' && j.bestSan !== j.san) parts.push(`лучше ${sanToRu(j.bestSan)}`);
    if (j.allowedMotif !== undefined) parts.push(`позволил: ${motifTitleRu(j.allowedMotif).toLowerCase()}`);
    if (j.missedMotif !== undefined) parts.push(`упустил: ${motifTitleRu(j.missedMotif).toLowerCase()}`);
    return parts.join(' · ');
  }
  if (qualityMark(j) !== '' && j.missedMotif !== undefined) return `нашёл идею: ${motifTitleRu(j.missedMotif).toLowerCase()}`;
  return '';
}

function praisedPlies(events: GameEvent[]): Set<number> {
  const plies = new Set<number>();
  for (const event of events) {
    if (event.type === 'coachSaid' && event.ply !== undefined && pickString(event.data, ['kind']) === 'praise') plies.add(event.ply);
  }
  return plies;
}

function renderMoveTable(input: JournalInput, mainLine: MainLineMove[], judged: JudgedLine): string[] {
  const { record, persona, nickname } = input;
  if (mainLine.length === 0) return ['_Ходы не записаны._'];
  const praised = praisedPlies(record.events);
  const whiteName = record.childColor === 'w' ? nickname : persona.name;
  const blackName = record.childColor === 'b' ? nickname : persona.name;
  const lines = [`| № | Белые (${mdInline(whiteName)}) | Чёрные (${mdInline(blackName)}) | Заметка о ходе ученика |`, '|---:|---|---|---|'];
  const lastPly = mainLine[mainLine.length - 1]?.ply ?? 0;
  for (let number = 1; number <= Math.ceil(lastPly / 2); number += 1) {
    const cells: string[] = [];
    let note = '';
    for (const ply of [number * 2 - 1, number * 2]) {
      const move = mainLine.find((m) => m.ply === ply);
      if (move === undefined) {
        cells.push('');
        continue;
      }
      const j = judged.byPly.get(ply);
      const mark = j !== undefined ? qualityMark(j, praised.has(ply)) : '';
      const text = `${sanToRu(move.san)}${mark}`;
      cells.push(j !== undefined && mark !== '' ? `**${text}**` : text);
      if (j !== undefined) note = judgementNote(j, input.motifTitleRu);
    }
    lines.push(`| ${number} | ${cells[0] ?? ''} | ${cells[1] ?? ''} | ${mdInline(note)} |`);
  }
  return lines;
}

function renderTakenBack(judged: JudgedLine, mainLine: MainLineMove[], motifTitleRu: (m: MotifId) => string): string[] {
  if (judged.takenBack.length === 0) return [];
  const lines = ['## Взятые назад ходы', '', '| Ход | Попытка | Что не так | В итоге сыграно |', '|---|---|---|---|'];
  for (const j of judged.takenBack) {
    const final = mainLine.find((m) => m.fenBefore !== null && positionKey(m.fenBefore) === positionKey(j.fenBefore));
    const finalJudgement = final !== undefined ? judged.byPly.get(final.ply) : undefined;
    const finalText = final === undefined ? '—' : `${sanToRu(final.san)}${finalJudgement !== undefined ? qualityMark(finalJudgement) : ''}`;
    lines.push(`| ${moveLabelFromFen(j.fenBefore, j.ply)} | ~~${sanToRu(j.san)}${qualityMark(j)}~~ | ${mdInline(judgementNote(j, motifTitleRu))} | ${finalText} |`);
  }
  lines.push('');
  return lines;
}

function renderKeyMoments(input: JournalInput): string[] {
  const moments = input.record.summary.keyMoments;
  const lines = ['## Ключевые моменты', ''];
  if (moments.length === 0) {
    lines.push('_В этой партии особых моментов не отмечено._', '');
    return lines;
  }
  for (const moment of moments) {
    const j = input.record.judgements.find((c) => c.san === moment.playedSan && positionKey(c.fenBefore) === positionKey(moment.fenBefore));
    const mark = qualityMark({ classification: moment.classification, missedMotif: j?.missedMotif });
    lines.push(`### ${moveLabelFromFen(moment.fenBefore, moment.ply)} ${sanToRu(moment.playedSan)}${mark} — ${MOVE_CLASS_RU[moment.classification]}`);
    lines.push('');
    lines.push(`- Позиция перед ходом (FEN): \`${moment.fenBefore.replace(/[^A-Za-z0-9/ -]/g, '')}\``);
    if (moment.bestSan !== '' && moment.bestSan !== moment.playedSan) lines.push(`- Лучший ход: **${sanToRu(moment.bestSan)}**${j !== undefined && j.bestPvSan.length > 1 ? ` (вариант: ${pvToRu(j.bestPvSan)})` : ''}`);
    if (j !== undefined && j.refutationPvSan.length > 0 && j.winPctLoss >= 5) lines.push(`- Как соперник мог наказать: ${pvToRu(j.refutationPvSan)}`);
    if (j !== undefined) lines.push(`- Шансы на победу: ${Math.round(j.winPctBefore)}% → ${Math.round(j.winPctAfter)}%`);
    if (moment.motif !== undefined) lines.push(`- Тема: ${input.motifTitleRu(moment.motif)}`);
    if (moment.explanation.trim() !== '') lines.push(`- Объяснение: ${mdInline(moment.explanation)}`);
    lines.push('');
  }
  return lines;
}

/**
 * Shifts markdown headings so that the highest heading of an embedded review becomes `topLevel`
 * — a review never outranks the journal's own sections, whatever level its author started from.
 */
export function demoteHeadings(markdown: string, topLevel = 3): string {
  const levels = [...markdown.matchAll(/^(#{1,6})(?=\s)/gm)].map((match) => match[1]?.length ?? 6);
  if (levels.length === 0) return markdown;
  const shift = topLevel - Math.min(...levels);
  if (shift <= 0) return markdown;
  return markdown.replace(/^(#{1,6})(?=\s)/gm, (hashes: string) => '#'.repeat(Math.min(6, hashes.length + shift)));
}

// ───────────────────────── which AI worked on this game (header) ─────────────────────────

/** A model id as the strategist reports it (`gpt-5.6-sol`, `openai/gpt-5.2`); anything else is not shown. */
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,64}$/;

function modelOf(data: Record<string, unknown>): string | null {
  const model = pickString(data, ['model']);
  return model !== null && MODEL_ID_RE.test(model) ? model : null;
}

/** Who paid for the strategist's answer (GameStrategy.billing): the owner's subscription, an API bill, nobody. */
const BILLING_RU: Record<string, string> = { subscription: 'через подписку', paid: 'платно', free: 'бесплатно' };

export interface AiSummary {
  strategy: { provider: string; model: string | null; billing: string | null; latencyMs: number | null } | 'failed' | null;
  /** re-plans that were used, by provider id */
  replans: Record<string, number>;
  review: GameReview['provider'] | null;
}

/** Who thought about this game: the strategy of «Учитель», its re-plans and the review (only known provider ids). */
export function aiSummary(record: GameRecord, review: JournalReview | null): AiSummary {
  let strategy: AiSummary['strategy'] = null;
  const replans: Record<string, number> = {};
  for (const event of record.events) {
    if (event.type !== 'coachSaid') continue;
    const kind = pickString(event.data, ['kind']);
    const provider = pickString(event.data, ['provider']);
    const known = provider !== null && STRATEGIST_PROVIDER_RU[provider] !== undefined ? provider : null;
    if (kind === 'strategy' && strategy === null) {
      if (event.data.failed === true) strategy = 'failed';
      else if (known !== null) {
        const billing = pickString(event.data, ['billing']);
        strategy = { provider: known, model: modelOf(event.data), billing: billing !== null && BILLING_RU[billing] !== undefined ? billing : null, latencyMs: pickNumber(event.data, ['latencyMs']) };
      }
    } else if (kind === 'replan' && known !== null && pickString(event.data, ['dropped']) === null && pickString(event.data, ['planRu']) !== null) {
      replans[known] = (replans[known] ?? 0) + 1;
    }
  }
  const reviewed = review !== null && (review.status === 'ready' || review.status === 'template') ? review.provider : null;
  return { strategy, replans, review: reviewed };
}

function aiFrontMatter(ai: AiSummary): string | null {
  const parts: string[] = [];
  if (ai.strategy === 'failed') parts.push('strategy: "failed"');
  else if (ai.strategy !== null) {
    parts.push(`strategy: ${yamlString(ai.strategy.provider)}`);
    if (ai.strategy.model !== null) parts.push(`strategy_model: ${yamlString(ai.strategy.model)}`);
    if (ai.strategy.billing !== null) parts.push(`strategy_billing: ${yamlString(ai.strategy.billing)}`);
  }
  const replanCount = Object.values(ai.replans).reduce((sum, n) => sum + n, 0);
  if (replanCount > 0) parts.push(`replans: ${replanCount}`);
  if (ai.review !== null) parts.push(`review: ${yamlString(ai.review)}`);
  return parts.length > 0 ? `ai: { ${parts.join(', ')} }` : null;
}

/** «стратегия — Codex (gpt-5.6-sol), 2,1 с · новые планы: 2 (OpenRouter ×1, Codex ×1) · разбор — ИИ-тренер (Codex)» */
function aiHeaderCell(ai: AiSummary): string | null {
  const parts: string[] = [];
  if (ai.strategy === 'failed') parts.push('стратегия не пришла вовремя');
  else if (ai.strategy !== null) {
    const extra = [
      ai.strategy.model,
      ai.strategy.billing !== null ? (BILLING_RU[ai.strategy.billing] ?? null) : null,
      ai.strategy.latencyMs !== null && ai.strategy.latencyMs >= 0 ? `${(ai.strategy.latencyMs / 1000).toFixed(1).replace('.', ',')} с` : null,
    ].filter((v): v is string => v !== null);
    parts.push(`стратегия — ${STRATEGIST_PROVIDER_RU[ai.strategy.provider] ?? ai.strategy.provider}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`);
  }
  const replans = Object.entries(ai.replans);
  if (replans.length > 0) {
    const total = replans.reduce((sum, [, n]) => sum + n, 0);
    parts.push(`новые планы: ${total} (${replans.map(([provider, n]) => `${STRATEGIST_PROVIDER_RU[provider] ?? provider} ×${n}`).join(', ')})`);
  }
  if (ai.review !== null) parts.push(`разбор — ${PROVIDER_RU[ai.review]}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const EXCLUDED_RU: Record<GameExclusion, string> = {
  adult: '**не считается** — играл взрослый (проверка)',
  archived: '**не считается** — в архиве после «Начать прогресс заново»',
};

export const PROVIDER_RU: Record<GameReview['provider'], string> = {
  codex: 'ИИ-тренер (Codex)',
  openrouter: 'ИИ-тренер (OpenRouter)',
  'openai-api': 'ИИ-тренер (OpenAI API)',
  template: 'шаблон тренера (без ИИ)',
};

function renderReview(review: JournalReview | null): string[] {
  const lines = ['## Разбор тренера', '', REVIEW_START];
  if (review === null || review.status === 'pending') {
    lines.push('_Разбор готовится — файл обновится сам, когда он будет готов._');
  } else if (review.status === 'failed' || review.markdown.trim() === '') {
    lines.push('_Разбор не получилось подготовить. Все факты о партии — в разделах выше._');
  } else {
    // LLM text is data: it can never carry one of the file's block markers
    lines.push(demoteHeadings(neutraliseMarkers(review.markdown.trim()), 3));
    if (review.keyTakeaways.length > 0) {
      lines.push('', '### Главное');
      for (const takeaway of review.keyTakeaways) lines.push(`- ${mdInline(takeaway)}`);
    }
    if (review.suggestedThemeTitle !== null) lines.push('', `**Что потренировать:** ${mdInline(review.suggestedThemeTitle)}`);
    lines.push('', `_Источник разбора: ${PROVIDER_RU[review.provider]}. Оценки ходов — только от шахматного движка._`);
  }
  lines.push(REVIEW_END, '');
  return lines;
}

function durationMinutes(record: GameRecord): number {
  const ms = Date.parse(record.endedAt) - Date.parse(record.startedAt);
  return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0;
}

export function renderGameJournal(input: JournalInput): string {
  const { record, persona, nickname } = input;
  const s = record.summary;
  const outcome = childOutcome(record.result, record.childColor);
  const tc = TIME_CONTROLS[record.timeControlId];
  const mainLine = extractMainLine(record);
  const judged = matchJudgements(mainLine, record.judgements);
  const minutes = durationMinutes(record);
  const excluded = input.excluded ?? null;
  const ai = aiSummary(record, input.review);
  const aiLine = aiFrontMatter(ai);

  const out: string[] = [];
  out.push(
    '---',
    'schema: game-journal/1',
    `game_id: ${yamlString(record.id)}`,
    `date: ${yamlString(toLocalIso(record.startedAt))}`,
    `student: ${yamlString(nickname)}`,
    `opponent: ${record.personaId}`,
    `opponent_elo: ${Math.round(persona.nominalElo)}`,
    `time_control: ${record.timeControlId}`,
    `child_color: ${record.childColor === 'w' ? 'white' : 'black'}`,
    `result: ${yamlString(record.result)}`,
    `outcome: ${outcome}`,
    `termination: ${record.termination}`,
    `exam_mode: ${record.examMode}`,
    ...(record.coachStyle !== undefined ? [`coach_style: ${record.coachStyle}`] : []),
    `counts_in_progress: ${excluded === null}`,
    ...(excluded !== null ? [`excluded: ${excluded}`] : []),
    `plies: ${mainLine.length}`,
    `accuracy: ${round1(s.accuracy)}`,
    `acpl: ${Math.round(s.acpl)}`,
    `blunders: ${s.counts.blunder}`,
    `mistakes: ${s.counts.mistake}`,
    `inaccuracies: ${s.counts.inaccuracy}`,
    `missed_wins: ${s.counts.missedWin}`,
    `takebacks: { offered: ${s.takebacksOffered}, accepted: ${s.takebacksAccepted} }`,
    `hints_used: ${s.hintsUsed}`,
    ...(s.openingName !== undefined ? [`opening: ${yamlString(neutraliseMarkers(s.openingName))}`] : []),
    `review: ${input.review?.status ?? 'pending'}`,
    ...(aiLine !== null ? [aiLine] : []),
    `pgn: ${yamlString(`./${input.pgnFileName}`)}`,
    '---',
    '',
  );

  out.push(`# Партия с ботом ${persona.name} — ${formatDateTimeRu(record.startedAt)}`, '');
  out.push('| | |', '|---|---|');
  out.push(`| Дата | ${formatDateTimeRu(record.startedAt)} |`);
  out.push(`| Соперник | ${mdInline(persona.name)} (бот, сила ≈ ${Math.round(persona.nominalElo)}) |`);
  out.push(`| Контроль времени | ${tc.label}${record.examMode ? ' · экзамен без подсказок' : ''} |`);
  out.push(`| Цвет ученика | ${COLOR_RU[record.childColor]} |`);
  out.push(`| Результат | **${OUTCOME_RU[outcome]}** (${record.result}), ${TERMINATION_RU[record.termination]} |`);
  out.push(`| Точность | **${Math.round(s.accuracy)}%** |`);
  out.push(`| Ошибки | зевков: ${s.counts.blunder} · ошибок: ${s.counts.mistake} · неточностей: ${s.counts.inaccuracy}${s.counts.missedWin > 0 ? ` · упущенных выигрышей: ${s.counts.missedWin}` : ''} |`);
  if (excluded !== null) out.push(`| В прогрессе ребёнка | ${EXCLUDED_RU[excluded]} |`);
  if (record.coachStyle !== undefined) out.push(`| Как помогал тренер | ${COACH_STYLE_RU[record.coachStyle]} |`);
  out.push(`| Помощь тренера | предложений вернуть ход: ${s.takebacksOffered} (принято: ${s.takebacksAccepted}) · подсказок: ${s.hintsUsed} |`);
  const advice = adviceStats(record, judged);
  if (advice !== null) {
    const followed = advice.primary + advice.alternative;
    out.push(
      `| Советы учителя | по совету: ${followed} из ${pluralRu(advice.advised, 'хода', 'ходов', 'ходов')} (зелёная стрелка — ${advice.primary}, синяя — ${advice.alternative}) · свои ходы: ${advice.own}, из них хороших: ${advice.ownGood} |`,
    );
  }
  const quiz = quizStats(record);
  if (quiz !== null) {
    const unanswered = quiz.asked - quiz.answered;
    const parts = [...(quiz.answered > 0 ? [`верно: ${quiz.right} из ${quiz.answered}`] : []), ...(unanswered > 0 ? [`без ответа: ${unanswered}`] : [])];
    out.push(`| Вопросы с кнопками | ${parts.join(' · ')} |`);
  }
  const aiCell = aiHeaderCell(ai);
  if (aiCell !== null) out.push(`| ИИ в этой партии | ${aiCell} |`);
  if (s.openingName !== undefined) out.push(`| Дебют | ${mdInline(s.openingName)} |`);
  if (minutes > 0) out.push(`| Длительность | ${minutes} мин · ${pluralRu(Math.ceil(mainLine.length / 2), 'ход', 'хода', 'ходов')} |`);
  out.push(`| Файл партии | [${input.pgnFileName}](./${input.pgnFileName}) |`, '');

  out.push('## Ходы', '');
  out.push(...renderMoveTable(input, mainLine, judged), '');
  out.push('_Знаки: `!!` блестяще · `!` сильный ход · `?!` неточность · `?` ошибка · `??` зевок. Оцениваются только ходы ученика; оценки ставит шахматный движок._', '');

  out.push(...renderTakenBack(judged, mainLine, input.motifTitleRu));

  out.push('## Общение с тренером', '');
  const timelineOptions: TimelineOptions = input.conceptTitleRu !== undefined ? { conceptTitleRu: input.conceptTitleRu } : {};
  const timeline = renderTimeline(record.events, nickname, timelineOptions);
  if (timeline.length === 0) out.push('_Тренер в этой партии молчал._', '');
  else out.push(...timeline, '');

  out.push(...renderThoughts(collectThoughts(record, input.thoughts ?? []), nickname));

  out.push(...renderKeyMoments(input));
  out.push(...renderReview(input.review));
  out.push(parentNotesBlock(input.parentNotes), '');
  return out.join('\n');
}

// ───────────────────────── PGN file ─────────────────────────

/**
 * The PGN sent by the client is kept as is when it already has a header section; otherwise the
 * seven-tag roster (plus a few useful extras) is added in front of the movetext.
 */
export function renderPgnFile(record: GameRecord, persona: Persona, nickname: string): string {
  const movetext = record.pgn.trim();
  if (/^\s*\[\w+\s+"/.test(movetext)) return `${movetext}\n`;
  const d = new Date(record.startedAt);
  const date = Number.isFinite(d.getTime()) ? `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}` : '????.??.??';
  const tc = TIME_CONTROLS[record.timeControlId];
  const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const child = escape(nickname);
  const bot = escape(`${persona.name} (бот)`);
  const headers: [string, string][] = [
    ['Event', 'Гамбитик: партия с ботом'],
    ['Site', 'Гамбитик (локально)'],
    ['Date', date],
    ['Round', '-'],
    ['White', record.childColor === 'w' ? child : bot],
    ['Black', record.childColor === 'b' ? child : bot],
    ['Result', record.result],
    ['TimeControl', tc.initialMs === null ? '-' : `${Math.round(tc.initialMs / 1000)}+${Math.round(tc.incrementMs / 1000)}`],
    ['Termination', record.termination],
    ['GameId', record.id],
    ['BotId', record.personaId],
    ['StudentColor', record.childColor === 'w' ? 'white' : 'black'],
    ['StudentAccuracy', String(round1(record.summary.accuracy))],
  ];
  if (record.summary.openingName !== undefined) headers.push(['Opening', escape(record.summary.openingName)]);
  const head = headers.map(([key, value]) => `[${key} "${value}"]`).join('\n');
  const body = movetext === '' ? record.result : /(1-0|0-1|1\/2-1\/2|\*)\s*$/.test(movetext) ? movetext : `${movetext} ${record.result}`;
  return `${head}\n\n${body}\n`;
}
