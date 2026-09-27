/**
 * CoachEvent builders — every moment the mascot «Гамбитик» speaks about during and around a game.
 *
 * Each event carries two things (so that the phrases are alive, not templated):
 *  - `brief` — for CONVERSATIONAL voices (Live / Realtime): engine-verified facts + the goal of the moment
 *    (see ./brief.ts: «Момент / Факты / Цель / Нельзя»); the model says it in its own words. Never the best move of
 *    the current position unless the hint ladder reached level 4 (`explainBest` is a post-mortem of a past move);
 *  - `text` / `bubbleText` — the verbatim template for browser TTS / silent layers and the bubble until the
 *    model's own transcript arrives.
 *
 * Rules (research 05 §8, 08 §3.2): short sentences, questions before answers, praise the process,
 * never shame, never say "плохой ход". `text` and `brief` have no Latin notation.
 *
 * Word rules (docs/TEACHING.md §0, §2.2): the spoken words never name a SQUARE — the piece and the idea are said, the
 * board highlights / arrows show where — and never «молодец», «умница», «так держать». The helper («Подсказчик») and
 * the shared builders keep that in `text` AND `bubbleText` (the bubble shows the same words, no notation). The clip
 * twins (tools/voice-clips plans them) and the briefs of the live voice follow their own rules.
 * One exception: the teacher's strategy intro of `buildGameStart` (coachStyle 'teacher' with a strategy, words of
 * ./strategy.ts) — the lesson engine starts a teacher game with `lessonGameStart` instead.
 * Every builder takes an optional `rng` (default Math.random) — as its last parameter, except the optional
 * extras of `buildPraise`.
 */
import type {
  AnalysisResult,
  BoardAnnotations,
  CoachEvent,
  CoachStyle,
  Color,
  GameListItem,
  GameResult,
  GameSummary,
  HintLevel,
  MotifId,
  MoveJudgement,
  Persona,
  PieceType,
  PositionFacts,
  StudentProfile,
  TeachAdvice,
  Termination,
  Threat,
  TimeControl,
} from '@gambit/shared';
import { Chess } from 'chess.js';
import { findHanging } from '../analysis/hanging.ts';
import { endangeredSquares, parseUci, pieceAt, resolveUciMove, zoneOf, zoneSquares } from './board.ts';
import type { BoardZone, ResolvedMove } from './board.ts';
import {
  ALLOWED_AFTER,
  FORBID_BEST_MOVE,
  FORBID_BEST_WORD,
  FORBID_LONG,
  FORBID_OBVIOUS,
  FORBID_OTHER_MOVES,
  FORBID_SHAME,
  FORBID_TWO_SENTENCES,
  capturedAlongRu,
  allowedFactRu,
  composeBrief,
  forbidFor,
  hangingListRu,
  motifWithGlossRu,
  pawnsAccRu,
  pieceOnRu,
  spokenLineRu,
  spokenMoveRu,
  studentWords,
  winChanceChangeRu,
} from './brief.ts';
import type { StudentWords } from './brief.ts';
import { isMateMotif, motifPracticeLineRu, motifTitleInlineRu, pickPracticeMotif } from './motifs.ts';
import {
  firstFitting,
  join,
  lowerFirst,
  makeEvent,
  ownPieceAcc,
  pick,
  pieceG,
  pieceWord,
  pronounAcc,
  pronounDat,
  pronounNom,
  say,
  speakableName,
  yourPieceNom,
} from './phrase.ts';
import type { Rng, Template, Voice } from './phrase.ts';
import { pieceGenderRu, pieceNameRu, squareToSpokenRu } from './spoken.ts';
import { threatFactsRu, threatTargetPiece } from './threats.ts';
import { explainOpponentMove, joinIdeasRu, pickIdeas } from './moveIdeas.ts';
import { strategyIntroTemplate } from './strategy.ts';
import type { TeachStrategy } from './strategy.ts';
import { hasClipLine } from './clips/catalog.ru.ts';
import { genderOf, lineItem, moveSentence, strategyIntroSentences, twinCapsFor, twinUtterance, wholeSentence, withClip } from './clips/twins.ts';
import type { TwinSentence } from './clips/twins.ts';

// ───────────────────────── «Записи»: the recorded twins of these events (docs/voice-clips/SPEC.md §3.4) ─────────────────────────

/** A non-teacher event's twin: ≤ 2 sentences / 24 words, the generic line of its kind (ladder L5). */
function eventTwin(event: CoachEvent, sentences: readonly (TwinSentence | null)[], moment?: string): CoachEvent {
  return withClip(event, twinUtterance({ sentences, kind: event.kind, pose: event.pose, ...(moment ? { moment } : {}), caps: twinCapsFor({ teacher: false }) }));
}

/** In-game phrases stay within this many words (speech form). */
export const MAX_IN_GAME_WORDS = 25;

// ───────────────────────── a move in words WITHOUT its square (the board shows it) ─────────────────────────

/** «короткая рокировка» / «длинная рокировка» (the king's target file tells the side). */
function castleWordsRu(move: Pick<ResolvedMove, 'to'>): string {
  return move.to[0] === 'g' ? 'короткая рокировка' : 'длинная рокировка';
}

/**
 * A move named by its piece and what it does — never by a square: «ход конём», «конь бьёт ладью», «короткая
 * рокировка», «пешка превращается в ферзя». Nominative, fits after a colon or a dash.
 */
function moveWordsRu(move: Pick<ResolvedMove, 'piece' | 'to' | 'captured' | 'promotion' | 'isCastle'>): string {
  if (move.isCastle) return castleWordsRu(move);
  if (move.promotion) return `пешка превращается в ${pieceNameRu(move.promotion, 'acc')}`;
  if (move.captured) return `${pieceNameRu(move.piece, 'nom')} бьёт ${pieceNameRu(move.captured, 'acc')}`;
  return `ход ${pieceNameRu(move.piece, 'ins')}`;
}

/** The same for a UCI move in `fen`; `fallback` when the move is not legal there. */
function uciWordsRu(fen: string, uci: string, fallback: string): string {
  const mv = resolveUciMove(fen, uci);
  return mv ? moveWordsRu(mv) : fallback;
}

/**
 * The advised moves of a take-back reminder, by piece only: «ход слоном», «ход слоном или конём», «рокировка или ход
 * конём» (the same piece twice is said once; an illegal one is skipped).
 */
function adviceWordsRu(fen: string, advice: readonly TeachAdvice[]): string {
  const parts: string[] = [];
  for (const a of advice) {
    const mv = resolveUciMove(fen, a.uci);
    if (!mv) continue;
    const part = mv.isCastle ? 'рокировка' : mv.captured ? `взятие ${pieceNameRu(mv.piece, 'ins')}` : pieceNameRu(mv.piece, 'ins');
    if (!parts.includes(part)) parts.push(part);
  }
  if (parts.length === 0) return 'ход по зелёной стрелке';
  // «ход слоном или конём», «рокировка или ход конём»: a castle / a capture carries its own noun, a bare instrumental
  // takes «ход» unless it continues another bare one
  const bare = (w: string | undefined): boolean => w !== undefined && w !== 'рокировка' && !w.startsWith('взятие ');
  return parts.map((w, i) => (bare(w) && !bare(parts[i - 1]) ? `ход ${w}` : w)).join(' или ');
}

/** A child's piece must stand to lose at least this much (SEE, cp) before we warn about it. */
export const THREAT_WARNING_MIN_SEE_CP = 200;

/** Up to this stage the threat warning names and highlights the piece; later it only asks. */
export const THREAT_WARNING_NAMED_MAX_STAGE = 3;

// ═════════════════════════ greeting ═════════════════════════

type DayPart = 'morning' | 'day' | 'evening' | 'night';

function dayPart(hour: number): DayPart {
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 12;
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'day';
  if (h >= 18 && h < 22) return 'evening';
  return 'night';
}

const HELLO: Readonly<Record<DayPart, readonly string[]>> = {
  morning: ['Доброе утро', 'С добрым утром', 'Привет-привет'],
  day: ['Привет-привет', 'Добрый день', 'Привет'],
  evening: ['Добрый вечер', 'Привет-привет', 'Привет'],
  night: ['Ого, как поздно', 'Привет'],
};

export type ChildOutcome = 'win' | 'loss' | 'draw' | 'unfinished';

/** Game result from the child's point of view. */
export function childOutcome(result: GameResult, childColor: Color): ChildOutcome {
  if (result === '1/2-1/2') return 'draw';
  if (result === '1-0') return childColor === 'w' ? 'win' : 'loss';
  if (result === '0-1') return childColor === 'b' ? 'win' : 'loss';
  return 'unfinished';
}

const GREETING_FIRST_TIME: readonly Template[] = [
  say('Я Гамбитик, твой шахматный друг. Сыграем?'),
  say('Меня зовут Гамбитик, я шахматный конь и люблю хитрые ходы. Начнём?'),
  say('Я Гамбитик! Умею перепрыгивать через фигуры и думать вместе с тобой. Поехали?'),
  say('Я Гамбитик. Будем играть и учиться вместе — сыграем первую партию?'),
];

const GREETING_TAILS: Readonly<Record<ChildOutcome | 'none', readonly Template[]>> = {
  win: [
    (v) => `В прошлый раз ты ${v.g('победил', 'победила')} — здорово! Сыграем ещё?`,
    say('Помню твою прошлую победу. Поехали дальше?'),
    (v) => `Прошлую партию ты ${v.g('выиграл', 'выиграла')}. Посмотрим, что получится сегодня?`,
    say('После победы играть ещё интереснее. Начнём?'),
  ],
  loss: [
    say('Прошлая партия была трудной, зато мы кое-чему научились. Попробуем ещё?'),
    say('После трудной партии мастера снова садятся за доску. Сыграем?'),
    say('Я уже придумал, что потренируем после прошлой партии. Начнём?'),
    say('Каждая партия делает нас сильнее. Сыграем ещё одну?'),
  ],
  draw: [
    say('В прошлый раз была боевая ничья. Сыграем ещё?'),
    say('Помню нашу ничью — никто не уступил! Продолжим?'),
    say('После ничьей хочется сыграть ещё. Поехали?'),
    say('Прошлая партия закончилась миром. Что будет сегодня?'),
  ],
  unfinished: [
    say('Прошлую партию мы не доиграли — ничего страшного. Начнём новую?'),
    say('Я уже соскучился по шахматам. Поехали!'),
    say('Доска ждёт! Сыграем?'),
    // (the child's gender, as the clip twin's `greet.unfinished` wording says it: a girl never hears «Готов»)
    (v) => `${v.g('Готов', 'Готова')} подумать вместе со мной? Поехали!`,
  ],
  none: [
    say('О, это ты! Я уже соскучился по шахматам. Поехали!'),
    say('Сыграем?'),
    say('Доска ждёт! С чего начнём?'),
    say('Я готов думать вместе с тобой. Начнём?'),
  ],
};

const GREETING_NIGHT_TAILS: readonly Template[] = [
  say('Давай одну спокойную партию — и отдыхать?'),
  say('Сыграем разок, а потом спать — мастерам нужен сон.'),
  say('Может, пару задачек — и на боковую?'),
  say('Одна партия, и глазкам пора отдыхать. Идёт?'),
];

export function buildGreeting(
  a: { profile: StudentProfile; hour: number; lastGame?: GameListItem },
  rng: Rng = Math.random,
): CoachEvent {
  const part = dayPart(a.hour);
  const hello = pick(HELLO[part], rng);
  const firstTime = a.profile.totals.games === 0 && !a.lastGame;
  const outcome = a.lastGame ? childOutcome(a.lastGame.result, a.lastGame.childColor) : 'none';
  const tail = firstTime
    ? pick(GREETING_FIRST_TIME, rng)
    : part === 'night'
      ? pick(GREETING_NIGHT_TAILS, rng)
      : pick(GREETING_TAILS[outcome], rng);
  const head: Template = (v) => (v.name ? `${hello}, ${v.name}!` : `${hello}!`);
  const event = makeEvent({
    kind: 'greeting',
    priority: 1,
    pose: 'wave',
    pauseClock: false,
    profile: a.profile,
    template: join(head, tail),
    brief: greetingBrief(a.profile, part, firstTime, outcome),
  });
  // (clips never say the child's name: the hello of the day part, then the same kind of tail)
  const g = genderOf(a.profile);
  const tailLine = firstTime ? 'greet.first' : part === 'night' ? 'greet.night' : `greet.${outcome}`;
  return eventTwin(event, [wholeSentence(`greet.hello.${part}`, 100), wholeSentence(lineItem(tailLine, { g }), 80)]);
}

const DAY_PART_RU: Readonly<Record<DayPart, string>> = {
  morning: 'сейчас утро',
  day: 'сейчас день',
  evening: 'сейчас вечер',
  night: 'уже поздно, почти ночь',
};

function greetingBrief(profile: StudentProfile, part: DayPart, firstTime: boolean, outcome: ChildOutcome | 'none'): string {
  const s = studentWords(profile);
  const name = speakableName(profile.nickname);
  const last: Readonly<Record<ChildOutcome, string>> = {
    win: `прошлую партию ${s.nom} ${s.g('выиграл', 'выиграла')}`,
    loss: `прошлую партию ${s.nom} ${s.g('проиграл', 'проиграла')} — вспоминай об этом бодро, без грусти`,
    draw: 'прошлая партия закончилась вничью',
    unfinished: 'прошлую партию не доиграли',
  };
  return composeBrief({
    moment: `${s.nom} ${s.g('открыл', 'открыла')} приложение, партии ещё нет`,
    facts: [
      DAY_PART_RU[part],
      firstTime ? `это ваша первая встреча: ${s.nom} ещё ни разу не ${s.g('играл', 'играла')} с тобой` : null,
      !firstTime && outcome !== 'none' ? last[outcome] : null,
      name ? `${s.nom} просит называть ${s.g('его', 'её')} «${name}»` : null,
    ],
    goal: [
      firstTime ? 'познакомься: скажи, кто ты, и предложи сыграть первую партию' : 'поздоровайся тепло и коротко и предложи сыграть',
      part === 'night' ? 'уже поздно: предложи одну спокойную партию, а потом отдыхать' : '',
    ],
    forbid: ['не расспрашивай о личном', FORBID_LONG],
  });
}

// ═════════════════════════ game start ═════════════════════════

const GAME_START_OPENERS: readonly ((opponent: string) => Template)[] = [
  (o) => say(o ? `Сегодня твой соперник — ${o}.` : 'Соперник уже ждёт.'),
  (o) => say(o ? `Играем! Напротив тебя — ${o}.` : 'Играем!'),
  (o) => say(o ? `За доской тебя ждёт ${o}.` : 'Доска готова.'),
  (o) => (v) => v.hey(o ? `сегодня играем с соперником по имени ${o}.` : 'начинаем партию.'),
];

/**
 * «Привет!» at the head of the game's first line, when the app's own hello was not heard (Гамбитик waves and then
 * talks when the game starts; the shell's hello is easily lost under the wizard's remarks).
 */
const GAME_HELLO: readonly Template[] = [(v) => (v.name ? `Привет, ${v.name}!` : 'Привет!'), say('Привет-привет!'), (v) => (v.name ? `Привет, ${v.name}!` : 'Приве-е-ет!')];

const GAME_START_TAIL_COACHED: readonly string[] = [
  'Помни наш секрет: сначала смотрим — потом ходим!',
  'Не спеши, я рядом.',
  'Если что — жми «Подсказка», подумаем вместе.',
  'Удачи, и проверяй каждый ход на безопасность!',
];

const GAME_START_TAIL_SILENT: readonly string[] = [
  'Партия быстрая: я молчу и болею за тебя, а потом всё обсудим.',
  'Тут надо играть быстро, так что я помолчу. Разберём после партии!',
  'Я не мешаю — болею за тебя молча. Поговорим после партии.',
  'Время летит, поэтому подсказок не будет. Я за тебя болею!',
];

const GAME_START_TAIL_UNTIMED: readonly string[] = [
  'Часов нет — думай спокойно, я рядом.',
  'Торопиться некуда: сначала смотрим — потом ходим!',
  'Времени сколько хочешь. Если что — жми «Подсказка».',
  'Играем без часов, так что проверяй каждый ход не спеша.',
];

/** Exam: no hints, no take-back offers — the phrase must not promise any (research 05, X1). */
const GAME_START_TAIL_EXAM: readonly Template[] = [
  (v) => `Это экзамен: сегодня ты играешь ${v.g('сам', 'сама')}, а я молчу и болею за тебя. Потом всё разберём!`,
  (v) => `Сегодня экзамен — как на турнире: ты играешь ${v.g('сам', 'сама')}, без подсказок. Я болею за тебя!`,
  say('Это экзамен: подсказок не будет, зато после партии всё обсудим. Я в тебя верю!'),
];

/**
 * Teacher mode without a strategy (the strategist and the library both failed): one short line — no greeting fluff,
 * no clock, no colour, no «можешь спрашивать меня».
 */
const GAME_START_TEACHER_PLAIN: readonly Template[] = [
  say('Играем! Я покажу хорошие ходы стрелками и объясню зачем.'),
  say('Поехали! Буду показывать хорошие ходы и объяснять, зачем они.'),
  (v) => `Начинаем! Покажу хорошие ходы, а выберешь ты ${v.g('сам', 'сама')}.`,
];

type GameStartArgs = {
  persona: Persona;
  timeControl: TimeControl;
  childColor: Color;
  profile: StudentProfile;
  examMode?: boolean;
  coachStyle?: CoachStyle;
  /** teacher mode: the strategy of this game (`GameStrategy` + its library card) — the start becomes its ONE intro line */
  strategy?: TeachStrategy | null;
  /** teacher mode: the position of the child's first move (Black: after the opponent's first move); White's default is the initial position */
  fen?: string;
  /**
   * The app's hello was not heard (the game knows it from the shell): the line starts with «Привет!». Not for the
   * teacher's intro — it waits for the strategy, so the teacher game says `buildGameHello` at once instead.
   */
  greet?: boolean;
};

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * `examMode` (extra, optional): the game is played without hints and take-back offers. `coachStyle` (teacher mode,
 * docs/TEACHER-MODE.md §6.2): 'teacher' = ONE strategy intro line (see `teacherGameStart`); 'exam' = the same as `examMode`.
 * Every start line WAVES (pose 'wave': «помахал и начал говорить») — the lines after it talk. Never the colour or whose
 * move it is: the child has just chosen them and sees them.
 */
export function buildGameStart(a: GameStartArgs, rng: Rng = Math.random): CoachEvent {
  const exam = a.examMode === true || a.coachStyle === 'exam';
  const silent = a.timeControl.coachMode === 'off';
  const teacher = !exam && !silent && a.coachStyle === 'teacher';
  if (teacher) return teacherGameStart(a, rng);
  const opponentSpoken = speakableName(a.persona.name);
  const hello = a.greet === true ? pick(GAME_HELLO, rng) : null;
  const opener = pick(GAME_START_OPENERS, rng);
  const tails: readonly Template[] = exam
    ? GAME_START_TAIL_EXAM
    : (silent ? GAME_START_TAIL_SILENT : a.timeControl.initialMs === null ? GAME_START_TAIL_UNTIMED : GAME_START_TAIL_COACHED).map((text) => say(text));
  const tail = pick(tails, rng);
  const template: Template = (v) => {
    const opponent = v.mode === 'speech' ? opponentSpoken : a.persona.name.trim();
    return `${hello ? `${hello(v)} ` : ''}${opener(opponent)(v)} ${tail(v)}`;
  };
  const event = makeEvent({ kind: 'gameStart', priority: 1, pose: 'wave', pauseClock: false, profile: a.profile, template, brief: gameStartBrief({ ...a, examMode: exam }) });
  // the opponent's name is not recorded: an opener that names him stays in the bubble only (with the hello, the hello
  // alone is said — a wording of its own); the voice never says another opener than the bubble shows
  const tailLine = exam ? 'start.tail.exam' : silent ? 'start.tail.silent' : a.timeControl.initialMs === null ? 'start.tail.untimed' : 'start.tail.coached';
  const openerSaid = hello !== null || opponentSpoken === '';
  return eventTwin(event, [openerSaid ? wholeSentence(hello ? 'start.open.greet' : 'start.open', 100) : null, wholeSentence(lineItem(tailLine, { g: genderOf(a.profile) }), openerSaid ? 80 : 100)]);
}

/**
 * «Привет!» — ONE word the moment the board opens, when the app's hello was not heard: the teacher's intro waits for
 * the strategy (up to a few seconds, Black: for the opponent's first move), and the child should not start in silence.
 * Kind 'greeting', pose 'wave'; nothing about the game in it.
 */
export function buildGameHello(profile: StudentProfile, rng: Rng = Math.random): CoachEvent {
  const s = studentWords(profile);
  const name = speakableName(profile.nickname);
  return gameHelloTwin(makeEvent({
    kind: 'greeting',
    priority: 1,
    pose: 'wave',
    pauseClock: false,
    profile,
    template: pick(GAME_HELLO, rng),
    brief: composeBrief({
      moment: 'открылась доска, партия начинается',
      facts: [name ? `${s.nom} просит называть ${s.g('его', 'её')} «${name}»` : null],
      goal: 'поздоровайся одним-двумя словами — просто «привет»; о партии скажешь следующей фразой',
      forbid: ['ничего больше: ни о партии, ни о ходах, ни пожеланий', FORBID_OBVIOUS, 'не говори, что с тобой можно разговаривать'],
    }),
  }));
}

function gameHelloTwin(event: CoachEvent): CoachEvent {
  return eventTwin(event, [wholeSentence('hello.game', 100)]);
}

/** The child's first move of the strategy in `fen` (the child to move), or null. */
function strategyFirstMove(s: TeachStrategy | null | undefined, fen: string | null, childColor: Color): { uci: string; san: string; fenBefore: string; ply: number } | null {
  const san = s?.lineSan?.[0];
  if (!san || !fen) return null;
  try {
    const chess = new Chess(fen);
    if (chess.turn() !== childColor) return null;
    const mv = chess.move(san);
    const parts = fen.trim().split(/\s+/);
    const full = Number(parts[5] ?? '1');
    const ply = (Number.isFinite(full) && full > 0 ? full - 1 : 0) * 2 + (childColor === 'w' ? 1 : 2);
    return { uci: `${mv.from}${mv.to}${mv.promotion ?? ''}`, san: mv.san, fenBefore: fen, ply };
  } catch {
    return null;
  }
}

/**
 * «Учитель»: the game starts with ONE line that announces this game's strategy and the first move —
 * «В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е
 * четыре.» Kind 'gameStart', `teach.moment` 'openingPlan' with the first move as the green arrow (the library lines
 * are engine-verified). Black before the opponent's first move (no `fen`): the strategy without a move. No strategy:
 * a short plain line. Never the clock, the colour, a greeting or «спрашивай меня».
 */
function teacherGameStart(a: GameStartArgs, rng: Rng): CoachEvent {
  const s = studentWords(a.profile);
  const strategy = a.strategy && a.strategy.titleRu.trim() !== '' ? a.strategy : null;
  const fen = a.fen ?? (a.childColor === 'w' ? START_FEN : null);
  const first = strategyFirstMove(strategy, fen, a.childColor);
  const template: Template = strategy ? strategyIntroTemplate(strategy, first ? { san: first.san, fenBefore: first.fenBefore } : null, a.childColor) : pick(GAME_START_TEACHER_PLAIN, rng);
  const spoken = first ? spokenMoveRu(first.san, first.fenBefore) : '';
  const brief = composeBrief({
    moment: 'начинается новая партия',
    facts: strategy
      ? [
          `в этой партии разыгрываем «${strategy.titleRu}»${strategy.ideaRu ? `: ${strategy.ideaRu}` : ''}`,
          spoken ? `первый ход по нашему плану — ${spoken}` : null,
        ]
      : [`ты учитель в этой партии: будешь показывать хорошие ходы стрелками и объяснять зачем, а выбирает ${s.nom}`],
    advice: spoken ? [`${spoken} (зелёная стрелка)`] : [],
    // (Black before the opponent's first move: no move — ONE phrase, so that the idea «пешка в центр, фигуры в игру,
    // король в домик» is not told as three more sentences)
    goal: strategy
      ? spoken
        ? 'одной-двумя короткими фразами скажи, какую стратегию разыграем в этой партии и зачем, и назови первый ход'
        : 'одной короткой фразой скажи, какую стратегию разыграем в этой партии и зачем — идею одним списком, не отдельными фразами'
      : 'одной короткой фразой скажи, что будешь показывать хорошие ходы и объяснять зачем',
    forbid: [
      spoken ? forbidFor(FORBID_OTHER_MOVES, s) : 'не называй ходы',
      FORBID_BEST_WORD,
      'без приветствий и пожеланий удачи — сразу к делу',
      FORBID_OBVIOUS,
      'не говори, что с тобой можно разговаривать',
      spoken ? FORBID_TWO_SENTENCES : 'не больше одного предложения',
    ],
  });
  const ply = first?.ply ?? (a.childColor === 'w' ? 1 : 2);
  const event = makeEvent({
    kind: 'gameStart',
    priority: 1,
    // the first line of the game waves («помахал и начал говорить»); the advice after it talks
    pose: 'wave',
    pauseClock: false,
    profile: a.profile,
    template,
    board: first ? { arrows: [{ from: first.uci.slice(0, 2), to: first.uci.slice(2, 4), color: 'green' }], highlights: [] } : undefined,
    brief,
    teach: {
      moment: 'openingPlan',
      // (no move to name: one sentence — the voice frame follows the style)
      style: first ? 'full' : 'short',
      ply,
      advice: first ? [{ uci: first.uci, san: first.san, source: 'repertoire', arrow: 'green' }] : [],
      ...(first ? { reveal: 'now' as const } : {}),
    },
  });
  // the library's own intro line (never the strategist's free `introRu`) · «Первый ход —» the move
  const g = genderOf(a.profile);
  const sentences = strategy ? strategyIntroSentences(strategy, first ? { san: first.san, fenBefore: first.fenBefore } : null, a.childColor, g) : [wholeSentence(lineItem('start.teacher.plain', { g }), 100)];
  return eventTwin(event, sentences, 'openingPlan');
}

function gameStartBrief(a: GameStartArgs): string {
  const s = studentWords(a.profile);
  const opponent = speakableName(a.persona.name);
  const name = speakableName(a.profile.nickname);
  const silent = a.timeControl.coachMode === 'off';
  const tagline = lowerFirst(a.persona.tagline.trim().replace(/[«»"]/g, '').replace(/[.!]+$/u, ''));
  const hello = a.greet === true ? `сначала поздоровайся одним словом${name ? ' и по имени' : ''}` : null;
  const goal = a.examMode
    ? [hello, 'коротко пожелай удачи и скажи, что это экзамен: ты молчишь и болеешь, а после партии всё разберёте']
    : silent
      ? [hello, 'коротко пожелай удачи и предупреди, что до конца партии будешь молчать и болеть, а поговорите после']
      : [
          hello,
          'одной короткой фразой пожелай удачи; соперника можно назвать по имени',
          'скажи, что с тобой можно говорить в любой момент: спросить про ход или подумать вслух',
          'потом замолчи и дай подумать',
        ];
  return composeBrief({
    moment: 'начинается новая партия',
    facts: [
      opponent ? `соперник — ${opponent}${tagline ? `, про него известно: ${tagline}` : ''}` : 'соперник — компьютерный игрок',
      a.greet === true && name ? `${s.nom} просит называть ${s.g('его', 'её')} «${name}»` : null,
      // (no colour, no whose move, no clock: the child has just chosen them and sees them)
      a.examMode ? 'это экзамен: без подсказок и без предложений вернуть ход' : null,
      silent && !a.examMode ? 'в быстрой партии ты молчишь до конца игры' : null,
    ],
    goal: goal.filter((g): g is string => g !== null),
    forbid: [a.examMode ? 'не обещай подсказок' : null, 'не называй ходы', FORBID_OBVIOUS, FORBID_LONG],
  });
}

const GAME_RESUMED_HEADS: readonly string[] = ['Продолжаем нашу партию!', 'Я всё запомнил — играем дальше!', 'Партия ждала тебя. Продолжаем!'];

/**
 * Extra: an interrupted game (closed tab, reload) is continued from the saved position. One short happy line — not
 * whose move it is (the board and the clock show it). `childToMove` is kept for the callers.
 */
export function buildGameResumed(a: { childToMove: boolean; profile: StudentProfile }, rng: Rng = Math.random): CoachEvent {
  const tails = ['', 'Я рядом.', 'Смотрим внимательно!'];
  const head = pick(GAME_RESUMED_HEADS, rng);
  const tail = pick(tails, rng);
  const event = makeEvent({
    kind: 'gameStart',
    priority: 1,
    pose: 'wave',
    pauseClock: false,
    profile: a.profile,
    template: say(tail ? `${head} ${tail}` : head),
    brief: composeBrief({
      moment: 'прерванную партию продолжаем с того же места',
      goal: 'одной короткой фразой обрадуйся, что продолжаем',
      forbid: ['не называй ходы', FORBID_OBVIOUS],
    }),
  });
  // (the tail the text adds is a sentence of its own, so the voice says exactly the bubble)
  return eventTwin(event, [wholeSentence('start.resumed', 100), tail ? wholeSentence('start.resumed.tail', 60) : null]);
}

const OPENING_IDEA_HEADS: readonly ((title: string) => string)[] = [
  (title) => `Узнаю наш дебютный план: ${title}.`,
  (title) => `Это знакомый план: ${title}.`,
  (title) => `Копытом чую знакомый дебют: ${title}.`,
];

const OPENING_WARNING_HEADS: readonly ((title: string) => string)[] = [
  (title) => `Осторожно, знакомая история: ${title}.`,
  (title) => `Помнишь наш урок — ${title}?`,
];

/**
 * Extra: one sentence about the IDEA of the opening the game follows (from the repertoire in @gambit/content —
 * `title` / `idea` are plain Russian without notation). Said at most once per game, from the stage the repertoire
 * is taught. `warning`: the recognised line is a cautionary one.
 */
export function buildOpeningIdea(a: { title: string; idea: string; warning?: boolean; profile: StudentProfile }, rng: Rng = Math.random): CoachEvent {
  const title = lowerFirst(a.title.trim().replace(/[.!?…]+$/u, ''));
  const head = pick(a.warning ? OPENING_WARNING_HEADS : OPENING_IDEA_HEADS, rng)(title);
  return makeEvent({
    kind: 'encourage',
    priority: 1,
    pose: 'talk',
    pauseClock: true,
    profile: a.profile,
    template: say(`${head} ${a.idea.trim()}`),
    brief: composeBrief({
      moment: 'партия пошла по знакомому дебютному плану',
      facts: [
        `план называется «${title}»`,
        `идея плана: ${lowerFirst(a.idea.trim())}`,
        a.warning ? 'это поучительная история: в этом дебюте легко попасть в ловушку' : null,
      ],
      goal: a.warning
        ? `по-доброму предупреди и спроси, ${a.profile.address === 'f' ? 'помнит ли ученица' : 'помнит ли ученик'}, в чём тут опасность`
        : 'одной-двумя фразами расскажи идею плана своими словами',
      forbid: ['не называй конкретный следующий ход', FORBID_LONG],
    }),
  });
}

// ═════════════════════════ take-back offer ═════════════════════════

const TAKEBACK_OPENERS: readonly Template[] = [
  say('Стоп-стоп, подожди — давай вернём ход и подумаем ещё разок!'),
  say('Ой-ой, копытом чую — тут что-то не так, давай вернём ход!'),
  say('Погоди-ка, давай вернём ход и посмотрим ещё раз!'),
  say('Тпру, не спеши — предлагаю вернуть ход и подумать вместе!'),
  (v) => v.hey('подожди — давай вернём ход и подумаем вместе!'),
];

type MotifGroup =
  | 'hanging'
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'discovered'
  | 'removeDefender'
  | 'trapped'
  | 'mate'
  | 'backRank'
  | 'badTrade'
  | 'promotion'
  | 'kingSafety'
  | 'generic';

function motifGroup(m: MotifId | undefined): MotifGroup {
  switch (m) {
    case 'hangingPiece':
    case 'freeCapture':
      return 'hanging';
    case 'fork':
      return 'fork';
    case 'pin':
      return 'pin';
    case 'skewer':
      return 'skewer';
    case 'discoveredAttack':
    case 'doubleCheck':
      return 'discovered';
    case 'removeDefender':
      return 'removeDefender';
    case 'trappedPiece':
      return 'trapped';
    case 'backRankMate':
      return 'backRank';
    case 'mateIn1':
    case 'mateIn2':
    case 'mateIn3':
      return 'mate';
    case 'badTrade':
      return 'badTrade';
    case 'promotion':
      return 'promotion';
    case 'kingSafety':
      return 'kingSafety';
    default:
      return 'generic';
  }
}

/** Socratic level-1 questions. `p` = the opponent piece that delivers the punishment, if known. */
function takebackQuestions(group: MotifGroup, p: PieceType | undefined): readonly string[] {
  const their = p ? `${pieceWord(p, 'nom')} соперника` : undefined;
  const jump = p === 'n' ? 'прыгнуть' : 'пойти';
  const withPiece = (s: string | undefined): string[] => (s ? [s] : []);
  switch (group) {
    case 'hanging':
      return [
        'Все ли твои фигуры сейчас под защитой?',
        'Посмотри: какая твоя фигура осталась без защиты?',
        'Что у тебя сейчас под боем?',
        'Этот ход что-то теряет — найдёшь что?',
        ...withPiece(their && `Посмотри, что теперь может забрать ${their}?`),
      ];
    case 'fork':
      return [
        'Соперник готовит вилку — на какие две фигуры он нападёт?',
        'Тут пахнет вилкой — какие твои фигуры можно атаковать одним ходом?',
        ...withPiece(their && `Посмотри, что теперь может сделать ${their} — не вилка ли это?`),
        ...withPiece(their && `Куда может ${jump} ${their}, чтобы напасть сразу на две фигуры?`),
      ];
    case 'pin':
      return [
        'Тут пахнет связкой — какая твоя фигура не сможет уйти?',
        'Какая твоя фигура заслоняет собой фигуру подороже?',
        ...withPiece(their && `Посмотри, на какую линию может встать ${their}?`),
      ];
    case 'skewer':
      return [
        'Какие твои фигуры стоят на одной линии?',
        'Посмотри на линии: кто стоит друг за другом?',
        ...withPiece(their && `Что будет, если ${their} нападёт вдоль этой линии?`),
      ];
    case 'discovered':
      return [
        'Какая фигура соперника может отойти и открыть нападение?',
        'Посмотри, что откроется, когда соперник уберёт фигуру с линии?',
        'Какая фигура соперника прячется за другой?',
      ];
    case 'removeDefender':
      return [
        'Кто защищает твои фигуры — и может ли соперник убрать этого защитника?',
        'Посмотри на защитников: всем ли им спокойно?',
        'Что случится, если твоего защитника прогонят или заберут?',
      ];
    case 'trapped':
      return [
        'Хватает ли твоей фигуре полей, чтобы отступить?',
        'Посмотри: есть ли у твоей фигуры путь назад?',
        'Куда уйдёт твоя фигура, если на неё нападут?',
      ];
    case 'backRank':
      return [
        'Есть ли у твоего короля форточка?',
        'Куда убежит твой король, если дадут шах по последней линии?',
        'Какие шахи теперь есть у соперника?',
      ];
    case 'mate':
      return [
        'Какие шахи теперь есть у соперника?',
        'Посмотри на своего короля: безопасно ли ему?',
        'Куда убежит твой король, если соперник даст шах?',
        'Королю опасно — какие шахи есть у соперника?',
      ];
    case 'badTrade':
      return [
        'Посчитай размен: кто что заберёт и кому это выгодно?',
        'Сколько стоит фигура, которую ты отдаёшь, и сколько — та, что забираешь?',
        'Кто останется с лишней фигурой после всех взятий?',
      ];
    case 'promotion':
      return [
        'Посмотри на пешки соперника: какая из них рвётся к превращению?',
        'Кто остановит пешку соперника, если она побежит вперёд?',
        'Далеко ли пешке соперника до последней линии?',
      ];
    case 'kingSafety':
      return [
        'Посмотри на своего короля: хватает ли ему защитников?',
        'Какие шахи теперь есть у соперника?',
        'Спокойно ли сейчас твоему королю?',
      ];
    case 'generic':
      return [
        'Что теперь хочет сделать соперник?',
        'Этот ход точно безопасен?',
        'Какие шахи, взятия и угрозы есть у соперника?',
        ...withPiece(their && `Посмотри, что теперь может сделать ${their}?`),
      ];
  }
}

/** True when the refutation mates the child within three moves. */
function getsMatedSoon(j: MoveJudgement): boolean {
  const mate = j.evalAfter.mate;
  return mate !== null && mate < 0 && -mate <= 3;
}

function takebackGroup(j: MoveJudgement): MotifGroup {
  const group = motifGroup(j.allowedMotif);
  if (group === 'generic') {
    if (getsMatedSoon(j)) return 'mate';
    if (j.materialLossPawns >= 2) return 'hanging';
  }
  return group;
}

/**
 * The child took the offered move back and played ANOTHER move that loses too: no second «Стоп-стоп»
 * speech — one short line «и этот ход теряет …, давай ещё подумаем».
 */
const TAKEBACK_AGAIN_OPENERS: readonly ((lost: string | null) => Template)[] = [
  (lost) => say(lost ? `И этот ход теряет ${lost} — давай ещё подумаем!` : 'И этот ход что-то теряет — давай ещё подумаем!'),
  (lost) => say(lost ? `Ой, так ты отдаёшь ${lost}. Вернём и подумаем ещё?` : 'Ой, и так что-то теряется. Вернём и подумаем ещё?'),
  (lost) => (v) => v.hey(lost ? `и этот ход отдаёт ${lost} — давай ещё разок подумаем!` : 'и этот ход что-то теряет — давай ещё разок подумаем!'),
];

/** The child's piece the refutation takes first, in the accusative («ферзя»), or null (a mate, a positional loss). */
function lostPieceAcc(j: MoveJudgement): string | null {
  if (getsMatedSoon(j)) return null;
  const lost = firstCapturedAlong(j.fenAfter, j.refutationPvUci, 4);
  return lost ? pieceNameRu(lost, 'acc') : null;
}

/**
 * «Стоп-стоп! Давай вернём ход…» + one Socratic question about what the move allowed.
 * Board: RED highlights on the endangered square(s) only — never the better move.
 *
 * Teacher mode (`opts.advice` = the advice the child saw before the move, docs/TEACHER-MODE.md §1.4 / §6.2): the same
 * policy decides WHEN; the words become concrete — what is lost, by which reply of the opponent, and a reminder of
 * the earlier advice. The brief may name those advised moves (the child has seen their arrows): «Можно назвать» lists
 * them plus the opponent's reply; `event.teach` carries the advice for the arrows after «Верну ход».
 *
 * `opts.again` — the move is the child's NEW try in the position whose losing move was just taken back: the opener is
 * the short «и этот ход теряет …, давай ещё подумаем», the brief says it is the second try.
 */
export function buildTakebackOffer(j: MoveJudgement, profile: StudentProfile, rng: Rng = Math.random, opts: { advice?: readonly TeachAdvice[]; again?: boolean } = {}): CoachEvent {
  const group = takebackGroup(j);
  const first = parseUci(j.refutationPvUci[0] ?? '');
  const punisher = first ? pieceAt(j.fenAfter, first.from)?.piece : undefined;
  const again = opts.again === true;
  const opener = again ? pick(TAKEBACK_AGAIN_OPENERS, rng)(lostPieceAcc(j)) : pick(TAKEBACK_OPENERS, rng);

  const mateThreat = group === 'mate' || group === 'backRank' || isMateMotif(j.allowedMotif) || getsMatedSoon(j);
  const squares = endangeredSquares(j.fenAfter, j.refutationPvUci, { mateThreat });
  const board: BoardAnnotations = {
    arrows: [],
    highlights: squares.map((square) => ({ square, color: 'red' as const })),
  };

  const advice = (opts.advice ?? []).filter((a) => resolveUciMove(j.fenBefore, a.uci) !== undefined).slice(0, 2);
  if (advice.length > 0) return teacherTakebackOffer(j, profile, rng, opener, advice, board, again);

  const question = pick(takebackQuestions(group, punisher), rng, `takeback.${group}`);
  const event = makeEvent({
    kind: 'takebackOffer',
    priority: 2,
    pose: 'oops',
    pauseClock: true,
    profile,
    // the second try: the short line alone (the question would make it a speech again)
    template: again ? opener : join(opener, say(question)),
    board,
    motif: j.allowedMotif,
    judgement: j,
    brief: takebackBrief(j, profile, question, again),
  });
  // «Стоп-стоп…» · a question of the same group (with the punisher's piece among its wordings); the second try alone
  return eventTwin(event, again ? [takebackAgainSentence(j)] : [wholeSentence('takeback.stop', 100), wholeSentence(lineItem(`takeback.q.${group}`, { piece: punisher ?? null }), 60)]);
}

/**
 * «Почему так?» while the take-back question is open (or right after the move was taken back): the same Socratic
 * question of the move's group again — never «это хороший ход», never the better move. The red squares stay.
 * Priority 1 (a question the child asked), the clock stands while it is said.
 */
export function buildTakebackQuestion(j: MoveJudgement, profile: StudentProfile, rng: Rng = Math.random): CoachEvent {
  const group = takebackGroup(j);
  const first = parseUci(j.refutationPvUci[0] ?? '');
  const punisher = first ? pieceAt(j.fenAfter, first.from)?.piece : undefined;
  const mateThreat = group === 'mate' || group === 'backRank' || isMateMotif(j.allowedMotif) || getsMatedSoon(j);
  const board: BoardAnnotations = { arrows: [], highlights: endangeredSquares(j.fenAfter, j.refutationPvUci, { mateThreat }).map((square) => ({ square, color: 'red' as const })) };
  const question = pick(takebackQuestions(group, punisher), rng, `takeback.${group}`);
  const event = makeEvent({ kind: 'answer', priority: 1, pose: 'think', pauseClock: true, profile, template: say(question), board, motif: j.allowedMotif });
  return eventTwin(event, [wholeSentence(lineItem(`takeback.q.${group}`, { piece: punisher ?? null }), 100)], 'why');
}

/** «И этот ход теряет коня — давай ещё подумаем!»: the piece the refutation takes first (none for a mate). */
function takebackAgainSentence(j: MoveJudgement): TwinSentence {
  const lost = getsMatedSoon(j) ? null : firstCapturedAlong(j.fenAfter, j.refutationPvUci, 4);
  return wholeSentence(lineItem('takeback.again', { piece: lost }), 100);
}

/** The brief's moment and goal of the second offer in the same position («и этот ход теряет …»). */
function againMomentRu(s: StudentWords): string {
  return `${s.nom} уже ${s.g('вернул', 'вернула')} ход и ${s.g('сыграл', 'сыграла')} в той же позиции другой, но и он что-то теряет; игра снова остановлена, приложение снова предлагает вернуть ход`;
}
const AGAIN_GOAL_RU = 'одной короткой фразой: и этот ход теряет — назови, что именно, — давай ещё подумаем; без второго длинного объяснения';

/** The first items of a spoken line, cut before anything that would sound like `forbidden` (the best move). */
function cutBefore(line: readonly string[], forbidden: string): string[] {
  if (!forbidden) return [...line];
  const at = line.findIndex((m) => m.includes(forbidden) || forbidden.includes(m));
  return at < 0 ? [...line] : line.slice(0, at);
}

const MOVES_GEN: readonly string[] = ['', 'один ход', 'два хода', 'три хода', 'четыре хода', 'пять ходов'];

/** «ученик теряет ферзя» / «соперник может поставить мат за два хода» — what the refutation costs, in words. */
function lossFactsRu(j: MoveJudgement, s: StudentWords): string[] {
  const mateIn = j.evalAfter.mate !== null && j.evalAfter.mate < 0 ? -j.evalAfter.mate : null;
  if (mateIn !== null && mateIn <= 5) {
    return [mateIn === 1 ? 'соперник может сразу поставить мат' : `соперник может поставить мат за ${MOVES_GEN[mateIn]}`];
  }
  const out: string[] = [];
  const captured = capturedAlongRu(j.fenAfter, j.refutationPvUci, 4);
  if (captured.length > 0) out.push(`соперник забирает ${captured.slice(0, 2).join(', а потом ')}`);
  if (j.materialLossPawns >= 1) out.push(`в итоге ${s.nom} теряет ${pawnsAccRu(j.materialLossPawns)} материала`);
  return out;
}

function takebackBrief(j: MoveJudgement, profile: StudentProfile, question: string, again = false): string {
  const s = studentWords(profile);
  const best = spokenMoveRu(j.bestSan, j.fenBefore);
  const line = cutBefore(spokenLineRu(j.fenAfter, j.refutationPvSan, 3), best);
  const hanging = line.length === 0 ? hangingListRu(safeHanging(j.fenAfter), j.color, THREAT_WARNING_MIN_SEE_CP) : null;
  if (again) {
    return composeBrief({
      moment: againMomentRu(s),
      facts: [
        `новый ход ${s.gen}: ${spokenMoveRu(j.san, j.fenBefore) || 'последний ход'}`,
        line.length > 0 ? `теперь у соперника сильный ответ: ${line[0]}` : null,
        ...lossFactsRu(j, s),
        hanging ? `под боем у ${s.gen}: ${hanging}` : null,
        'на экране две кнопки: «Верну ход и подумаю» и «Оставлю свой ход»',
      ],
      goal: [AGAIN_GOAL_RU, `решение за ${s.g('ним', 'ней')}: если хочет оставить ход — уважай это`],
      forbid: [FORBID_BEST_MOVE, FORBID_SHAME, 'не говори «опять» и «снова ошибся»'],
    });
  }
  return composeBrief({
    moment: `${s.nom} только что ${s.g('сделал', 'сделала')} ход, который что-то теряет; игра остановлена, приложение предлагает вернуть ход`,
    facts: [
      `ход ${s.gen}: ${spokenMoveRu(j.san, j.fenBefore) || 'последний ход'}`,
      line.length > 0 ? `теперь у соперника сильный ответ: ${line[0]}${line.length > 1 ? `, дальше, например, ${line.slice(1).join(', потом ')}` : ''}` : null,
      j.allowedMotif ? allowedFactRu(j.allowedMotif) : null,
      ...lossFactsRu(j, s),
      hanging ? `под боем у ${s.gen}: ${hanging}` : null,
      winChanceChangeRu(j.winPctBefore, j.winPctAfter, s),
      'на экране две кнопки: «Верну ход и подумаю» и «Оставлю свой ход»',
    ],
    goal: [
      'мягко останови и предложи вернуть ход',
      // not «например: «…»» — with an example the model repeats the template's question word for word
      `спроси своими словами, что теперь может сделать соперник; мысль вопроса — «${question}», но скажи её по-своему, не этими словами`,
      `если ${s.nom} не видит опасность, можешь назвать ответ соперника`,
      `решение за ${s.g('ним', 'ней')}: если хочет оставить ход — уважай это`,
    ],
    forbid: [FORBID_BEST_MOVE, FORBID_SHAME],
  });
}

/** The child's move in words for «ученик сыграл …»: «конём на же пять» / «ход: пешка бьёт на дэ пять». */
export function playedMoveRu(j: Pick<MoveJudgement, 'fenBefore' | 'uci' | 'san'>): string {
  const mv = resolveUciMove(j.fenBefore, j.uci);
  const spoken = spokenMoveRu(j.san, j.fenBefore) || 'последний ход';
  if (!mv || mv.isCastle || mv.captured || mv.promotion) return `ход: ${spoken}`;
  return `${pieceNameRu(mv.piece, 'ins')} на ${squareToSpokenRu(mv.to)}`;
}

/** What the opponent's first reply does, in facts: «ферзь соперника может сразу забрать коня: ферзь бьёт на же пять». */
function teacherRefutationFacts(j: MoveJudgement, s: StudentWords): { facts: string[]; replySpoken: string; lostAcc: string | null } {
  const reply = resolveUciMove(j.fenAfter, j.refutationPvUci[0] ?? '');
  const replySpoken = reply ? spokenMoveRu(reply.san, j.fenAfter) : '';
  const mateIn = j.evalAfter.mate !== null && j.evalAfter.mate < 0 ? -j.evalAfter.mate : null;
  const facts: string[] = [];
  let lostAcc: string | null = null;
  const firstLost = firstCapturedAlong(j.fenAfter, j.refutationPvUci, 4);
  if (reply && replySpoken) {
    if (reply.givesMate) facts.push(`соперник может сразу поставить мат: ${replySpoken}`);
    else if (reply.captured) {
      lostAcc = pieceNameRu(reply.captured, 'acc');
      facts.push(`${pieceNameRu(reply.piece, 'nom')} соперника может сразу забрать ${lostAcc}: ${replySpoken}`);
      const victim = safeHanging(j.fenAfter).find((h) => h.square === reply.to && h.color === j.color);
      if (victim && victim.defenders.length === 0) facts.push(`${pieceNameRu(victim.piece, 'acc')} на ${squareToSpokenRu(victim.square)} никто не защищает`);
    } else {
      // a quiet refutation needs its mechanism (G04 5…Кd4: it attacks the queen), not only «сильный ответ»
      let why = '';
      try {
        const { ideas } = explainOpponentMove(j.fenAfter, j.refutationPvUci[0] ?? '', reply.fenAfter, { prev: { uci: j.uci, fenBefore: j.fenBefore } });
        why = joinIdeasRu(pickIdeas(ideas, { stage: 3, max: 1 }));
      } catch {
        why = '';
      }
      facts.push(`теперь у соперника сильный ответ: ${replySpoken}${why ? ` — ${pieceNameRu(reply.piece, 'nom')} ${why}` : ''}`);
      if (firstLost && mateIn === null) facts.push(`потом соперник забирает ${pieceNameRu(firstLost, 'acc')}`);
    }
  }
  if (mateIn !== null && mateIn <= 5 && !(reply?.givesMate ?? false)) facts.push(mateIn === 1 ? 'соперник может сразу поставить мат' : `соперник может поставить мат за ${MOVES_GEN[mateIn]}`);
  if (j.allowedMotif && j.allowedMotif !== 'hangingPiece' && j.allowedMotif !== 'freeCapture' && !isMateMotif(j.allowedMotif)) facts.push(allowedFactRu(j.allowedMotif));
  if (mateIn === null && j.materialLossPawns >= 1) {
    const pawns = Math.round(j.materialLossPawns);
    const lostType = firstLost ?? reply?.captured;
    // «теряет ладью — это четыре пешки» is false: the piece is named only when the net loss IS its value
    if (lostType && VALUE_PAWNS_EV[lostType] === pawns) facts.push(`в итоге ${s.nom} теряет ${pieceNameRu(lostType, 'acc')} — это ${pawnsAccRu(pawns)} материала`);
    else facts.push(`в итоге теряется примерно ${pawnsAccRu(pawns)} материала`);
  }
  return { facts, replySpoken, lostAcc };
}

const VALUE_PAWNS_EV: Readonly<Record<PieceType, number>> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** The first unit of the side NOT to move in `fen` that the side to move captures along the line. */
function firstCapturedAlong(fen: string, pvUci: readonly string[], maxPlies: number): PieceType | null {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  const attacker = chess.turn();
  for (const uci of pvUci.slice(0, maxPlies)) {
    const parts = parseUci(uci);
    if (!parts) break;
    try {
      const mv = chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
      if (mv.color === attacker && mv.captured) return mv.captured;
    } catch {
      break;
    }
  }
  return null;
}

/** The reminder of the advice: its piece, never its square (the arrows come back after «Верну ход»). */
const TEACHER_TAKEBACK_REMINDERS: readonly ((lost: string | null, advice: (v: Voice) => string) => Template)[] = [
  (lost, advice) => (v) => (lost ? `Соперник может забрать ${lost} — помнишь мой совет: ${advice(v)}?` : `Помнишь мой совет: ${advice(v)}?`),
  (_lost, advice) => (v) => `Мой совет был такой: ${advice(v)}.`,
  (lost, advice) => (v) => (lost ? `Так теряется ${lost === 'пешку' ? 'пешка' : 'фигура'}, а я советовал: ${advice(v)}.` : `Я советовал: ${advice(v)}.`),
];

function teacherTakebackOffer(j: MoveJudgement, profile: StudentProfile, rng: Rng, opener: Template, advice: readonly TeachAdvice[], board: BoardAnnotations, again = false): CoachEvent {
  const s = studentWords(profile);
  const { facts, replySpoken, lostAcc } = teacherRefutationFacts(j, s);
  const bothWords = adviceWordsRu(j.fenBefore, advice);
  const primaryWords = adviceWordsRu(j.fenBefore, advice.slice(0, 1));
  const both = (): string => bothWords;
  const primary = (): string => primaryWords;
  const reminder = pick(TEACHER_TAKEBACK_REMINDERS, rng, 'takeback.teacher');
  const template = again
    ? firstFitting([join(opener, () => `Мой совет: ${primary()}.`), opener], profile, MAX_IN_GAME_WORDS)
    : firstFitting([join(opener, reminder(lostAcc, both)), join(opener, reminder(lostAcc, primary)), join(opener, say('Давай вернём ход?'))], profile, MAX_IN_GAME_WORDS);
  const adviceSpoken = advice.map((a) => spokenMoveRu(a.san, j.fenBefore)).filter((x) => x !== '');
  const brief = composeBrief({
    moment: again
      ? againMomentRu(s)
      : `${s.nom} ${s.g('сыграл', 'сыграла')} ${playedMoveRu(j)}, и этот ход ${lostAcc ? `теряет ${lostAcc}` : getsMatedSoon(j) ? 'пропускает мат' : 'что-то теряет'}; игра остановлена, приложение предлагает вернуть ход`,
    facts: [
      ...facts,
      adviceSpoken.length > 0 ? `раньше ты советовал: ${adviceSpoken.join(' или ')}` : null,
      'на экране кнопки «Верну ход и подумаю» и «Оставлю свой ход»',
    ],
    advice: [...adviceSpoken, replySpoken ? `${replySpoken} (ход соперника)` : null],
    goal: again
      ? [AGAIN_GOAL_RU, 'можно одним словом напомнить совет', `решение за ${s.g('ним', 'ней')}: если хочет оставить ход — уважай это`]
      : [
          'мягко останови и предложи вернуть ход',
          'коротко и конкретно покажи, чем опасен этот ход',
          'напомни свой совет',
          `решение за ${s.g('ним', 'ней')}: если хочет оставить ход — уважай это`,
        ],
    forbid: [FORBID_SHAME, forbidFor(FORBID_OTHER_MOVES, s), 'никаких оценок в цифрах'],
  });
  const event = makeEvent({
    kind: 'takebackOffer',
    priority: 2,
    pose: 'oops',
    pauseClock: true,
    profile,
    template,
    board,
    motif: j.allowedMotif,
    judgement: j,
    brief,
    teach: { moment: 'reaction', style: 'full', ply: j.ply, advice: advice.map((a) => ({ uci: a.uci, san: a.san, source: a.source, arrow: a.arrow })) },
  });
  // «Стоп-стоп…» · «Мой совет был такой:» the advised move «— а так соперник заберёт коня!» (the first reply's capture)
  const reply = resolveUciMove(j.fenAfter, j.refutationPvUci[0] ?? '');
  const lost = reply && !reply.givesMate ? reply.captured : undefined;
  const reminderTwin = moveSentence({
    head: 'takeback.head.advice',
    san: (advice[0] as TeachAdvice).san,
    fen: j.fenBefore,
    reason: !again && lost ? lineItem('takeback.tail.lost', { piece: lost }) : null,
    prio: 60,
  });
  return eventTwin(event, [again ? takebackAgainSentence(j) : wholeSentence('takeback.stop', 100), reminderTwin], 'reaction');
}

function safeHanging(fen: string) {
  try {
    return findHanging(fen);
  } catch {
    return [];
  }
}

const TAKEBACK_DECLINED: readonly string[] = [
  'Хорошо, твоё решение! После партии разберём этот момент.',
  'Договорились, играем дальше! Проверим твой ход на доске.',
  'Ладно, оставляем. Потом вместе посмотрим, что получилось.',
  'Твой ход — твоё решение! Разберём после партии.',
];

/** Extra (not in ARCHITECTURE §3): the child said «Оставлю свой ход». */
export function buildTakebackDeclined(profile: StudentProfile, rng: Rng = Math.random): CoachEvent {
  const s = studentWords(profile);
  const event = makeEvent({
    kind: 'encourage',
    priority: 1,
    pose: 'talk',
    pauseClock: false,
    profile,
    template: say(pick(TAKEBACK_DECLINED, rng)),
    brief: composeBrief({
      moment: `${s.nom} ${s.g('решил', 'решила')} оставить свой ход, партия продолжается`,
      facts: ['под доской три кнопки-ответа: почему ход оставлен'],
      goal: 'уважай решение одной короткой фразой, без упрёка; можно сказать, что посмотрите этот момент после партии',
      forbid: ['не говори, что ход плохой, и не пугай', FORBID_BEST_MOVE],
    }),
  });
  return eventTwin(event, [wholeSentence('takeback.declined', 100)]);
}

const TAKEBACK_ACCEPTED: readonly string[] = [
  'Отлично, ход вернули. Не спеши: что хочет соперник?',
  'Ход вернули. Спокойно посмотри на доску — я рядом.',
  'Вернули! Думай сколько нужно, а если что — жми «Подсказка».',
  'Остановиться и проверить ещё раз — сильная привычка.',
];

/** Extra (not in ARCHITECTURE §3): the child said «Верну ход и подумаю». */
export function buildTakebackAccepted(profile: StudentProfile, rng: Rng = Math.random): CoachEvent {
  const s = studentWords(profile);
  const event = makeEvent({
    kind: 'encourage',
    priority: 1,
    pose: 'think',
    pauseClock: true,
    profile,
    template: say(pick(TAKEBACK_ACCEPTED, rng)),
    brief: composeBrief({
      moment: `${s.nom} ${s.g('согласился', 'согласилась')} вернуть ход`,
      facts: ['позиция восстановлена', 'опасные клетки подсвечены красным', 'можно нажать «Подсказка» или спросить тебя'],
      goal: [
        `похвали за то, что ${s.g('остановился', 'остановилась')} и ${s.g('решил', 'решила')} проверить, — за привычку, а не за ум`,
        'предложи спокойно поискать другой ход; можно спросить, что хочет соперник',
      ],
      forbid: [FORBID_BEST_MOVE, 'не торопи', FORBID_LONG],
    }),
  });
  return eventTwin(event, [wholeSentence('takeback.accepted', 100)]);
}

/** Why the child kept the move — three tappable answers, no typing (research 05: the child's thinking is data). */
export const TAKEBACK_DECLINE_REASONS = ['planned', 'dontSee', 'risk'] as const;
export type TakebackDeclineReason = (typeof TAKEBACK_DECLINE_REASONS)[number];

/** Button label of a decline reason, in the child's own voice (first person, gendered). */
export function declineReasonLabelRu(reason: TakebackDeclineReason, address: StudentProfile['address']): string {
  switch (reason) {
    case 'planned':
      return address === 'f' ? 'Я так задумала' : 'Я так задумал';
    case 'dontSee':
      return 'Не вижу, что не так';
    case 'risk':
      return 'Хочу рискнуть';
  }
}

const DECLINE_REASON_REPLIES: Readonly<Record<TakebackDeclineReason, readonly string[]>> = {
  planned: ['Понял, у тебя свой план! Проверим его на доске.', 'Свой план — это здорово. Посмотрим, как он сработает!'],
  dontSee: ['Хорошо! После партии вместе разберём этот ход.', 'Ничего страшного. После партии посмотрим этот момент вместе.'],
  risk: ['Смело! Посмотрим, что получится.', 'Риск — дело интересное. Играем дальше!'],
};

/** Extra: a short, never judging reply to the tapped reason. Priority 0 — it may be dropped when the coach is busy. */
export function buildDeclineReasonReply(reason: TakebackDeclineReason, profile: StudentProfile, rng: Rng = Math.random): CoachEvent {
  return eventTwin(declineReasonEvent(reason, profile, rng), [wholeSentence(`takeback.reason.${reason}`, 100)]);
}

function declineReasonEvent(reason: TakebackDeclineReason, profile: StudentProfile, rng: Rng): CoachEvent {
  const s = studentWords(profile);
  const goals: Readonly<Record<TakebackDeclineReason, string>> = {
    planned: 'коротко поддержи и с интересом спроси, какой у него план, — пусть расскажет в двух словах',
    dontSee: 'успокой: ничего страшного, после партии посмотрите этот момент вместе',
    risk: 'коротко отметь смелость, без оценки хода',
  };
  return makeEvent({
    kind: 'encourage',
    priority: 0,
    pose: 'talk',
    pauseClock: false,
    profile,
    template: say(pick(DECLINE_REASON_REPLIES[reason], rng)),
    brief: composeBrief({
      moment: `${s.nom} ${s.g('объяснил', 'объяснила')}, почему ${s.g('оставил', 'оставила')} свой ход`,
      facts: [`ответ ${s.gen}: «${declineReasonLabelRu(reason, profile.address)}»`],
      goal: reason === 'planned' && profile.address === 'f' ? goals.planned.replace('у него', 'у неё') : goals[reason],
      forbid: [FORBID_BEST_MOVE, FORBID_SHAME],
    }),
  });
}

const VOLUNTARY_TAKEBACK: readonly string[] = [
  'Ход вернули — бывает! Посмотри ещё раз и ходи.',
  'Вернули. Рука иногда спешит быстрее головы — не беда!',
  'Готово, ход вернули. Сначала смотрим — потом ходим!',
];

/** Extra: the child pressed «Вернуть ход» in a training game (a slip of the hand is not a mistake). */
export function buildVoluntaryTakeback(profile: StudentProfile, rng: Rng = Math.random): CoachEvent {
  const s = studentWords(profile);
  const event = makeEvent({
    kind: 'encourage',
    priority: 1,
    pose: 'talk',
    pauseClock: false,
    profile,
    template: say(pick(VOLUNTARY_TAKEBACK, rng)),
    brief: composeBrief({
      moment: `${s.nom} ${s.g('сам', 'сама')} ${s.g('вернул', 'вернула')} свой последний ход кнопкой: рука поспешила`,
      goal: 'ободри одной короткой фразой: так бывает; сначала смотрим — потом ходим',
      forbid: [FORBID_SHAME],
    }),
  });
  return eventTwin(event, [wholeSentence('takeback.voluntary', 100)]);
}

// ═════════════════════════ hint ladder ═════════════════════════

type HintIdea = 'mate' | 'captureFree' | 'capture' | 'check' | 'saveHanging' | 'castle' | 'promotion' | 'develop' | 'defend' | 'quiet';

function hintIdea(move: ResolvedMove, best: AnalysisResult, facts: PositionFacts): HintIdea {
  const mate = best.lines[0]?.mate ?? null;
  if (move.givesMate || (mate !== null && mate > 0 && mate <= 3)) return 'mate';
  if (move.isCastle) return 'castle';
  if (move.promotion) return 'promotion';
  const me = move.color;
  if (move.captured) {
    const free = facts.hanging.some((h) => h.color !== me && h.square === move.to && h.seeLossCp > 0);
    return free ? 'captureFree' : 'capture';
  }
  if (facts.hanging.some((h) => h.color === me && h.square === move.from && h.seeLossCp > 0)) return 'saveHanging';
  if (move.givesCheck) return 'check';
  if (facts.hanging.some((h) => h.color === me && h.seeLossCp >= THREAT_WARNING_MIN_SEE_CP)) return 'defend';
  const homeRank = me === 'w' ? '1' : '8';
  if (facts.phase === 'opening' && (move.piece === 'n' || move.piece === 'b') && move.from[1] === homeRank) return 'develop';
  return 'quiet';
}

const HINT_LEAD_INS: readonly string[] = ['Давай вместе.', 'Так-так-так…', 'Подумаем!', 'Хороший момент, чтобы подумать.', ''];

const HINT_L1_QUESTIONS: Readonly<Record<HintIdea, readonly string[]>> = {
  mate: ['Проверь все шахи: нет ли среди них мата?', 'Посмотри на короля соперника: куда он может убежать?'],
  captureFree: ['Какая фигура соперника осталась без защиты?', 'Что у соперника можно забрать бесплатно?'],
  capture: ['Какие взятия у тебя есть — и какое самое выгодное?', 'Проверь все взятия: кто что заберёт в ответ?'],
  check: ['Какие шахи у тебя есть?', 'Что будет, если побеспокоить короля соперника?'],
  saveHanging: ['Какая твоя фигура сейчас под боем?', 'Всем ли твоим фигурам спокойно?'],
  defend: ['Что хочет соперник — на что он напал?', 'Какой твоей фигуре нужна помощь?'],
  castle: ['Безопасно ли твоему королю в центре?', 'Как спрятать короля и разбудить ладью одним ходом?'],
  promotion: ['Какая твоя пешка ближе всех к превращению?', 'Кто мешает твоей пешке добежать до конца?'],
  develop: ['Какие твои фигуры ещё спят дома?', 'Кого пора разбудить и вывести в игру?'],
  quiet: ['Что хочет соперник, и какая твоя фигура стоит хуже всех?', 'Какие у тебя есть шахи, взятия и угрозы?'],
};

const HINT_GENERIC_QUESTIONS: readonly string[] = [
  'Что хочет соперник?',
  'Какие у тебя есть шахи, взятия и угрозы?',
  'Какой ход тебе нравится — и безопасен ли он?',
  'Назови два хода, которые тебе нравятся, и выбери лучший.',
];

const ZONE_ACC: Readonly<Record<BoardZone, string>> = {
  kingside: 'королевский фланг',
  queenside: 'ферзевый фланг',
  center: 'центр доски',
};

const ZONE_LOC: Readonly<Record<BoardZone, string>> = {
  kingside: 'на королевском фланге',
  queenside: 'на ферзевом фланге',
  center: 'в центре доски',
};

const HINT_L2_NUDGE: Readonly<Record<HintIdea, string>> = {
  mate: 'Там можно поймать короля.',
  captureFree: 'Там есть что забрать.',
  capture: 'Там есть интересное взятие.',
  check: 'Там прячется шах.',
  saveHanging: 'Там твоей фигуре нужна помощь.',
  defend: 'Там твоей фигуре нужна помощь.',
  castle: 'Там королю будет спокойнее.',
  promotion: 'Там пешка рвётся вперёд.',
  develop: 'Туда хорошо вывести фигуру.',
  quiet: 'Там можно усилить позицию.',
};

function hintL2Templates(zone: BoardZone, idea: HintIdea): readonly Template[] {
  const nudge = HINT_L2_NUDGE[idea];
  return [
    say(`Посмотри на ${ZONE_ACC[zone]} — я подсветил клетки жёлтым. ${nudge}`),
    say(`Самое интересное сейчас — ${ZONE_LOC[zone]}. ${nudge}`),
    say(`Подсказываю место: ${ZONE_ACC[zone]}. ${nudge}`),
    say(`Ищи ${ZONE_LOC[zone]}, где жёлтые клетки. ${nudge}`),
  ];
}

function hintL3Second(idea: HintIdea, p: PieceType): string {
  const he = pronounNom(p);
  const He = he.charAt(0).toUpperCase() + he.slice(1);
  switch (idea) {
    case 'mate':
      return `${He} может поставить мат — найдёшь как?`;
    case 'captureFree':
    case 'capture':
      return `${He} может кое-что забрать — найдёшь что?`;
    case 'check':
      return `${He} может дать шах — куда?`;
    case 'saveHanging':
      return `${He} под боем — куда ${pronounDat(p)} лучше уйти?`;
    case 'castle':
      return 'Как спрятать его в безопасный домик?';
    case 'promotion':
      return 'Она совсем близко к превращению!';
    case 'develop':
      return `${He} ещё не ${pieceG(p, 'вышел', 'вышла')} в игру — куда ${pronounAcc(p)} поставить?`;
    case 'defend':
      return `${He} может помочь другой твоей фигуре — как?`;
    case 'quiet':
      return `Куда ${pronounDat(p)} лучше пойти?`;
  }
}

function hintL3Templates(move: ResolvedMove, idea: HintIdea): readonly Template[] {
  const p = move.piece;
  const second = hintL3Second(idea, p);
  // the piece, never its square: the board highlights it in blue
  return [
    say(`Посмотри на ${ownPieceAcc(p)}. ${second}`),
    say(`Подсказываю фигуру: ${yourPieceNom(p)}. ${second}`),
    say(`Главный герой этого хода — ${yourPieceNom(p)}. ${second}`),
    say(`Я подсветил синим ${yourPieceAcc(p)}. ${second}`),
  ];
}

function hintL4Why(idea: HintIdea, move: ResolvedMove): string {
  const p = move.piece;
  switch (idea) {
    case 'mate':
      return move.givesMate ? 'Это мат!' : 'Так ты идёшь прямо к мату.';
    case 'captureFree':
      return 'Фигура соперника стояла без защиты.';
    case 'capture':
      return 'Это выгодное взятие.';
    case 'check':
      return 'Это шах, и сопернику придётся защищаться.';
    case 'saveHanging':
      return `Так ${pieceWord(p, 'nom')} уходит из-под боя.`;
    case 'castle':
      return 'Король прячется в домик, а ладья выходит в игру.';
    case 'promotion':
      // (the move words already say «пешка превращается в ферзя»)
      return 'Так у тебя появится новая фигура!';
    case 'develop':
      return 'Ещё одна фигура выходит в игру.';
    case 'defend':
      return 'Так все твои фигуры под защитой.';
    case 'quiet':
      return 'Этот ход делает твою позицию крепче.';
  }
}

/** The level-4 reason in the third person (the template's «твою позицию» would be the model's own position). */
function hintL4WhyBrief(idea: HintIdea, move: ResolvedMove, s: StudentWords): string {
  switch (idea) {
    case 'mate':
      return move.givesMate ? 'это мат' : 'так идут прямо к мату';
    case 'captureFree':
      return 'фигура соперника стояла без защиты';
    case 'capture':
      return 'это самое выгодное взятие';
    case 'check':
      return 'это шах, и сопернику придётся защищаться';
    case 'saveHanging':
      return `так ${pieceWord(move.piece, 'nom')} уходит из-под боя`;
    case 'castle':
      return 'король прячется в домик, а ладья выходит в игру';
    case 'promotion':
      return 'пешка добегает до конца и превращается';
    case 'develop':
      return 'ещё одна фигура выходит в игру';
    case 'defend':
      return `так все фигуры ${s.gen} под защитой`;
    case 'quiet':
      return `этот ход делает позицию ${s.gen} крепче`;
  }
}

/**
 * Level 4: the green arrow shows the move; the words say its piece (what it takes) and why — never the square, never
 * «лучший» / «сильнейший» (the engine's first line has no proven margin here).
 */
function hintL4Templates(move: ResolvedMove, idea: HintIdea): readonly Template[] {
  const why = hintL4Why(idea, move);
  const what = moveWordsRu(move);
  return [
    say(`Смотри на зелёную стрелку: ${what}. ${why}`),
    say(`Я бы сыграл так: ${what}. ${why}`),
    say(`Показываю стрелкой: ${what}. ${why}`),
    say(`Вот подсказка — ${what}. ${why}`),
  ];
}

/**
 * Hint ladder. 1 = Socratic question (no board marks), 2 = board zone in YELLOW (a 3×3 block that
 * contains the target somewhere — never reliably in its middle),
 * 3 = the piece to move in BLUE, 4 = GREEN arrow of the best move + why.
 * `best` must be an analysis of `fen`; when it has no legal best move a generic question is returned.
 */
export function buildHint(
  level: HintLevel,
  a: { fen: string; best: AnalysisResult; facts: PositionFacts; profile: StudentProfile },
  rng: Rng = Math.random,
): CoachEvent {
  const bestUci = a.best.lines[0]?.pvUci[0] ?? a.best.bestmove;
  const move = bestUci ? resolveUciMove(a.fen, bestUci) : undefined;
  const base = { kind: 'hint' as const, priority: 2 as const, pose: 'think' as const, pauseClock: true, profile: a.profile, hintLevel: level };

  const s = studentWords(a.profile);
  const asked = `${s.nom} ${s.g('попросил', 'попросила')} подсказку`;
  if (!move) {
    const question = pick(HINT_GENERIC_QUESTIONS, rng);
    return makeEvent({
      ...base,
      template: say(question),
      brief: composeBrief({
        moment: `${asked}, но точной подсказки сейчас нет`,
        facts: ['точных данных о позиции сейчас нет'],
        goal: `задай один общий вопрос-наводку; мысль — «${question}», но скажи её по-своему, не этими словами`,
        forbid: ['не выдумывай ходы и угрозы', FORBID_BEST_MOVE],
      }),
    });
  }
  const idea = hintIdea(move, a.best, a.facts);

  if (level === 1) {
    const lead = pick(HINT_LEAD_INS, rng);
    const question = pick(HINT_L1_QUESTIONS[idea], rng);
    return makeEvent({
      ...base,
      template: say(`${lead} ${question}`),
      brief: composeBrief({
        moment: `${asked}: первая ступень из четырёх — вопрос-наводка`,
        facts: [hintIdeaFact(idea, s)],
        goal: [`задай один наводящий вопрос; мысль — «${question}», но скажи её по-своему, не этими словами`, 'потом слушай ответ'],
        forbid: [FORBID_BEST_MOVE, 'не называй фигуру и не показывай место на доске'],
      }),
    });
  }
  if (level === 2) {
    const board: BoardAnnotations = {
      arrows: [],
      highlights: zoneSquares(move.to, a.fen).map((square) => ({ square, color: 'yellow' as const })),
    };
    return makeEvent({
      ...base,
      template: pick(hintL2Templates(zoneOf(move.to), idea), rng, 'hint.2'),
      board,
      brief: composeBrief({
        moment: `${asked}: вторая ступень из четырёх — куда смотреть`,
        facts: [`смотреть нужно ${ZONE_LOC[zoneOf(move.to)]}: там на доске подсвечены жёлтые клетки`, hintIdeaFact(idea, s)],
        goal: `скажи, куда посмотреть, и спроси, что ${s.nom} там видит`,
        forbid: [FORBID_BEST_MOVE, 'не называй фигуру, которой ходить'],
      }),
    });
  }
  if (level === 3) {
    const board: BoardAnnotations = { arrows: [], highlights: [{ square: move.from, color: 'blue' }] };
    return makeEvent({
      ...base,
      template: pick(hintL3Templates(move, idea), rng, 'hint.3'),
      board,
      brief: composeBrief({
        moment: `${asked}: третья ступень из четырёх — какой фигурой ходить`,
        facts: [`ходить стоит ${pieceNameRu(move.piece, 'ins')} с клетки ${squareToSpokenRu(move.from)}: она подсвечена синим`, hintIdeaFact(idea, s)],
        goal: 'назови эту фигуру и спроси, куда ей лучше пойти',
        forbid: ['не называй клетку, куда идти, и сам ход'],
      }),
    });
  }
  const board: BoardAnnotations = { arrows: [{ from: move.from, to: move.to, color: 'green' }], highlights: [] };
  return makeEvent({
    ...base,
    pose: 'talk',
    template: pick(hintL4Templates(move, idea), rng, 'hint.4'),
    board,
    brief: composeBrief({
      moment: `${asked}: четвёртая, последняя ступень — сам ход`,
      facts: [`сильный ход: ${spokenMoveRu(move.san, a.fen)}`, `почему: ${hintL4WhyBrief(idea, move, s)}`, 'на доске зелёная стрелка'],
      goal: `назови ход и одной фразой объясни, почему он хорош; предложи ${s.dat} сделать его ${s.g('самому', 'самой')}`,
      forbid: [FORBID_LONG],
    }),
  });
}

/** What the position is about, for the model — as abstract as the level-1 question (no piece, no square). */
function hintIdeaFact(idea: HintIdea, s: StudentWords): string {
  switch (idea) {
    case 'mate':
      return 'в позиции есть мат или прямая атака на короля соперника';
    case 'captureFree':
      return 'у соперника есть фигура без защиты';
    case 'capture':
      return 'есть выгодное взятие';
    case 'check':
      return 'есть полезный шах';
    case 'saveHanging':
      return `одна фигура ${s.gen} под боем, её нужно спасать`;
    case 'defend':
      return `соперник нападает: одной фигуре ${s.gen} нужна помощь`;
    case 'castle':
      return 'королю пора в безопасное место';
    case 'promotion':
      return `пешка ${s.gen} близко к превращению`;
    case 'develop':
      return `не все фигуры ${s.gen} вышли в игру`;
    case 'quiet':
      return 'срочного ничего нет: можно усилить позицию';
  }
}

// ═════════════════════════ explain best ═════════════════════════

const MISSED_TAIL: Readonly<Record<MotifId, string>> = {
  hangingPiece: 'фигура соперника стояла без защиты',
  freeCapture: 'это бесплатное взятие',
  badTrade: 'это выгодный размен',
  fork: 'это вилка',
  pin: 'это связка',
  skewer: 'это сквозной удар',
  discoveredAttack: 'это вскрытое нападение',
  doubleCheck: 'это двойной шах',
  removeDefender: 'так убирается защитник',
  trappedPiece: 'так ловится фигура соперника',
  backRankMate: 'это мат на последней линии',
  mateIn1: 'это мат',
  mateIn2: 'это мат в два хода',
  mateIn3: 'это мат в три хода',
  promotion: 'пешка бежит к превращению',
  kingSafety: 'так королю спокойнее',
  development: 'в игру выходит ещё одна фигура',
  center: 'так ты занимаешь центр',
};


/**
 * The better move is a noun phrase in the nominative («конь бьёт пешку», «ход слоном»): it always follows a colon —
 * never «Сильнее было конь бьёт …» (docs/voice-clips/SPEC.md §3.5). Its square is never said: the green arrow shows it.
 */
const EXPLAIN_HEADS: readonly ((best: string) => Template)[] = [
  (best) => () => `Сильнее было так: ${best}`,
  (best) => () => `Я бы сыграл так: ${best}`,
  (best) => () => `Смотри на зелёную стрелку: ${best}`,
  (best) => () => `Вот ход посильнее: ${best}`,
  (best) => (v) => `Ты ${v.g('сходил', 'сходила')} иначе, а сильнее было так: ${best}`,
];

/** The child's own move was the engine's first line: confirm it concretely — no «лучший ход», no «так держать». */
const EXPLAIN_FOUND_BEST: readonly ((best: string) => Template)[] = [
  () => (v) => `Ты ${v.g('нашёл', 'нашла')} самый сильный ход в этой позиции!`,
  (best) => () => `Так и надо было: ${best} — сильнее тут ничего нет.`,
  () => (v) => `Сильнее хода тут нет — ты ${v.g('выбрал', 'выбрала')} его ${v.g('сам', 'сама')}!`,
  () => (v) => `Зелёная стрелка — это твой ход. Ты ${v.g('нашёл', 'нашла')} его ${v.g('сам', 'сама')}!`,
];

/**
 * «Сильнее было … — это вилка. А после твоего хода …». GREEN arrow = best move,
 * RED arrow = the opponent's refutation of the played move.
 */
export function buildExplainBest(j: MoveJudgement, profile: StudentProfile, rng: Rng = Math.random): CoachEvent {
  // the better move by its piece (the green arrow shows where); the bubble shows the same words
  const best = uciWordsRu(j.fenBefore, j.bestUci, 'ход по зелёной стрелке');
  const bestParts = parseUci(j.bestUci);
  const arrows: BoardAnnotations['arrows'] = [];
  if (bestParts) arrows.push({ from: bestParts.from, to: bestParts.to, color: 'green' });

  const s = studentWords(profile);
  const played = spokenMoveRu(j.san, j.fenBefore) || 'последний ход';
  if (j.bestUci === j.uci) {
    return makeEvent({
      kind: 'explainBest',
      priority: 1,
      pose: 'cheer',
      pauseClock: true,
      profile,
      template: pick(EXPLAIN_FOUND_BEST, rng)(best),
      board: { arrows, highlights: [] },
      motif: j.missedMotif,
      judgement: j,
      brief: composeBrief({
        moment: `${s.nom} ${s.g('спросил', 'спросила')} про свой последний ход`,
        facts: [`ход ${s.gen}: ${played}`, 'это и был самый сильный ход в позиции', j.missedMotif ? `в нём ${motifWithGlossRu(j.missedMotif)}` : null],
        goal: 'порадуйся конкретно: что именно получилось',
        forbid: ['не хвали за ум и талант', FORBID_LONG],
      }),
    });
  }

  const refParts = parseUci(j.refutationPvUci[0] ?? '');
  if (refParts) arrows.push({ from: refParts.from, to: refParts.to, color: 'red' });

  const head = pick(EXPLAIN_HEADS, rng)(best);
  const missedTail = j.missedMotif ? ` — ${MISSED_TAIL[j.missedMotif]}` : '';
  // (no notation of the reply: the red arrow shows it, the bubble says the same words)
  const allowed: Template = () => {
    if (j.allowedMotif) return `А после твоего хода ${ALLOWED_AFTER[j.allowedMotif]}.`;
    if (getsMatedSoon(j)) return 'А после твоего хода появляется угроза мата.';
    if (!refParts) return 'А твой ход давал сопернику больше шансов.';
    return 'А после твоего хода у соперника сильный ответ — красная стрелка.';
  };
  const full: Template = (v) => `${head(v)}${missedTail}. ${allowed(v)}`;
  const noTail: Template = (v) => `${head(v)}. ${allowed(v)}`;
  const minimal: Template = (v) => `Сильнее было так: ${best}. ${allowed(v)}`;

  const bestSpoken = spokenMoveRu(j.bestSan, j.fenBefore);
  const reply = spokenLineRu(j.fenAfter, j.refutationPvSan, 1)[0];
  return makeEvent({
    kind: 'explainBest',
    priority: 1,
    pose: 'talk',
    pauseClock: true,
    profile,
    template: firstFitting([full, noTail, minimal], profile, MAX_IN_GAME_WORDS),
    board: { arrows, highlights: [] },
    motif: j.missedMotif ?? j.allowedMotif,
    judgement: j,
    // A post-mortem: the position has changed, so the better move of THAT position may be named (the tool host
    // never asks for this while the same move can still be replayed).
    brief: composeBrief({
      moment: `разбор последнего хода ${s.gen}: этот ход кое-что потерял`,
      facts: [
        `ход ${s.gen}: ${played}`,
        reply ? `у соперника на это сильный ответ: ${reply} — на доске красная стрелка` : null,
        j.allowedMotif ? allowedFactRu(j.allowedMotif) : getsMatedSoon(j) ? 'после этого хода появилась угроза мата' : null,
        ...lossFactsRu(j, s),
        bestSpoken ? `сильнее был ход: ${bestSpoken}${j.missedMotif ? ` — ${MISSED_TAIL[j.missedMotif]}` : ''}; на доске зелёная стрелка` : null,
      ],
      goal: 'без упрёка, одной-двумя фразами объясни, что случилось и что было сильнее; предложи запомнить идею на будущее',
      forbid: [FORBID_SHAME, 'не говори «я же предупреждал»'],
    }),
  });
}

// ═════════════════════════ praise ═════════════════════════

function praiseHeads(j: MoveJudgement, motif: MotifId | undefined): readonly Template[] {
  const isMate = j.san.includes('#');
  if (isMate) return [say('Мат — красиво!'), say('Мат, и король пойман!')];
  switch (motif) {
    case 'fork':
      return [say('Вилка — одним ходом сразу на две фигуры!'), say('Ого, вилка!')];
    case 'pin':
      return [say('Связка — фигура соперника теперь не может уйти!'), say('Ого, связка!')];
    case 'skewer':
      return [say('Сквозной удар — прямо насквозь!'), say('Ого, сквозной удар!')];
    case 'discoveredAttack':
      return [say('Вскрытое нападение — одна фигура отошла, другая напала!'), say('Ого, вскрытое нападение!')];
    case 'doubleCheck':
      return [say('Двойной шах — самый сильный шах на свете!'), say('Ого, двойной шах!')];
    case 'removeDefender':
      return [say('Защитник убран — здорово придумано!'), say('Ого, защитника больше нет!')];
    case 'trappedPiece':
      return [say('Фигура соперника поймана — ей некуда уйти!'), say('Ловушка захлопнулась!')];
    case 'hangingPiece':
    case 'freeCapture':
      return [(v) => `Фигура стояла без защиты — и ты её ${v.g('забрал', 'забрала')}!`, say('Зоркий глаз!')];
    case 'badTrade':
      return [say('Выгодный размен!'), say('Размен в твою пользу!')];
    case 'backRankMate':
      return [say('Король соперника заперт своими пешками — отличная идея!'), say('Удар по последней линии!')];
    case 'mateIn1':
    case 'mateIn2':
    case 'mateIn3':
      return [(v) => `Ты ${v.g('увидел', 'увидела')} дорогу к мату!`, say('Король соперника в беде!')];
    case 'promotion':
      return [say('Пешка рвётся в ферзи!'), say('Пешка бежит к превращению!')];
    case 'kingSafety':
      return [say('Король в безопасности — мудрый ход!'), say('Королю теперь спокойно!')];
    case 'development':
      return [say('Ещё одна фигура в игре — теперь она помогает!'), say('Фигуры просыпаются!')];
    case 'center':
      return [say('Центр твой — отличный ход!'), say('Сильный ход в центре!')];
    default: {
      const generic: Template[] = [
        say('Вот это ход!'),
        say('Ух ты, сильно!'),
        say('Отлично сыграно!'),
        (v) => v.hey('это сильный ход!'),
      ];
      if (j.san.startsWith('N')) generic.push(say('Ход конём!'));
      return generic;
    }
  }
}

function praiseTails(j: MoveJudgement): readonly Template[] {
  const tails: Template[] = [
    say('Так думают мастера!'),
    (v) => `Видно, что ты ${v.g('смотрел', 'смотрела')} на всю доску.`,
    (v) => `Ты ${v.g('заметил', 'заметила')} главную идею — вот это работа!`,
    (v) => `Сначала ${v.g('подумал', 'подумала')}, потом ${v.g('сходил', 'сходила')} — вот наш секрет!`,
  ];
  if (j.classification === 'best' || j.uci === j.bestUci) {
    tails.push((v) => `Ты ${v.g('нашёл', 'нашла')} самый сильный ход в позиции.`);
  }
  return tails;
}

/**
 * Short, concrete, process-oriented praise (priority 0 — dropped when the coach is busy).
 * The motif the child FOUND is `foundMotif`, or else `j.missedMotif` (= "motif of the best move",
 * which is the move the child played). Pass `foundMotif` when the judgement carries none.
 */
export function buildPraise(
  j: MoveJudgement,
  profile: StudentProfile,
  rng: Rng = Math.random,
  foundMotif?: MotifId,
  opts: { onlyMove?: boolean } = {},
): CoachEvent {
  const motif = foundMotif ?? j.missedMotif;
  const head = pick(praiseHeads(j, motif), rng, `praise.head.${motif ?? 'generic'}`);
  const tail = pick(praiseTails(j), rng, 'praise.tail');
  const s = studentWords(profile);
  const best = j.classification === 'best' || j.uci === j.bestUci;
  const event = makeEvent({
    kind: 'praise',
    priority: 0,
    pose: 'cheer',
    pauseClock: false,
    profile,
    template: join(head, tail),
    motif,
    judgement: j,
    brief: composeBrief({
      moment: `${s.nom} только что ${s.g('сделал', 'сделала')} сильный ход`,
      facts: [
        `ход ${s.gen}: ${spokenMoveRu(j.san, j.fenBefore) || 'сильный ход'}`,
        j.san.includes('#') ? 'это мат, партия выиграна' : motif ? `это ${motifWithGlossRu(motif)}` : null,
        best ? 'это самый сильный ход в позиции' : 'это отличный ход',
        opts.onlyMove ? 'других хороших ходов здесь почти не было' : null,
      ],
      goal: [
        `порадуйся коротко и конкретно — за то, что ${s.g('заметил', 'заметила')} и ${s.g('проверил', 'проверила')}, а не за ум`,
        'можно спросить, как это получилось найти',
      ],
      forbid: ['не хвали за ум и талант', FORBID_LONG],
    }),
  });
  // what was found · the process («Сначала подумал, потом сходил — вот наш секрет!»)
  return eventTwin(event, [wholeSentence(lineItem(praiseLineOf(j, motif), { g: genderOf(profile) }), 100), wholeSentence(lineItem('praise.process', { g: genderOf(profile) }), 60)]);
}

/** The praise line of the found idea (`praiseHeads`' families). */
function praiseLineOf(j: Pick<MoveJudgement, 'san'>, motif: MotifId | undefined): string {
  if (j.san.includes('#')) return 'praise.mate';
  switch (motif) {
    case 'fork':
    case 'pin':
    case 'skewer':
    case 'doubleCheck':
    case 'removeDefender':
    case 'badTrade':
    case 'promotion':
    case 'kingSafety':
    case 'development':
    case 'center':
      return `praise.${motif}`;
    case 'discoveredAttack':
      return 'praise.discovered';
    case 'trappedPiece':
      return 'praise.trapped';
    case 'hangingPiece':
    case 'freeCapture':
      return 'praise.capture';
    case 'backRankMate':
      return 'praise.backRank';
    case 'mateIn1':
    case 'mateIn2':
    case 'mateIn3':
      return 'praise.mateIdea';
    default:
      return 'praise.generic';
  }
}

/** Motifs that count as a REAL tactic found by the child (a free capture or a quiet move does not). */
const REAL_TACTICS: ReadonlySet<MotifId> = new Set<MotifId>([
  'fork',
  'pin',
  'skewer',
  'discoveredAttack',
  'doubleCheck',
  'removeDefender',
  'trappedPiece',
  'backRankMate',
  'mateIn1',
  'mateIn2',
  'mateIn3',
  'promotion',
]);

/** A found tactic is worth saying in the normal talkativeness; other praise is optional chatter (design D). */
export function isRealTacticMotif(m: MotifId | undefined): boolean {
  return m !== undefined && REAL_TACTICS.has(m);
}

// ═════════════════════════ threat warning ═════════════════════════

function yourPieceAcc(p: PieceType): string {
  return `${pieceGenderRu(p) === 'f' ? 'твою' : 'твоего'} ${pieceWord(p, 'acc')}`;
}

const THREAT_SOCRATIC: readonly string[] = [
  'Что хочет соперник? Проверь, всем ли твоим фигурам спокойно.',
  'Перед ходом — быстрая проверка: что у тебя под боем?',
  'Копытом чую — соперник что-то задумал. Найдёшь его угрозу?',
  'Одной твоей фигуре сейчас неуютно. Найдёшь какой?',
];

/**
 * Warns (before the child moves) that one of the child's pieces is en prise.
 * Returns null when there is nothing worth a warning, or when the child is in check
 * (the check is the only thing that matters then, and the UI already shows it).
 * Up to stage 3 the piece is named and marked in RED; later the coach only asks.
 */
const THREAT_MATE_NAMED: readonly Template[] = [
  say('Осторожно: соперник грозит матом! Как защитить короля?'),
  say('Стоп, посмотри на своего короля: соперник хочет поставить мат. Что делать?'),
  say('Копытом чую опасность: у соперника угроза мата! Где спрятать короля?'),
];

function threatTacticNamed(m: MotifId): readonly Template[] {
  const title = motifTitleInlineRu(m);
  return [
    say(`Осторожно: соперник что-то готовит — кажется, ${title}! Что он задумал?`),
    say(`Копытом чую — у соперника идея: ${title}. Найдёшь её?`),
    say(`Что хочет соперник? Похоже, он готовит ${MOTIF_ACC_SHORT[m] ?? 'ловушку'}.`),
  ];
}

const MOTIF_ACC_SHORT: Partial<Readonly<Record<MotifId, string>>> = {
  fork: 'вилку',
  pin: 'связку',
  skewer: 'сквозной удар',
  discoveredAttack: 'вскрытое нападение',
  doubleCheck: 'двойной шах',
  removeDefender: 'размен защитника',
  trappedPiece: 'ловушку для фигуры',
  promotion: 'превращение пешки',
};


/**
 * Warns (before the child moves) that something is in danger: a piece of the child's is en prise, or — when the
 * game passes the opponent's engine-verified `threat` (null-move search, see ./threats.ts) — a mate or a tactic is
 * coming. Returns null when there is nothing worth a warning, or when the child is in check (the check is the only
 * thing that matters then, and the UI already shows it).
 * Up to stage 3 the piece / danger is named and marked in RED; later the coach only asks.
 * `lastMove` (optional): the opponent's move that created the danger — only for the brief.
 */
export function buildThreatWarning(
  a: { fen: string; facts: PositionFacts; profile: StudentProfile; threat?: Threat | null; lastMove?: { san: string; fenBefore: string } | null },
  rng: Rng = Math.random,
): CoachEvent | null {
  const { facts, profile } = a;
  if (facts.inCheck) return null;
  const mine = facts.hanging
    .filter((h) => h.color === facts.sideToMove && h.piece !== 'k' && h.seeLossCp >= THREAT_WARNING_MIN_SEE_CP)
    .sort((x, y) => y.seeLossCp - x.seeLossCp);
  const target = mine[0];
  const threat = a.threat ?? null;
  const mateThreat = threat !== null && isMateMotif(threat.motif);
  if (!target && !threat) return null;

  const brief = threatBrief(a, target, threat);
  const base = { kind: 'threatWarning' as const, priority: 1 as const, pose: 'think' as const, pauseClock: true, profile, brief };
  const motif: MotifId = mateThreat ? (threat as Threat).motif : target ? 'hangingPiece' : (threat as Threat).motif;
  if (profile.stage > THREAT_WARNING_NAMED_MAX_STAGE) {
    return makeEvent({ ...base, template: say(pick(THREAT_SOCRATIC, rng)), motif });
  }

  if (mateThreat || !target) {
    const t = threat as Threat;
    const squares = t.targetSquares.slice(0, 3);
    const board: BoardAnnotations = { arrows: [], highlights: squares.map((square) => ({ square, color: 'red' as const })) };
    const templates = mateThreat ? THREAT_MATE_NAMED : threatTacticNamed(t.motif);
    return makeEvent({ ...base, template: pick(templates, rng, mateThreat ? 'threat.mate' : 'threat.tactic'), board, motif });
  }

  const p = target.piece;
  // the piece, never its square: the board marks it (and its attackers) in red
  const templates: readonly Template[] = [
    say(`Осторожно: ${yourPieceNom(p)} под боем! Кто ${pronounAcc(p)} защищает?`),
    say(`Прежде чем ходить, глянь на ${ownPieceAcc(p)}. Спокойно ли ${pronounDat(p)} там?`),
    say(`Копытом чую: на ${yourPieceAcc(p)} кто-то напал! Как ${pronounDat(p)} помочь?`),
    say(`Что хочет соперник? Посмотри на ${ownPieceAcc(p)} — я подсветил красным.`),
    (v) => v.hey(`посмотри на ${ownPieceAcc(p)} — что задумал соперник?`),
  ];
  const board: BoardAnnotations = {
    arrows: target.attackers.slice(0, 2).map((from) => ({ from, to: target.square, color: 'red' as const })),
    highlights: [{ square: target.square, color: 'red' }],
  };
  return makeEvent({ ...base, template: pick(templates, rng, 'threat.named'), board, motif });
}

function threatBrief(
  a: { fen: string; profile: StudentProfile; lastMove?: { san: string; fenBefore: string } | null },
  target: PositionFacts['hanging'][number] | undefined,
  threat: Threat | null,
): string {
  const s = studentWords(a.profile);
  const last = a.lastMove ? spokenMoveRu(a.lastMove.san, a.lastMove.fenBefore) : '';
  const attackers = target
    ? target.attackers
        .slice(0, 2)
        .map((sq) => {
          const p = pieceAt(a.fen, sq);
          return p ? `${pieceNameRu(p.piece, 'nom')} соперника` : null;
        })
        .filter((x): x is string => x !== null)
    : [];
  const named = a.profile.stage <= THREAT_WARNING_NAMED_MAX_STAGE;
  const threatFacts = threat ? threatFactsRu(a.fen, threat, s) : [];
  // the same piece is the story of both — say it once
  const sameStory = threat !== null && target !== undefined && threatTargetPiece(a.fen, threat)?.square === target.square && !isMateMotif(threat.motif);
  return composeBrief({
    moment: `соперник ${last ? `сыграл ${last}` : 'сходил'}, и теперь у ${s.gen} появилась опасность; ход за ${s.g('ним', 'ней')}`,
    facts: [
      target ? `под боем ${pieceOnRu(target.piece, target.square)}${attackers.length > 0 ? `, нападает ${attackers.join(' и ')}` : ''}, защиты не хватает` : null,
      ...(sameStory ? [] : threatFacts),
    ],
    goal: named
      ? [`спроси, что хочет соперник, и помоги ${s.dat} ${s.g('самому', 'самой')} заметить опасность`, `если ${s.nom} не видит — назови, что под угрозой`]
      : ['спроси, что задумал соперник, не называя фигуру', `если ${s.nom} совсем не видит — намекни, где искать`],
    forbid: ['не называй ход, которым защититься', `не делай ход за ${s.acc}`, FORBID_LONG],
  });
}

// ═════════════════════════ thinking routine ═════════════════════════

const ROUTINE_TWO = 'Что хочет соперник? Мой ход безопасен?';
const ROUTINE_THREE = 'Что хочет соперник? Что могу я — шахи, взятия, угрозы? Безопасно ли?';

/** Up to this stage the routine is two questions; from the next one — three (research 05 §5). */
export const ROUTINE_TWO_QUESTIONS_MAX_STAGE = 2;

export function buildThinkingRoutine(profile: StudentProfile, rng: Rng = Math.random): CoachEvent {
  const two = profile.stage <= ROUTINE_TWO_QUESTIONS_MAX_STAGE;
  const routine = two ? ROUTINE_TWO : ROUTINE_THREE;
  const count = two ? 'два вопроса' : 'три вопроса';
  const templates: readonly Template[] = [
    say(`Помни наш секрет — ${count} перед каждым ходом. ${routine}`),
    say(`Сначала смотрим — потом ходим! ${routine}`),
    say(`${two ? 'Два' : 'Три'} вопроса мастера. ${routine}`),
    (v) => `${v.hey(`давай вспомним ${count}.`)} ${routine}`,
  ];
  return makeEvent({
    kind: 'thinkingRoutine',
    priority: 1,
    pose: 'think',
    pauseClock: true,
    profile,
    template: pick(templates, rng, `routine.${two ? 2 : 3}`),
    brief: composeBrief({
      moment: 'пора напомнить привычку перед каждым ходом',
      facts: [`вопросы привычки: ${routine}`],
      goal: 'напомни эти вопросы своими словами, коротко и весело',
      forbid: ['не называй ходы', FORBID_LONG],
    }),
  });
}

// ═════════════════════════ long silence ═════════════════════════

const SILENCE_NUDGES: readonly string[] = [
  'Думаешь? Можешь думать вслух — я слушаю.',
  'Не спеши. Если хочешь, расскажи, какой ход тебе нравится.',
  'Я рядом. Можешь спросить меня про любой ход.',
  'Хорошо думаешь! Скажи вслух, что хочет соперник?',
];

/**
 * Extra: the child has been thinking silently for a long time in an unhurried game — one gentle invitation to
 * think aloud (the game only sends it while a conversational voice is listening). Never hurries, never hints.
 */
export function buildSilenceNudge(profile: StudentProfile, rng: Rng = Math.random): CoachEvent {
  const s = studentWords(profile);
  return makeEvent({
    kind: 'encourage',
    priority: 1,
    pose: 'listen',
    pauseClock: false,
    profile,
    template: say(pick(SILENCE_NUDGES, rng)),
    brief: composeBrief({
      moment: `${s.nom} уже давно молча думает над ходом`,
      facts: ['это нормально: шахматисты думают долго'],
      goal: ['одной короткой фразой мягко предложи подумать вслух или спросить тебя — ты слушаешь', 'не торопи'],
      forbid: [FORBID_BEST_MOVE, 'не говори «быстрее»', 'не подсказывай'],
    }),
  });
}

// ═════════════════════════ game end ═════════════════════════

/**
 * The game end's first sentence, each with the catalogue line whose wording it is (the recorded twin says exactly the
 * opener the bubble shows); null: it names the opponent — never recorded, it stays in the bubble.
 */
function endOpeners(outcome: ChildOutcome, termination: Termination, opponent: string): readonly { t: Template; line: string | null }[] {
  const of = (line: string | null, ...texts: string[]) => texts.map((text) => ({ t: say(text), line }));
  switch (outcome) {
    case 'win': {
      const pool = of('end.win', 'Победа! И-го-го!', 'Победа! Дай копыто!', 'Ура, победа!');
      if (opponent) pool.push(...of(null, `Соперник сегодня — ${opponent}, и победа за тобой!`));
      else pool.push(...of('end.win', 'Победа за тобой!'));
      if (termination === 'checkmate') pool.push(...of('end.win.checkmate', 'Мат — и победа твоя!'));
      if (termination === 'timeout') pool.push(...of('end.win.timeout', 'У соперника кончилось время — победа твоя!'));
      return pool;
    }
    case 'loss': {
      const pool = of(
        'end.loss',
        'Обидно, понимаю. Даже чемпионы проигрывают.',
        'Трудная была партия. Проигрывать неприятно даже чемпионам.',
        'Ничего страшного: проиграть — значит чему-то научиться.',
        'Сегодня сильнее оказался соперник — так бывает у всех.',
      );
      if (termination === 'timeout') pool.push(...of('end.loss.timeout', 'Время закончилось — так бывает у всех.'));
      return pool;
    }
    case 'draw': {
      const pool = of('end.draw', 'Ничья — оба бились до конца.', 'Ничья! Боевая получилась партия.', 'Ничья — никто не уступил.', 'Мир на доске — ничья!');
      if (termination === 'stalemate') pool.push(...of('end.draw.stalemate', 'Пат — это ничья. Запомним этот приём!'));
      return pool;
    }
    case 'unfinished':
      return of('end.unfinished', 'Партия не доиграна — ничего страшного.', 'Остановились на полпути — так тоже бывает.', 'Эту партию доиграем в другой раз.', 'Пауза — тоже решение.');
  }
}

/** One thing that went well: the spoken template, the same fact in the third person for the brief, its recorded line. */
interface PraiseItem {
  template: Template;
  fact: string;
  /** «Записи»: the catalogue line of the same praise (`end.praise.*`) */
  clip: string;
}

function processPraiseItems(summary: GameSummary, outcome: ChildOutcome, termination: Termination, takebacksImproved: number, s: StudentWords): PraiseItem[] {
  const c = summary.counts;
  const total = c.best + c.excellent + c.good + c.inaccuracy + c.mistake + c.blunder + c.missedWin;
  const earned: PraiseItem[] = [];
  if (takebacksImproved > 0) {
    // only when the code has PROVED it: a different move with a smaller loss stayed on the board
    earned.push({
      template: (v) => `Мне понравилось, как ты ${v.g('вернул', 'вернула')} ход и ${v.g('нашёл', 'нашла')} лучше — вот это работа головой!`,
      fact: `${s.nom} ${s.g('вернул', 'вернула')} ход и ${s.g('нашёл', 'нашла')} ход лучше`,
      clip: 'end.praise.takebackImproved',
    });
  } else if (summary.takebacksAccepted > 0) {
    earned.push({
      template: (v) => `Ты ${v.g('вернул', 'вернула')} ход и ${v.g('подумал', 'подумала')} ещё раз — это сильная привычка.`,
      fact: `${s.nom} ${s.g('соглашался', 'соглашалась')} вернуть ход и подумать ещё раз`,
      clip: 'end.praise.takebackAccepted',
    });
  }
  if (total >= 8 && c.blunder === 0) {
    earned.push({ template: (v) => `Ты ${v.g('играл', 'играла')} внимательно: ни одного зевка за всю партию!`, fact: 'за всю партию ни одного грубого промаха', clip: 'end.praise.noBlunder' });
  }
  if (total >= 8 && summary.accuracy >= 80) {
    earned.push({ template: (v) => `Ты ${v.g('играл', 'играла')} очень точно — видно, что ${v.g('думал', 'думала')} над ходами.`, fact: 'партия сыграна очень точно', clip: 'end.praise.accurate' });
  }
  if (c.best + c.excellent >= 5) {
    // «сам» is only true in a game without hints
    earned.push(
      summary.hintsUsed > 0
        ? { template: (v) => `У тебя было много сильных ходов — ты ${v.g('искал', 'искала')} их внимательно.`, fact: 'было много сильных ходов (с подсказками)', clip: 'end.praise.manyStrongHints' }
        : { template: (v) => `У тебя было много сильных ходов, и ты ${v.g('нашёл', 'нашла')} их ${v.g('сам', 'сама')}.`, fact: `было много сильных ходов, найденных без подсказок`, clip: 'end.praise.manyStrong' },
    );
  }
  if (total >= 8 && summary.hintsUsed === 0 && summary.takebacksOffered === 0) {
    earned.push({ template: (v) => `Ты ${v.g('справился', 'справилась')} без единой подсказки.`, fact: 'партия сыграна без единой подсказки', clip: 'end.praise.noHints' });
  }
  if (earned.length > 0) return earned;

  const fallback: PraiseItem[] = [
    { template: (v) => `Ты ${v.g('старался', 'старалась')} и ${v.g('искал', 'искала')} хорошие ходы — это главное.`, fact: `${s.nom} ${s.g('старался', 'старалась')} и ${s.g('искал', 'искала')} хорошие ходы`, clip: 'end.praise.tried' },
    { template: (v) => `Каждая партия делает тебя сильнее, и сегодня ты ${v.g('поработал', 'поработала')} на славу.`, fact: `${s.nom} хорошо ${s.g('поработал', 'поработала')} за доской`, clip: 'end.praise.worked' },
  ];
  if (outcome !== 'unfinished' && termination !== 'resign' && termination !== 'abandoned') {
    fallback.push({ template: (v) => `Мне понравилось, что ты ${v.g('боролся', 'боролась')} до самого конца.`, fact: `${s.nom} ${s.g('боролся', 'боролась')} до самого конца`, clip: 'end.praise.fought' });
  }
  return fallback;
}


const PRACTICE_INTRO: Readonly<Record<ChildOutcome, readonly string[]>> = {
  win: ['Идея на завтра:', 'А чтобы стать ещё сильнее:'],
  loss: ['Одна идея на завтра:', 'Одна мысль на будущее:'],
  draw: ['Идея на завтра:', 'А чтобы в следующий раз победить:'],
  unfinished: ['Идея на следующий раз:', 'На будущее:'],
};

const PRACTICE_DEFAULT: readonly string[] = [
  'решим пару задачек, чтобы глаз оставался зорким.',
  'закрепим успех задачками.',
  'перед каждым ходом спрашиваем: «Это безопасно?»',
  'сыграем ещё партию и снова проверим каждый ход.',
];

/**
 * End-of-game line: result (feelings first after a loss) → ONE process praise → ONE thing to
 * practise (from summary.motifsAllowed / motifsMissed). `event.motif` carries the practice motif.
 *
 * `takebacksImproved` (extra, optional): how many take-backs ended with a provably better move
 * (`takebackOutcomes(...).filter(o => o.improved).length`). Without it the coach never claims
 * «нашёл лучше» — pressing the button is not the achievement.
 */
export function buildGameEnd(
  a: {
    result: GameResult;
    childColor: Color;
    termination: Termination;
    summary: GameSummary;
    persona: Persona;
    profile: StudentProfile;
    takebacksImproved?: number;
  },
  rng: Rng = Math.random,
): CoachEvent {
  const outcome = childOutcome(a.result, a.childColor);
  const opponentSpoken = speakableName(a.persona.name);
  const practiceMotif = pickPracticeMotif(a.summary);
  // (one item of the same list, the same draw: its template for `text`, its line for the recorded twin)
  const praiseItem = pick(processPraiseItems(a.summary, outcome, a.termination, a.takebacksImproved ?? 0, studentWords()), rng, 'gameEnd.praise');
  const praise = praiseItem.template;
  const intro = pick(PRACTICE_INTRO[outcome], rng);
  const practice = practiceMotif ? lowerFirst(motifPracticeLineRu(practiceMotif)) : pick(PRACTICE_DEFAULT, rng);
  const openerIndex = rng();

  const template: Template = (v) => {
    const opponent = v.mode === 'speech' ? opponentSpoken : a.persona.name.trim();
    const opener = pick(endOpeners(outcome, a.termination, opponent), () => openerIndex).t;
    return `${opener(v)} ${praise(v)} ${intro} ${practice}`;
  };

  const event = makeEvent({
    kind: 'gameEnd',
    priority: 2,
    pose: outcome === 'win' ? 'cheer' : outcome === 'loss' ? 'idle' : 'talk',
    pauseClock: false,
    profile: a.profile,
    template,
    motif: practiceMotif,
    brief: gameEndBrief(a, outcome, practice),
  });
  // the result — the line of the opener the bubble shows (its own words; one that names the opponent stays in the
  // bubble only) · the one thing that went well; the practice idea stays in the bubble (two sentences at most)
  const g = genderOf(a.profile);
  const resultLine = pick(endOpeners(outcome, a.termination, opponentSpoken), () => openerIndex).line;
  const result = resultLine !== null && hasClipLine(resultLine) ? resultLine : null;
  return eventTwin(event, [result !== null ? wholeSentence(lineItem(result, { g }), 100) : null, wholeSentence(lineItem(praiseItem.clip, { g }), result !== null ? 70 : 100)]);
}

function gameEndBrief(
  a: { result: GameResult; childColor: Color; termination: Termination; summary: GameSummary; persona: Persona; profile: StudentProfile; takebacksImproved?: number },
  outcome: ChildOutcome,
  practice: string,
): string {
  const s = studentWords(a.profile);
  const name = speakableName(a.persona.name);
  const RESULT: Readonly<Record<ChildOutcome, string>> = {
    win: `${s.nom} ${s.g('выиграл', 'выиграла')} партию${name ? ` у соперника по имени ${name}` : ''}`,
    loss: `${s.nom} ${s.g('проиграл', 'проиграла')} партию${name ? ` сопернику по имени ${name}` : ''}`,
    draw: `партия${name ? ` с соперником по имени ${name}` : ''} закончилась вничью`,
    unfinished: 'партию не доиграли',
  };

  const HOW: Readonly<Record<Termination, string | null>> = {
    checkmate: outcome === 'win' ? `${s.nom} ${s.g('поставил', 'поставила')} мат` : outcome === 'loss' ? 'соперник поставил мат' : null,
    resign: outcome === 'loss' ? `${s.nom} ${s.g('решил', 'решила')} сдаться` : outcome === 'win' ? 'соперник сдался' : null,
    timeout: outcome === 'win' ? 'у соперника закончилось время' : outcome === 'loss' ? `у ${s.gen} закончилось время` : 'закончилось время',
    stalemate: 'получился пат — это ничья',
    draw: null,
    abandoned: null,
  };
  const earned = processPraiseItems(a.summary, outcome, a.termination, a.takebacksImproved ?? 0, s).map((item) => item.fact);
  const GOAL: Readonly<Record<ChildOutcome, readonly string[]>> = {
    win: ['порадуйся вместе', 'назови одну конкретную вещь, которая получилась', 'и одну идею на будущее'],
    loss: ['сначала посочувствуй: проигрывать обидно даже чемпионам', 'потом назови одну конкретную вещь, которая получилась', 'и одну идею на будущее'],
    draw: ['порадуйся боевой партии', 'назови одну вещь, которая получилась, и одну идею на будущее'],
    unfinished: ['скажи, что ничего страшного и доиграем в другой раз'],
  };
  return composeBrief({
    moment: 'партия закончилась',
    facts: [RESULT[outcome], HOW[a.termination], earned.length > 0 ? `что получилось: ${earned.slice(0, 3).join('; ')}` : null, `идея на будущее: ${practice.replace(/[.!]+$/u, '')}`],
    goal: [...GOAL[outcome], 'можно спросить, что было самым трудным'],
    forbid: [FORBID_SHAME, 'не называй проценты и цифры точности', 'не сравнивай с другими детьми'],
  });
}
