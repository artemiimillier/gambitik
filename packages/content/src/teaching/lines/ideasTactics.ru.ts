/**
 * Wordings of «Учитель» — family «ideasTactics» (docs/TEACHING.md §5; pool specs: ../spec.ts).
 * Rules: no Latin, NO squares (the board shows them), Гамбитик speaks of himself as a boy, the child through {g:…},
 * no «молодец», no clock words; «вот эти клетки / этот фланг / сюда» only in pools with a board cue.
 *
 * These are the WHY-tails of the tactical and defensive ideas: they follow any lead («Давай сходим {конём}», «{конь}
 * просится в бой», «Отвечаем {пешкой}», «Ход {ферзём} хорош» …), so they speak in the «мы»-future or the present and
 * never lean on «он / она» for the moving piece unless the pool's subject IS the moving piece. In a pool whose subject
 * is another piece (target / defended) that piece is named before any pronoun points at it.
 * Truth follows the detectors of packages/core/src/coach/moveIdeas.ts and analysis/motifs.ts (see the notes per pool).
 * An advice tail is often followed by the outcome line v3.result.<idea> after the child's move, so the tails avoid the
 * wordings of v3.result.* / v3.praise.* / v3.treasure.* (the child would hear the same sentence twice in a row).
 */
import type { LessonWordings } from '../types.ts';

const YOUNG = [1, 2] as const;
const OLD = [3, 5] as const;

export const WORDINGS: LessonWordings = {
  // the move mates
  'v3.idea.mate': [
    { t: '— и это мат!', mood: 'excited' },
    { t: '— шах, и спасения нет: это мат!' },
    { t: '— королю соперника не спрятаться: мат!' },
    { t: '— ставим мат!', mood: 'excited' },
    { t: '— мат в один ход!' },
    { t: '— победный ход: мат!' },
    { t: '— мат, и победа наша!', mood: 'excited' },
    { t: '— последний ход партии: мат!' },
  ],

  // a forced mate in 2 (m2) / 3 (m3) of our moves, this one included, or along the back rank (backRank: the king is
  // locked in by its own pawns). «ещё один ход» / «ещё два наших хода» count the moves AFTER this one.
  'v3.idea.mateSoon': [
    { t: '— так мы идём к мату.' },
    { t: '— королю соперника уже не спастись!' },
    { t: '— мат уже близко!' },
    { t: '— король соперника уже в западне!' },
    { t: '— и следующим ходом будет мат!', when: ['m2'] },
    { t: '— ещё один ход, и мат!', when: ['m2'] },
    { t: '— ещё два наших хода, и мат!', when: ['m3'] },
    { t: '— это первый шаг к мату в три хода.', when: ['m3'] },
    { t: '— король соперника заперт своими же пешками: мат близко!', when: ['backRank'] },
    { t: '— король не выберется из-за своих пешек, и будет мат!', when: ['backRank'] },
    { t: '— по последнему ряду прорвёмся к мату!', when: ['backRank'], stages: [2, 3] },
    { t: '— готовим мат по последней горизонтали.', when: ['backRank'], stages: [4, 5] },
  ],

  // the pawn promotes (the mover is always the pawn; «обычно в ферзя» — so the queen is never promised)
  'v3.idea.promotion': [
    { t: '— {он} дойдёт до края и превратится!', mood: 'excited' },
    { t: '— это превращение: у нас появится новая фигура!' },
    { t: '— {он} {p:заслужил|заслужила} награду: новую фигуру!' },
    { t: '— край доски: время превращения!' },
    { t: '— так {он} получит новую силу!' },
    { t: '— ура, превращение!', mood: 'excited' },
    { t: '— мечта сбывается: превращение!' },
    { t: '— как в сказке: {он} станет новой фигурой!' },
  ],

  // a fork now or two plies later, after a check / capture (motifs: two real targets — the king or pieces, never
  // pawns — one of them is won). The fork may come on the NEXT move, so no «это вилка» / «одним ходом» in the present:
  // «будет», «получится», «нападём». Stage 1: only «двойной удар»; stage 2 meets «вилка» once, with its meaning.
  'v3.idea.fork': [
    { t: '— и будет двойной удар!', mood: 'excited' },
    { t: '— одна наша фигура нападёт сразу на две.' },
    { t: '— две цели сразу: одну соперник не спасёт.' },
    { t: '— обе фигуры соперник спасти не успеет.' },
    { t: '— ударим, как краб: сразу двумя клешнями!' },
    { t: '— соперник спасёт одну фигуру, а другую заберём мы.' },
    { t: '— соперник схватится за голову: целей сразу две!' },
    { t: '— будет вилка: одна фигура ударит сразу по двум!', stages: [2, 5] },
    { t: '— так мы поймаем соперника на вилку.', stages: OLD },
    { t: '— вилка, и одна из фигур станет нашей.', stages: OLD, mood: 'excited' },
  ],

  // subject target = the pinned piece (never a pawn or the king); the variant = the piece behind it (king / queen /
  // rook; none — a minor piece worth more). The motif only fires when the line later wins the pinned piece.
  'v3.idea.pin': [
    { t: '— {конь} застрянет на месте, а потом мы {его} заберём.' },
    { t: '— прижмём {коня}: за {его} спиной фигура поважнее.' },
    { t: '— свяжем {коня}!', stages: OLD },
    { t: '— связка: {конь} {p:прикован|прикована} к месту.', stages: OLD },
    { t: '— {конь} не сможет уйти: за {его} спиной король.', when: ['king'] },
    { t: '— теперь {конь} {p:прилип|прилипла} к королю: уйти нельзя.', when: ['king'] },
    { t: '— свяжем {коня} с королём!', when: ['king'], stages: OLD },
    { t: '— за {конём} прячется самая сильная фигура соперника.', when: ['queen'] },
    { t: '— если {конь} отойдёт, фигура подороже достанется нам.', when: ['queen', 'rook'] },
    { t: '— {конь} загораживает фигуру подороже, и уйти {ему} страшно.', when: ['queen', 'rook'] },
  ],

  // subject target = the dear piece in FRONT: king → 'king' (said without a placeholder), queen → 'queen', else no
  // variant (a rook in front). The line: the front piece steps aside, the piece behind is taken with profit.
  'v3.idea.skewer': [
    { t: '— дорогая фигура уйдёт, и мы заберём ту, что за ней.' },
    { t: '— наш удар достанет и ту фигуру, что прячется сзади.' },
    { t: '— фигуры соперника стоят друг за другом, на свою беду.' },
    { t: '— это сквозной удар!', stages: OLD, mood: 'excited' },
    { t: '— сквозной удар: за первой фигурой прячется вторая.', stages: OLD },
    { t: '— король уйдёт, а фигуру за ним мы заберём.', when: ['king'] },
    { t: '— объявим шах, а заберём фигуру за королём.', when: ['king'] },
    { t: '— {конь} отойдёт, и мы доберёмся до фигуры сзади.', when: ['queen'] },
    { t: '— соперник спасёт {коня}, но потеряет фигуру сзади.', when: ['queen'] },
  ],

  // our piece steps aside and opens the line of another one, which attacks (a piece or the king)
  'v3.idea.discoveredAttack': [
    { t: '— и откроем дорогу другой нашей фигуре!' },
    { t: '— одна наша фигура отойдёт, а другая нападёт.' },
    { t: '— уйдём в сторону, и в бой вступит фигура сзади.' },
    { t: '— откроется линия, и наш дальний стрелок ударит.' },
    { t: '— вот эта линия откроется, и по ней пойдёт удар.' },
    { t: '— спрятанная фигура вдруг ударит!', mood: 'excited' },
    { t: '— это вскрытое нападение!', stages: [4, 5], mood: 'excited' },
    { t: '— вскрытое нападение: ударит фигура, что стояла сзади.', stages: [4, 5] },
  ],

  // two pieces check at once: no block and no capture helps, the king must move
  'v3.idea.doubleCheck': [
    { t: '— двойной шах!', mood: 'excited' },
    { t: '— шах сразу от двух наших фигур!' },
    { t: '— от двух шахов не закрыться: королю придётся бежать.' },
    { t: '— объявим королю два шаха сразу!' },
    { t: '— на такой шах один ответ: бежать королём.' },
  ],

  // subject target = the defender we take first; it is taken back, then we collect the prize (motifs.removeDefender;
  // the prize may be a pawn — «добыча», «тот, кого он охраняет»). «защитник» is a stage-4 word.
  'v3.idea.removeDefender': [
    { t: '— съедим {коня}, а потом и того, кого {он} охраняет.' },
    { t: '— {коня} заберём {p:первым|первой}: {он} сторожит другую фигуру.' },
    { t: '— заберём {коня}, и охранять станет некому.' },
    { t: '— снимаем сторожа: сначала {конь}, потом добыча.' },
    { t: '— уберём {коня}: {он} мешает нам взять добычу.' },
    { t: '— {конь} стоит на посту, но мы {его} снимем.' },
    { t: '— {конь} тут защитник: убираем {его}!', stages: [4, 5] },
    { t: '— уберём защитника, и другая фигура останется без охраны.', stages: [4, 5] },
  ],

  // subject target = a piece (not a pawn) every escape of which loses — the line collects it
  'v3.idea.trappedPiece': [
    { t: '— поймаем {коня}: {он} никуда не убежит.' },
    { t: '— куда бы {конь} ни {p:побежал|побежала}, мы {его} догоним.' },
    { t: '— тупик для {коня:gen}: выхода нет!' },
    { t: '— капкан сработает, и {конь} станет {p:нашим|нашей}.', mood: 'excited' },
    { t: '— окружим {коня}: спрятаться {ему} негде!' },
    { t: '— {конь} {p:заперт|заперта}: на любой клетке {его} ждёт удар.' },
    { t: '— {конь} как муха в паутине: не вырваться!' },
  ],

  // subject target = the piece we take and nobody can take back (never a recapture). The detector knows only that no
  // enemy piece can recapture (a pinned guard still «defends»), so the tails say «взять назад некому», «бесплатно»,
  // «даром» — not «без защиты» (docs/TEACHING.md §6.2).
  'v3.idea.freeCapture': [
    { t: '— и съедим {коня} бесплатно!' },
    { t: '— и отнять добычу соперник не сможет.' },
    { t: '— это подарок: забираем даром!', mood: 'excited' },
    { t: '— заберём {коня}, а наша фигура останется целой.' },
    { t: '— {конь} {p:сам|сама} идёт к нам в руки!' },
    { t: '— так мы выиграем {коня} без размена.' },
    { t: '— {коня} можно взять, и нас за это не съедят.', stages: YOUNG },
    { t: '— бесплатный приз: {конь}!', stages: YOUNG },
    { t: '— лёгкая добыча, и совсем бесплатная!', stages: YOUNG, mood: 'excited' },
    { t: '— цап, и {конь} уже {p:наш|наша}!', stages: YOUNG },
    { t: '— соперник проглядел {коня}, а мы заметили!', stages: YOUNG },
    { t: '— снимем {коня}: взять назад соперник не сможет.', stages: OLD },
    { t: '— чистый выигрыш: {конь} уходит к нам даром.', stages: OLD },
    { t: '— забираем {коня}, и сдачи не будет.', stages: OLD },
    { t: '— {конь} {p:подставлен|подставлена}: берём бесплатно.', stages: OLD },
    { t: '— плюс {конь}, и никаких потерь!', stages: OLD },
  ],

  // subject target = a DEFENDED piece we take with profit (SEE ≥ 1: it is worth more than all we give in the
  // exchanges; never «без защиты»)
  'v3.idea.winMaterial': [
    { t: '— после размена мы будем в плюсе.' },
    { t: '— на этом размене мы заработаем.' },
    { t: '— считаем: заберём больше, чем потеряем.' },
    { t: '— этот размен в нашу пользу.' },
    { t: '— даже если нас съедят в ответ, мы будем в выигрыше.', stages: YOUNG },
    { t: '— меняемся выгодно!', stages: YOUNG, mood: 'excited' },
    { t: '— охрана у {коня:gen} есть, но её не хватит.', stages: YOUNG },
    { t: '— {конь} стоит дороже, чем мы отдадим.', stages: YOUNG },
    { t: '— съедим {коня}, и пусть соперник бьёт в ответ!', stages: YOUNG },
    { t: '— выигрываем материал, хоть {коня} и защищают.', stages: OLD },
    { t: '— забираем {коня} с прибылью.', stages: OLD },
    { t: '— соперник возьмёт в ответ, но останется в минусе.', stages: OLD },
    { t: '— защита есть, но размен всё равно выигрышный.', stages: OLD },
    { t: '— у нас останется больше материала.', stages: OLD },
  ],

  // subject target = the piece that has just taken ours; even — an equal trade, gain — we come out ahead,
  // no variant — the recapture only limits a loss (then only the untagged wordings are said)
  'v3.idea.recapture': [
    { t: '— {конь} только что {p:съел|съела} нашу фигуру, заберём {его}!' },
    { t: '— забираем {коня} в ответ.' },
    { t: '— в долгу не останемся: {конь} тоже уйдёт с доски.' },
    { t: '— ответим тем же: съедим {коня}!' },
    { t: '— теперь наша очередь брать: съедаем {коня}!', stages: YOUNG },
    { t: '— кто съел нашу фигуру, того и съедим!', stages: YOUNG },
    { t: '— так будет честный размен.', stages: YOUNG, when: ['even'] },
    { t: '— фигура за фигуру, всё поровну.', stages: YOUNG, when: ['even'] },
    { t: '— и мы ещё окажемся в плюсе!', stages: YOUNG, when: ['gain'] },
    { t: '— заберём {коня}, и нам достанется даже больше.', stages: YOUNG, when: ['gain'] },
    { t: '— возвращаем материал: забираем {коня}.', stages: OLD },
    { t: '— отыгрываемся: снимаем {коня} с доски.', stages: OLD },
    { t: '— это ровный размен.', stages: OLD, when: ['even'] },
    { t: '— материал останется равным.', stages: OLD, when: ['even'] },
    { t: '— и этот размен нам даже выгоден.', stages: OLD, when: ['gain'] },
    { t: '— в итоге мы выиграем материал.', stages: OLD, when: ['gain'] },
  ],

  // the move parries a mate in one against our king (no mate at all after it)
  'v3.idea.defendMate': [
    { t: '— и мата не будет!' },
    { t: '— так мы спасём короля от мата.' },
    { t: '— угрозы мата больше нет.' },
    { t: '— мат соперника не получится.' },
    { t: '— ставим защиту от мата.' },
    { t: '— не дадим поставить мат нашему королю!', stages: YOUNG },
    { t: '— мат был близко, но мы успеем!', stages: YOUNG },
    { t: '— прикроем короля, и мат не пройдёт!', stages: YOUNG },
    { t: '— сначала безопасность, остальное потом!', stages: YOUNG },
    { t: '— и соперник останется без мата.', stages: YOUNG },
    { t: '— закрываем угрозу мата.', stages: OLD },
    { t: '— отбиваем угрозу мата, это главное сейчас.', stages: OLD },
    { t: '— успеваем защититься: мата в один ход не будет.', stages: OLD },
    { t: '— защита прежде всего!', stages: OLD },
    { t: '— соперник рассчитывал на мат, но просчитался.', stages: OLD },
  ],

  // we are in check: capture — the checking piece is taken (maybe by the king); king — the king steps away; block —
  // a piece closes the line. The lead already names the king when it moves, so the king tails do not repeat «король».
  'v3.idea.answerCheck': [
    { t: '— так мы спасёмся от шаха.' },
    { t: '— и шах нам больше не страшен.' },
    { t: '— королю станет спокойнее.' },
    { t: '— спасаем короля от шаха!', stages: YOUNG },
    { t: '— и съедим фигуру, которая объявила шах!', stages: YOUNG, when: ['capture'] },
    { t: '— съедаем того, кто шахует!', stages: YOUNG, when: ['capture'] },
    { t: '— отбежим туда, где шаха нет!', stages: YOUNG, when: ['king'] },
    { t: '— увернёмся от шаха, как от мяча в вышибалах!', stages: YOUNG, when: ['king'] },
    { t: '— закроем короля, как щитом!', stages: YOUNG, when: ['block'] },
    { t: '— заслоним короля своей фигурой.', stages: YOUNG, when: ['block'] },
    { t: '— шах отражён, партия продолжается.', stages: OLD },
    { t: '— забираем шахующую фигуру.', stages: OLD, when: ['capture'] },
    { t: '— шахующая фигура сама станет добычей.', stages: OLD, when: ['capture'] },
    { t: '— уклоняемся от шаха.', stages: OLD, when: ['king'] },
    { t: '— уйдём туда, куда шах не достанет.', stages: OLD, when: ['king'] },
    { t: '— закрываемся от шаха своей фигурой.', stages: OLD, when: ['block'] },
    { t: '— перекрываем путь шаху.', stages: OLD, when: ['block'] },
  ],

  // subject mover = the attacked piece that leaves for a safe square (never the king in practice)
  'v3.idea.escape': [
    { t: '— {он} уйдёт из-под удара.' },
    { t: '— так {он} будет в безопасности.' },
    { t: '— уведём {его} в укрытие.' },
    { t: '— там {его} никто не съест бесплатно.' },
    { t: '— спасаем {его} от удара!' },
    { t: '— {он} убежит, и съесть {его} не получится.', stages: YOUNG },
    { t: '— скорее прочь от опасности!', stages: YOUNG },
    { t: '— раз, и {он} уже не под ударом!', stages: YOUNG },
    { t: '— играем в прятки: {он} спрячется от удара.', stages: YOUNG },
    { t: '— {его} хотели съесть, а {он} ускользнёт!', stages: YOUNG },
    { t: '— уносим ноги от удара!', stages: YOUNG },
    { t: '— {он} переберётся на надёжное место.', stages: OLD },
    { t: '— уводим {его} на безопасное поле.', stages: OLD },
    { t: '— материал цел: {он} уходит из-под боя.', stages: OLD },
    { t: '— ни одной фигуры даром!', stages: OLD },
    { t: '— отступаем: {он} ещё пригодится в бою.', stages: OLD },
    { t: '— меняем место, пока {его} не съели.', stages: OLD },
  ],

  // subject defended = OUR piece under attack that the moved piece now guards (not the mover itself). It may have had
  // a guard already (it was outnumbered), so no «теперь он не один»; after the move it cannot be won (SEE 0).
  'v3.idea.defend': [
    { t: '— и защитим {коня}!' },
    { t: '— так у {коня:gen} появится защита.' },
    { t: '— {конь} под ударом, а мы {его} прикроем.' },
    { t: '— прикроем {коня}, чтобы {его} не съели бесплатно.' },
    { t: '— пусть соперник только попробует съесть {коня}!' },
    { t: '— друзья помогают друг другу: защищаем {коня}!', stages: YOUNG },
    { t: '— охрана для {коня:gen} готова!', stages: YOUNG },
    { t: '— возьмём {коня} под крылышко!', stages: YOUNG },
    { t: '— подстрахуем {коня}!', stages: YOUNG },
    { t: '— если {коня} съедят, мы съедим обидчика!', stages: YOUNG },
    { t: '— выручаем {коня} из беды!', stages: YOUNG },
    { t: '— соперник целится в {коня}, а мы прикрываем.', stages: OLD },
    { t: '— нападение на {коня} теперь ничего не даст.', stages: OLD },
    { t: '— подкрепим {коня}, и {он} устоит.', stages: OLD },
    { t: '— ставим {коня} под защиту.', stages: OLD },
    { t: '— теперь {конь} сопернику не по зубам.', stages: OLD },
    { t: '— взять {коня} теперь невыгодно.', stages: OLD },
  ],

  // subject defended = our piece; the move stands in the line of an enemy bishop / rook / queen
  'v3.idea.block': [
    { t: '— закроем {коня} от удара.' },
    { t: '— встанем между {конём} и нападающим.' },
    { t: '— перегородим дорогу, и удар до {коня:gen} не дойдёт.' },
    { t: '— {конь} спрячется за нашей стенкой.' },
    { t: '— станем щитом для {коня:gen}.' },
    { t: '— перекроем вот эту линию, и {конь} {p:спасён|спасена}.' },
    { t: '— дальний удар упрётся в нашу фигуру.' },
  ],

  // after the move we threaten mate in one (the opponent can still defend: «может», «если»)
  'v3.idea.threatMate': [
    { t: '— и пригрозим матом!', mood: 'excited' },
    { t: '— теперь соперник должен защищаться от мата.' },
    { t: '— появится угроза мата!' },
    { t: '— королю соперника станет тесно: грозит мат.' },
    { t: '— если соперник не защитится, поставим мат!' },
    { t: '— соперник получит задачку: как спастись от мата.' },
    { t: '— над королём соперника нависнет мат.' },
  ],

  // subject target = the dearest attacked piece (a pawn too), won next move if left alone; one / two (not a fork) /
  // queenDevelop (a knight or bishop comes out and hits the queen — the target is then the queen)
  'v3.idea.attack': [
    { t: '— и нападём на {коня}!' },
    { t: '— нападём: пусть {конь} подумает, куда бежать.' },
    { t: '— {конь} станет нашей целью.' },
    { t: '— и {конь} {p:должен|должна} будет спасаться.' },
    { t: '— следующим ходом {конь} может стать {p:нашим|нашей}.' },
    { t: '— пугнём {коня}!', stages: YOUNG },
    { t: '— погоним {коня}!', stages: YOUNG },
    { t: '— ну-ка, {конь}, берегись!', stages: YOUNG },
    { t: '— нападём сразу на двоих, и {конь} среди них!', stages: YOUNG, when: ['two'] },
    { t: '— у нас будет сразу две цели!', stages: YOUNG, when: ['two'] },
    { t: '— выйдем в игру и сразу нападём на {коня}!', stages: YOUNG, when: ['queenDevelop'] },
    { t: '— заодно погоняем самую сильную фигуру соперника.', stages: YOUNG, when: ['queenDevelop'] },
    { t: '— атакуем {коня}: {его} можно будет выгодно взять.', stages: OLD },
    { t: '— появится угроза съесть {коня}.', stages: OLD },
    { t: '— {конь} попадёт под обстрел.', stages: OLD },
    { t: '— под прицелом {конь} и ещё одна цель.', stages: OLD, when: ['two'] },
    { t: '— нападаем на {коня}, а заодно и на другую цель.', stages: OLD, when: ['two'] },
    { t: '— развиваемся и сразу нападаем на {коня}.', stages: OLD, when: ['queenDevelop'] },
    { t: '— выводим фигуру и гоним {коня}.', stages: OLD, when: ['queenDevelop'] },
  ],

  // a safe check (not a mate, the checking piece cannot be won): the enemy king must be saved
  'v3.idea.check': [
    { t: '— и объявим шах!', mood: 'excited' },
    { t: '— шах, и ответить соперник обязан.' },
    { t: '— шах с безопасного места!' },
    { t: '— и королю соперника достанется шах!' },
    { t: '— пусть чужой король поволнуется!', stages: YOUNG },
    { t: '— скажем королю: шах!', stages: YOUNG },
    { t: '— король вздрогнет от неожиданности!', stages: YOUNG },
    { t: '— нападём прямо на короля!', stages: YOUNG },
    { t: '— этот шах королю не понравится!', stages: YOUNG },
    { t: '— этот шах заставит соперника защищаться.', stages: OLD },
    { t: '— беспокоим короля соперника шахом.', stages: OLD },
    { t: '— шах, и сопернику будет не до своих планов.', stages: OLD },
    { t: '— королю соперника станет неуютно.', stages: OLD },
    { t: '— держим короля соперника в напряжении.', stages: OLD },
  ],
};
