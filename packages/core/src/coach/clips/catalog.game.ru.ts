/**
 * «Записи» catalogue, part 2 — around and across the game (docs/voice-clips/SPEC.md §3.3, §7, §8): greeting, game start
 * and the 24 strategy intros (from the library's own titles and ideas — never the strategist's free text), praise,
 * take-back offers, game end, the generic line of every moment (ladder L5), barks by pose, «Спроси» answers, the
 * child's thoughts after the game, a poke's catchphrases, the settings' voice preview.
 *
 * Names are never recorded (SPEC §7.6: opt-in only): every line here is nameless. Гамбитик speaks about himself as a
 * boy («я готов», «я соскучился», «понял»). Placeholders: see ./catalog.ts.
 *
 * «Дозапись голоса»: a recording is made of the words the bubble shows, so every text a builder (or the web's
 * shell) says for a W sentence is a wording here, the name stripped (catalog.test.ts measures it). New wordings are
 * APPENDED to a line, never inserted: a wording's number is its recording's key (`line:<pool>#<n>`), and the takes of
 * the starter set (tier `pilot`) must keep naming their words.
 */
import type { ClipCatalogLine, ClipWording, PieceType } from '@gambit/shared';

const w = (...texts: string[]): ClipWording[] => texts.map((t) => ({ t }));

// ───────────────────────── greeting (app open) ─────────────────────────

const GREETING: readonly ClipCatalogLine[] = [
  { id: 'greet.hello.morning', role: 'whole', wordings: w('Доброе утро!', 'С добрым утром!', 'Привет-привет, доброе утро!', 'Привет-привет!') },
  { id: 'greet.hello.day', role: 'whole', wordings: w('Добрый день!', 'Привет-привет, добрый день!', 'Здравствуй!', 'Привет-привет!', 'Привет!') },
  { id: 'greet.hello.evening', role: 'whole', wordings: w('Добрый вечер!', 'Вечер добрый!', 'Привет! Вот и вечер.', 'Привет-привет!', 'Привет!') },
  { id: 'greet.hello.night', role: 'whole', wordings: w('Ого, как поздно!', 'Ой, уже совсем поздно!', 'Привет!') },
  {
    id: 'greet.first',
    role: 'whole',
    wordings: w(
      'Я Гамбитик, твой шахматный друг. Сыграем?',
      'Меня зовут Гамбитик. Я шахматный конь и люблю хитрые ходы!',
      'Я Гамбитик! Умею перепрыгивать через фигуры. Поехали?',
      'Я Гамбитик. Будем играть и учиться вместе — сыграем?',
      'Меня зовут Гамбитик, я шахматный конь и люблю хитрые ходы. Начнём?',
      'Я Гамбитик! Умею перепрыгивать через фигуры и думать вместе с тобой. Поехали?',
      'Я Гамбитик. Будем играть и учиться вместе — сыграем первую партию?',
    ),
  },
  {
    id: 'greet.win',
    role: 'whole',
    byGender: true,
    fallback: 'greet.none',
    wordings: w(
      'В прошлый раз ты {g:победил|победила} — здорово! Сыграем ещё?',
      'Помню твою прошлую победу. Поехали дальше?',
      'Прошлую партию ты {g:выиграл|выиграла}. Что будет сегодня?',
      'После победы играть ещё интереснее. Начнём?',
      'Прошлую партию ты {g:выиграл|выиграла}. Посмотрим, что получится сегодня?',
    ),
  },
  {
    id: 'greet.loss',
    role: 'whole',
    fallback: 'greet.none',
    wordings: w(
      'Прошлая партия была трудной, зато мы кое-чему научились. Попробуем ещё?',
      'После трудной партии мастера снова садятся за доску. Сыграем?',
      'Я уже придумал, что потренируем. Начнём?',
      'Каждая партия делает нас сильнее. Сыграем ещё одну?',
      'Я уже придумал, что потренируем после прошлой партии. Начнём?',
    ),
  },
  {
    id: 'greet.draw',
    role: 'whole',
    fallback: 'greet.none',
    wordings: w('В прошлый раз была боевая ничья. Сыграем ещё?', 'Помню нашу ничью — никто не уступил! Продолжим?', 'После ничьей хочется сыграть ещё. Поехали?', 'Прошлая партия закончилась миром. Что будет сегодня?'),
  },
  {
    id: 'greet.unfinished',
    role: 'whole',
    byGender: true,
    fallback: 'greet.none',
    wordings: w('Прошлую партию мы не доиграли — ничего страшного. Начнём новую?', 'Я уже соскучился по шахматам. Поехали!', 'Доска ждёт! Сыграем?', '{g:Готов|Готова} подумать вместе со мной? Поехали!'),
  },
  { id: 'greet.none', role: 'whole', wordings: w('О, это ты! Я уже соскучился по шахматам. Поехали!', 'Сыграем?', 'Доска ждёт! С чего начнём?', 'Я готов думать вместе с тобой. Начнём?') },
  { id: 'greet.night', role: 'whole', wordings: w('Давай одну спокойную партию — и отдыхать?', 'Сыграем разок, а потом спать — мастерам нужен сон.', 'Может, пару задачек — и на боковую?', 'Одна партия, и глазкам пора отдыхать. Идёт?') },
  // the one «Привет!» when the board opens (buildGameHello)
  { id: 'hello.game', role: 'whole', wordings: w('Привет!', 'Привет-привет!', 'Приве-е-ет!', 'Привет, а вот и я!') },
];

// ───────────────────────── game start ─────────────────────────

const GAME_START: readonly ClipCatalogLine[] = [
  { id: 'start.open', role: 'whole', wordings: w('Соперник уже ждёт.', 'Играем!', 'Доска готова.', 'Начинаем партию!', 'Начинаем партию.') },
  {
    id: 'start.open.greet',
    role: 'whole',
    fallback: 'start.open',
    wordings: w(
      'Привет! Соперник уже ждёт.',
      'Привет-привет! Играем!',
      'Приве-е-ет! Доска готова.',
      'Привет! Начинаем партию!',
      // every hello of the builder with every nameless opener; the hello alone before an opener that names the opponent
      'Привет! Играем!',
      'Привет! Доска готова.',
      'Привет! Начинаем партию.',
      'Привет-привет! Соперник уже ждёт.',
      'Привет-привет! Доска готова.',
      'Привет-привет! Начинаем партию.',
      'Приве-е-ет! Соперник уже ждёт.',
      'Приве-е-ет! Играем!',
      'Приве-е-ет! Начинаем партию.',
      'Привет!',
      'Привет-привет!',
      'Приве-е-ет!',
    ),
  },
  {
    id: 'start.tail.coached',
    role: 'whole',
    wordings: w('Помни наш секрет: сначала смотрим — потом ходим!', 'Не спеши, я рядом.', 'Если что — жми «Подсказка», подумаем вместе.', 'Удачи, и проверяй каждый ход на безопасность!'),
  },
  {
    id: 'start.tail.silent',
    role: 'whole',
    wordings: w(
      'Партия быстрая: я молчу и болею за тебя, а потом всё обсудим.',
      'Тут надо играть быстро, так что я помолчу.',
      'Я не мешаю — болею за тебя молча.',
      'Подсказок не будет, но я за тебя болею!',
      'Тут надо играть быстро, так что я помолчу. Разберём после партии!',
      'Я не мешаю — болею за тебя молча. Поговорим после партии.',
      'Время летит, поэтому подсказок не будет. Я за тебя болею!',
    ),
  },
  {
    id: 'start.tail.untimed',
    role: 'whole',
    wordings: w(
      'Часов нет — думай спокойно, я рядом.',
      'Торопиться некуда: сначала смотрим — потом ходим!',
      'Думай сколько хочешь. Если что — жми «Подсказка».',
      'Играем без часов — проверяй каждый ход не спеша.',
      'Времени сколько хочешь. Если что — жми «Подсказка».',
      'Играем без часов, так что проверяй каждый ход не спеша.',
    ),
  },
  {
    id: 'start.tail.exam',
    role: 'whole',
    byGender: true,
    wordings: w('Это экзамен: ты играешь {g:сам|сама}, а я болею за тебя!', 'Сегодня экзамен — как на турнире, без подсказок. Я болею за тебя!', 'Это экзамен: подсказок не будет, зато потом всё обсудим!'),
  },
  {
    id: 'start.teacher.plain',
    role: 'whole',
    byGender: true,
    wordings: w('Играем! Я покажу хорошие ходы стрелками и объясню зачем.', 'Поехали! Буду показывать хорошие ходы и объяснять, зачем они.', 'Начинаем! Покажу хорошие ходы, а выберешь ты {g:сам|сама}.'),
  },
  { id: 'start.resumed', role: 'whole', wordings: w('Продолжаем нашу партию!', 'Я всё запомнил — играем дальше!', 'Партия ждала тебя. Продолжаем!', 'Продолжаем! Я рядом.') },
  // what `buildGameResumed` may add after the line, a sentence of its own (so both are recorded once, not every pair)
  { id: 'start.resumed.tail', role: 'whole', wordings: w('Я рядом.', 'Смотрим внимательно!') },
  // the first move of a strategy (White) — a nom head; Black answers with `teach.head.answer`
  { id: 'start.head.first', role: 'head', fallback: 'teach.head.arrow', wordings: w('Первый ход —', 'Начинаем так:', 'Для начала —', 'Начнём с хода:') },
];

// ───────────────────────── the 24 strategy intros (library titles + ideas, no squares) ─────────────────────────

/** `strategy.<id>`: one sentence, the idea of the game; the first move follows as its own H·S sentence. */
const STRATEGY_INTROS: readonly ClipCatalogLine[] = [
  { id: 'strategy.italian', role: 'whole', wordings: w('Разыграем Итальянскую партию: быстро выводим фигуры и целимся в слабую точку!', 'Сегодня у нас Итальянская партия — фигуры в бой, целимся в слабую точку!') },
  { id: 'strategy.four-knights', role: 'whole', wordings: w('Разыграем партию четырёх коней: оба коня в бой, потом слоны и рокировка!', 'Сегодня у нас партия четырёх коней — сначала оба коня в бой!') },
  { id: 'strategy.london', role: 'whole', wordings: w('Разыграем Лондонскую систему: слон выходит первым, а пешки строят крепость!', 'Сегодня у нас Лондонская система — слон, а потом крепость из пешек!') },
  { id: 'strategy.bishops-opening', role: 'whole', wordings: w('Разыграем Дебют слона: слон выходит первым и целится в слабую точку!', 'Сегодня у нас Дебют слона — слон сразу идёт в бой!') },
  { id: 'strategy.colle', role: 'whole', wordings: w('Разыграем Систему Колле: строим крепость из пешек и готовим удар в центре!', 'Сегодня у нас Система Колле — крепость из пешек и удар в центре!') },
  { id: 'strategy.scotch', role: 'whole', wordings: w('Разыграем Шотландскую партию: сразу бьёмся за центр пешкой!', 'Сегодня у нас Шотландская партия — сразу бой за центр!') },
  { id: 'strategy.vienna', role: 'whole', wordings: w('Разыграем Венскую партию: конь выходит раньше слона и крепко держит центр!', 'Сегодня у нас Венская партия — конь первым держит центр!') },
  { id: 'strategy.spanish', role: 'whole', wordings: w('Разыграем Испанскую партию: слон давит на коня, который защищает центр!', 'Сегодня у нас Испанская партия — слон давит на защитника центра!') },
  { id: 'strategy.queens-gambit', role: 'whole', wordings: w('Разыграем Ферзевый гамбит: предлагаем пешку, чтобы забрать центр себе!', 'Сегодня у нас Ферзевый гамбит — отдаём пешку, забираем центр!') },
  { id: 'strategy.open-game', role: 'whole', wordings: w('Разыграем Открытую игру: отвечаем пешкой в центр и выводим все фигуры!', 'Сегодня у нас Открытая игра — пешка в центр, фигуры в бой!') },
  { id: 'strategy.two-knights', role: 'whole', wordings: w('Разыграем Защиту двух коней: второй конь сразу нападает на пешку в центре!', 'Сегодня у нас Защита двух коней — оба коня сразу в атаку!') },
  { id: 'strategy.french', role: 'whole', wordings: w('Разыграем Французскую защиту: строим цепочку пешек и бьём по ней сбоку!', 'Сегодня у нас Французская защита — цепочка пешек и удар сбоку!') },
  { id: 'strategy.scandinavian', role: 'whole', wordings: w('Разыграем Скандинавскую защиту: сразу бьём по центру и быстро выводим фигуры!', 'Сегодня у нас Скандинавская защита — сразу удар по центру!') },
  { id: 'strategy.sicilian', role: 'whole', wordings: w('Разыграем Сицилианскую защиту: спорим за центр сбоку, а слон-дракон стреляет!', 'Сегодня у нас Сицилианская защита — бьёмся за центр сбоку!') },
  { id: 'strategy.caro-kann', role: 'whole', wordings: w('Разыграем защиту Каро-Канн: строим крепкий центр, а слон выходит на свободу!', 'Сегодня у нас Каро-Канн — крепкий центр и свободный слон!') },
  { id: 'strategy.orthodox', role: 'whole', wordings: w('Разыграем Ортодоксальную защиту: крепко держим центр и спокойно развиваемся!', 'Сегодня у нас Ортодоксальная защита — крепкий центр, спокойная игра!') },
  { id: 'strategy.slav', role: 'whole', wordings: w('Разыграем Славянскую защиту: пешки держат центр, а слон выходит заранее!', 'Сегодня у нас Славянская защита — крепкий центр и ранний слон!') },
  { id: 'strategy.dutch-stonewall', role: 'whole', wordings: w('Разыграем Голландскую защиту: строим каменную стену из пешек и идём на короля!', 'Сегодня у нас Голландская защита — каменная стена из пешек!') },
  { id: 'strategy.kings-indian', role: 'whole', wordings: w('Разыграем Староиндийскую защиту: прячем короля за слоном и ломаем центр пешкой!', 'Сегодня у нас Староиндийская защита — король за слоном, удар по центру!') },
  { id: 'strategy.classic-development', role: 'whole', wordings: w('Играем классическое развитие: пешка в центр, фигуры в игру, король в домик!', 'Сегодня всё по-классически: центр, фигуры, рокировка!') },
  { id: 'strategy.kings-indian-setup', role: 'whole', wordings: w('Разыграем Староиндийское построение: слон на диагонали, король в крепости!', 'Сегодня у нас Староиндийское построение — слон и крепость для короля!') },
  { id: 'strategy.queens-indian-setup', role: 'whole', wordings: w('Разыграем Новоиндийское построение: слон смотрит по длинной диагонали!', 'Сегодня у нас Новоиндийское построение — слон на длинной диагонали!') },
  { id: 'strategy.botvinnik-system', role: 'whole', wordings: w('Разыграем Систему Ботвинника: две пешки крепко держат центр!', 'Сегодня у нас Система Ботвинника — крепкий центр из пешек!') },
  { id: 'strategy.reversed-sicilian', role: 'whole', wordings: w('Разыграем Сицилианскую наоборот: пешка сразу в центр, и выводим коней!', 'Сегодня у нас Сицилианская наоборот — пешка в центр, кони в бой!') },
];

// ───────────────────────── praise (buildPraise): the found idea, then the process ─────────────────────────

const PRAISE: readonly ClipCatalogLine[] = [
  { id: 'praise.generic', role: 'whole', freq: 2.0, wordings: w('Вот это ход!', 'Ух ты, сильно!', 'Отлично сыграно!', 'Это сильный ход!', 'Здорово придумано!', 'Красиво!', 'Ход конём!') },
  { id: 'praise.mate', role: 'whole', fallback: 'praise.generic', wordings: w('Мат — красиво!', 'Мат, и король пойман!', 'Мат! Вот это финал!', 'Ура, мат!') },
  { id: 'praise.fork', role: 'whole', fallback: 'praise.generic', wordings: w('Вилка — одним ходом сразу на две фигуры!', 'Ого, вилка!', 'Вот это вилка!') },
  { id: 'praise.pin', role: 'whole', fallback: 'praise.generic', wordings: w('Связка — фигура соперника теперь не может уйти!', 'Ого, связка!', 'Отличная связка!') },
  { id: 'praise.skewer', role: 'whole', fallback: 'praise.generic', wordings: w('Сквозной удар — прямо насквозь!', 'Ого, сквозной удар!') },
  { id: 'praise.discovered', role: 'whole', fallback: 'praise.generic', wordings: w('Вскрытое нападение — одна фигура отошла, другая напала!', 'Ого, вскрытое нападение!') },
  { id: 'praise.doubleCheck', role: 'whole', fallback: 'praise.generic', wordings: w('Двойной шах — самый сильный шах на свете!', 'Ого, двойной шах!') },
  { id: 'praise.removeDefender', role: 'whole', fallback: 'praise.generic', wordings: w('Защитник убран — здорово придумано!', 'Ого, защитника больше нет!') },
  { id: 'praise.trapped', role: 'whole', fallback: 'praise.generic', wordings: w('Фигура соперника поймана — ей некуда уйти!', 'Ловушка захлопнулась!') },
  { id: 'praise.capture', role: 'whole', byGender: true, freq: 1.0, fallback: 'praise.generic', wordings: w('Фигура стояла без защиты — и ты её {g:забрал|забрала}!', 'Зоркий глаз!', 'Вот это зоркость!', 'Ничего от тебя не спрячешь!') },
  { id: 'praise.badTrade', role: 'whole', fallback: 'praise.generic', wordings: w('Выгодный размен!', 'Размен в твою пользу!') },
  { id: 'praise.backRank', role: 'whole', fallback: 'praise.generic', wordings: w('Король соперника заперт своими пешками — отличная идея!', 'Удар по последней линии!') },
  { id: 'praise.mateIdea', role: 'whole', byGender: true, fallback: 'praise.generic', wordings: w('Ты {g:увидел|увидела} дорогу к мату!', 'Король соперника в беде!') },
  { id: 'praise.promotion', role: 'whole', fallback: 'praise.generic', wordings: w('Пешка рвётся в ферзи!', 'Пешка бежит к превращению!') },
  { id: 'praise.kingSafety', role: 'whole', fallback: 'praise.generic', wordings: w('Король в безопасности — мудрый ход!', 'Королю теперь спокойно!') },
  { id: 'praise.development', role: 'whole', fallback: 'praise.generic', wordings: w('Ещё одна фигура в игре — так держать!', 'Фигуры просыпаются!', 'Ещё одна фигура в игре — теперь она помогает!') },
  { id: 'praise.center', role: 'whole', fallback: 'praise.generic', wordings: w('Центр твой — отличный ход!', 'Сильный ход в центре!') },
  {
    id: 'praise.process',
    role: 'whole',
    byGender: true,
    freq: 4.8,
    wordings: w(
      'Так думают мастера!',
      'Видно, что ты {g:смотрел|смотрела} на всю доску.',
      'Ты {g:заметил|заметила} главную идею — вот это работа!',
      'Сначала {g:подумал|подумала}, потом {g:сходил|сходила} — вот наш секрет!',
      'Ты всё {g:проверил|проверила} — молодец!',
      'Зоркий глаз и холодная голова!',
      'Вот что значит смотреть внимательно!',
      'Ты {g:нашёл|нашла} самый сильный ход в позиции.',
    ),
  },
];

// ───────────────────────── take-back offers and what follows ─────────────────────────

const TAKEBACK: readonly ClipCatalogLine[] = [
  {
    id: 'takeback.stop',
    role: 'whole',
    freq: 1.0,
    wordings: w(
      'Стоп-стоп, подожди — давай вернём ход и подумаем ещё разок!',
      'Ой-ой, копытом чую — тут что-то не так, давай вернём ход!',
      'Погоди-ка, давай вернём ход и посмотрим ещё раз!',
      'Тпру, не спеши — предлагаю вернуть ход и подумать вместе!',
      'Подожди — давай вернём ход и подумаем вместе!',
    ),
  },
  {
    id: 'takeback.again',
    role: 'whole',
    byPiece: true,
    wordings: w(
      'И этот ход теряет {коня} — давай ещё подумаем!',
      'Ой, так ты отдаёшь {коня}. Вернём и подумаем ещё?',
      'И этот ход что-то теряет — давай ещё подумаем!',
      'Ой, и так что-то теряется. Вернём и подумаем ещё?',
      'И этот ход отдаёт {коня} — давай ещё разок подумаем!',
      'И этот ход что-то теряет — давай ещё разок подумаем!',
    ),
  },
  // the teacher's reminder of the advice — a nom head
  { id: 'takeback.head.advice', role: 'head', fallback: 'teach.head.arrow', wordings: w('Мой совет был такой:', 'Я советовал так:', 'Вспомни мой совет:', 'А совет был такой:') },
  // Socratic questions by what the move allowed (the punisher's piece names the byPiece ones)
  {
    id: 'takeback.q.hanging',
    role: 'whole',
    byPiece: true,
    fallback: 'takeback.q.generic',
    wordings: w('Все ли твои фигуры сейчас под защитой?', 'Посмотри: какая твоя фигура осталась без защиты?', 'Что у тебя сейчас под боем?', 'Этот ход что-то теряет — найдёшь что?', 'Посмотри, что теперь может забрать {конь} соперника?'),
  },
  {
    id: 'takeback.q.fork',
    role: 'whole',
    byPiece: true,
    fallback: 'takeback.q.generic',
    wordings: w(
      'Соперник готовит вилку — на какие две фигуры он нападёт?',
      'Тут пахнет вилкой — какие твои фигуры можно атаковать одним ходом?',
      'Посмотри, что теперь может сделать {конь} соперника — не вилка ли это?',
      'Куда может {n:прыгнуть|пойти} {конь} соперника, чтобы напасть сразу на две фигуры?',
    ),
  },
  {
    id: 'takeback.q.pin',
    role: 'whole',
    byPiece: true,
    fallback: 'takeback.q.generic',
    wordings: w('Тут пахнет связкой — какая твоя фигура не сможет уйти?', 'Какая твоя фигура заслоняет собой фигуру подороже?', 'Посмотри, на какую линию может встать {конь} соперника?'),
  },
  {
    id: 'takeback.q.skewer',
    role: 'whole',
    byPiece: true,
    fallback: 'takeback.q.generic',
    wordings: w('Какие твои фигуры стоят на одной линии?', 'Посмотри на линии: кто стоит друг за другом?', 'Что будет, если {конь} соперника нападёт вдоль этой линии?'),
  },
  {
    id: 'takeback.q.discovered',
    role: 'whole',
    fallback: 'takeback.q.generic',
    wordings: w('Какая фигура соперника может отойти и открыть нападение?', 'Посмотри, что откроется, когда соперник уберёт фигуру с линии?', 'Какая фигура соперника прячется за другой?'),
  },
  {
    id: 'takeback.q.removeDefender',
    role: 'whole',
    fallback: 'takeback.q.generic',
    wordings: w(
      'Кто защищает твои фигуры — и может ли соперник убрать защитника?',
      'Посмотри на защитников: всем ли им спокойно?',
      'Что случится, если твоего защитника прогонят или заберут?',
      'Кто защищает твои фигуры — и может ли соперник убрать этого защитника?',
    ),
  },
  {
    id: 'takeback.q.trapped',
    role: 'whole',
    fallback: 'takeback.q.generic',
    wordings: w('Хватает ли твоей фигуре полей, чтобы отступить?', 'Посмотри: есть ли у твоей фигуры путь назад?', 'Куда уйдёт твоя фигура, если на неё нападут?'),
  },
  {
    id: 'takeback.q.backRank',
    role: 'whole',
    fallback: 'takeback.q.mate',
    wordings: w('Есть ли у твоего короля форточка?', 'Куда убежит твой король, если дадут шах по последней линии?', 'Какие шахи теперь есть у соперника?'),
  },
  {
    id: 'takeback.q.mate',
    role: 'whole',
    fallback: 'takeback.q.generic',
    wordings: w('Какие шахи теперь есть у соперника?', 'Посмотри на своего короля: безопасно ли ему?', 'Куда убежит твой король, если соперник даст шах?', 'Королю опасно — какие шахи есть у соперника?'),
  },
  {
    id: 'takeback.q.badTrade',
    role: 'whole',
    fallback: 'takeback.q.generic',
    wordings: w('Посчитай размен: кто что заберёт и кому это выгодно?', 'Сколько стоит фигура, которую ты отдаёшь, и сколько — та, что забираешь?', 'Кто останется с лишней фигурой после всех взятий?'),
  },
  {
    id: 'takeback.q.promotion',
    role: 'whole',
    fallback: 'takeback.q.generic',
    wordings: w('Посмотри на пешки соперника: какая из них рвётся к превращению?', 'Кто остановит пешку соперника, если она побежит вперёд?', 'Далеко ли пешке соперника до последней линии?'),
  },
  {
    id: 'takeback.q.kingSafety',
    role: 'whole',
    fallback: 'takeback.q.generic',
    wordings: w('Посмотри на своего короля: хватает ли ему защитников?', 'Какие шахи есть теперь у соперника?', 'Спокойно ли сейчас твоему королю?', 'Какие шахи теперь есть у соперника?'),
  },
  {
    id: 'takeback.q.generic',
    role: 'whole',
    byPiece: true,
    wordings: w('Что теперь хочет сделать соперник?', 'Этот ход точно безопасен?', 'Какие шахи, взятия и угрозы есть у соперника?', 'Посмотри, что теперь может сделать {конь} соперника?'),
  },
  { id: 'takeback.accepted', role: 'whole', wordings: w('Отлично, ход вернули. Не спеши: что хочет соперник?', 'Ход вернули. Спокойно посмотри на доску — я рядом.', 'Вернули! Думай сколько нужно, а если что — жми «Подсказка».', 'Остановиться и проверить ещё раз — сильная привычка.') },
  { id: 'takeback.declined', role: 'whole', wordings: w('Хорошо, твоё решение! После партии разберём этот момент.', 'Договорились, играем дальше! Проверим твой ход на доске.', 'Ладно, оставляем. Потом вместе посмотрим, что получилось.', 'Твой ход — твоё решение! Разберём после партии.') },
  { id: 'takeback.reason.planned', role: 'whole', wordings: w('Понял, у тебя свой план! Проверим его на доске.', 'Свой план — это здорово. Посмотрим, как он сработает!') },
  { id: 'takeback.reason.dontSee', role: 'whole', wordings: w('Хорошо! После партии вместе разберём этот ход.', 'Ничего страшного. После партии посмотрим этот момент вместе.') },
  { id: 'takeback.reason.risk', role: 'whole', wordings: w('Смело! Посмотрим, что получится.', 'Риск — дело интересное. Играем дальше!') },
  { id: 'takeback.voluntary', role: 'whole', wordings: w('Ход вернули — бывает! Посмотри ещё раз и ходи.', 'Вернули. Рука иногда спешит быстрее головы — не беда!', 'Готово, ход вернули. Сначала смотрим — потом ходим!') },
];

// ───────────────────────── game end: the result, then ONE thing that went well ─────────────────────────

const GAME_END: readonly ClipCatalogLine[] = [
  { id: 'end.win', role: 'whole', byGender: true, wordings: w('Победа! И-го-го!', 'Победа! Дай копыто!', 'Ура, победа!', 'Победа за тобой!', 'Ты {g:победил|победила} — ура!') },
  { id: 'end.win.checkmate', role: 'whole', fallback: 'end.win', wordings: w('Мат — и победа твоя!', 'Мат! Победа за тобой!') },
  { id: 'end.win.timeout', role: 'whole', fallback: 'end.win', wordings: w('У соперника кончилось время — победа твоя!') },
  { id: 'end.loss', role: 'whole', wordings: w('Обидно, понимаю. Даже чемпионы проигрывают.', 'Трудная была партия. Проигрывать неприятно даже чемпионам.', 'Ничего страшного: проиграть — значит чему-то научиться.', 'Сегодня сильнее оказался соперник — так бывает у всех.') },
  { id: 'end.loss.timeout', role: 'whole', fallback: 'end.loss', wordings: w('Время закончилось — так бывает у всех.') },
  { id: 'end.draw', role: 'whole', wordings: w('Ничья — это когда оба молодцы.', 'Ничья! Боевая получилась партия.', 'Ничья — никто не уступил.', 'Мир на доске — ничья!', 'Ничья — оба бились до конца.') },
  { id: 'end.draw.stalemate', role: 'whole', fallback: 'end.draw', wordings: w('Пат — это ничья. Запомним этот приём!') },
  { id: 'end.unfinished', role: 'whole', wordings: w('Партия не доиграна — ничего страшного.', 'Остановились на полпути — так тоже бывает.', 'Эту партию доиграем в другой раз.', 'Пауза — тоже решение.') },
  { id: 'end.praise.takebackImproved', role: 'whole', byGender: true, fallback: 'end.praise.takebackAccepted', wordings: w('Мне понравилось, как ты {g:вернул|вернула} ход и {g:нашёл|нашла} лучше!') },
  { id: 'end.praise.takebackAccepted', role: 'whole', byGender: true, fallback: 'end.praise.tried', wordings: w('Ты {g:вернул|вернула} ход и {g:подумал|подумала} ещё раз — это сильная привычка.') },
  { id: 'end.praise.noBlunder', role: 'whole', byGender: true, fallback: 'end.praise.tried', wordings: w('Ты {g:играл|играла} внимательно: ни одного зевка за всю партию!') },
  { id: 'end.praise.accurate', role: 'whole', byGender: true, fallback: 'end.praise.tried', wordings: w('Ты {g:играл|играла} очень точно — видно, что {g:думал|думала} над ходами.') },
  { id: 'end.praise.manyStrongHints', role: 'whole', byGender: true, fallback: 'end.praise.tried', wordings: w('У тебя было много сильных ходов — ты {g:искал|искала} их внимательно.') },
  { id: 'end.praise.manyStrong', role: 'whole', byGender: true, fallback: 'end.praise.tried', wordings: w('У тебя было много сильных ходов, и ты {g:нашёл|нашла} их {g:сам|сама}.') },
  { id: 'end.praise.noHints', role: 'whole', byGender: true, fallback: 'end.praise.tried', wordings: w('Ты {g:справился|справилась} без единой подсказки.') },
  { id: 'end.praise.tried', role: 'whole', byGender: true, wordings: w('Ты {g:старался|старалась} и {g:искал|искала} хорошие ходы — это главное.', 'Ты {g:старался|старалась} — и это видно!') },
  { id: 'end.praise.worked', role: 'whole', byGender: true, fallback: 'end.praise.tried', wordings: w('Каждая партия делает тебя сильнее, и сегодня ты {g:поработал|поработала} на славу.', 'Сегодня ты {g:поработал|поработала} на славу!') },
  { id: 'end.praise.fought', role: 'whole', byGender: true, fallback: 'end.praise.tried', wordings: w('Мне понравилось, что ты {g:боролся|боролась} до самого конца.', 'Ты {g:бился|билась} до самого конца — молодец!') },
];

// ───────────────────────── generic lines of every moment (ladder L5): never a move, never a square ─────────────────────────

/**
 * `generic.<kind>[.<moment>][.<pose>]` — the planner walks up the dots to `generic` (`genericLineOf`, compile.ts); a
 * `….think` line only to `generic.<kind>.think` and `generic`, never to a parent that names an arrow.
 */
const GENERICS: readonly ClipCatalogLine[] = [
  { id: 'generic', role: 'whole', wordings: w('Давай дальше!', 'Играем дальше!', 'Смотри на доску!', 'Думаем вместе!') },
  { id: 'generic.greeting', role: 'whole', wordings: w('Привет! Сыграем?', 'Рад тебя видеть!', 'Я тут! Поехали?', 'Ну что, сыграем партию?') },
  { id: 'generic.gameStart', role: 'whole', wordings: w('Поехали!', 'Начинаем!', 'Доска готова — начинаем!', 'Вперёд, к новой партии!') },
  { id: 'generic.gameStart.openingPlan', role: 'whole', wordings: w('Начинаем! Смотри на зелёную стрелку.', 'Первый ход — на доске стрелкой!', 'Поехали: стрелка подскажет первый ход!', 'Начнём со стрелки на доске!') },
  { id: 'generic.praise', role: 'whole', wordings: w('Отличный ход!', 'Здорово!', 'Так держать!', 'Вот это да!') },
  { id: 'generic.takebackOffer', role: 'whole', wordings: w('Стоп-стоп, давай вернём ход!', 'Подожди, тут что-то не так!', 'Ой, давай подумаем ещё раз!', 'Погоди — вернём ход?') },
  { id: 'generic.hint', role: 'whole', wordings: w('Смотри на подсказку на доске!', 'Подумай, что хочет соперник.', 'Проверь шахи, взятия и угрозы!', 'Давай подумаем вместе!') },
  { id: 'generic.explainBest', role: 'whole', wordings: w('Смотри на стрелки на доске!', 'Зелёная стрелка — ход посильнее.', 'Запомним этот момент!', 'Разберём это вместе!') },
  { id: 'generic.threatWarning', role: 'whole', wordings: w('Осторожно, посмотри внимательно!', 'Что хочет соперник?', 'Проверь, всё ли под защитой!', 'Копытом чую опасность!') },
  { id: 'generic.botMoveComment', role: 'whole', wordings: w('Соперник сделал свой ход.', 'Интересный ход соперника!', 'Смотри, что сделал соперник.', 'Соперник походил — теперь ты!') },
  { id: 'generic.gameEnd', role: 'whole', wordings: w('Партия закончилась!', 'Вот и всё — хорошая была партия!', 'Спасибо за игру!', 'Хорошо поиграли!') },
  { id: 'generic.reviewMoment', role: 'whole', wordings: w('Давай разберём этот момент.', 'Смотри на доску внимательно.', 'Тут было интересно!', 'Запомним этот ход!') },
  { id: 'generic.encourage', role: 'whole', wordings: w('У тебя получается!', 'Я рядом!', 'Молодец, думаем дальше!', 'Всё хорошо, играем!') },
  { id: 'generic.thinkingRoutine', role: 'whole', wordings: w('Сначала смотрим — потом ходим!', 'Помни: что хочет соперник?', 'Шахи, взятия, угрозы — проверим!', 'Проверь: твой ход безопасен?') },
  { id: 'generic.answer', role: 'whole', wordings: w('Хороший вопрос!', 'Давай посмотрим вместе.', 'Глянь на доску!', 'Подумаем вместе!') },
  { id: 'generic.teachTurn', role: 'whole', wordings: w('Смотри на зелёную стрелку!', 'Глянь на доску — там подсказка.', 'Зелёная стрелка покажет ход!', 'Смотри, что я нарисовал на доске!') },
  { id: 'generic.teachTurn.turn', role: 'whole', freq: 1.0, wordings: w('Смотри на стрелку — это хороший ход!', 'Стрелка на доске подскажет ход.', 'Глянь на стрелку — это мой совет!', 'Вот мой совет — он на доске!') },
  // (a danger or a hidden treasure: no arrow is drawn, the squares are — never «стрелка», never «осторожно» for a gift)
  { id: 'generic.teachTurn.turn.think', role: 'whole', wordings: w('Хм, тут надо подумать!', 'Посмотри, что подсвечено!', 'Посмотри внимательно на доску!', 'Тут есть что-то важное — смотри на доску!') },
  { id: 'generic.teachTurn.openingPlan', role: 'whole', wordings: w('Начинаем! Стрелка покажет первый ход.', 'Первый ход подскажет стрелка!', 'Смотри на стрелку — с неё и начнём!', 'Вот стрелка — начинаем!') },
  { id: 'generic.teachTurn.reveal', role: 'whole', wordings: w('Вот он — смотри на стрелку!', 'Подарок — там, где стрелка!', 'Стрелка покажет подарок!', 'Держи подсказку — стрелка на доске!') },
  { id: 'generic.teachTurn.repeat', role: 'whole', wordings: w('Ещё раз: смотри на стрелки!', 'Мой совет — на доске стрелкой.', 'Стрелки на доске — выбирай!', 'Вот стрелки — решай!') },
  { id: 'generic.teachReaction', role: 'whole', wordings: w('Так тоже можно, играем дальше!', 'Ничего, играем дальше!', 'Хм, интересный выбор!', 'Смотри, что теперь на доске.') },
];

// ───────────────────────── barks by pose (≈ 35 % of priority-1 utterances, never in 5-minute games) ─────────────────────────

const BARKS: readonly ClipCatalogLine[] = [
  { id: 'bark.talk', role: 'bark', wordings: w('Так!', 'Итак…', 'Смотри-ка!', 'Ага!') },
  { id: 'bark.think', role: 'bark', wordings: w('Хм…', 'Так-так…', 'Хм-м-м…', 'Та-ак…') },
  { id: 'bark.cheer', role: 'bark', wordings: w('Ого!', 'Ух ты!', 'Ура!', 'И-го-го!') },
  { id: 'bark.oops', role: 'bark', wordings: w('Ой-ой!', 'Упс!', 'Ой!', 'Ай-ай!') },
  { id: 'bark.idle', role: 'bark', wordings: w('Эх…', 'Ну вот…') },
];

// ───────────────────────── «Спроси» answers, thoughts after the game, taps ─────────────────────────

/**
 * The «Спроси» chips (SPEC §8.2): «Почему так?» = the advice's slot + its reason tail (teacher.ts `buildTeachWhy`), else
 * a question back (`ask.why.think`); «Что задумал соперник?» = his threat (`ask.opp.*`), else his last move (`opp.*`) and
 * `ask.opp.none`; «Повтори» after the board changed = `ask.repeat.stale`. Every id the web emits is in `CLIP_TAP_LINES`.
 */
const ASK: readonly ClipCatalogLine[] = [
  { id: 'ask.why.think', role: 'whole', wordings: w('Давай подумаем вместе: какая фигура ещё не в игре?', 'Давай подумаем вместе: что хочет соперник?', 'А ты как думаешь? Проверь шахи, взятия и угрозы!') },
  { id: 'ask.opp.notYet', role: 'whole', wordings: w('Соперник ещё не ходил — ход за тобой!', 'Пока он ничего не сделал — твой ход!') },
  // (said after his move when the engine found no threat: «Соперник вывел коня. Пока ничего страшного он не задумал.»)
  { id: 'ask.opp.none', role: 'whole', wordings: w('Пока ничего страшного он не задумал.', 'Пока всё спокойно — он просто играет.') },
  { id: 'ask.opp.mate', role: 'whole', wordings: w('Он грозит матом!', 'Соперник хочет поставить мат!', 'Осторожно — он целится в короля!') },
  { id: 'ask.opp.fork', role: 'whole', fallback: 'ask.opp.threat', wordings: w('Он готовит вилку!', 'Соперник задумал вилку!') },
  { id: 'ask.opp.hanging', role: 'whole', byPiece: true, fallback: 'ask.opp.threat', wordings: w('Он хочет забрать {твоего} {коня}!', 'Соперник целится в {твоего} {коня}!', 'Он хочет что-то забрать!') },
  { id: 'ask.opp.threat', role: 'whole', wordings: w('Он что-то задумал — посмотри внимательно!', 'У соперника есть хитрая идея!') },
  { id: 'ask.repeat.stale', role: 'whole', wordings: w('Это я про прошлый ход говорил — смотри на доску!', 'Это было про прошлый ход. Что теперь на доске?') },
  { id: 'ask.hint.exam', role: 'whole', wordings: w('Сегодня экзамен — без подсказок. Я в тебя верю!', 'На экзамене подсказок нет, но ты справишься!') },
];

/** The child's thoughts after the game (SPEC §8.3): Гамбитик answers the tapped chip. */
const THOUGHTS: readonly ClipCatalogLine[] = [
  // (the web's chips pass no gender: every reply is said the same to a boy and a girl)
  { id: 'thought.easy', role: 'whole', wordings: w('Легко? Тогда в следующий раз позовём соперника посильнее!', 'Здорово! Значит, пора играть посложнее!') },
  { id: 'thought.hard', role: 'whole', wordings: w('Трудно — значит, ты растёшь!', 'Трудные партии делают нас сильнее!') },
  { id: 'thought.goodMove', role: 'whole', wordings: w('Здорово! Я тоже заметил этот ход.', 'Вот это да! Запомни этот ход.') },
  { id: 'thought.mistake', role: 'whole', wordings: w('Молодец! Найти свою ошибку — это уже победа.', 'Ошибка — это находка: теперь мы знаем больше.') },
  { id: 'thought.rematch', role: 'whole', wordings: w('Давай! Я готов к реваншу!', 'Отличная идея — сыграем ещё!') },
];

/**
 * The web's shell (apps/web, «Дозапись голоса»): the fixed phrases of the onboarding, the new-game wizard, the
 * parent gate, the break nudge and the game's own one-liners. The web says each as a clip twin whose bubble is exactly
 * these wordings (a line per sentence, ≤ 2 sentences), so they can be recorded on demand like the builders' phrases.
 * The wizard's teaching times are one line shared by the time step and the 1-minute step.
 */
const SHELL: readonly ClipCatalogLine[] = [
  // onboarding: the name question (a greeting), then the address question (an answer)
  { id: 'shell.onboard.name', role: 'whole', wordings: w('Привет! Я Гамбитик, твой шахматный тренер. А как тебя зовут?') },
  { id: 'shell.onboard.address', role: 'whole', wordings: w('Приятно познакомиться! Скажи, ты мальчик или девочка?') },
  // the new-game wizard: step 1 (time), step 3 (how Гамбитик helps; the 1-minute game says what he does there)
  { id: 'shell.wizard.time', role: 'whole', wordings: w('Сколько будем играть? В молнии я только поздороваюсь.') },
  { id: 'shell.wizard.teachTimes', role: 'whole', wordings: w('Учить могу на пяти, десяти минутах и без часов.') },
  { id: 'shell.wizard.bullet', role: 'whole', wordings: w('В молнии я только поздороваюсь, а поговорим после партии.') },
  { id: 'shell.wizard.teacher', role: 'whole', wordings: w('Хочешь, я буду твоим учителем — показывать хорошие ходы и объяснять?') },
  { id: 'shell.wizard.self', role: 'whole', byGender: true, wordings: w('Или подумаешь {g:сам|сама}, а я помогу, когда попросишь?') },
  { id: 'shell.wizard.help', role: 'whole', byGender: true, wordings: w('Я помогу, когда попросишь. А хочешь — сыграешь экзамен совсем {g:сам|сама}.') },
  // the parent gate, said to the child
  { id: 'shell.parentGate', role: 'whole', wordings: w('Это страница для взрослых. Позови маму или папу!') },
  // a long session: the mascot's own break lines (@gambit/content MASCOT.phrases.break — catalog.test.ts keeps them equal)
  { id: 'shell.break', role: 'whole', wordings: w('Фух, я подустал. И глазкам пора отдохнуть. Продолжим завтра?', 'Мы сегодня здорово потрудились. Может, перерыв?') },
  // in a game: the one clock word, and the «Подсказка» button in a game without hints
  { id: 'shell.hurry', role: 'whole', wordings: w('Поторопись!') },
  { id: 'shell.noHints.exam', role: 'whole', wordings: w('Это экзамен — сегодня играем без подсказок. Я в тебя верю!') },
  { id: 'shell.noHints.fast', role: 'whole', wordings: w('В быстрой партии я молчу, чтобы не мешать. Всё разберём после игры!') },
];

/** A poke on Гамбитик while he is quiet (mascot catchphrases), and the voice sample of the settings («Послушать»). */
const TAPS: readonly ClipCatalogLine[] = [
  {
    id: 'poke',
    role: 'whole',
    wordings: w(
      'Сначала смотрим — потом ходим!',
      'Ход конём!',
      'И-го-го! Дай копыто!',
      'Копытом чую — тут что-то есть!',
      'Так-так-так… дай-ка прикину…',
      'Стоп — смотрю — считаю — проверяю — хожу!',
      'Ошибка — это находка: теперь мы знаем больше.',
      'Шахи, взятия, угрозы — проверим всё!',
      'Одним прыжком на двоих — люблю вилки!',
    ),
  },
  { id: 'preview', role: 'whole', wordings: w('Привет! Я Гамбитик. Вот так звучит мой голос.', 'Привет! Это мой голос — давай играть вместе!') },
];

/**
 * Every line the no-microphone UI says from a TAP (apps/web/src/coach/clips/clipAsk.ts — «Спроси», the thought chips —,
 * the dock's poke, the settings' «Послушать»), with the piece variants it can ask for. These are heard on the child's
 * request, not in the harvest: the tools force every one of them into the Starter tier (tools/voice-clips/script.ts),
 * and clipAsk.test.ts checks that clipAsk emits nothing else.
 */
export const CLIP_TAP_LINES: readonly { line: string; pieces?: readonly PieceType[] }[] = [
  { line: 'poke' },
  { line: 'preview' },
  { line: 'ask.why.think' },
  { line: 'ask.opp.notYet' },
  { line: 'ask.opp.none' },
  { line: 'ask.opp.mate' },
  { line: 'ask.opp.fork' },
  { line: 'ask.opp.hanging', pieces: ['p', 'n', 'b', 'r', 'q'] },
  { line: 'ask.opp.threat' },
  { line: 'ask.repeat.stale' },
  { line: 'opp.took', pieces: ['p', 'n', 'b', 'r', 'q'] },
  { line: 'opp.castled' },
  { line: 'opp.check' },
  { line: 'opp.attack', pieces: ['n', 'b', 'r', 'q'] },
  { line: 'opp.developed', pieces: ['n', 'b'] },
  { line: 'opp.pawn' },
  { line: 'opp.moved', pieces: ['n', 'b', 'r', 'q', 'k'] },
  { line: 'thought.easy' },
  { line: 'thought.hard' },
  { line: 'thought.goodMove' },
  { line: 'thought.mistake' },
  { line: 'thought.rematch' },
];

export const GAME_CATALOG: readonly ClipCatalogLine[] = [
  ...GREETING,
  ...GAME_START,
  ...STRATEGY_INTROS,
  ...PRAISE,
  ...TAKEBACK,
  ...GAME_END,
  ...GENERICS,
  ...BARKS,
  ...ASK,
  ...THOUGHTS,
  ...TAPS,
  ...SHELL,
];
