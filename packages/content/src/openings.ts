/**
 * A tiny idea-based opening repertoire (docs/research/05 §6): the Italian game for White and the
 * 1...e5 / 1...d5 set-ups for Black. The curriculum screen teaches it from stage 5 (`fromStage`); in a game the
 * coach names the IDEA of a recognised line at any stage (the child already knows how the
 * pieces move, the 5-minute helper must not be passive) — the game simply omits the `stage` option.
 *
 * The repertoire teaches IDEAS, not memorised trees: every model line is short, legal from the
 * initial position (verified by `openings.test.ts` with chess.js) and comes with one plain-Russian
 * sentence about its point. `keyIdeas`, `watchOut` and `idea` contain no Latin notation so the
 * coach may read them aloud; the moves themselves live in `movesSan` (English SAN).
 */
import { Chess } from 'chess.js';
import type { Color } from '@gambit/shared';

export interface RepertoireLine {
  id: string;
  /** Russian name of the line. */
  title: string;
  /** One or two plain sentences: what this line is about. */
  idea: string;
  /** Model moves in English SAN from the initial position, White's move first. */
  movesSan: string[];
  /** What to aim for once the model moves are over — one plain sentence, no notation. */
  nextIdea: string;
  /** A cautionary line: it shows what NOT to do (the child's side goes wrong in it). */
  warning?: boolean;
}

export interface OpeningRepertoireEntry {
  id: 'italian-white' | 'e5-black' | 'd5-black';
  /** The colour the child plays in this part of the repertoire. */
  side: Color;
  title: string;
  /** Against which first move(s) this set-up is used, Russian. */
  against: string;
  /** Curriculum stage from which the repertoire part is shown on the curriculum screen (a game uses it at any stage). */
  fromStage: number;
  /** One-paragraph summary for the curriculum screen. */
  summary: string;
  /** Key ideas in plain Russian, short sentences. */
  keyIdeas: string[];
  /** Traps and typical mistakes to be aware of. */
  watchOut: string[];
  /** Model lines; the first one defines the basic set-up. */
  lines: RepertoireLine[];
}

export const OPENING_REPERTOIRE: OpeningRepertoireEntry[] = [
  {
    id: 'italian-white',
    side: 'w',
    title: 'Итальянская партия',
    against: 'Играем белыми: королевская пешка на две клетки вперёд',
    fromStage: 5,
    summary:
      'Самый понятный дебют для открытой игры: пешка в центр, конь, слон — и сразу рокировка. Слон с первых ходов смотрит на слабую клетку возле чёрного короля.',
    keyIdeas: [
      'Пешка в центр, конь нападает на пешку, слон выходит на боевую диагональ.',
      'Слон целится в слабую клетку рядом с чёрным королём: её защищает только сам король.',
      'Рокировку делаем рано — король в домике, ладья в игре.',
      'Тихий план: скромный шаг ферзевой пешки, рокировка, ладья на линию короля. Конь с ферзевого фланга идёт длинным путём на королевский фланг.',
      'План «сильный центр»: сначала пешка рядом со слоном делает шаг, потом ферзевая пешка идёт на две клетки. Получаются две пешки в центре.',
      'Когда ладьи соединились, дебют закончен. Ищем план: какую фигуру улучшить?',
    ],
    watchOut: [
      'Не выводи ферзя рано и не ходи одной фигурой дважды без причины.',
      'Выпад конём к слабой клетке — только когда тактика уже надёжна. Сначала спокойное развитие.',
      'Если соперник рано вывел ферзя — развивай фигуры с нападением на него.',
      'Против других ответов чёрных играем по тем же правилам: центр, фигуры, рокировка.',
    ],
    lines: [
      {
        id: 'italian-quiet',
        title: 'Тихая итальянка',
        idea: 'Никаких ловушек: развиваем все фигуры, прячем короля и готовим удар в центре. Конь идёт длинным путём на королевский фланг.',
        movesSan: [
          'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O', 'Re1', 'a6', 'Nbd2', 'Ba7',
          'Nf1', 'h6', 'Ng3',
        ],
        nextIdea: 'Дальше готовим удар ферзевой пешкой в центре и ищем, какую фигуру поставить лучше.',
      },
      {
        id: 'italian-strong-center',
        title: 'Сильный центр',
        idea: 'Строим две пешки в центре. Если чёрные меняются, у наших фигур открываются линии.',
        movesSan: [
          'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4', 'Bb4+', 'Bd2', 'Bxd2+', 'Nbxd2',
          'd5', 'exd5', 'Nxd5', 'O-O', 'O-O',
        ],
        nextIdea: 'Дальше ладьи выходят на открытые линии: фигурам теперь просторно.',
      },
      {
        id: 'italian-two-knights-quiet',
        title: 'Если чёрные вывели второго коня',
        idea: 'Спокойно защищаем центральную пешку и продолжаем развитие. Получается та же тихая итальянка.',
        movesSan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Bc5', 'O-O', 'd6', 'c3', 'O-O', 'Re1'],
        nextIdea: 'Дальше всё как в тихой итальянке: конь идёт длинным путём на королевский фланг.',
      },
      {
        id: 'white-vs-sicilian',
        title: 'Против сицилианской защиты',
        idea: 'Тот же план «сильный центр»: готовим шаг ферзевой пешки на две клетки.',
        movesSan: ['e4', 'c5', 'c3', 'd5', 'exd5', 'Qxd5', 'd4', 'Nf6', 'Nf3', 'e6', 'Be2'],
        nextIdea: 'Дальше рокировка и спокойное развитие: центр у нас крепкий.',
      },
      {
        id: 'white-vs-french',
        title: 'Против французской защиты',
        idea: 'Меняемся в центре и получаем открытую игру с простым развитием.',
        movesSan: ['e4', 'e6', 'd4', 'd5', 'exd5', 'exd5', 'Nf3', 'Nf6', 'Bd3', 'Bd6', 'O-O', 'O-O'],
        nextIdea: 'Дальше слон связывает коня, а ладья занимает открытую линию.',
      },
      {
        id: 'white-vs-scandinavian',
        title: 'Против скандинавской защиты',
        idea: 'Бьём пешку, а потом конь выходит с нападением на ферзя. Мы развиваемся, а ферзь убегает.',
        movesSan: ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'd4', 'Nf6', 'Nf3'],
        nextIdea: 'Дальше выводим слона и делаем рокировку: мы впереди в развитии.',
      },
    ],
  },
  {
    id: 'e5-black',
    side: 'b',
    title: 'Чёрными: отвечаем пешкой в центр',
    against: 'Белые пошли королевской пешкой на две клетки',
    fromStage: 5,
    summary:
      'Зеркало нашего белого дебюта: ставим пешку в центр, выводим коней и слонов, делаем рокировку. Мы учим одни и те же позиции с обеих сторон.',
    keyIdeas: [
      'Пешка в центр, конь защищает её, слон и второй конь выходят в игру, потом рокировка.',
      'Центральную пешку держим и не отдаём даром.',
      'Если белые строят две пешки в центре — меняемся, даём шах слоном и бьём по центру ферзевой пешкой.',
      'Против раннего ферзя: сначала закрыть угрозу мата, потом развиваться с нападением на ферзя.',
      'Против испанской партии: прогоняем слона пешкой, выводим фигуры, делаем рокировку.',
    ],
    watchOut: [
      'Детский мат: следи, куда целятся ферзь и слон белых.',
      'Когда белый конь прыгнул к нашей слабой клетке, не бери пешку конём — это ловушка «жареная печень». Уводим коня на край с нападением на слона.',
      'Не хватай пешки, пока фигуры не развиты.',
    ],
    lines: [
      {
        id: 'black-vs-italian',
        title: 'Против итальянской партии',
        idea: 'Развиваемся зеркально: слон, конь, скромный шаг ферзевой пешки и рокировка.',
        movesSan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O'],
        nextIdea: 'Дальше отводим слона в безопасное место и ищем, какую фигуру улучшить.',
      },
      {
        id: 'black-vs-italian-center',
        title: 'Белые строят центр — бьём по нему',
        idea: 'Меняем пешку, даём шах слоном и наносим ответный удар ферзевой пешкой в центре.',
        movesSan: [
          'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4', 'Bb4+', 'Bd2', 'Bxd2+', 'Nbxd2',
          'd5',
        ],
        nextIdea: 'Дальше бьём пешку конём и делаем рокировку: у белых в центре останется одинокая пешка.',
      },
      {
        id: 'black-vs-knight-attack',
        title: 'Против выпада конём: без «жареной печени»',
        idea: 'Закрываемся ударом пешки в центре. Пешку конём не берём, а уводим коня на край с нападением на слона.',
        movesSan: [
          'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Na5', 'Bb5+', 'c6', 'dxc6', 'bxc6', 'Be2', 'h6',
          'Nf3', 'e4',
        ],
        nextIdea: 'Дальше развиваем слонов и делаем рокировку: за пешку у нас быстрая игра фигурами.',
      },
      {
        id: 'black-vs-early-queen',
        title: 'Против раннего ферзя',
        idea: 'Сначала защищаем центральную пешку. Потом закрываем угрозу мата пешкой, а следующую угрозу — конём. Ферзь белых бегает, а мы развиваемся.',
        movesSan: ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6'],
        nextIdea: 'Дальше слон выходит на длинную диагональ, и делаем рокировку.',
      },
      {
        id: 'black-vs-spanish',
        title: 'Против испанской партии',
        idea: 'Прогоняем слона пешками, развиваем фигуры и делаем рокировку. Центральную пешку держим.',
        movesSan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O'],
        nextIdea: 'Дальше ищем хорошее место для коня и держим центральную пешку.',
      },
      {
        id: 'black-vs-scotch',
        title: 'Против шотландской партии',
        idea: 'Бьём пешку в центре и развиваемся с темпом: каждый наш ход что-то атакует.',
        movesSan: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nc3', 'Bb4'],
        nextIdea: 'Дальше рокировка и удар ферзевой пешкой в центре.',
      },
    ],
  },
  {
    id: 'd5-black',
    side: 'b',
    title: 'Чёрными: крепкая пешка в центре',
    against: 'Белые пошли ферзевой пешкой (или начали с фланга)',
    fromStage: 5,
    summary:
      'Надёжная расстановка отказанного ферзевого гамбита: пешка в центре под защитой соседки, конь, слон, рокировка. Никаких приключений — просто крепкая позиция.',
    keyIdeas: [
      'Ставим пешку в центр и защищаем её соседней пешкой.',
      'Выводим коня и слона на королевском фланге и сразу делаем рокировку.',
      'Потом бьём по центру белых пешкой со стороны ферзевого фланга.',
      'Белопольный слон — наш «трудный ребёнок»: ему тесно. Освобождаем его позже, через шаг соседней пешки.',
      'Против лондонской системы: удар пешкой по центру и ферзь смотрит на ослабленную пешку, от которой ушёл слон.',
    ],
    watchOut: [
      'Не бери пешку на фланге, чтобы потом её удерживать: пешку не удержишь, а фигуры отстанут.',
      'Не запирай слона навсегда: помни про план его освобождения.',
      'Против фланговых начал ставим ту же расстановку — она годится почти всегда.',
    ],
    lines: [
      {
        id: 'black-qgd-setup',
        title: 'Основная расстановка',
        idea: 'Пешка в центре под защитой, конь, слон, рокировка, второй конь. Потом — удар по центру.',
        movesSan: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O', 'Nf3', 'Nbd7', 'Rc1', 'c6'],
        nextIdea: 'Дальше меняемся в центре, чтобы фигурам стало просторнее, и освобождаем трудного слона.',
      },
      {
        id: 'black-vs-london',
        title: 'Против лондонской системы',
        idea: 'Слон белых ушёл со своего места, и пешка рядом с ним ослабла. Бьём по центру и нападаем на неё ферзём.',
        movesSan: ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'c5', 'c3', 'Nc6', 'Nd2', 'Qb6'],
        nextIdea: 'Дальше спокойно развиваем фигуры, а ферзь держит слабую пешку под прицелом.',
      },
      {
        id: 'black-vs-flank',
        title: 'Против фланговых начал',
        idea: 'Та же расстановка: пешки в центр, конь, слон, рокировка.',
        movesSan: ['c4', 'e6', 'Nc3', 'd5', 'd4', 'Nf6', 'Nf3', 'Be7', 'Bf4', 'O-O'],
        nextIdea: 'Дальше бьём по центру пешкой со стороны ферзевого фланга.',
      },
      {
        id: 'black-greedy-pawn-trap',
        title: 'Почему нельзя жадничать',
        idea: 'Чёрные взяли пешку и пытаются её удержать. Белые вскрывают линию, и ферзь нападает на ладью в углу — чёрные теряют фигуру.',
        movesSan: ['d4', 'd5', 'c4', 'dxc4', 'e3', 'b5', 'a4', 'c6', 'axb5', 'cxb5', 'Qf3'],
        nextIdea: 'Вывод: пешку на фланге не удерживаем — лучше быстрее развивать фигуры.',
        warning: true,
      },
    ],
  },
];

/** Repertoire part by id. */
export function getRepertoireEntry(id: OpeningRepertoireEntry['id']): OpeningRepertoireEntry {
  // All three ids are present (covered by tests).
  return OPENING_REPERTOIRE.find((entry) => entry.id === id) as OpeningRepertoireEntry;
}

/** Repertoire parts for the colour the child plays. */
export function getRepertoireForSide(side: Color): OpeningRepertoireEntry[] {
  return OPENING_REPERTOIRE.filter((entry) => entry.side === side);
}

// ───────────────────────── advice for a running game ─────────────────────────

/** What the repertoire has to say about the opening of a running game. All texts are plain Russian without notation. */
export interface RepertoireAdvice {
  entryId: OpeningRepertoireEntry['id'];
  entryTitle: string;
  lineId: string;
  /** Russian name of the recognised model line. */
  lineTitle: string;
  /** The point of the line (one or two sentences) — safe to read aloud. */
  idea: string;
  /** What to aim for next, once the model moves are over. */
  nextIdea: string;
  /** The line is a warning (the child's side goes wrong in it), not a plan to follow. */
  warning: boolean;
  /** Curriculum stage from which this part of the repertoire is taught. */
  fromStage: number;
  /** How many plies of the model line the game has reached (a transposition counts). */
  matchedPlies: number;
  /** The current position is still a position of the model line. */
  inBook: boolean;
  /** Next model move in English SAN while `inBook` and the line goes on (for a board demo, never for speech). */
  nextMoveSan?: string;
  /** Whose move `nextMoveSan` is. */
  nextMoveBy?: 'child' | 'opponent';
}

export interface RepertoireAdviceOptions {
  /** The child's curriculum stage: parts of the repertoire taught later are ignored. Omit to match everything. */
  stage?: number;
  /** A line is recognised only after this many of its plies were reached. Default 4 (two full moves). */
  minPlies?: number;
}

export const REPERTOIRE_MIN_PLIES = 4;

/** Piece placement + side to move + castling rights: enough to recognise a transposition. */
function repertoireKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 3).join(' ');
}

const lineKeysCache = new Map<string, string[]>();

/** Position keys after every ply of a model line (lazily computed, the lines are verified by the tests). */
function lineKeys(line: RepertoireLine): string[] {
  const cached = lineKeysCache.get(line.id);
  if (cached) return cached;
  const keys = keysOfSanHistory(line.movesSan);
  lineKeysCache.set(line.id, keys);
  return keys;
}

function keysOfSanHistory(sans: readonly string[]): string[] {
  const chess = new Chess();
  const keys: string[] = [];
  for (const san of sans) {
    try {
      chess.move(san);
    } catch {
      break; // an illegal / foreign move: everything before it still counts
    }
    keys.push(repertoireKey(chess.fen()));
  }
  return keys;
}

/**
 * Recognises the repertoire line a running game follows and returns its idea.
 *
 * `history` is either the SAN moves played so far (English SAN, as chess.js prints them) or the FENs after every
 * ply (a leading start position is fine) — the form is detected from the first element. Only the parts of the
 * repertoire for `childColor` are considered. The line that was followed deepest wins (ties: a line the game is
 * still in, then the more basic line). Returns undefined when nothing was followed for `minPlies` plies.
 *
 * The game mentions `idea` once at any stage (it passes no `stage`); the curriculum screen can show `lineTitle` /
 * `nextIdea` from `fromStage` on.
 */
export function getRepertoireAdvice(history: readonly string[], childColor: Color, options: RepertoireAdviceOptions = {}): RepertoireAdvice | undefined {
  if (history.length === 0) return undefined;
  const minPlies = Math.max(1, options.minPlies ?? REPERTOIRE_MIN_PLIES);
  const isFenHistory = (history[0] ?? '').includes('/');
  const keys = isFenHistory ? history.map(repertoireKey) : keysOfSanHistory(history);
  if (keys.length === 0) return undefined;
  const seen = new Set(keys);
  const lastKey = keys[keys.length - 1];

  let best: { entry: OpeningRepertoireEntry; line: RepertoireLine; matched: number; inBook: boolean } | undefined;
  for (const entry of OPENING_REPERTOIRE) {
    if (entry.side !== childColor) continue;
    if (options.stage !== undefined && entry.fromStage > options.stage) continue;
    for (const line of entry.lines) {
      const modelKeys = lineKeys(line);
      let matched = 0;
      for (let i = modelKeys.length - 1; i >= 0; i--) {
        if (seen.has(modelKeys[i] as string)) {
          matched = i + 1;
          break;
        }
      }
      if (matched < minPlies) continue;
      const inBook = modelKeys[matched - 1] === lastKey;
      if (!best || matched > best.matched || (matched === best.matched && inBook && !best.inBook)) best = { entry, line, matched, inBook };
    }
  }
  if (!best) return undefined;

  const { entry, line, matched, inBook } = best;
  const advice: RepertoireAdvice = {
    entryId: entry.id,
    entryTitle: entry.title,
    lineId: line.id,
    lineTitle: line.title,
    idea: line.idea,
    nextIdea: line.nextIdea,
    warning: line.warning === true,
    fromStage: entry.fromStage,
    matchedPlies: matched,
    inBook,
  };
  const next = inBook ? line.movesSan[matched] : undefined;
  if (next !== undefined) {
    advice.nextMoveSan = next;
    // ply `matched + 1` is White's when `matched` is even
    advice.nextMoveBy = (matched % 2 === 0 ? 'w' : 'b') === childColor ? 'child' : 'opponent';
  }
  return advice;
}

// ───────────────────────── the teacher's plan (docs/TEACHER-MODE.md §3.3) ─────────────────────────

/** The repertoire as a PLAN for the teacher mode: where the game is in a model line and what the child plays next. */
export interface RepertoirePlan {
  entryId: OpeningRepertoireEntry['id'];
  /** Russian title of the repertoire part («Итальянская партия»). */
  entryTitle: string;
  lineId: string;
  /** Russian name of the model line («Тихая итальянка») — spoken only from stage 3. */
  lineTitle: string;
  /** The position of the game is a position of the model line. */
  inBook: boolean;
  /** The next 2–4 model moves of the CHILD (English SAN, for code only — never spoken as is); empty when not in book or the line is over. */
  nextChildSans: string[];
  /** What to aim for once the model moves are over — plain Russian, no notation. */
  nextIdea: string;
  /** The point of the line — plain Russian, no notation. */
  idea: string;
  /** A cautionary line: the child's side goes wrong in it — never a plan to follow. */
  warning: boolean;
  /** How many plies of the model line the game has reached (0 = the initial position). */
  matchedPlies: number;
  /** The rest of the model line from the current position, both sides (English SAN), so the plan can be spoken position by position. Empty when not in book. */
  continuationSan: string[];
}

/** How many of the child's next model moves a plan names. */
export const PLAN_CHILD_MOVES = 4;

/**
 * Like `getRepertoireAdvice`, but for the teacher mode: no `minPlies` and no stage gate (the teacher uses the
 * repertoire at ANY stage), and the initial position counts as the start of every line — so White gets a plan before
 * the first move. When several lines share the same beginning, the first line of the part wins (the parts and lines
 * are ordered from basic to special). The deepest line followed wins; on a tie a line the game is still in.
 *
 * Returns undefined when the game has left every model line at its very first move (e.g. 1.a3 for White, or 1.b3
 * against the Black repertoire) — then the teacher plans by the principles. `history` = SAN moves or FENs after every
 * ply, as in `getRepertoireAdvice`.
 */
export function getRepertoirePlan(history: readonly string[], childColor: Color): RepertoirePlan | undefined {
  const startKey = repertoireKey(new Chess().fen());
  const isFenHistory = history.length > 0 && (history[0] ?? '').includes('/');
  const played = history.length === 0 ? [] : isFenHistory ? history.map(repertoireKey) : keysOfSanHistory(history);
  // garbage in a SAN history: the replayed position is not the game's — never plan from a wrong position
  if (!isFenHistory && played.length < history.length) return undefined;
  const keys = played[0] === startKey ? played : [startKey, ...played];
  const seen = new Set(keys);
  const lastKey = keys[keys.length - 1];

  let best: { entry: OpeningRepertoireEntry; line: RepertoireLine; matched: number; inBook: boolean } | undefined;
  for (const entry of OPENING_REPERTOIRE) {
    if (entry.side !== childColor) continue;
    for (const line of entry.lines) {
      if (line.warning) continue; // a cautionary line is never a plan
      const modelKeys = [startKey, ...lineKeys(line)];
      let matched = -1;
      for (let i = modelKeys.length - 1; i >= 0; i--) {
        if (seen.has(modelKeys[i] as string)) {
          matched = i;
          break;
        }
      }
      if (matched < 0) continue;
      const inBook = modelKeys[matched] === lastKey;
      if (!best || matched > best.matched || (matched === best.matched && inBook && !best.inBook)) best = { entry, line, matched, inBook };
    }
  }
  if (!best || (best.matched === 0 && !best.inBook)) return undefined;

  const { entry, line, matched, inBook } = best;
  const continuationSan = inBook ? line.movesSan.slice(matched) : [];
  const childParity = childColor === 'w' ? 0 : 1;
  const nextChildSans = inBook ? line.movesSan.map((san, i) => ({ san, i })).filter(({ i }) => i >= matched && i % 2 === childParity).slice(0, PLAN_CHILD_MOVES).map(({ san }) => san) : [];
  return {
    entryId: entry.id,
    entryTitle: entry.title,
    lineId: line.id,
    lineTitle: line.title,
    inBook,
    nextChildSans,
    nextIdea: line.nextIdea,
    idea: line.idea,
    warning: line.warning === true,
    matchedPlies: matched,
    continuationSan,
  };
}

// ───────────────────────── frequent moves (docs/TEACHER-MODE.md §3.5) ─────────────────────────

/**
 * Curated main moves of the first plies: the honest basis of «так часто начинают» (`AdviceSource` 'mainLine').
 * General chess knowledge, NOT a statistic — there is no offline game database in the app.
 *
 * Сверить один раз с lichess opening explorer (вкладка «Masters»): для каждой позиции ходы из списка
 * должны быть среди самых частых. После сверки записать дату в `MAIN_LINE_EXPLORER_CHECKED` (формат 2026-09-30).
 * Это только пометка о сверке: код её не читает и ничего по ней не переключает. Тренер и без неё говорит лишь
 * сдержанное «так часто начинают партию» (в начальной позиции) — без «самый популярный» и без цифр.
 */
export const MAIN_LINE_EXPLORER_CHECKED: string | null = null;

/** Position (SAN moves from the initial position) → up to three frequent next moves (English SAN). */
export const MAIN_LINE_TABLE: readonly { readonly after: readonly string[]; readonly moves: readonly string[] }[] = [
  { after: [], moves: ['e4', 'd4'] },
  { after: ['e4'], moves: ['e5', 'c5'] },
  { after: ['d4'], moves: ['d5', 'Nf6'] },
  { after: ['e4', 'e5'], moves: ['Nf3'] },
  { after: ['e4', 'e5', 'Nf3'], moves: ['Nc6'] },
  { after: ['e4', 'e5', 'Nf3', 'Nc6'], moves: ['Bb5', 'Bc4', 'd4'] },
  { after: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], moves: ['Bc5', 'Nf6'] },
  { after: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], moves: ['a6', 'Nf6'] },
  { after: ['e4', 'c5'], moves: ['Nf3'] },
  { after: ['e4', 'e6'], moves: ['d4'] },
  { after: ['e4', 'c6'], moves: ['d4'] },
  { after: ['e4', 'd5'], moves: ['exd5'] },
  { after: ['d4', 'd5'], moves: ['c4'] },
  { after: ['d4', 'd5', 'c4'], moves: ['e6', 'c6'] },
  { after: ['d4', 'Nf6'], moves: ['c4'] },
  { after: ['c4'], moves: ['e5', 'Nf6'] },
  { after: ['Nf3'], moves: ['Nf6', 'd5'] },
];

function buildMainLineMoves(): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const row of MAIN_LINE_TABLE) {
    const chess = new Chess();
    for (const san of row.after) chess.move(san); // the table is verified by openings.test.ts
    out[repertoireKey(chess.fen())] = row.moves;
  }
  return out;
}

/** `repertoireKey` of a position (placement, side to move, castling) → its frequent moves (English SAN, ≤ 3). */
export const MAIN_LINE_MOVES: Readonly<Record<string, readonly string[]>> = buildMainLineMoves();

/** Frequent moves of this position (English SAN, for code only), [] when the position is not in the table. */
export function mainLineMoves(fen: string): readonly string[] {
  const key = repertoireKey(fen);
  return Object.hasOwn(MAIN_LINE_MOVES, key) ? (MAIN_LINE_MOVES[key] ?? []) : [];
}
