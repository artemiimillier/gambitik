/**
 * Wordings of «Учитель» — family «ideasPlay» (docs/TEACHING.md §5; pool specs: ../spec.ts).
 * Rules: no Latin, NO squares (the board shows them), Гамбитик speaks of himself as a boy, the child through {g:…},
 * no «молодец», no clock words; «вот эти клетки / этот фланг / сюда» only in pools with a board cue.
 *
 * The pools are the idea tails `v3.idea.<id>` of the opening, middlegame and endgame ideas (castle … quiet): the WHY
 * of an advised move, said after ANY lead with the moving piece — «Давай сходим {конём}», «{Конь} просится в бой»,
 * «По нашему плану идёт {конь}», «Отвечаем {пешкой}», «Вот он: ход {слоном}», «Ход {ферзём} хорош»,
 * «Напомню: мой совет — ход {конём}». A tail starts with «—», is «мы»-future or present, ≤ 10 words, and has no
 * second dash inside (the lead + «—» + tail already has one: «…пешкой — центр — наша цель» sounds broken).
 *
 * Truth (the detectors: packages/core/src/coach/moveIdeas.ts):
 *  - the lead already names the piece, so a tail with a piece subject speaks of it by pronoun ({он}/{его}/{ему});
 *    a pool with a subject never names a piece word (the lint expands {он} for every piece — «пешку» would be wrong
 *    for a knight), so aimWeakSquare says «клетка / место рядом с королём», passedPawn — «превращение», «последний ряд»,
 *    «сильная фигура»; a pool WITHOUT a subject whose mover is always one piece type (centerPawn, fightCenter,
 *    openLine, space — a pawn; rookOpenFile, rookSeventh — a rook; kingActivity — the king) may say a fixed
 *    «она / он / его» instead of repeating the lead's piece («Давай сходим ладьёй — она ворвётся в лагерь соперника»),
 *    and never names that same piece again («…пешкой — и у нас будет пешка в центре» is a double naming);
 *    recording economy: most tails are piece-free (recorded once), only a few carry {он}/{ему}/{коня};
 *  - develop: «центр» only in when:['center'] (the piece hits a centre square after the move); a plain development
 *    (Bb5, Bg5, Be2, Na3 …) only «выходит в игру / из дома»;
 *  - openLine: the pawn opens a road to a bishop OR the queen, along a diagonal OR a file — so «фигура сзади /
 *    дальнобойная фигура / слон или ферзь», «линия / дорога» (never «диагональ» alone);
 *  - fightCenter: our pawn and the attacked centre pawn attack EACH OTHER (pawn attacks are mutual), so «пешки могут
 *    разменяться» is true; it is not yet a win of the pawn;
 *  - prepareCastle: after the move every square between the king and that rook is empty (the path is free, the
 *    castling itself may still wait: «скоро», «можно подумать»);
 *  - trade: a trade without a variant (unequal pieces the line evened out) hears only the untagged wordings, so «такой
 *    же силы / той же цены» are when:['same','diff']; diff is always a knight for a bishop («лёгкая за лёгкую»);
 *  - kingActivity: 'center' may step back towards the centre, 'pawns' may step back to stop a pawn — «вперёд» only in
 *    when:['forward'];
 *  - opposition: the kings stand with one square between, and that square can never be taken by either king;
 *  - quiet: nothing is given away, the landing square is safe — never «всё защищено», never «ничем не рискуем».
 * Stage words: «развитие» from 2, «слабое место / детский мат» from 2–3, «открытая / полуоткрытая линия»,
 * «вертикаль», «горизонталь», «диагональ», «фланг», «дальнобойная», «лёгкая фигура» from 3, «проходная», «эндшпиль»,
 * «активный король», «оппозиция» — only at 5.
 * Kept apart from the neighbours that say the same idea in other shapes: v3.aim.*, v3.result.*, v3.themeTail.*,
 * v3.why.*, v3.praise.* (checked by hand: no near-copies).
 */
import type { LessonWordings } from '../types.ts';

const YOUNG = [1, 2] as const;
const OLD = [3, 5] as const;
const ST2 = [2, 2] as const;
const ST5 = [5, 5] as const;

export const WORDINGS: LessonWordings = {
  // ───────────────────────── C: opening principles ─────────────────────────

  // castling (usually said as a whole v3.whole.castle; the tail is for «Почему так?» and the rare lead + tail)
  'v3.idea.castle': [
    { t: '— когда откроются линии, он будет уже в укрытии.' },
    { t: '— это самый быстрый способ спрятать короля.' },
    { t: '— так ладья выйдет из угла.' },
    { t: '— спрячем самую главную фигуру.' },
    { t: '— один ход, а сразу двум фигурам польза.' },
    { t: '— переедем в уголок, подальше от центра.' },
    { t: '— он отправится отдыхать в домик.' },
  ],

  // a knight or a bishop leaves home (center — it hits a centre square after the move; plain — it does not)
  'v3.idea.develop': [
    // every stage
    { t: '— разбудим фигуру, которая спит дома.' },
    { t: '— новая фигура вступает в игру.' },
    { t: '— в игре станет на одну фигуру больше.' },
    { t: '— {он} встанет на боевой пост.' },
    { t: '— пора и {ему} поработать!' },
    { t: '— выйдем в игру и возьмём центр на прицел.', when: ['center'] },
    // stages 1–2
    { t: '— хватит {ему} спать дома!', stages: YOUNG },
    { t: '— {он} {p:засиделся|засиделась} дома!', stages: YOUNG },
    { t: '— выводим фигуру из дома: пора в бой!', stages: YOUNG },
    { t: '— {он} выйдет из дома помогать своим.', stages: YOUNG },
    { t: '— дома {ему} больше делать нечего.', stages: YOUNG },
    { t: '— так фигура встанет поближе к центру.', stages: YOUNG, when: ['center'] },
    { t: '— оттуда хорошо стрелять по центру.', stages: YOUNG, when: ['center'] },
    { t: '— {он} будет смотреть прямо в центр.', stages: YOUNG, when: ['center'] },
    { t: '— это развитие: фигура покидает дом и идёт в бой.', stages: ST2 },
    // stages 3–5
    { t: '— это развитие: чем раньше, тем лучше.', stages: OLD },
    { t: '— в хорошем дебюте фигуры выходят быстро.', stages: OLD },
    { t: '— чем быстрее выйдут фигуры, тем скорее мы готовы к бою.', stages: OLD },
    { t: '— пусть работают все фигуры, и {он} тоже.', stages: OLD },
    { t: '— лёгкая фигура займёт боевую позицию.', stages: OLD },
    { t: '— оттуда фигура будет бить клетки в центре.', stages: OLD, when: ['center'] },
    { t: '— {он} поможет нам в борьбе за центр.', stages: OLD, when: ['center'] },
    { t: '— с новой клетки фигура увидит центр.', stages: OLD, when: ['center'] },
  ],

  // a pawn steps into the centre (the lead named the pawn: «она», never «пешка» again)
  'v3.idea.centerPawn': [
    // every stage
    { t: '— так у нас появится своя клетка в центре.' },
    { t: '— она встанет в самую середину доски.' },
    { t: '— посередине она будет охранять соседние клетки.' },
    { t: '— займём главное место на доске.' },
    // stages 1–2
    { t: '— центр её уже ждёт!', stages: YOUNG },
    { t: '— шагнём прямо в центр!', stages: YOUNG },
    { t: '— чужим фигурам рядом с ней станет тесно.', stages: YOUNG },
    { t: '— из центра она стреляет по двум клеткам сразу.', stages: YOUNG },
    { t: '— в центре она будет как часовой.', stages: YOUNG },
    { t: '— вперёд, в серединку!', stages: YOUNG },
    { t: '— в серединке ей самое место.', stages: YOUNG },
    // stages 3–5
    { t: '— соседние клетки станут опасными для чужих фигур.', stages: OLD },
    { t: '— кто держит центр, тому легче играть по всей доске.', stages: OLD },
    { t: '— наши фигуры получат опору в центре.', stages: OLD },
    { t: '— захватим центр: оттуда она давит на обе стороны.', stages: OLD },
    { t: '— борьба за центр начинается с пешек.', stages: OLD },
    { t: '— соперник уже не займёт центр так легко.', stages: OLD },
    { t: '— с ней нашим фигурам будет где развернуться.', stages: OLD },
  ],

  // a pawn hits the opponent's centre pawn (without taking it); the two pawns now attack each other
  'v3.idea.fightCenter': [
    // every stage
    { t: '— и нападём на пешку соперника прямо в центре.' },
    { t: '— поспорим за центр всерьёз!' },
    // stages 1–2
    { t: '— стукнем по пешке соперника в центре!', stages: YOUNG },
    { t: '— не отдадим центр без боя!', stages: YOUNG },
    { t: '— пешка соперника в центре задрожит!', stages: YOUNG },
    { t: '— пешка против пешки: кто сильнее в центре?', stages: YOUNG },
    { t: '— зацепим пешку соперника в центре!', stages: YOUNG },
    { t: '— пусть соперник поломает голову над центром!', stages: YOUNG },
    { t: '— вперёд, в бой за центр!', stages: YOUNG },
    // stages 3–5
    { t: '— зададим центру соперника трудный вопрос.', stages: OLD },
    { t: '— подкопаемся под центр соперника.', stages: OLD },
    { t: '— соперник должен решить: разменять, защитить или пройти вперёд.', stages: OLD },
    { t: '— вызовем пешку соперника на дуэль.', stages: OLD },
    { t: '— теперь пешки в центре могут разменяться.', stages: OLD },
    { t: '— сопернику придётся думать о центре.', stages: OLD },
    { t: '— так мы не дадим сопернику спокойно держать центр.', stages: OLD },
  ],

  // pawn — the pawn move defends our attacked centre pawn; step — it prepares a pawn's step into the centre
  'v3.idea.supportCenter': [
    // every stage
    { t: '— центр станет крепче.' },
    { t: '— поддержим нашу пешку в центре.', when: ['pawn'] },
    { t: '— подготовим соседней пешке дорогу в центр.', when: ['step'] },
    // stages 1–2
    { t: '— у пешки в центре появится подружка.', stages: YOUNG, when: ['pawn'] },
    { t: '— одна пешка защитит другую.', stages: YOUNG, when: ['pawn'] },
    { t: '— она прикроет соседку в центре.', stages: YOUNG, when: ['pawn'] },
    { t: '— потом соседняя пешка шагнёт в центр под защитой.', stages: YOUNG, when: ['step'] },
    { t: '— скоро другая пешка займёт центр, а эта ей поможет.', stages: YOUNG, when: ['step'] },
    { t: '— позаботимся о центре заранее.', stages: YOUNG, when: ['step'] },
    { t: '— так центр труднее будет отнять.', stages: YOUNG },
    // stages 3–5
    { t: '— укрепим центр: пешка защищает пешку.', stages: OLD, when: ['pawn'] },
    { t: '— выстроим пешки цепочкой.', stages: OLD, when: ['pawn'] },
    { t: '— подставим плечо пешке в центре.', stages: OLD, when: ['pawn'] },
    { t: '— следующим ходом пешка сможет занять центр под защитой.', stages: OLD, when: ['step'] },
    { t: '— строим центр по кирпичику: сначала опора, потом пешка.', stages: OLD, when: ['step'] },
    { t: '— готовим почву для пешки в центре.', stages: OLD, when: ['step'] },
    { t: '— с крепким центром играть спокойнее.', stages: OLD },
  ],

  // a pawn move opens a road to our bishop or queen (a diagonal or a file) — «фигура сзади», not always «слон»
  'v3.idea.openLine': [
    // every stage
    { t: '— она уступит дорогу слону или ферзю.' },
    { t: '— за ней откроется дорога.' },
    // stages 1–2
    { t: '— позади проснётся фигура, которая ходит далеко.', stages: YOUNG },
    { t: '— у слона или ферзя появится дорожка.', stages: YOUNG },
    { t: '— откроем окошко для фигуры, что стоит сзади.', stages: YOUNG },
    { t: '— она подвинется, и фигуре позади станет просторно.', stages: YOUNG },
    { t: '— она перестанет загораживать дорогу.', stages: YOUNG },
    { t: '— откроем путь фигуре, которая стреляет издалека.', stages: YOUNG },
    { t: '— освободим дорогу фигуре, которая пряталась позади.', stages: YOUNG },
    // stages 3–5
    { t: '— откроем линию для слона или ферзя.', stages: OLD },
    { t: '— освободим путь дальнобойным фигурам.', stages: OLD },
    { t: '— она сдвинется, и фигура позади оживёт.', stages: OLD },
    { t: '— эта линия больше не заперта.', stages: OLD },
    { t: '— слону и ферзю нужны свободные линии.', stages: OLD },
    { t: '— у фигуры сзади станет больше ходов.', stages: OLD },
    { t: '— дальнобойная фигура увидит дальше.', stages: OLD },
  ],

  // a bishop or the queen aims at the weak pawn by the opponent's king (the king still at home; it guards that square)
  'v3.idea.aimWeakSquare': [
    // every stage
    { t: '— прицелимся в клетку рядом с королём соперника.' },
    { t: '— посмотрим на клетку, которую бережёт король.' },
    { t: '— {он} издалека заглянет к королю соперника.' },
    // stages 1–2
    { t: '— {он} уставится прямо на клетку у короля.', stages: YOUNG },
    { t: '— пусть соперник подумает, как защитить эту клетку.', stages: YOUNG },
    { t: '— надавим на клетку возле короля.', stages: YOUNG },
    { t: '— {он} будет следить за клеткой рядом с королём.', stages: YOUNG },
    { t: '— пусть король соперника знает: мы рядом!', stages: YOUNG },
    { t: '— клетка у короля станет нашей целью.', stages: YOUNG },
    { t: '— нацелимся туда, где у соперника слабое место.', stages: ST2 },
    // stages 3–5
    { t: '— {он} нацелится в слабое место рядом с королём.', stages: OLD },
    { t: '— {он} встанет на линию к слабой клетке у короля.', stages: OLD },
    { t: '— {он} смотрит туда же, куда целятся в детском мате.', stages: OLD },
    { t: '— давим на слабое место, пока король дома.', stages: OLD },
    { t: '— слабая точка у короля окажется под ударом.', stages: OLD },
    { t: '— соперник должен будет беречь слабое место у короля.', stages: OLD },
  ],

  // a piece leaves the road between the king and a rook: the path for castling is free (castling may still wait)
  'v3.idea.prepareCastle': [
    // every stage
    { t: '— освободим королю дорогу в домик.' },
    { t: '— между королём и ладьёй станет пусто.' },
    // stages 1–2
    { t: '— скоро король сможет спрятаться в домик.', stages: YOUNG },
    { t: '— уберём фигуру с дороги короля.', stages: YOUNG },
    { t: '— ещё чуть-чуть, и рокировка!', stages: YOUNG },
    { t: '— король уже поглядывает на свой домик.', stages: YOUNG },
    { t: '— дорога к домику почти готова.', stages: YOUNG },
    { t: '— ещё один шаг к домику для короля.', stages: YOUNG },
    { t: '— расчистим дорожку для рокировки.', stages: YOUNG },
    // stages 3–5
    { t: '— скоро король уйдёт из центра.', stages: OLD },
    { t: '— следующим ходом можно подумать о рокировке.', stages: OLD },
    { t: '— готовим рокировку: лишних фигур на пути короля нет.', stages: OLD },
    { t: '— дорога для рокировки расчищена.', stages: OLD },
    { t: '— рокировка уже близко.', stages: OLD },
    { t: '— безопасность короля начинается с таких ходов.', stages: OLD },
    { t: '— освобождаем проход для короля и ладьи.', stages: OLD },
  ],

  // a second idea: the piece hits more centre squares than before (it may have hit some already: no «ещё одна фигура»)
  'v3.idea.centerControl': [
    // every stage
    { t: '— {он} встанет на охрану центра.' },
    { t: '— {он} подключится к борьбе за центр.' },
    // stages 1–2
    { t: '— оттуда хорошо видна середина доски.', stages: YOUNG },
    { t: '— {он} возьмёт центр под присмотр.', stages: YOUNG },
    { t: '— так {он} поможет держать центр.', stages: YOUNG },
    { t: '— {ему} станет лучше виден центр.', stages: YOUNG },
    { t: '— теперь и вот эти клетки под нашим присмотром.', stages: YOUNG },
    { t: '— в центре станет больше наших глаз.', stages: YOUNG },
    { t: '— центр будет как на ладони.', stages: YOUNG },
    // stages 3–5
    { t: '— теперь больше клеток в центре под боем.', stages: OLD },
    { t: '— центр окажется под {его} прицелом.', stages: OLD },
    { t: '— {он} надавит на клетки в центре.', stages: OLD },
    { t: '— наш контроль над центром станет крепче.', stages: OLD },
    { t: '— сила фигуры растёт, когда она смотрит в центр.', stages: OLD },
    { t: '— с нового места центр виден лучше.', stages: OLD },
    { t: '— держать центр теперь проще.', stages: OLD },
  ],

  // both rooks see each other on the back rank: the opening is almost over
  'v3.idea.connectRooks': [
    { t: '— ладьи наконец увидят друг друга.' },
    { t: '— ладьи будут охранять друг друга.' },
    { t: '— фигуры вышли, и ладьи встретятся.' },
    { t: '— две ладьи встанут дружной парой.' },
    { t: '— по своему ряду ладьи пройдут друг к другу.' },
    { t: '— вместе ладьи сильнее, чем поодиночке.' },
    { t: '— у каждой ладьи появится напарник.' },
    { t: '— так и заканчивается дебют.', stages: OLD },
  ],

  // ───────────────────────── D: middlegame ─────────────────────────

  // open — a file without pawns; halfOpen — without our pawns, with an opponent's pawn
  'v3.idea.rookOpenFile': [
    { t: '— впереди у неё нет наших пешек.' },
    { t: '— оттуда она смотрит далеко вперёд.' },
    { t: '— раньше ей мешали свои пешки, а здесь их нет.' },
    { t: '— на этой линии нет ни одной пешки.', when: ['open'] },
    { t: '— ни своих, ни чужих пешек на пути.', when: ['open'] },
    { t: '— встанем на открытую линию.', stages: OLD, when: ['open'] },
    { t: '— на открытой вертикали ладье раздолье.', stages: OLD, when: ['open'] },
    { t: '— у ладьи на этой линии есть цель: пешка соперника.', when: ['halfOpen'] },
    { t: '— наших пешек тут нет, зато есть чужая пешка.', when: ['halfOpen'] },
    { t: '— полуоткрытая линия ведёт прямо к пешке соперника.', stages: OLD, when: ['halfOpen'] },
    { t: '— давим по полуоткрытой вертикали на чужую пешку.', stages: OLD, when: ['halfOpen'] },
  ],

  // a rook breaks into the opponent's camp (his pawns there, or his king behind)
  'v3.idea.rookSeventh': [
    { t: '— она ворвётся в лагерь соперника.' },
    { t: '— заберёмся глубоко на сторону соперника.' },
    { t: '— она встанет прямо за спиной у соперника.' },
    { t: '— в чужом лагере она наведёт шороху.' },
    { t: '— там она поищет себе добычу.' },
    { t: '— нагрянем к сопернику в гости.' },
    { t: '— выходим на седьмую горизонталь.', stages: OLD },
    { t: '— на седьмой горизонтали ладья очень сильна.', stages: OLD },
  ],

  // a passed pawn goes on to promotion (the subject is that pawn: never a piece word, only pronouns)
  'v3.idea.passedPawn': [
    // every stage
    { t: '— до превращения всё ближе.' },
    { t: '— идём туда, где превращаются в сильную фигуру.' },
    // stages 1–2
    { t: '— бегом к последнему ряду!', stages: YOUNG },
    { t: '— вперёд, к финишу!', stages: YOUNG },
    { t: '— {он} мечтает дойти до конца доски.', stages: YOUNG },
    { t: '— топ-топ, прямо к превращению!', stages: YOUNG },
    { t: '— там, в конце доски, ждёт превращение.', stages: YOUNG },
    { t: '— шагаем дальше, до самого конца!', stages: YOUNG },
    { t: '— на последнем ряду {его} ждёт сюрприз!', stages: YOUNG },
    // stages 3–5
    { t: '— чем ближе к цели, тем {он} опаснее.', stages: OLD },
    { t: '— пусть соперник думает, как {его} остановить.', stages: OLD },
    { t: '— рвёмся вперёд без остановки.', stages: OLD },
    { t: '— двигаемся вперёд, к превращению.', stages: OLD },
    { t: '— до последнего ряда всё меньше шагов.', stages: OLD },
    { t: '— у соперника прибавится забот.', stages: OLD },
    { t: '— каждый шаг приближает превращение.', stages: OLD },
    // stage 5
    { t: '— проходные должны идти вперёд.', stages: ST5 },
    { t: '— у нас проходная: двигаем её к превращению.', stages: ST5 },
  ],

  // a trade; the subject is the opponent's piece we take (same — the same pieces; diff — a knight for a bishop;
  // ahead — we have more material; no variant — unequal pieces the engine line evened out: only untagged wordings)
  'v3.idea.trade': [
    // every stage, every trade
    { t: '— мы берём {коня}, соперник возьмёт в ответ.' },
    { t: '— после размена счёт не изменится.' },
    // stages 1–2
    { t: '— заберём {коня}, и начнётся размен.', stages: YOUNG },
    { t: '— заберём {коня}, но отдадим фигуру такой же силы.', stages: YOUNG, when: ['same', 'diff'] },
    { t: '— меняемся одинаковыми фигурами.', stages: YOUNG, when: ['same'] },
    { t: '— {конь} соперника исчезнет, но и {p:наш|наша} тоже.', stages: YOUNG, when: ['same'] },
    { t: '— фигуры не похожи, но цена у них одна.', stages: YOUNG, when: ['diff'] },
    { t: '— отдадим фигуру, а возьмём {коня} той же цены.', stages: YOUNG, when: ['diff'] },
    { t: '— размены выгодны тому, кто сильнее, а сильнее мы!', stages: YOUNG, when: ['ahead'] },
    { t: '— мы впереди: меняемся и идём к победе.', stages: YOUNG, when: ['ahead'] },
    // stages 3–5
    { t: '— отдаём и забираем поровну.', stages: OLD },
    { t: '— меняем фигуру на фигуру той же цены.', stages: OLD, when: ['same', 'diff'] },
    { t: '— {коня} меняем на {p:такого же|такую же}.', stages: OLD, when: ['same'] },
    { t: '— лёгкая фигура за лёгкую фигуру: цена равная.', stages: OLD, when: ['diff'] },
    { t: '— разные фигуры, но по силе они равны.', stages: OLD, when: ['diff'] },
    { t: '— у нас перевес, а чем проще позиция, тем легче выиграть.', stages: OLD, when: ['ahead'] },
    { t: '— у соперника станет меньше фигур для контратаки.', stages: OLD, when: ['ahead'] },
  ],

  // a pawn on the queen's side steps forward and takes squares in the opponent's half
  'v3.idea.space': [
    { t: '— она шагнёт вперёд и отнимет место у соперника.' },
    { t: '— отвоюем место на стороне ферзя.' },
    { t: '— отберём у соперника пару клеток.' },
    { t: '— теперь она держит клетки на половине соперника.' },
    { t: '— фигурам соперника там станет теснее.' },
    { t: '— так мы потесним соперника.' },
    { t: '— так мы отодвигаем соперника назад.' },
    { t: '— расширим свои владения на ферзевом фланге.', stages: OLD },
    { t: '— давим на ферзевом фланге: у соперника меньше места.', stages: OLD },
  ],

  // ───────────────────────── E: endgame ─────────────────────────

  // few pieces, the king walks: center — towards the centre; forward — forward; pawns — to the pawns
  'v3.idea.kingActivity': [
    // every stage, every variant
    { t: '— теперь у него полно работы.' },
    { t: '— он умеет не только прятаться.' },
    // stages 1–2
    { t: '— пусть и он поработает!', stages: YOUNG },
    { t: '— отправим его поближе к центру.', stages: YOUNG, when: ['center'] },
    { t: '— из центра легче дойти до любой пешки.', stages: YOUNG, when: ['center'] },
    { t: '— смело шагаем вперёд!', stages: YOUNG, when: ['forward'] },
    { t: '— вперёд, помогай своим!', stages: YOUNG, when: ['forward'] },
    { t: '— спешим к пешкам: там есть дело.', stages: YOUNG, when: ['pawns'] },
    { t: '— он подойдёт поближе к пешкам.', stages: YOUNG, when: ['pawns'] },
    // stages 3–5
    { t: '— в конце партии каждый его шаг важен.', stages: OLD },
    { t: '— идём к центру: оттуда открыты все дороги.', stages: OLD, when: ['center'] },
    { t: '— из центра он дотянется до любого края доски.', stages: OLD, when: ['center'] },
    { t: '— шаг вперёд, и он займёт важные клетки.', stages: OLD, when: ['forward'] },
    { t: '— двигаем его вперёд: так он сильнее.', stages: OLD, when: ['forward'] },
    { t: '— он подойдёт к пешкам и возьмётся за дело.', stages: OLD, when: ['pawns'] },
    { t: '— у пешек для него найдётся работа.', stages: OLD, when: ['pawns'] },
    // stage 5
    { t: '— в эндшпиле он должен быть активным.', stages: ST5 },
  ],

  // the opponent has a lonely king (maybe pawns): we take its squares away, drive it to the edge
  'v3.idea.restrictKing': [
    { t: '— отнимем у короля соперника ещё одну клетку.' },
    { t: '— загоняем короля к краю доски.' },
    { t: '— коробочка для короля станет меньше.' },
    { t: '— королю соперника станет теснее.' },
    { t: '— клетка за клеткой прижимаем короля.' },
    { t: '— одинокому королю всё труднее убегать.' },
    { t: '— так король соперника не убежит на простор.' },
  ],

  // the kings face each other with one square between: the opponent's king has to give way
  'v3.idea.opposition': [
    { t: '— короли встанут нос к носу, и чужому придётся уступить.' },
    { t: '— короли играют в гляделки, и первым отвернётся чужой.' },
    { t: '— наш король не пропустит чужого вперёд.' },
    { t: '— король соперника должен будет посторониться.' },
    { t: '— клетку между королями не займёт никто.' },
    { t: '— это оппозиция: король соперника должен уступить дорогу.', stages: ST5 },
  ],

  // ───────────────────────── F: the rest ─────────────────────────

  // a piece goes where it sees more squares (not in the opening)
  'v3.idea.improvePiece': [
    // every stage
    { t: '— с нового места видно все вот эти клетки.' },
    { t: '— {он} займёт место повыгоднее.' },
    // stages 1–2
    { t: '— там {ему} будет просторнее.', stages: YOUNG },
    { t: '— оттуда видно больше клеток.', stages: YOUNG },
    { t: '— {он} переедет туда, где веселее.', stages: YOUNG },
    { t: '— на новом месте фигура станет сильнее.', stages: YOUNG },
    { t: '— {он} найдёт себе местечко поудобнее.', stages: YOUNG },
    { t: '— оттуда {он} дотянется до многих клеток.', stages: YOUNG },
    { t: '— пусть {он} поработает с нового места.', stages: YOUNG },
    // stages 3–5
    { t: '— оттуда фигура будет бить больше клеток.', stages: OLD },
    { t: '— {он} встанет активнее и будет полезнее.', stages: OLD },
    { t: '— найдём {ему} место, где {он} сильнее.', stages: OLD },
    { t: '— так от фигуры будет больше пользы.', stages: OLD },
    { t: '— возможностей у фигуры станет больше.', stages: OLD },
    { t: '— фигуре нужно место, где она работает, а не скучает.', stages: OLD },
    { t: '— хорошая фигура та, что много видит.', stages: OLD },
  ],

  // an honest quiet move without a special idea: nothing is given away (never «всё защищено» / «без риска»)
  'v3.idea.quiet': [
    // every stage
    { t: '— крепко стоим и смотрим, что задумал соперник.' },
    { t: '— ничего не отдаём и готовимся к бою.' },
    // stages 1–2
    { t: '— тихо, как мышка, но с пользой.', stages: YOUNG },
    { t: '— не торопимся, играем надёжно.', stages: YOUNG },
    { t: '— маленький шажок тоже важен.', stages: YOUNG },
    { t: '— не всегда нужно нападать.', stages: YOUNG },
    { t: '— ход скромный, зато безопасный.', stages: YOUNG },
    { t: '— пусть фигура постоит в надёжном месте.', stages: YOUNG },
    { t: '— потихоньку-полегоньку.', stages: YOUNG },
    // stages 3–5
    { t: '— ничего не подставляем, и соперник не получит подарков.', stages: OLD },
    { t: '— позиция станет чуть удобнее.', stages: OLD },
    { t: '— иногда нужно просто укрепиться.', stages: OLD },
    { t: '— спокойный ход: пусть соперник покажет свой план.', stages: OLD },
    { t: '— надёжный ход без лишнего риска.', stages: OLD },
    { t: '— терпение: хороший ход не всегда громкий.', stages: OLD },
    { t: '— копим силы для будущей борьбы.', stages: OLD },
  ],
};
