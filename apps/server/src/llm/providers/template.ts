/**
 * Provider C: no LLM at all. Game reviews come from `buildTemplateReview` (@gambit/core) when that
 * package is available, otherwise from the minimal built-in template below. It is always the last
 * provider in the chain, so the app works with zero paid APIs.
 */
import type { GameRecord, MotifId, Persona, StudentProfile } from '@gambit/shared';
import type { TemplateReviewFn } from '../../content.ts';
import { childOutcome, sanToRu } from '../../storage/notation.ts';
import { LlmProviderError } from '../types.ts';
import type { LlmProvider, LlmRequest } from '../types.ts';
import type { RephraseOutput, ReviewOutput } from '../reviewSchema.ts';

/** Engine motif → lichess puzzle theme to practise. */
export const MOTIF_TO_THEME: Record<MotifId, string> = {
  hangingPiece: 'hangingPiece',
  freeCapture: 'hangingPiece',
  badTrade: 'hangingPiece',
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  discoveredAttack: 'discoveredAttack',
  doubleCheck: 'doubleCheck',
  removeDefender: 'capturingDefender',
  trappedPiece: 'trappedPiece',
  backRankMate: 'backRankMate',
  mateIn1: 'mateIn1',
  mateIn2: 'mateIn2',
  mateIn3: 'mateIn3',
  promotion: 'promotion',
  kingSafety: 'kingsideAttack',
  development: 'opening',
  center: 'opening',
};

/** The motif that cost the most in this game → theme key; `fallback` when the game was clean. */
export function suggestThemeFromRecord(record: GameRecord, fallback: string): string {
  const counts = new Map<MotifId, number>();
  for (const motif of [...record.summary.motifsAllowed, ...record.summary.motifsMissed]) counts.set(motif, (counts.get(motif) ?? 0) + 1);
  const worst = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (worst !== undefined) return MOTIF_TO_THEME[worst[0]];
  const moment = record.summary.keyMoments.find((m) => m.motif !== undefined);
  return moment?.motif !== undefined ? MOTIF_TO_THEME[moment.motif] : fallback;
}

export interface TemplateContext {
  templateReview: TemplateReviewFn | null;
  motifTitleRu: (motif: MotifId) => string;
  themeTitleRu: (theme: string) => string;
  /** default practice theme: first puzzle theme of the student's stage */
  defaultTheme: (profile: StudentProfile) => string;
}

function gendered(profile: StudentProfile, male: string, female: string): string {
  return profile.address === 'f' ? female : male;
}

export function buildTakeaways(record: GameRecord, profile: StudentProfile, ctx: Pick<TemplateContext, 'motifTitleRu'>): string[] {
  const s = record.summary;
  const takeaways: string[] = [];
  const goodMoves = s.counts.best + s.counts.excellent;
  if (goodMoves > 0) takeaways.push(`Сильных ходов в партии: ${goodMoves}. Точность — ${Math.round(s.accuracy)}%.`);
  if (s.takebacksAccepted > 0) takeaways.push(`${gendered(profile, 'Вернул', 'Вернула')} ход и ${gendered(profile, 'подумал', 'подумала')} ещё раз — это привычка сильных игроков.`);
  const worst = s.keyMoments.find((m) => m.classification === 'blunder' || m.classification === 'mistake' || m.classification === 'missedWin');
  if (worst !== undefined) {
    const motif = worst.motif !== undefined ? ` Тема: ${ctx.motifTitleRu(worst.motif).toLowerCase()}.` : '';
    takeaways.push(`Главный момент — ход ${sanToRu(worst.playedSan)}: сильнее было ${sanToRu(worst.bestSan)}.${motif}`);
  } else if (s.counts.blunder === 0) {
    takeaways.push('Ни одного зевка за партию — фигуры были под присмотром.');
  }
  takeaways.push('Перед каждым ходом: что хочет соперник? Какие у меня шахи, взятия, угрозы? Безопасен ли мой ход?');
  return takeaways.slice(0, 4);
}

/** Minimal built-in review used when @gambit/core's `buildTemplateReview` is unavailable. */
export function builtinTemplateReview(record: GameRecord, persona: Persona, profile: StudentProfile, ctx: Pick<TemplateContext, 'motifTitleRu'>): string {
  const s = record.summary;
  const outcome = childOutcome(record.result, record.childColor);
  const played = gendered(profile, 'сыграл', 'сыграла');
  const lines: string[] = ['## Что получилось', ''];
  const opening: Record<typeof outcome, string> = {
    win: `Победа над ботом ${persona.name}! Ты ${played} с точностью ${Math.round(s.accuracy)}%.`,
    loss: `В этот раз сильнее оказался бот ${persona.name}, но партия была полезной: точность ${Math.round(s.accuracy)}%.`,
    draw: `Ничья с ботом ${persona.name}. Точность — ${Math.round(s.accuracy)}%.`,
    unfinished: `Партия с ботом ${persona.name} не доиграна. Точность сыгранных ходов — ${Math.round(s.accuracy)}%.`,
  };
  lines.push(opening[outcome]);
  const goodMoves = s.counts.best + s.counts.excellent;
  if (goodMoves > 0) lines.push(`Сильных ходов: ${goodMoves} — это результат внимательной игры.`);
  if (s.takebacksAccepted > 0) lines.push(`Ты ${gendered(profile, 'вернул', 'вернула')} ход и ${gendered(profile, 'нашёл', 'нашла')} продолжение лучше — так и растут шахматисты.`);
  if (s.hintsUsed > 0) lines.push(`Подсказок: ${s.hintsUsed}. Спрашивать, когда трудно, — это нормально.`);
  lines.push('', '## Главный урок партии', '');
  const moments = s.keyMoments.filter((m) => m.classification !== 'best' && m.classification !== 'excellent' && m.classification !== 'good').slice(0, 2);
  if (moments.length === 0) {
    lines.push('Серьёзных ошибок не было. Продолжай проверять каждый ход так же внимательно.');
  } else {
    for (const moment of moments) {
      const motif = moment.motif !== undefined ? ` (${ctx.motifTitleRu(moment.motif).toLowerCase()})` : '';
      const explanation = moment.explanation.trim() !== '' ? ` ${moment.explanation.trim()}` : '';
      lines.push(`- Ход ${sanToRu(moment.playedSan)}${motif}: сильнее было **${sanToRu(moment.bestSan)}**.${explanation}`);
    }
  }
  lines.push('', '## Как думать над ходом', '', 'Что хочет соперник? Что могу я — шахи, взятия, угрозы? Безопасен ли мой ход?');
  return lines.join('\n');
}

export function createTemplateProvider(ctx: TemplateContext): LlmProvider {
  const review = (record: GameRecord, persona: Persona, profile: StudentProfile): ReviewOutput => {
    let markdown: string | null = null;
    if (ctx.templateReview !== null) {
      try {
        markdown = ctx.templateReview(record, persona, profile);
      } catch {
        markdown = null; // whatever happens inside buildTemplateReview, the built-in template always works
      }
    }
    markdown ??= builtinTemplateReview(record, persona, profile, ctx);
    return {
      markdown,
      keyTakeaways: buildTakeaways(record, profile, ctx),
      suggestedTheme: suggestThemeFromRecord(record, ctx.defaultTheme(profile)),
    };
  };

  return {
    id: 'template',
    isConfigured: () => true,
    generate(request: LlmRequest): Promise<unknown> {
      try {
        const task = request.task;
        if (task.kind === 'gameReview') return Promise.resolve(review(task.record, task.persona, task.profile));
        // the strategist computed its deterministic answer in code before asking any model
        if (task.kind === 'strategy' || task.kind === 'replan') return Promise.resolve({ ...task.fallback });
        const out: RephraseOutput = { text: task.event.text };
        return Promise.resolve(out);
      } catch (error) {
        return Promise.reject(new LlmProviderError('template', 'failed', error instanceof Error ? error.message : String(error)));
      }
    },
  };
}
