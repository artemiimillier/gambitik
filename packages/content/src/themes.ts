/**
 * Lichess puzzle theme taxonomy with kid-friendly Russian titles and one-line descriptions.
 *
 * Facts (docs/research/05 + 06):
 *  - The `Themes` column of lichess_db_puzzle.csv contains exactly the 73 tags listed in
 *    LICHESS_PUZZLE_THEMES below.
 *  - `mix` is NOT a CSV tag (it is an interface-only pseudo theme) — never query puzzles by it.
 *  - `oneMove` duplicates `mateIn1` (99.7 %), `castling` is rare and hard (min rating ~1400),
 *    `opening` is a game-phase tag, not "opening principles". They are valid tags but must not be
 *    used as drill themes of the curriculum (see THEMES_NOT_FOR_DRILL).
 *
 * The Russian titles are common chess vocabulary; the descriptions are our own texts written for
 * a child (they are deliberately NOT the Lichess interface strings).
 */

/** Every tag that really occurs in the `Themes` column of the Lichess puzzle CSV. */
export const LICHESS_PUZZLE_THEMES = [
  // tactics motifs
  'advancedPawn',
  'attackingF2F7',
  'attraction',
  'capturingDefender',
  'clearance',
  'collinearMove',
  'defensiveMove',
  'deflection',
  'discoveredAttack',
  'discoveredCheck',
  'doubleCheck',
  'enPassant',
  'exposedKing',
  'fork',
  'hangingPiece',
  'interference',
  'intermezzo',
  'kingsideAttack',
  'pin',
  'promotion',
  'queensideAttack',
  'quietMove',
  'sacrifice',
  'skewer',
  'trappedPiece',
  'underPromotion',
  'xRayAttack',
  'zugzwang',
  'castling',
  // mates
  'mate',
  'mateIn1',
  'mateIn2',
  'mateIn3',
  'mateIn4',
  'mateIn5',
  'anastasiaMate',
  'arabianMate',
  'backRankMate',
  'balestraMate',
  'blindSwineMate',
  'bodenMate',
  'cornerMate',
  'doubleBishopMate',
  'dovetailMate',
  'epauletteMate',
  'hookMate',
  'killBoxMate',
  'morphysMate',
  'operaMate',
  'pillsburysMate',
  'smotheredMate',
  'swallowstailMate',
  'triangleMate',
  'vukovicMate',
  // game phases and endgame classes
  'opening',
  'middlegame',
  'endgame',
  'pawnEndgame',
  'knightEndgame',
  'bishopEndgame',
  'rookEndgame',
  'queenEndgame',
  'queenRookEndgame',
  // length
  'oneMove',
  'short',
  'long',
  'veryLong',
  // goal
  'advantage',
  'crushing',
  'equality',
  // origin
  'master',
  'masterVsMaster',
  'superGM',
] as const;

export type LichessPuzzleTheme = (typeof LICHESS_PUZZLE_THEMES)[number];

/**
 * Keys that must never be used as a curriculum drill theme:
 * `mix`/`playerGames` do not exist in the CSV; the other three exist but are misleading for a child
 * (see the header comment).
 */
export const THEMES_NOT_FOR_DRILL: readonly string[] = ['mix', 'playerGames', 'oneMove', 'castling', 'opening'];

/**
 * App-level pseudo theme: "a bit of everything". It is NOT a Lichess tag — a client that wants a
 * mixed set must simply omit the `theme` query parameter of `GET /api/puzzles/next`.
 */
export const MIXED_THEME_KEY = 'mix';

/** Lichess theme key → short Russian title a child can read. */
export const THEME_TITLES_RU: Record<string, string> = {
  // tactics motifs
  advancedPawn: 'Далеко ушедшая пешка',
  attackingF2F7: 'Атака на слабый пункт у короля',
  attraction: 'Завлечение',
  capturingDefender: 'Уничтожение защитника',
  clearance: 'Освобождение линии',
  collinearMove: 'Ход вдоль линии',
  defensiveMove: 'Защитный ход',
  deflection: 'Отвлечение',
  discoveredAttack: 'Вскрытое нападение',
  discoveredCheck: 'Вскрытый шах',
  doubleCheck: 'Двойной шах',
  enPassant: 'Взятие на проходе',
  exposedKing: 'Открытый король',
  fork: 'Вилка',
  hangingPiece: 'Незащищённая фигура',
  interference: 'Перекрытие',
  intermezzo: 'Промежуточный ход',
  kingsideAttack: 'Атака на королевском фланге',
  pin: 'Связка',
  promotion: 'Превращение пешки',
  queensideAttack: 'Атака на ферзевом фланге',
  quietMove: 'Тихий ход',
  sacrifice: 'Жертва',
  skewer: 'Сквозной удар',
  trappedPiece: 'Ловля фигуры',
  underPromotion: 'Слабое превращение',
  xRayAttack: 'Рентген',
  zugzwang: 'Цугцванг',
  castling: 'Рокировка',
  // mates
  mate: 'Мат',
  mateIn1: 'Мат в 1 ход',
  mateIn2: 'Мат в 2 хода',
  mateIn3: 'Мат в 3 хода',
  mateIn4: 'Мат в 4 хода',
  mateIn5: 'Мат в 5 ходов и длиннее',
  anastasiaMate: 'Мат Анастасии',
  arabianMate: 'Арабский мат',
  backRankMate: 'Мат на последней линии',
  balestraMate: 'Мат Балестра',
  blindSwineMate: 'Мат двумя ладьями на седьмой',
  bodenMate: 'Мат Бодена',
  cornerMate: 'Мат в углу',
  doubleBishopMate: 'Мат двумя слонами',
  dovetailMate: 'Мат «ласточкин хвост»',
  epauletteMate: 'Эполетный мат',
  hookMate: 'Мат-крючок',
  killBoxMate: 'Мат «тесная коробка»',
  morphysMate: 'Мат Морфи',
  operaMate: 'Оперный мат',
  pillsburysMate: 'Мат Пильсбери',
  smotheredMate: 'Спёртый мат',
  swallowstailMate: 'Мат «хвост ласточки»',
  triangleMate: 'Мат-треугольник',
  vukovicMate: 'Мат Вуковича',
  // game phases and endgame classes
  opening: 'Дебют',
  middlegame: 'Середина партии',
  endgame: 'Эндшпиль',
  pawnEndgame: 'Пешечный эндшпиль',
  knightEndgame: 'Коневой эндшпиль',
  bishopEndgame: 'Слоновый эндшпиль',
  rookEndgame: 'Ладейный эндшпиль',
  queenEndgame: 'Ферзевый эндшпиль',
  queenRookEndgame: 'Ферзь и ладья в эндшпиле',
  // length
  oneMove: 'Задача в один ход',
  short: 'Короткая задача',
  long: 'Длинная задача',
  veryLong: 'Очень длинная задача',
  // goal
  advantage: 'Получи перевес',
  crushing: 'Разгром',
  equality: 'Спаси партию',
  // origin
  master: 'Из партий мастеров',
  masterVsMaster: 'Мастер против мастера',
  superGM: 'Из партий супергроссмейстеров',
  // app pseudo theme (not a Lichess tag)
  mix: 'Всего понемногу',
};

/** Lichess theme key → our own one-line explanation for a child (Russian, no notation). */
export const THEME_DESCRIPTIONS_RU: Record<string, string> = {
  // tactics motifs
  advancedPawn: 'Пешка подобралась близко к последней линии. Помоги ей стать ферзём или напугай ею соперника.',
  attackingF2F7: 'Рядом с королём в начале игры есть слабая клеточка — её защищает только он сам. Ударь туда!',
  attraction: 'Замани чужую фигуру на плохую клетку — и там её ждёт сюрприз.',
  capturingDefender: 'Сначала съешь того, кто защищает, — потом забирай то, что он охранял.',
  clearance: 'Твоя же фигура мешает? Уведи её с пользой и открой дорогу другой.',
  collinearMove: 'Фигура остаётся на той же линии, но встаёт точнее. Маленький шаг — большая польза.',
  defensiveMove: 'Соперник грозит бедой. Найди ход, который всё надёжно защищает.',
  deflection: 'Отвлеки защитника от важного дела — и то, что он сторожил, останется без охраны.',
  discoveredAttack: 'Одна фигура отходит и открывает линию другой. Получаются сразу две угрозы!',
  discoveredCheck: 'Фигура отходит, а шах объявляет та, что стояла за ней. Отошедшая может брать что хочет.',
  doubleCheck: 'Шах сразу от двух фигур. Закрыться и съесть нельзя — королю остаётся только убегать.',
  enPassant: 'Хитрое правило: пешка бьёт чужую пешку, которая проскочила мимо неё на два поля.',
  exposedKing: 'Вокруг короля мало защитников. Нападай шахами, пока он не спрятался.',
  fork: 'Одна фигура нападает сразу на две. Обе спастись не успеют!',
  hangingPiece: 'Фигуру никто не защищает. Её можно забрать бесплатно — найди её!',
  interference: 'Поставь фигуру между чужими фигурами, чтобы они перестали защищать друг друга.',
  intermezzo: 'Не спеши отвечать как обычно. Сначала сделай неожиданный ход с угрозой.',
  kingsideAttack: 'Король спрятался в коротком домике. Собери фигуры и постучись к нему.',
  pin: 'Фигура не может уйти, потому что за ней стоит кто-то важнее. Она как приклеенная.',
  promotion: 'Пешка дошла до конца доски и превращается в сильную фигуру. Чаще всего — в ферзя!',
  queensideAttack: 'Король ушёл в длинную рокировку. Атакуй его на той стороне доски.',
  quietMove: 'Ход без шаха и без взятия, но после него у соперника нет хорошей защиты.',
  sacrifice: 'Отдай фигуру, чтобы получить больше: мат или перевес побольше.',
  skewer: 'Нападаем на важную фигуру. Она уходит — и мы забираем ту, что пряталась за ней.',
  trappedPiece: 'У фигуры нет безопасных клеток. Осталось на неё напасть и забрать.',
  underPromotion: 'Иногда пешке лучше стать не ферзём, а конём или ладьёй. Например, чтобы дать вилку или не дать пат.',
  xRayAttack: 'Фигура смотрит сквозь другую фигуру, как рентген, и помогает издалека.',
  zugzwang: 'У соперника все ходы плохие, а ходить надо. Любой его ход портит ему позицию.',
  castling: 'Рокировка здесь не просто прячет короля, а сама выигрывает игру.',
  // mates
  mate: 'Поставь мат: король под шахом, и спасения нет.',
  mateIn1: 'Один точный ход — и королю некуда деться.',
  mateIn2: 'Твой ход, ответ соперника — и мат вторым ходом.',
  mateIn3: 'Мат в три хода. Считай так: я — он — я — он — мат!',
  mateIn4: 'Длинная дорожка к мату. Ищи шахи, от которых не убежать.',
  mateIn5: 'Очень длинный мат. Иди шаг за шагом и не отпускай короля.',
  anastasiaMate: 'Конь и ладья запирают короля у края доски.',
  arabianMate: 'Конь и ладья ставят мат королю в самом углу.',
  backRankMate: 'Король заперт за своими пешками. Ладья или ферзь ставят мат на последней линии.',
  balestraMate: 'Слон даёт шах, а ферзь отнимает у короля все клетки.',
  blindSwineMate: 'Две ладьи ворвались на седьмую линию и вместе матуют короля.',
  bodenMate: 'Два слона ставят мат крест-накрест, а королю мешают его же фигуры.',
  cornerMate: 'Король зажат в углу: ладья или ферзь держат линию, а конь ставит мат.',
  doubleBishopMate: 'Два слона стреляют по соседним диагоналям — и королю конец.',
  dovetailMate: 'Ферзь ставит мат вплотную, а убежать королю мешают свои же фигуры.',
  epauletteMate: 'Свои фигуры стоят по бокам короля, как погоны, и не дают ему убежать.',
  hookMate: 'Ладья, конь и пешка держатся друг за друга, как крючок, и матуют короля.',
  killBoxMate: 'Ладья и ферзь строят вокруг короля коробочку без выхода.',
  morphysMate: 'Слон даёт шах, а ладья не выпускает короля. Так любил играть Пол Морфи.',
  operaMate: 'Ладья матует на последней линии, а слон её защищает. Как в знаменитой партии в опере.',
  pillsburysMate: 'Ладья ставит мат по открытой линии, а слон издалека закрывает королю выход.',
  smotheredMate: 'Король окружён своими же фигурами, и конь ставит ему мат.',
  swallowstailMate: 'Ферзь ставит мат вплотную, а клетки сзади заняты фигурами самого короля.',
  triangleMate: 'Ферзь и ладья встают треугольником вокруг короля и матуют его.',
  vukovicMate: 'Ладья матует у края доски, конь её охраняет, а ещё одна фигура помогает.',
  // game phases and endgame classes
  opening: 'Задача из самого начала партии.',
  middlegame: 'Задача из середины партии, когда на доске много фигур.',
  endgame: 'Фигур осталось мало. Король выходит помогать, а пешки бегут в ферзи.',
  pawnEndgame: 'На доске только короли и пешки. Кто первым проведёт ферзя?',
  knightEndgame: 'На доске кони и пешки. Конь прыгает хитро — считай внимательно.',
  bishopEndgame: 'На доске слоны и пешки. Следи, по каким клеткам ходит слон.',
  rookEndgame: 'На доске ладьи и пешки. Ладья любит открытые линии и активную работу.',
  queenEndgame: 'На доске ферзи и пешки. Остерегайся вечного шаха.',
  queenRookEndgame: 'На доске остались ферзи и ладьи. Береги своего короля!',
  // length
  oneMove: 'Нужно найти всего один ход.',
  short: 'Решение в два хода: твой ход, ответ соперника и ещё один твой ход.',
  long: 'Решение в три хода. Считай до конца.',
  veryLong: 'Решение в четыре хода или больше. Для самых терпеливых.',
  // goal
  advantage: 'Найди ход, после которого у тебя будет заметно больше сил.',
  crushing: 'Соперник ошибся. Найди удар, после которого победа совсем близко.',
  equality: 'Позиция трудная. Найди ход, который спасает партию.',
  // origin
  master: 'Эта позиция случилась в партии настоящих мастеров.',
  masterVsMaster: 'Здесь сражались два мастера. Попробуй сыграть не хуже!',
  superGM: 'Так играли сильнейшие гроссмейстеры мира.',
  // app pseudo theme
  mix: 'Задачи на разные темы вперемешку — как в настоящей партии.',
};

/** Russian title for a theme key; unknown keys fall back to the key itself. */
export function themeTitleRu(theme: string): string {
  return Object.hasOwn(THEME_TITLES_RU, theme) ? (THEME_TITLES_RU[theme] ?? theme) : theme;
}

/** Kid-friendly description for a theme key, or undefined for unknown keys. */
export function themeDescriptionRu(theme: string): string | undefined {
  return Object.hasOwn(THEME_DESCRIPTIONS_RU, theme) ? THEME_DESCRIPTIONS_RU[theme] : undefined;
}

const LICHESS_THEME_SET: ReadonlySet<string> = new Set<string>(LICHESS_PUZZLE_THEMES);

/** True when `theme` is a real tag of the Lichess puzzle CSV. */
export function isLichessPuzzleTheme(theme: string): theme is LichessPuzzleTheme {
  return LICHESS_THEME_SET.has(theme);
}
