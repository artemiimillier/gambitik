/**
 * Transcripts of the report's games (docs/TEACHING.md §7): one game as Russian markdown — the header,
 * «До первого хода», every move in Russian notation with what Гамбитик said, what the board showed (in plain words),
 * the quiz with its buttons and the child's press, the quiet moves, praise and mistakes, the end and the takeaway —
 * plus the choice of the sample games and «было → стало» (the template teacher's words next to the lesson's).
 * Pure: records in, markdown out.
 */
import type { BoardAnnotations, LessonCue } from '../../packages/shared/src/index.ts';
import { hasSpokenSquare, sanToBubbleRu } from '../../packages/core/src/index.ts';
import { getPersona } from '../../packages/content/src/index.ts';
import { FAMILY_RU, TC_RU } from './config.ts';
import type { EvRecord, GameRecord, MoveHow, TurnRecord } from './config.ts';
import { isUtterance } from './report.ts';
import type { Run } from './report.ts';

// ───────────────────────── small words ─────────────────────────

/** «5. Кf3» for White's move, «5… Кc6» for Black's (ply 1 = White's first move). */
export function moveLabelRu(ply: number, san: string): string {
  const no = Math.ceil(ply / 2);
  return `${no}${ply % 2 === 1 ? '.' : '…'} ${sanToBubbleRu(san)}`;
}

const CUE_WORDS: Readonly<Record<string, string>> = {
  move: 'ход',
  attacks: 'куда будет бить фигура',
  line: 'линия',
  flank: 'фланг',
  center: 'центр',
  capture: 'кого съедим',
  threat: 'угроза соперника',
  hanging: 'фигура под ударом',
  piece: 'фигура',
  king: 'король',
  weak: 'слабая пешка',
  path: 'путь пешки',
  defend: 'кого защищаем',
  lastMove: 'прошлый ход',
};

const COLOR_RU: Readonly<Record<string, string>> = { green: 'зелёная', red: 'красная', yellow: 'жёлтая', blue: 'синяя' };

/** The cues of an utterance in plain words: «стрелка g1→f3 (после фразы); подсветка d4 e5 — куда будет бить фигура». */
export function cuesInWords(cues: readonly LessonCue[]): string {
  const parts: string[] = [];
  const drawn = new Set<string>();
  for (const c of cues) {
    const what = CUE_WORDS[c.kind] ?? c.kind;
    // (an arrow already named — the move and its capture share one — is not named twice)
    const arrows = (c.arrows ?? []).map((a) => `${a.from}→${a.to}`).filter((a) => !drawn.has(a));
    for (const a of arrows) drawn.add(a);
    if (c.kind === 'move' && arrows.length === 0 && (c.arrows?.length ?? 0) > 0) continue;
    const squares = c.kind === 'move' || c.kind === 'lastMove' ? [] : c.squares;
    const bits: string[] = [];
    if (arrows.length > 0) bits.push(`${c.kind === 'threat' ? 'красная стрелка' : 'стрелка'} ${arrows.join(', ')}`);
    if (squares.length > 0) bits.push(`подсветка ${squares.join(' ')}`);
    if (bits.length === 0) {
      bits.push(c.kind === 'flank' ? 'фланг (не рисуется)' : `(${what}: нечего показать)`);
      parts.push(bits.join(' '));
      continue;
    }
    const tail = c.kind === 'move' ? '' : ` — ${what}`;
    parts.push(`${bits.join(', ')}${tail}${c.at === 'end' ? ' (после фразы)' : ''}`);
  }
  return parts.join('; ');
}

/** A board without cues (a quiet move's arrow, a hint): «зелёная стрелка e2→e4; подсветка e4 (жёлтая)». */
export function boardInWords(b: BoardAnnotations | undefined | null): string {
  if (!b) return '';
  const parts: string[] = [];
  for (const a of b.arrows) parts.push(`${COLOR_RU[a.color] ?? a.color} стрелка ${a.from}→${a.to}`);
  const byColor = new Map<string, string[]>();
  for (const h of b.highlights) byColor.set(h.color, [...(byColor.get(h.color) ?? []), h.square]);
  for (const [color, sq] of byColor) parts.push(`подсветка ${sq.join(' ')} (${COLOR_RU[color] ?? color})`);
  return parts.join('; ');
}

const MOMENT_LABEL: Readonly<Record<string, string>> = {
  theme: 'тема',
  recall: 'вспомним',
  advice: 'совет',
  quiz: 'вопрос',
  self: '«Сам»',
  mini: 'мини-урок',
  danger: 'опасность',
  treasure: 'подарок',
  answer: 'ответ на вопрос',
  reveal: 'показывает',
  repeat: 'на «Совет»',
  why: 'на «Почему так?»',
  opponent: 'на «Что задумал соперник?»',
  hurry: 'торопит',
  praise: 'похвала',
  result: 'итог хода',
  mistake: 'ошибка',
  reaction: 'после хода',
  takeback: 'возврат хода',
  end: 'конец партии',
};

const HOW_RU: Readonly<Record<MoveHow, string>> = {
  arrow: 'по стрелке',
  second: 'свой ход',
  pv: 'свой ход',
  random: 'свой ход, наугад',
  found: 'нашёл сам, без стрелки',
  guess: 'сходил, не ответив на вопрос',
  retry: 'второй раз, после возврата',
};

const ICON_RU: Readonly<Record<string, string>> = { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' };

function personaName(id: string): string {
  try {
    return getPersona(id as Parameters<typeof getPersona>[0])?.name ?? id;
  } catch {
    return id;
  }
}

function secs(ms: number): string {
  return `${Math.round(ms / 1000)} с`;
}

const OUTCOME_RU: Readonly<Record<string, string>> = {
  checkmate: 'мат',
  resign: 'сдача',
  timeout: 'время',
  stalemate: 'пат',
  draw: 'ничья по правилам',
  abandoned: 'не доиграна',
};

function outcomeRu(g: Pick<GameRecord, 'result' | 'childColor' | 'termination'>): string {
  const how = OUTCOME_RU[g.termination] ?? g.termination;
  if (g.result === '1/2-1/2') return `ничья (${how})`;
  if (g.result === '*') return 'партия не доиграна';
  const win = (g.result === '1-0') === (g.childColor === 'w');
  return `${win ? 'победа' : 'поражение'} (${how})`;
}

// ───────────────────────── one utterance ─────────────────────────

function utteranceLines(e: EvRecord, turn: TurnRecord | undefined): string[] {
  const out: string[] = [];
  if (e.source === 'bark') {
    const board = boardInWords(e.board);
    out.push(`- _(молчит — стрелка на доске${board ? `: ${board}` : ''}; короткий звук «${e.text}»)_`);
    return out;
  }
  if (e.empty) {
    out.push(`- _(${MOMENT_LABEL[e.moment] ?? e.moment}: у Гамбитика нет слов для этого случая — молчит)_`);
    return out;
  }
  // (said after the child's move — a reaction, the take-back and the advice again after it: no «через N с»)
  const afterMove = e.afterPly >= e.ply;
  const when = e.atMs > 0 && !afterMove ? `через ${secs(e.atMs)}, ` : '';
  if (e.source === 'answer' && e.pressed) {
    const p = e.pressed;
    if (p.how === 'right' || p.how === 'wrong') out.push(`- _Ребёнок нажал «${p.label ?? p.optionId}» — ${p.correct ? 'верно' : 'неверно'}._`);
    else if (p.how === 'timeout') out.push(`- _Ребёнок не ответил ${secs(e.atMs)} — Гамбитик объясняет сам._`);
  }
  if (e.source === 'repeat' && turn?.quiz?.how === 'sovet' && e.atMs === turn.quiz.atMs) out.push('- _Ребёнок не стал отвечать и нажал «Совет» — вопрос закрыт._');
  else if (e.source === 'repeat' && !afterMove) out.push('- _Ребёнок нажал «Совет»._');
  if (e.source === 'why') out.push('- _Ребёнок нажал «Почему так?»._');
  if (e.source === 'opponent') out.push('- _Ребёнок нажал «Что задумал соперник?»._');
  const label =
    e.quiz && e.source === 'turn'
      ? e.moment === 'danger'
        ? 'вопрос об опасности'
        : 'вопрос'
      : e.source === 'repeat' && afterMove
        ? 'совет ещё раз, после возврата'
        : (MOMENT_LABEL[e.moment] ?? e.moment);
  out.push(`- **Гамбитик** (${when}${label}): «${e.text}»`);
  if (e.bubble && e.bubble !== e.text) out.push(`  облачко: «${e.bubble}»`);
  if (e.quiz) {
    const buttons = e.quiz.options.map((o) => `[${o.icon ? `${ICON_RU[o.icon] ?? o.icon} ` : ''}${o.label}]`).join(' ');
    const right = e.quiz.options.find((o) => o.id === e.quiz?.correctId)?.label ?? e.quiz.correctId;
    out.push(`  кнопки: ${buttons} · верный ответ: «${right}»`);
  }
  const cues = cuesInWords(e.cues);
  const board = cues || boardInWords(e.board);
  const hidden = e.arrowHidden ? 'стрелки пока нет' : '';
  const doska = [board, hidden].filter(Boolean).join('; ');
  if (doska) out.push(`  [доска: ${doska}]`);
  return out;
}

// ───────────────────────── one game ─────────────────────────

export interface TranscriptOptions {
  /** a heading instead of the default one */
  title?: string;
  /** why this game was chosen (sample transcripts) */
  note?: string;
}

/** One game as Russian markdown. */
export function transcriptMarkdown(g: GameRecord, events: readonly EvRecord[], opts: TranscriptOptions = {}): string {
  const out: string[] = [];
  const colour = g.childColor === 'w' ? 'белые' : 'чёрные';
  const utt = events.filter(isUtterance);
  const quizzes = g.turns.filter((t) => t.quiz);
  const right = quizzes.filter((t) => t.quiz?.how === 'right').length;
  out.push(`# ${opts.title ?? `Партия ${g.game}: ступень ${g.stage}, ${TC_RU[g.tc] ?? g.tc}, ${colour}`}`);
  out.push('');
  if (opts.note) {
    out.push(opts.note);
    out.push('');
  }
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| Ученик | ${g.name || 'без имени'} (${g.address === 'f' ? 'девочка' : 'мальчик'}), ${g.gameNo}-я партия подряд |`);
  out.push(`| Ступень | ${g.stage} |`);
  out.push(`| Контроль | ${TC_RU[g.tc] ?? g.tc} |`);
  out.push(`| Цвет | ${colour} |`);
  out.push(`| Соперник | ${personaName(g.persona)} |`);
  out.push(`| Тема | ${g.strategyTitle ? `«${g.strategyTitle}»` : '—'}${g.family ? `, семья «${FAMILY_RU[g.family] ?? g.family}»` : ''} |`);
  out.push(`| Итог | ${outcomeRu(g)}, ${g.plies.length} полуходов |`);
  out.push(`| Реплик | ${utt.length}; вопросов ${quizzes.length} (верно ${right}) |`);
  out.push('');
  const byAfter = new Map<number, EvRecord[]>();
  for (const e of events) byAfter.set(e.afterPly, [...(byAfter.get(e.afterPly) ?? []), e]);
  const turnAt = new Map(g.turns.map((t) => [t.ply, t] as const));
  const ends = events.filter((e) => e.source === 'end');
  const block = (list: readonly EvRecord[]): void => {
    for (const e of list) {
      if (e.source === 'end') continue;
      out.push(...utteranceLines(e, turnAt.get(e.ply)));
    }
  };
  out.push('## До первого хода');
  out.push('');
  const first = byAfter.get(0) ?? [];
  if (first.length === 0) out.push(g.childColor === 'b' ? '_Первым ходит соперник._' : '_Гамбитик молчит._');
  else block(first);
  out.push('');
  out.push('## Партия');
  out.push('');
  g.plies.forEach((p, i) => {
    const ply = i + 1;
    const turn = p.by === 'child' ? turnAt.get(ply) : undefined;
    const after = byAfter.get(ply) ?? [];
    if (p.by === 'bot') {
      out.push(`**${moveLabelRu(ply, p.san)}** (соперник)`);
      out.push('');
      if (after.length > 0) {
        block(after);
        out.push('');
      }
      return;
    }
    // (the events of this turn said before the move are listed under the opponent's move above)
    const tb = turn?.takeback ?? null;
    const how = turn ? HOW_RU[turn.move.how] : '';
    const hidden = turn && turn.advice && !turn.move.arrowShown && turn.move.how !== 'found' ? ', стрелки не было' : '';
    // (the hints of a hidden advice stop once it is shown — a reveal, «Совет», an answer — or when the child moves)
    const hintsEnd = turn ? Math.min(turn.hintsStopMs ?? turn.reveal?.atMs ?? Infinity, turn.move.thinkMs) : 0;
    const hints = turn ? turn.hints.filter((h) => h.atMs < hintsEnd) : [];
    for (const h of hints) out.push(`- _(через ${secs(h.atMs)} подсказка на доске: ${boardInWords(h.board)})_`);
    if (tb) {
      // every move tried in this position: an offered one taken back is followed by the reply and the advice again
      // (up to the next «Совет»-repeat), the last try stays on the board
      const tries = tb.tries ?? [{ uci: tb.uci, san: tb.san, offered: true, accepted: tb.accepted, again: false }, ...(tb.accepted ? [{ uci: '', san: p.san, offered: false, accepted: null, again: false }] : [])];
      let rest = after;
      tries.forEach((x, k) => {
        const lastTry = k === tries.length - 1;
        const retryHow = k >= 2 && turn?.move.how === 'retry' ? `${k + 1}-я попытка, после возврата` : how;
        const label = x.offered ? (x.accepted ? 'этот ход потом вернули' : x.again ? 'Гамбитик снова предложил вернуть ход, ребёнок оставил' : 'Гамбитик предложил вернуть ход') : retryHow;
        out.push(`**${moveLabelRu(ply, lastTry ? p.san : x.san)}** (ты) — ${label}`);
        out.push('');
        if (lastTry || !x.accepted) {
          block(rest);
          rest = [];
          return;
        }
        const split = rest.findIndex((e) => e.source === 'repeat');
        const seg = split >= 0 ? rest.slice(0, split + 1) : rest;
        rest = split >= 0 ? rest.slice(split + 1) : [];
        block(seg);
        out.push('');
      });
    } else {
      out.push(`**${moveLabelRu(ply, p.san)}** (ты) — ${how}${hidden}`);
      out.push('');
      if (turn?.quiz?.how === 'moved') out.push('- _Ребёнок сходил, не ответив на вопрос — карточка тихо закрылась._');
      block(after);
    }
    out.push('');
  });
  const last = g.turns[g.turns.length - 1];
  if (last && last.move.uci === '') {
    out.push('_У ребёнка кончилось время._');
    out.push('');
  }
  out.push('## Конец партии');
  out.push('');
  out.push(`Итог: ${outcomeRu(g)}.`);
  out.push('');
  for (const e of ends) out.push(`- **Гамбитик**: «${e.text}»`);
  if (g.takeaway) out.push(`- Главный вывод на карточке итога: «${g.takeaway}» (\`${g.takeawayKey}\`)`);
  out.push('');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ───────────────────────── the sample games ─────────────────────────

export interface SamplePick {
  slot: 1 | 2 | 3 | 4;
  file: string;
  title: string;
  game: GameRecord;
  /** what the slot asked for and what is missing (the closest match) */
  note: string;
  exact: boolean;
}

function hasMoment(events: readonly EvRecord[], m: string): boolean {
  return events.some((e) => isUtterance(e) && (e.moment === m || (m === 'mini' && e.say.some((s) => s.pool.startsWith('v3.mini.')))));
}

interface Want {
  label: string;
  ok: (g: GameRecord, ev: readonly EvRecord[]) => boolean;
  weight: number;
}

function best(run: Run, wants: readonly Want[], avoid: ReadonlySet<string>): { game: GameRecord; missing: string[] } | null {
  let top: { game: GameRecord; score: number; missing: string[] } | null = null;
  for (const g of run.games) {
    const ev = run.events.get(g.game) ?? [];
    let score = avoid.has(g.game) ? -0.5 : 0;
    const missing: string[] = [];
    for (const w of wants) {
      if (w.ok(g, ev)) score += w.weight;
      else missing.push(w.label);
    }
    if (!top || score > top.score) top = { game: g, score, missing };
  }
  return top ? { game: top.game, missing: top.missing } : null;
}

/**
 * The sample transcripts (docs/TEACHING.md §7), chosen deterministically from the run — the closest match when no
 * game fits exactly: 1) blitz, stage 1, White; 2) 10 minutes, stage 2, Black, with a take-back, a quiz and a mistake;
 * 3) untimed, stage 4, with a mini-lesson; 4) game 7 of the stage-1 child («день 3»).
 */
export function chooseSampleGames(run: Run): SamplePick[] {
  const picks: SamplePick[] = [];
  const used = new Set<string>();
  const add = (slot: SamplePick['slot'], file: string, title: string, wants: Want[], ask: string): void => {
    const b = best(run, wants, used);
    if (!b) return;
    used.add(b.game.game);
    const exact = b.missing.length === 0;
    picks.push({ slot, file, title, game: b.game, exact, note: `Отбор: ${ask}.${exact ? '' : ` Точной партии не нашлось — взята ближайшая, в ней нет: ${b.missing.join(', ')}.`}` });
  };
  const stage = (s: number): Want => ({ label: `ступень ${s}`, ok: (g) => g.stage === s, weight: 8 });
  const tc = (t: string): Want => ({ label: TC_RU[t] ?? t, ok: (g) => g.tc === t, weight: 4 });
  const colour = (c: 'w' | 'b'): Want => ({ label: c === 'w' ? 'белые' : 'чёрные', ok: (g) => g.childColor === c, weight: 2 });
  const notDay3: Want = { label: 'не 7-я партия', ok: (g) => !(g.stage === 1 && g.gameNo === 7), weight: 1 };
  add(1, 'game1-blitz-stage1-white.md', 'Партия 1: блиц, ступень 1, белые', [stage(1), tc('blitz5'), colour('w'), notDay3], 'блиц, ступень 1, белые');
  add(
    2,
    'game2-rapid-stage2-black.md',
    'Партия 2: 10 минут, ступень 2, чёрные',
    [
      stage(2),
      tc('rapid10'),
      colour('b'),
      { label: 'возврат хода', ok: (g) => g.turns.some((t) => t.takeback), weight: 3 },
      { label: 'вопрос', ok: (g) => g.turns.some((t) => t.quiz), weight: 3 },
      { label: 'ошибка', ok: (_g, ev) => hasMoment(ev, 'mistake') || ev.some((e) => e.source === 'takebackOffer'), weight: 3 },
    ],
    '10 минут, ступень 2, чёрные, с возвратом хода, вопросом и ошибкой',
  );
  add(3, 'game3-training-stage4.md', 'Партия 3: без часов, ступень 4', [stage(4), tc('training'), { label: 'мини-урок', ok: (_g, ev) => hasMoment(ev, 'mini'), weight: 3 }], 'без часов, ступень 4, с мини-уроком');
  const day3 = run.games.find((g) => g.stage === 1 && g.gameNo === 7) ?? run.games.filter((g) => g.stage === 1).sort((a, b) => b.gameNo - a.gameNo)[0];
  if (day3) {
    picks.push({
      slot: 4,
      file: 'game4-stage1-day3.md',
      title: `Партия 4: ученик ступени 1, ${day3.gameNo}-я партия («день 3»)`,
      game: day3,
      exact: day3.gameNo === 7,
      note: day3.gameNo === 7 ? 'Отбор: 7-я партия ученика ступени 1 — как Гамбитик говорит на третий день.' : `Отбор: 7-я партия ученика ступени 1; в прогоне их меньше — взята ${day3.gameNo}-я.`,
    });
  }
  return picks;
}

// ───────────────────────── «было → стало» ─────────────────────────

export interface BeforeAfter {
  pick: SamplePick;
  turn: TurnRecord;
  now: EvRecord;
}

/**
 * Six positions of the sample games where the template teacher's words (buildTeachTurn: they name squares) can be
 * put next to the lesson's: different moments first, a square in the legacy words, at most two per game.
 */
export function chooseBeforeAfter(picks: readonly SamplePick[], run: Run, count = 6): BeforeAfter[] {
  const cands: (BeforeAfter & { score: number; order: number })[] = [];
  let order = 0;
  for (const pick of picks) {
    const ev = run.events.get(pick.game.game) ?? [];
    for (const t of pick.game.turns) {
      const now = ev.find((e) => e.ply === t.ply && e.source === 'turn' && isUtterance(e));
      if (!t.legacy || !now) continue;
      cands.push({ pick, turn: t, now, score: hasSpokenSquare(t.legacy) ? 1 : 0, order: order++ });
    }
  }
  const out: BeforeAfter[] = [];
  const moments = new Set<string>();
  const perGame = new Map<string, number>();
  while (out.length < count && cands.length > 0) {
    let bestI = -1;
    let bestScore = -Infinity;
    cands.forEach((c, i) => {
      const n = perGame.get(c.pick.game.game) ?? 0;
      const s = c.score + (moments.has(c.now.moment) ? 0 : 3) - (n >= 2 ? 10 : n) - c.order / 1e4;
      if (s > bestScore) {
        bestScore = s;
        bestI = i;
      }
    });
    const [c] = cands.splice(bestI, 1);
    if (!c) break;
    out.push({ pick: c.pick, turn: c.turn, now: c.now });
    moments.add(c.now.moment);
    perGame.set(c.pick.game.game, (perGame.get(c.pick.game.game) ?? 0) + 1);
  }
  return out.sort((a, b) => a.pick.slot - b.pick.slot || a.turn.ply - b.turn.ply);
}

export function beforeAfterMarkdown(items: readonly BeforeAfter[], picks: readonly SamplePick[] = []): string {
  const out: string[] = [];
  out.push('# Было → стало');
  out.push('');
  out.push('Одни и те же позиции из партий выше. «Было» — слова шаблонного совета (`buildTeachTurn`, он называет клетки). «Стало» — слова урока: клетку показывают стрелка и подсветка.');
  out.push('');
  const starts = picks.filter((p) => p.game.legacyStart);
  items.forEach((x, i) => {
    const g = x.pick.game;
    const opp = g.plies[x.turn.ply - 2];
    const colour = g.childColor === 'w' ? 'белые' : 'чёрные';
    out.push(`## ${i + 1}. Партия ${x.pick.slot} (ступень ${g.stage}, ${TC_RU[g.tc] ?? g.tc}, ${colour}), ход ${Math.ceil(x.turn.ply / 2)} — ${MOMENT_LABEL[x.now.moment] ?? x.now.moment}`);
    out.push('');
    out.push(`${opp ? `После хода соперника ${moveLabelRu(x.turn.ply - 1, opp.san)}` : 'Первый ход партии'}; совет движка: ${x.turn.advice ? sanToBubbleRu(x.turn.advice.san) : '—'}.`);
    out.push('');
    out.push(`- **Было:** «${x.turn.legacy}»`);
    out.push(`- **Стало:** «${x.now.text}»`);
    const cues = cuesInWords(x.now.cues) || boardInWords(x.now.board);
    if (cues || x.now.arrowHidden) out.push(`  [доска: ${[cues, x.now.arrowHidden ? 'стрелки пока нет' : ''].filter(Boolean).join('; ')}]`);
    out.push('');
  });
  if (starts.length > 0) {
    out.push('## Начало партии');
    out.push('');
    for (const p of starts) out.push(`- ${p.title}. **Было:** «${p.game.legacyStart}»`);
    out.push('');
    out.push('Стало: одна фраза о теме без хода и без клетки (см. «До первого хода» в каждой партии).');
    out.push('');
  }
  return out.join('\n');
}

/** The index of the transcripts folder: which game each file is and why it was chosen. */
export function sampleIndexMarkdown(picks: readonly SamplePick[], meta: { seed: number; games: number }): string {
  const out: string[] = [];
  out.push('# Расшифровки партий');
  out.push('');
  out.push(`Сгенерировано командой \`pnpm teach:report --transcripts\` (партий в прогоне: ${meta.games}, сид ${meta.seed}). Файлы перезаписываются при каждом прогоне.`);
  out.push('');
  for (const p of picks) out.push(`- [${p.title}](${p.file}) — партия ${p.game.game}. ${p.note}`);
  out.push('- [Было → стало](before-after.md) — шаблонный совет и слова урока в одних и тех же позициях.');
  out.push('');
  return out.join('\n');
}
