/**
 * zod schemas mirroring `packages/shared/src/contracts.ts`. Every request body is validated
 * with these; the compile-time assertions at the bottom keep them in sync with the contract.
 */
import { z } from 'zod';
import { PERSONA_IDS, TIME_CONTROL_IDS } from '@gambit/shared';
import type {
  BoardAnnotations,
  ClipGenLine,
  ClipGenRequest,
  ClipGenSentence,
  ClipGenSettings,
  CoachEvent,
  CoachEventKind,
  ConceptCard,
  CurriculumStage,
  EvalScore,
  GameEvent,
  GameExclusion,
  GameExclusionRequest,
  GameRecord,
  GameStrategy,
  GameSummary,
  GameThought,
  GameThoughtsRequest,
  KeyMoment,
  LessonSaySentence,
  MoveJudgement,
  Persona,
  ProgressResetRequest,
  PuzzleAttempt,
  ReplanRequest,
  ReplanResponse,
  StrategyCard,
  StrategyRequest,
  StudentProfile,
  ThemeSkill,
} from '@gambit/shared';

const finite = z.number();
const pct = z.number().min(0).max(100);
const shortText = z.string().max(200);
const longText = z.string().max(4000);
// strict charsets: these strings are written into markdown files (inside backticks / tables) and
// must not be able to carry markup or one of the block markers
const fen = z
  .string()
  .min(10)
  .max(120)
  .regex(/^[A-Za-z0-9/ -]+$/);
const uci = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
const san = z.string().regex(/^[A-Za-z0-9+#=-]{2,12}$/);
const sanOrEmpty = z.string().regex(/^[A-Za-z0-9+#=-]{0,12}$/);
const square = z.string().regex(/^[a-h][1-8]$/);

export const colorSchema = z.enum(['w', 'b']);
export const personaIdSchema = z.enum(PERSONA_IDS);
export const timeControlIdSchema = z.enum(TIME_CONTROL_IDS);
export const moveClassSchema = z.enum(['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder', 'missedWin']);
export const motifIdSchema = z.enum([
  'hangingPiece',
  'freeCapture',
  'badTrade',
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
  'kingSafety',
  'development',
  'center',
]);
export const gameResultSchema = z.enum(['1-0', '0-1', '1/2-1/2', '*']);
export const terminationSchema = z.enum(['checkmate', 'resign', 'timeout', 'stalemate', 'draw', 'abandoned']);
export const gameEventTypeSchema = z.enum([
  'gameStart',
  'move',
  'takebackOffered',
  'takebackAccepted',
  'takebackDeclined',
  'hintRequested',
  'hintGiven',
  'coachSaid',
  'childSaid',
  'gameEnd',
]);

export const evalScoreSchema = z.object({
  cp: finite.nullable(),
  mate: finite.nullable(),
});

export const moveJudgementSchema = z.object({
  ply: z.number().int().min(0).max(2000),
  color: colorSchema,
  san,
  uci,
  fenBefore: fen,
  fenAfter: fen,
  evalBefore: evalScoreSchema,
  evalAfter: evalScoreSchema,
  winPctBefore: pct,
  winPctAfter: pct,
  winPctLoss: pct,
  classification: moveClassSchema,
  accuracy: pct,
  bestUci: z.string().max(5),
  bestSan: sanOrEmpty,
  bestPvSan: z.array(san).max(40),
  refutationPvSan: z.array(san).max(40),
  refutationPvUci: z.array(uci).max(40),
  allowedMotif: motifIdSchema.optional(),
  missedMotif: motifIdSchema.optional(),
  materialLossPawns: finite,
  confidence: z.enum(['quick', 'confirmed']),
});

export const keyMomentSchema = z.object({
  ply: z.number().int().min(0).max(2000),
  fenBefore: fen,
  playedSan: san,
  bestSan: sanOrEmpty,
  classification: moveClassSchema,
  motif: motifIdSchema.optional(),
  explanation: longText,
});

const count = z.number().int().min(0).max(10_000);

export const gameSummarySchema = z.object({
  accuracy: pct,
  acpl: finite.min(0),
  counts: z.object({
    best: count,
    excellent: count,
    good: count,
    inaccuracy: count,
    mistake: count,
    blunder: count,
    missedWin: count,
  }),
  takebacksOffered: count,
  takebacksAccepted: count,
  hintsUsed: count,
  motifsMissed: z.array(motifIdSchema).max(600),
  motifsAllowed: z.array(motifIdSchema).max(600),
  openingName: shortText.optional(),
  keyMoments: z.array(keyMomentSchema).max(50),
});

export const gameEventSchema = z.object({
  t: finite.min(0),
  type: gameEventTypeSchema,
  ply: z.number().int().min(0).max(2000).optional(),
  data: z.record(z.string(), z.unknown()),
});

const isoDate = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), { message: 'must be an ISO date-time' });

export const gameIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const coachStyleSchema = z.enum(['teacher', 'helper', 'exam']);

export const gameRecordSchema = z.object({
  id: gameIdSchema,
  startedAt: isoDate,
  endedAt: isoDate,
  personaId: personaIdSchema,
  timeControlId: timeControlIdSchema,
  childColor: colorSchema,
  result: gameResultSchema,
  termination: terminationSchema,
  pgn: z.string().max(200_000),
  events: z.array(gameEventSchema).max(10_000),
  judgements: z.array(moveJudgementSchema).max(1_000),
  summary: gameSummarySchema,
  examMode: z.boolean(),
  coachStyle: coachStyleSchema.optional(),
});

// ───────────── the size of a NEW game ─────────────
//
// Without a cap, one signed-in account could post a legal 200 KB PGN of ~28 000 plies (chess.js loadPgn 0.5 s, the
// journal ~0.9 s, synchronous) and then make the server re-render and recount it on every «играл взрослый» toggle. A
// new game is held to what a real game can be. Real records (a sample of 9 real games): at most 106
// plies, a PGN of at most 3 031 characters (~29 per ply with the clock comments), at most 140 events (up to 2.7 per
// ply: the teacher speaks a lot), the largest event `data` 453 characters (a coach's phrase), at most 77 KB a game
// (up to ~1.1 KB per ply). The caps leave a wide margin: a 300-move game (twice the longest game of a world
// championship) fits, with the chattiest teacher. Stored games are read with the plain schema: nothing saved before
// becomes unreadable.

/** plies of a new game (300 moves each side) */
export const MAX_GAME_PLIES = 600;
/** characters of its PGN: 600 plies × ~35 (a long SAN, the move number, the clock comment) + the headers */
export const MAX_GAME_PGN_CHARS = 32_000;
/** events of a new game: 5 per ply at 600 plies (the real ones: at most 2.7) */
export const MAX_GAME_EVENTS = 3_000;
/** characters of one event's `data` as JSON (the real ones: at most 453) */
export const MAX_GAME_EVENT_DATA_CHARS = 8_192;

/** every move names a square it goes to, or castles: counting those is an upper bound of the moves in a token */
const MOVE_MARK = /[a-h][1-8]|[O0]-[O0](?:-[O0])?/g;

/**
 * How many plies a PGN's main line holds — a cheap, linear upper bound, run BEFORE anything parses it with chess.js:
 * headers, comments `{…}` / `;…`, variations `(…)`, move numbers and the result are skipped; in what is left every
 * square named and every castling counts (so `e4e5Nf3`, with no spaces, counts 3, not 1; a move with a full-square
 * disambiguation, `Qh4e1`, counts 2 — never fewer plies than chess.js would read).
 */
export function pgnPlyCount(pgn: string): number {
  let plies = 0;
  let depth = 0;
  let i = 0;
  const n = pgn.length;
  const stop = (ch: string): boolean => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '{' || ch === ';' || ch === '(' || ch === ')' || ch === '[';
  while (i < n) {
    const ch = pgn[i] as string;
    if (ch === '{' || ch === ';' || (ch === '[' && depth === 0)) {
      const end = pgn.indexOf(ch === '{' ? '}' : ch === ';' ? '\n' : ']', i + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (stop(ch) || ch === ')') {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !stop(pgn[j] as string)) j++;
    const token = pgn.slice(i, j).replace(/^\d+\.+/, '');
    i = j;
    if (depth > 0 || token === '' || /^(?:1-0|0-1|1\/2-1\/2|\*)$/.test(token)) continue;
    plies += token.match(MOVE_MARK)?.length ?? 0;
  }
  return plies;
}

/** `POST /games`: the plain record schema plus the size of a real game (see above). */
export const newGameRecordSchema = gameRecordSchema.superRefine((record, ctx) => {
  if (record.pgn.length > MAX_GAME_PGN_CHARS) ctx.addIssue({ code: 'custom', path: ['pgn'], message: `a PGN of at most ${MAX_GAME_PGN_CHARS} characters` });
  else if (pgnPlyCount(record.pgn) > MAX_GAME_PLIES) ctx.addIssue({ code: 'custom', path: ['pgn'], message: `at most ${MAX_GAME_PLIES} plies` });
  if (record.events.length > MAX_GAME_EVENTS) ctx.addIssue({ code: 'custom', path: ['events'], message: `at most ${MAX_GAME_EVENTS} events` });
  const eventIssue = record.events.findIndex((e) => (e.ply ?? 0) > MAX_GAME_PLIES || JSON.stringify(e.data).length > MAX_GAME_EVENT_DATA_CHARS);
  if (eventIssue >= 0) ctx.addIssue({ code: 'custom', path: ['events', eventIssue], message: `an event of ply ≤ ${MAX_GAME_PLIES} with data of at most ${MAX_GAME_EVENT_DATA_CHARS} characters` });
  const judgementIssue = record.judgements.findIndex((j) => j.ply > MAX_GAME_PLIES);
  if (judgementIssue >= 0) ctx.addIssue({ code: 'custom', path: ['judgements', judgementIssue, 'ply'], message: `at most ply ${MAX_GAME_PLIES}` });
});

export const themeSkillSchema = z.object({
  rating: finite,
  rd: finite,
  vol: finite,
  attempts: count.max(10_000_000),
  solved: count.max(10_000_000),
  lastSeen: z.string().max(40).nullable(),
});

export const studentProfileSchema = z.object({
  nickname: z.string().min(1).max(40),
  address: z.enum(['m', 'f']),
  stage: z.number().int().min(1).max(50),
  totals: z.object({
    games: finite,
    wins: finite,
    losses: finite,
    draws: finite,
    puzzlesAttempted: finite,
    puzzlesSolved: finite,
    minutesPlayed: finite,
  }),
  puzzleRating: themeSkillSchema,
  themeSkills: z.record(z.string(), themeSkillSchema),
  recentAccuracy: z.array(pct),
  weaknesses: z.array(z.string()),
  strengths: z.array(z.string()),
  bestWin: personaIdSchema.nullable(),
  updatedAt: z.string(),
  conceptsIntroduced: z.array(z.string().max(80)).max(500).optional(),
});

/** Body of `PUT /student`. */
export const studentUpdateSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(1)
    .max(24)
    // a pseudonym, not free text: no markup / control characters
    .regex(/^[^<>\\\u0000-\u001f|`]+$/)
    .optional(),
  address: z.enum(['m', 'f']).optional(),
  stage: z.number().int().min(1).max(50).optional(),
});
export type StudentUpdateInput = z.infer<typeof studentUpdateSchema>;

export const puzzleAttemptSchema = z.object({
  puzzleId: z.string().min(1).max(32),
  solved: z.boolean(),
  msSpent: finite.min(0).max(86_400_000),
  hintsUsed: z.number().int().min(0).max(100),
  themes: z.array(z.string().min(1).max(40)).max(40),
  puzzleRating: finite.min(0).max(4000),
});

export const boardAnnotationsSchema = z.object({
  arrows: z.array(z.object({ from: square, to: square, color: z.enum(['green', 'red', 'yellow', 'blue']) })).max(32),
  highlights: z.array(z.object({ square, color: z.enum(['green', 'red', 'yellow', 'blue']) })).max(64),
});

/** «Записи» (docs/voice-clips/SPEC.md §3.3): catalogue line ids are plain dotted ids, never Russian text. */
const clipLineIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);
const clipItemSchema = z.union([
  z.object({ line: clipLineIdSchema, piece: z.enum(['p', 'n', 'b', 'r', 'q', 'k']).optional(), g: z.enum(['m', 'f']).optional() }),
  z.object({ slot: z.enum(['nom', 'cap', 'ins']), san, fen }),
]);
export const clipUtteranceSchema = z.object({
  sentences: z
    .array(z.object({ items: z.array(clipItemSchema).min(1).max(3), prio: z.number().int().min(0).max(100), end: z.enum(['.', '!', '?']) }))
    .max(4),
  bark: z.enum(['idle', 'wave', 'talk', 'think', 'cheer', 'oops', 'sleep', 'listen']).optional(),
  generic: clipLineIdSchema,
  moment: z.string().max(40).optional(),
});

export const teachSummarySchema = z.object({
  moment: z.enum(['turn', 'openingPlan', 'repeat', 'reveal', 'reaction', 'theme', 'quiz', 'answer', 'mini', 'takeaway']),
  style: z.enum(['full', 'short', 'concept']),
  ply: z.number().int().min(0).max(2000),
  advice: z
    .array(
      z.object({
        uci: z.string().max(6),
        san: z.string().max(12),
        source: z.enum(['repertoire', 'mainLine', 'book', 'engine']),
        arrow: z.enum(['green', 'blue']),
      }),
    )
    .max(3),
  conceptId: z.string().max(80).optional(),
  reveal: z.enum(['now', 'later']).optional(),
});

/** the lesson model (docs/TEACHING.md §3–4): board cues, the button quiz, the pre-written wordings said. */
const cueKindSchema = z.enum(['move', 'attacks', 'line', 'flank', 'center', 'capture', 'threat', 'hanging', 'piece', 'king', 'weak', 'path', 'defend', 'lastMove']);
export const lessonCueSchema = z.object({
  kind: cueKindSchema,
  sentence: z.number().int().min(0).max(8),
  squares: z.array(square).max(64),
  arrows: z.array(z.object({ from: square, to: square })).max(16).optional(),
  tone: z.enum(['good', 'danger', 'info']),
  at: z.enum(['start', 'end']).optional(),
});
const quizKindSchema = z.enum(['oppIdea', 'whichPiece', 'canCapture', 'checkEscape', 'danger', 'why']);
const pieceTypeSchema = z.enum(['p', 'n', 'b', 'r', 'q', 'k']);
export const lessonQuizSchema = z.object({
  id: z.string().min(1).max(80),
  kind: quizKindSchema,
  ply: z.number().int().min(0).max(2000),
  question: z.string().min(1).max(300),
  options: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(80), icon: z.string().max(4).optional() })).length(3),
  correctId: z.string().min(1).max(40),
});
export const lessonSaySchema = z.object({
  pool: clipLineIdSchema,
  n: z.number().int().min(1).max(200),
  piece: pieceTypeSchema.optional(),
  g: z.enum(['m', 'f']).optional(),
});
/** «Дозапись голоса»: which `say` parts make each sentence of `text` (indexes into `say`, ≤ 12 of them). */
const sayIndexSchema = z.number().int().min(0).max(11);
export const lessonSaySentenceSchema = z
  .object({
    text: z.string().min(1).max(600),
    parts: z.array(sayIndexSchema).max(2),
    quiz: z
      .object({
        kind: quizKindSchema,
        options: z.array(z.union([z.object({ say: sayIndexSchema }).strict(), z.object({ piece: pieceTypeSchema }).strict()])).length(3),
      })
      .strict()
      .optional(),
  })
  .strict();

const coachEventKindSchema = z.enum([
  'greeting',
  'gameStart',
  'praise',
  'takebackOffer',
  'hint',
  'explainBest',
  'threatWarning',
  'botMoveComment',
  'gameEnd',
  'reviewMoment',
  'encourage',
  'thinkingRoutine',
  'answer',
  'teachTurn',
  'teachReaction',
]);

export const coachEventSchema = z.object({
  id: z.string().max(80),
  kind: coachEventKindSchema,
  priority: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  text: z.string().min(1).max(1200),
  bubbleText: z.string().max(1200),
  pose: z.enum(['idle', 'wave', 'talk', 'think', 'cheer', 'oops', 'sleep', 'listen']),
  board: boardAnnotationsSchema.optional(),
  pauseClock: z.boolean(),
  hintLevel: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  motif: motifIdSchema.optional(),
  judgement: moveJudgementSchema.optional(),
  brief: z.string().max(4000).optional(),
  teach: teachSummarySchema.optional(),
  clip: clipUtteranceSchema.optional(),
  cues: z.array(lessonCueSchema).max(16).optional(),
  quiz: lessonQuizSchema.optional(),
  say: z.array(lessonSaySchema).max(12).optional(),
  saySentences: z.array(lessonSaySentenceSchema).max(8).optional(),
});

export const rephraseBodySchema = z.object({ event: coachEventSchema });

// ───────────── «Дозапись голоса» (POST /voice/clips/request, PUT /voice/clips/settings) ─────────────

/**
 * Ids only, strict at every level: an extra field (`text`, `name`, …) is a 400, so no Russian text — and never the
 * child's name — can reach the TTS through a request. The server renders the words from @gambit/content itself.
 */
const clipGenSaySchema = lessonSaySchema.strict();
/**
 * A whole catalogue sentence (older events: greetings, answers, take-back replies…). Shape only: which ids and variants
 * may be recorded (role 'whole', not `v3.*`, `n` in range, a variant the wording uses) is decided by the renderer.
 */
const clipGenLineSchema = z
  .object({
    id: clipLineIdSchema,
    n: z.number().int().min(1).max(200),
    piece: pieceTypeSchema.optional(),
    g: z.enum(['m', 'f']).optional(),
  })
  .strict();
export const clipGenSentenceSchema = z.union([
  z.object({ parts: z.union([z.tuple([clipGenSaySchema]), z.tuple([clipGenSaySchema, clipGenSaySchema])]) }).strict(),
  z
    .object({
      quiz: z
        .object({
          kind: quizKindSchema,
          options: z.array(z.union([z.object({ say: clipGenSaySchema }).strict(), z.object({ piece: pieceTypeSchema }).strict()])).length(3),
        })
        .strict(),
    })
    .strict(),
  z.object({ line: clipGenLineSchema }).strict(),
]);
export const clipGenRequestSchema = z
  .object({
    sentences: z.array(clipGenSentenceSchema).min(1).max(6),
    kind: coachEventKindSchema.optional(),
  })
  .strict();
/** The route also caps `dailyCapMilli` at the env's CLIP_GEN_DAILY_MAX; 30 000 = the env maximum's own clamp (30 credits). */
export const clipGenSettingsSchema = z
  .object({
    enabled: z.boolean(),
    dailyCapMilli: z.number().int().min(0).max(30_000),
  })
  .strict();

// ───────────── the smart strategist of «Учитель» (POST /coach/strategy, /coach/replan) ─────────────

/** A library id: plain, short, never markup (it is echoed into prompts, logs and the kv history). */
export const strategyIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const providerIdSchema = z.enum(['codex', 'openrouter', 'openai-api', 'template']);
const stageSchema = z.number().int().min(1).max(50);
/** Russian text of the curated library (validated when @gambit/content is imported) */
const libraryText = z.string().trim().min(1).max(400);

export const strategyCardSchema = z.object({
  id: strategyIdSchema,
  titleRu: z.string().trim().min(1).max(80),
  ideaRu: libraryText,
  side: colorSchema,
  against: z.enum(['any', 'e4', 'd4', 'other']),
  lineSan: z.array(san).max(40),
  stepsRu: z.array(libraryText).max(12),
  middlegameRu: z.array(libraryText).max(12),
  minStage: z.number().int().min(1).max(50),
  themes: z.array(z.string().max(60)).max(20),
  // spoken after a deviation: Russian only (a card with a Latin goal is dropped like one with a Latin step)
  planGoalsRu: z
    .array(libraryText.regex(/^[^A-Za-z]*$/))
    .max(8)
    .optional(),
});

export const strategyRequestSchema = z.object({
  childColor: colorSchema,
  stage: stageSchema,
  personaId: personaIdSchema,
  timeControlId: timeControlIdSchema,
  opponentFirstUci: uci.optional(),
});

export const replanCandidateSchema = z.object({
  uci,
  san,
  /** centipawns for the child; mate scores arrive as large numbers */
  cp: z.number().min(-200_000).max(200_000),
  ideasRu: z.array(z.string().max(200)).max(6),
});

export const replanRequestSchema = z.object({
  ply: z.number().int().min(0).max(2000),
  fen,
  childColor: colorSchema,
  strategyId: strategyIdSchema,
  movesSan: z.array(san).max(1000),
  candidates: z.array(replanCandidateSchema).max(8),
  stage: stageSchema,
});

export const gameStrategySchema = z.object({
  strategyId: strategyIdSchema,
  titleRu: z.string().min(1).max(80),
  introRu: z.string().min(1).max(400),
  ideaRu: z.string().max(400),
  provider: providerIdSchema,
  model: z.string().min(1).max(80).optional(),
  billing: z.enum(['subscription', 'paid', 'free']).optional(),
});

export const replanResponseSchema = z.object({
  ply: z.number().int().min(0).max(2000),
  planRu: z.string().max(400),
  preferredUci: uci.nullable(),
  whyRu: z.string().max(400),
  provider: providerIdSchema,
});

export const gamesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

// ───────────── the child's progress: adult games, «Начать прогресс заново», post-game thoughts ─────────────

export const gameExclusionSchema = z.enum(['adult', 'archived']);

export const gameExclusionRequestSchema = z.object({ excluded: z.literal('adult').nullable() });

export const progressResetRequestSchema = z.object({ confirm: z.literal(true) });

export const MAX_THOUGHTS_PER_REQUEST = 20;
export const MAX_THOUGHT_CHARS = 600;
export const MAX_THOUGHT_QUESTION_CHARS = 300;

export const gameThoughtSchema = z.object({
  id: gameIdSchema,
  source: z.enum(['voice', 'typed']),
  question: z.string().trim().min(1).max(MAX_THOUGHT_QUESTION_CHARS).optional(),
  text: z.string().trim().min(1).max(MAX_THOUGHT_CHARS),
  at: isoDate,
});

export const gameThoughtsRequestSchema = z.object({ thoughts: z.array(gameThoughtSchema).min(1).max(MAX_THOUGHTS_PER_REQUEST) });

export const puzzlesNextQuerySchema = z.object({
  theme: z
    .string()
    .max(40)
    .regex(/^[A-Za-z0-9]*$/)
    .optional(),
  count: z.coerce.number().int().min(1).max(30).optional(),
});

// ───────────── content validation (defensive import of @gambit/content) ─────────────

export const personaSchema = z.object({
  id: personaIdSchema,
  name: z.string().min(1),
  age: finite,
  nominalElo: finite,
  tagline: z.string(),
  style: z.string(),
  avatar: z.object({
    bg: z.string(),
    skin: z.string(),
    hair: z.string(),
    hairStyle: z.enum(['short', 'curly', 'ponytail', 'bob', 'cap', 'spiky', 'long', 'bun']),
    accessory: z.enum(['glasses', 'headphones', 'bow', 'cap', 'scarf']).optional(),
  }),
  lines: z.object({
    intro: z.array(z.string()),
    onWin: z.array(z.string()),
    onLose: z.array(z.string()),
    onDraw: z.array(z.string()),
    onGoodMoveByChild: z.array(z.string()),
  }),
  recommendedFromStage: finite,
});

export const curriculumStageSchema = z.object({
  stage: z.number().int().min(1),
  title: z.string().min(1),
  ratingBand: z.string(),
  goal: z.string(),
  skills: z.array(z.string()),
  puzzleThemes: z.array(z.string()),
  endgames: z.array(z.string()),
  openingFocus: z.string(),
  mastery: z.object({
    description: z.string(),
    minPuzzleRating: finite.optional(),
    maxBlundersPerGame: finite.optional(),
    minAccuracy: finite.optional(),
  }),
  recommendedPersonas: z.array(personaIdSchema),
});

export const conceptCardSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  motif: motifIdSchema.optional(),
  lichessThemes: z.array(z.string()),
  stage: finite,
  explanation: z.string(),
  question: z.string(),
  examples: z.array(z.object({ fen: z.string(), solutionSan: z.array(z.string()), comment: z.string() })),
});

// ───────────── compile-time sync with the contract ─────────────

type Extends<A, B> = [A] extends [B] ? true : false;
type Mutual<A, B> = Extends<A, B> extends true ? Extends<B, A> : false;
function assertType<_T extends true>(): void {}

assertType<Mutual<z.infer<typeof evalScoreSchema>, EvalScore>>();
assertType<Mutual<z.infer<typeof moveJudgementSchema>, MoveJudgement>>();
assertType<Mutual<z.infer<typeof keyMomentSchema>, KeyMoment>>();
assertType<Mutual<z.infer<typeof gameSummarySchema>, GameSummary>>();
assertType<Mutual<z.infer<typeof gameEventSchema>, GameEvent>>();
assertType<Mutual<z.infer<typeof gameRecordSchema>, GameRecord>>();
assertType<Mutual<z.infer<typeof themeSkillSchema>, ThemeSkill>>();
assertType<Mutual<z.infer<typeof studentProfileSchema>, StudentProfile>>();
assertType<Mutual<z.infer<typeof puzzleAttemptSchema>, PuzzleAttempt>>();
assertType<Mutual<z.infer<typeof boardAnnotationsSchema>, BoardAnnotations>>();
assertType<Mutual<z.infer<typeof coachEventSchema>, CoachEvent>>();
assertType<Mutual<z.infer<typeof coachEventKindSchema>, CoachEventKind>>();
assertType<Mutual<z.infer<typeof lessonSaySentenceSchema>, LessonSaySentence>>();
assertType<Mutual<z.infer<typeof clipGenLineSchema>, ClipGenLine>>();
assertType<Mutual<z.infer<typeof clipGenSentenceSchema>, ClipGenSentence>>();
assertType<Mutual<z.infer<typeof clipGenRequestSchema>, ClipGenRequest>>();
assertType<Mutual<z.infer<typeof clipGenSettingsSchema>, ClipGenSettings>>();
assertType<Mutual<z.infer<typeof personaSchema>, Persona>>();
assertType<Mutual<z.infer<typeof curriculumStageSchema>, CurriculumStage>>();
assertType<Mutual<z.infer<typeof conceptCardSchema>, ConceptCard>>();
assertType<Mutual<z.infer<typeof strategyCardSchema>, StrategyCard>>();
assertType<Mutual<z.infer<typeof strategyRequestSchema>, StrategyRequest>>();
assertType<Mutual<z.infer<typeof replanRequestSchema>, ReplanRequest>>();
assertType<Mutual<z.infer<typeof gameStrategySchema>, GameStrategy>>();
assertType<Mutual<z.infer<typeof replanResponseSchema>, ReplanResponse>>();
assertType<Mutual<z.infer<typeof gameExclusionSchema>, GameExclusion>>();
assertType<Mutual<z.infer<typeof gameExclusionRequestSchema>, GameExclusionRequest>>();
assertType<Mutual<z.infer<typeof progressResetRequestSchema>, ProgressResetRequest>>();
assertType<Mutual<z.infer<typeof gameThoughtSchema>, GameThought>>();
assertType<Mutual<z.infer<typeof gameThoughtsRequestSchema>, GameThoughtsRequest>>();
