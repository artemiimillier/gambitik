/**
 * Template post-game review — Russian markdown for the parent + child, produced without any LLM.
 * The server uses it when neither Codex nor the OpenAI API is available (provider 'template').
 * Everything here is derived from engine-backed data in the GameRecord; nothing is invented.
 */
import type {
  GameRecord,
  KeyMoment,
  MotifId,
  MoveClass,
  MoveJudgement,
  Persona,
  StudentProfile,
  Termination,
  TimeControlId,
} from '@gambit/shared';
import { takebackOutcomes } from '../analysis/summary.ts';
import { fullMoveNumber, sideToMove } from './board.ts';
import { childOutcome } from './events.ts';
import type { ChildOutcome } from './events.ts';
import {
  motifExplanationRu,
  motifPracticeLineRu,
  motifTitleRu,
  motifToPuzzleTheme,
  pickPracticeMotif,
} from './motifs.ts';
import { sanToBubbleRu } from './spoken.ts';

/** Most key moments shown in a review (one idea is learnt, ten are not — research 05 §8). */
export const REVIEW_MAX_KEY_MOMENTS = 3;

const TIME_CONTROL_LABEL_RU: Readonly<Record<TimeControlId, string>> = {
  bullet1: '1 минута',
  blitz5: '5 минут',
  rapid10: '10 минут',
  training: 'тренировка без часов',
};

const MOVE_CLASS_LABEL_RU: Readonly<Record<MoveClass, string>> = {
  best: 'Лучший ход',
  excellent: 'Отличный ход',
  good: 'Хороший ход',
  inaccuracy: 'Неточность',
  mistake: 'Ошибка',
  blunder: 'Зевок',
  missedWin: 'Упущенный шанс',
};

const MOVE_CLASS_ICON: Readonly<Record<MoveClass, string>> = {
  best: '★',
  excellent: '✓',
  good: '·',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
  missedWin: '◇',
};

const MOVE_CLASS_ORDER: readonly MoveClass[] = ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder', 'missedWin'];

const TERMINATION_RU: Readonly<Record<Termination, string>> = {
  checkmate: 'мат',
  resign: 'сдача',
  timeout: 'закончилось время',
  stalemate: 'пат',
  draw: 'ничья',
  abandoned: 'партия не доиграна',
};

const OUTCOME_LINE: Readonly<Record<ChildOutcome, string>> = {
  win: '**Победа!**',
  loss: '**Поражение** — это тоже урок.',
  draw: '**Ничья.**',
  unfinished: '**Партия не доиграна.**',
};

export function moveClassLabelRu(c: MoveClass): string {
  return MOVE_CLASS_LABEL_RU[c];
}

/** '12.' for a white move, '12…' for a black move — taken from the FEN before the move. */
export function moveNumberLabel(fenBefore: string): string {
  return `${fullMoveNumber(fenBefore)}${sideToMove(fenBefore) === 'w' ? '.' : '…'}`;
}

function formatDateRu(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function accuracyComment(accuracy: number): string {
  if (accuracy >= 90) return 'очень точная игра';
  if (accuracy >= 80) return 'точная игра';
  if (accuracy >= 65) return 'хорошая игра, есть куда расти';
  if (accuracy >= 50) return 'были трудные моменты — разберём их ниже';
  return 'партия получилась сложной — тем полезнее разбор';
}

/** 1 → '1 раз', 2 → '2 раза', 5 → '5 раз', 22 → '22 раза'. */
export function timesRu(n: number): string {
  const d = Math.abs(n) % 10;
  const dd = Math.abs(n) % 100;
  const few = d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14);
  return `${n} ${few ? 'раза' : 'раз'}`;
}

function judgementToMoment(j: MoveJudgement): KeyMoment {
  const motif = j.allowedMotif ?? j.missedMotif;
  return {
    ply: j.ply,
    fenBefore: j.fenBefore,
    playedSan: j.san,
    bestSan: j.bestSan,
    classification: j.classification,
    motif,
    explanation: '',
  };
}

/** Key moments from the summary; when it has none, the costliest judged moves (loss ≥ 10). */
function selectKeyMoments(record: GameRecord): KeyMoment[] {
  if (record.summary.keyMoments.length > 0) return record.summary.keyMoments.slice(0, REVIEW_MAX_KEY_MOMENTS);
  return [...record.judgements]
    .filter((j) => j.winPctLoss >= 10 && j.san !== j.bestSan)
    .sort((a, b) => b.winPctLoss - a.winPctLoss)
    .slice(0, REVIEW_MAX_KEY_MOMENTS)
    .sort((a, b) => a.ply - b.ply)
    .map(judgementToMoment);
}

function momentExplanation(m: KeyMoment, record: GameRecord): string {
  const given = m.explanation.trim();
  if (given) return given;
  const j = record.judgements.find((x) => x.ply === m.ply && x.san === m.playedSan);
  if (j?.allowedMotif) return motifExplanationRu(j.allowedMotif, 'allowed');
  if (j?.missedMotif) return motifExplanationRu(j.missedMotif, 'missed');
  if (m.motif) return motifExplanationRu(m.motif, m.classification === 'missedWin' ? 'missed' : 'allowed');
  return m.classification === 'missedWin'
    ? 'Здесь был ход, который давал большое преимущество.'
    : 'Этот ход что-то терял — другой ход был надёжнее.';
}

function isProudMoment(m: KeyMoment): boolean {
  return m.classification === 'best' || m.classification === 'excellent' || m.playedSan === m.bestSan;
}

function keyMomentBlock(m: KeyMoment, index: number, record: GameRecord): string[] {
  const label = moveNumberLabel(m.fenBefore);
  const played = sanToBubbleRu(m.playedSan);
  const best = sanToBubbleRu(m.bestSan);
  if (isProudMoment(m)) {
    // the child's own strong move: nothing was "stronger", and nobody "refuted" it
    const proud = [`### ${index + 1}. Ход ${label} ${played} — ${MOVE_CLASS_LABEL_RU[m.classification].toLowerCase()}`, '', `- Сильный ход партии: **${label} ${played}** ${MOVE_CLASS_ICON[m.classification]}`];
    if (m.motif) proud.push(`- Тема: ${motifTitleRu(m.motif)}`);
    proud.push('', momentExplanation(m, record), '');
    return proud;
  }
  const lines = [
    `### ${index + 1}. Ход ${label} ${played} — ${MOVE_CLASS_LABEL_RU[m.classification].toLowerCase()}`,
    '',
    `- Сыграно: **${label} ${played}** ${MOVE_CLASS_ICON[m.classification]}`,
    `- Сильнее было: **${label} ${best}**`,
  ];
  if (m.motif) lines.push(`- Тема: ${motifTitleRu(m.motif)}`);
  const j = record.judgements.find((x) => x.ply === m.ply && x.san === m.playedSan);
  if (j && j.refutationPvSan.length > 0 && m.classification !== 'missedWin') {
    lines.push(`- Как мог ответить соперник: ${j.refutationPvSan.slice(0, 3).map(sanToBubbleRu).join(' ')}`);
  }
  lines.push('', momentExplanation(m, record), '');
  return lines;
}

function strengths(record: GameRecord, profile: StudentProfile): string[] {
  const s = record.summary;
  const c = s.counts;
  const total = MOVE_CLASS_ORDER.reduce((n, k) => n + c[k], 0);
  const g = (m: string, f: string): string => (profile.address === 'f' ? f : m);
  const out: string[] = [];
  const strong = c.best + c.excellent;
  if (strong > 0) out.push(`Сильных ходов (лучших и отличных): ${strong} из ${total}.`);
  if (total >= 8 && c.blunder === 0) out.push('Ни одного зевка за всю партию — внимательная игра.');
  const outcomes = takebackOutcomes(record.judgements, record.events);
  const improved = outcomes.filter((o) => o.improved).length;
  if (improved > 0) {
    // proven by the judgements: a different move with a smaller loss stayed on the board
    out.push(`${g('Вернул', 'Вернула')} ход и ${g('нашёл', 'нашла')} продолжение лучше (${timesRu(improved)}) — отличная работа.`);
  } else if (outcomes.length > 0) {
    out.push(`${g('Вернул', 'Вернула')} ход и ${g('подумал', 'подумала')} ещё раз (${timesRu(outcomes.length)}) — полезная привычка.`);
  }
  if (total >= 8 && s.hintsUsed === 0 && s.takebacksOffered === 0) out.push(`${g('Справился', 'Справилась')} без подсказок.`);
  // Russian text only: an opening without a Russian name stays unnamed
  if (s.openingName && /[а-яё]/i.test(s.openingName)) out.push(`Дебют партии: ${s.openingName}.`);
  if (out.length === 0) out.push(`${g('Старался', 'Старалась')} и ${g('искал', 'искала')} хорошие ходы — это главное.`);
  return out;
}

function uniqueMotifs(list: readonly MotifId[]): MotifId[] {
  return [...new Set(list)];
}

function growthPoints(record: GameRecord, judged: boolean): string[] {
  const s = record.summary;
  const out: string[] = [];
  for (const m of uniqueMotifs(s.motifsAllowed).slice(0, 2)) {
    out.push(`**${motifTitleRu(m)}** (соперник смог это использовать). ${motifPracticeLineRu(m)}`);
  }
  for (const m of uniqueMotifs(s.motifsMissed).filter((x) => !s.motifsAllowed.includes(x)).slice(0, 1)) {
    out.push(`**${motifTitleRu(m)}** (спрятанное сокровище — такой ход был на доске). ${motifPracticeLineRu(m)}`);
  }
  if (out.length === 0) {
    out.push(
      s.counts.blunder + s.counts.mistake > 0 || !judged
        ? 'Перед каждым ходом спрашиваем: «Что хочет соперник? Это безопасно?»'
        : 'Серьёзных промахов не было. Продолжаем проверять каждый ход на безопасность.',
    );
  }
  return out;
}

/** The puzzle theme worth practising after this game (lichess theme key + Russian title). */
export function suggestPuzzleTheme(summary: GameRecord['summary']): { theme: string; title: string; motif: MotifId } | undefined {
  const candidates = [pickPracticeMotif(summary), ...summary.motifsAllowed, ...summary.motifsMissed];
  for (const m of candidates) {
    const theme = m ? motifToPuzzleTheme(m) : undefined;
    if (m && theme) return { theme, title: motifTitleRu(m), motif: m };
  }
  return undefined;
}

/**
 * Russian markdown review: header → result → accuracy → move-quality table → 1–3 key moments
 * (played vs best in Russian notation + motif explanation) → «Что получилось» →
 * «Над чем поработать» → suggested puzzle theme.
 */
export function buildTemplateReview(record: GameRecord, persona: Persona, profile: StudentProfile): string {
  const s = record.summary;
  const outcome = childOutcome(record.result, record.childColor);
  const who = profile.nickname.trim() || 'Ученик';
  const colorRu = record.childColor === 'w' ? 'белыми' : 'чёрными';
  const accuracy = Math.round(s.accuracy);
  const judged = record.judgements.length > 0 || MOVE_CLASS_ORDER.some((k) => s.counts[k] > 0);

  const lines: string[] = [
    `# Разбор партии: ${who} — ${persona.name}`,
    '',
    `_${formatDateRu(record.startedAt)} · ${TIME_CONTROL_LABEL_RU[record.timeControlId]} · ${who} играет ${colorRu}${record.examMode ? ' · экзамен без подсказок' : ''}_`,
    '',
    '## Результат',
    '',
    `${OUTCOME_LINE[outcome]} Счёт ${record.result === '*' ? '—' : record.result} (${TERMINATION_RU[record.termination]}).`,
    '',
    '## Точность',
    '',
    // a game the engine never looked at (it could not start) has no accuracy — "0%" would be a false fact
    ...(judged
      ? [
          `**${accuracy}%** — ${accuracyComment(accuracy)}.`,
          '',
          '| Качество хода | Сколько |',
          '|---|---|',
          ...MOVE_CLASS_ORDER.map((k) => `| ${MOVE_CLASS_LABEL_RU[k]} ${MOVE_CLASS_ICON[k]} | ${s.counts[k]} |`),
        ]
      : ['В этой партии шахматный движок не смог проверить ходы, поэтому точность не считалась.']),
    '',
    `Тренер предлагал вернуть ход: ${s.takebacksOffered} (принято: ${s.takebacksAccepted}). Подсказок: ${s.hintsUsed}.`,
    '',
    '## Ключевые моменты',
    '',
  ];

  const moments = selectKeyMoments(record);
  if (!judged) {
    lines.push('Ходы этой партии остались без проверки — ключевые моменты найдём в следующей.', '');
  } else if (moments.length === 0) {
    lines.push('Решающих промахов в этой партии не было — так держать!', '');
  } else {
    moments.forEach((m, i) => lines.push(...keyMomentBlock(m, i, record)));
  }

  lines.push('## Что получилось', '', ...strengths(record, profile).map((x) => `- ${x}`), '');
  lines.push('## Над чем поработать', '', ...growthPoints(record, judged).map((x) => `- ${x}`), '');

  const puzzle = suggestPuzzleTheme(s);
  lines.push('## Задачи на завтра', '');
  lines.push(
    puzzle
      ? `Тема: **${puzzle.title}**. Пяти–шести задач хватит.`
      : 'Любые задачи по своему уровню — пяти–шести хватит, чтобы глаз оставался зорким.',
  );
  lines.push('', '_Разбор составлен автоматически по оценкам шахматного движка._', '');

  return lines.join('\n');
}
