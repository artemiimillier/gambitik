/**
 * `data/student/profile.md` — the living student profile, readable by a parent and by an LLM.
 * Regenerated as a whole from the database; only the parent-notes block survives rewrites.
 */
import { TIME_CONTROLS } from '@gambit/shared';
import type { CurriculumStage, GameListItem, Persona, PersonaId, StudentProfile } from '@gambit/shared';
import { parentNotesBlock } from './files.ts';
import { COLOR_RU, OUTCOME_RU, childOutcome, formatDateShortRu, formatDateTimeRu, mdInline, pluralRu, toLocalIso } from './notation.ts';

export interface CoachNote {
  startedAt: string;
  personaId: PersonaId;
  takeaways: string[];
  suggestedThemeTitle: string | null;
}

export interface ProfileMdInput {
  profile: StudentProfile;
  stage: CurriculumStage;
  nextStage: CurriculumStage | null;
  personas: Record<PersonaId, Persona>;
  themeTitleRu: (theme: string) => string;
  /** newest first, at most 10 are shown — only the games that count in the child's progress */
  lastGames: (GameListItem & { journalPath: string | null })[];
  /** games left out of the progress (played by an adult / archived); they stay in data/games */
  excludedGames?: number;
  /** newest first */
  coachNotes: CoachNote[];
  parentNotes: string | null;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function masteryLine(stage: CurriculumStage): string {
  const parts: string[] = [];
  const m = stage.mastery;
  if (m.minPuzzleRating !== undefined) parts.push(`рейтинг задач от ${Math.round(m.minPuzzleRating)}`);
  if (m.maxBlundersPerGame !== undefined) parts.push(`не больше ${m.maxBlundersPerGame} зевков за партию`);
  if (m.minAccuracy !== undefined) parts.push(`точность от ${Math.round(m.minAccuracy)}%`);
  return parts.length === 0 ? m.description : `${m.description} (${parts.join(', ')})`;
}

export function renderProfileMd(input: ProfileMdInput): string {
  const { profile, stage, nextStage } = input;
  const t = profile.totals;
  const out: string[] = [];
  out.push('---', 'schema: student-profile/1', `student: ${JSON.stringify(profile.nickname)}`, `updated: ${JSON.stringify(toLocalIso(profile.updatedAt))}`, `stage: ${profile.stage}`, `puzzle_rating: ${Math.round(profile.puzzleRating.rating)}`, '---', '');
  out.push(`# Профиль ученика: ${mdInline(profile.nickname)}`, '');
  out.push('> Этот файл программа «Гамбитик» обновляет сама после каждой партии и серии задач. Его удобно читать родителю и давать ИИ-тренеру как контекст. Всё, кроме блока «Заметки родителя» в конце, перезаписывается.', '');

  out.push('## Сейчас', '');
  out.push(`- **Ступень ${stage.stage} из программы: «${mdInline(stage.title)}»** (уровень ${mdInline(stage.ratingBand)})`);
  out.push(`- Цель ступени: ${mdInline(stage.goal)}`);
  out.push(`- Чтобы перейти дальше: ${mdInline(masteryLine(stage))}`);
  if (nextStage !== null) out.push(`- Следующая ступень: «${mdInline(nextStage.title)}»`);
  out.push(`- Рейтинг задач: **${Math.round(profile.puzzleRating.rating)} ± ${Math.round(profile.puzzleRating.rd)}** (попыток: ${profile.puzzleRating.attempts}, решено: ${profile.puzzleRating.solved})`);
  out.push(`- Партий: ${t.games} (побед ${t.wins} · поражений ${t.losses} · ничьих ${t.draws}) · за доской ${Math.round(t.minutesPlayed)} мин`);
  const excluded = input.excludedGames ?? 0;
  if (excluded > 0) out.push(`- Не считаются в прогрессе: ${pluralRu(excluded, 'партия', 'партии', 'партий')} (играл взрослый или архив «Начать прогресс заново») — их файлы остались в data/games`);
  const avg10 = mean(profile.recentAccuracy.slice(-10));
  if (avg10 !== null) out.push(`- Средняя точность за последние партии (до 10): **${Math.round(avg10)}%**`);
  out.push(`- Самый сильный побеждённый соперник: ${profile.bestWin !== null ? mdInline(input.personas[profile.bestWin].name) : 'пока нет'}`);
  out.push(`- Обращение в репликах тренера: ${profile.address === 'f' ? 'женский род' : 'мужской род'}`, '');

  out.push('## Рейтинги по темам', '');
  const themes = Object.entries(profile.themeSkills).sort((a, b) => b[1].attempts - a[1].attempts);
  if (themes.length === 0) {
    out.push('_Задачи ещё не решались._', '');
  } else {
    out.push('| Тема | Рейтинг | ± | Попыток | Решено | Последний раз |', '|---|---:|---:|---:|---:|---|');
    for (const [theme, skill] of themes) {
      const solvedPct = skill.attempts > 0 ? ` (${Math.round((skill.solved / skill.attempts) * 100)}%)` : '';
      out.push(`| ${mdInline(input.themeTitleRu(theme))} \`${theme}\` | ${Math.round(skill.rating)} | ${Math.round(skill.rd)} | ${skill.attempts} | ${skill.solved}${solvedPct} | ${skill.lastSeen !== null ? formatDateShortRu(skill.lastSeen) : '—'} |`);
    }
    out.push('');
  }

  out.push('## Сильные стороны', '');
  if (profile.strengths.length === 0) out.push('_Пока мало данных — сыграем ещё несколько партий._', '');
  else out.push(...profile.strengths.map((s) => `- ${mdInline(s)}`), '');

  out.push('## Над чем работаем', '');
  if (profile.weaknesses.length === 0) out.push('_Повторяющихся ошибок за последние партии не замечено._', '');
  else out.push(...profile.weaknesses.map((w) => `- ${mdInline(w)} — встречалось несколько раз за последние 10 партий`), '');

  out.push('## Последние 10 партий', '');
  if (input.lastGames.length === 0) {
    out.push('_Партий пока нет._', '');
  } else {
    out.push('| Дата | Соперник | Контроль | Цвет | Результат | Точность | Зевки | Журнал |', '|---|---|---|---|---|---:|---:|---|');
    for (const game of input.lastGames.slice(0, 10)) {
      const outcome = OUTCOME_RU[childOutcome(game.result, game.childColor)];
      const journal = game.journalPath !== null ? `[журнал](../${game.journalPath})` : '—';
      out.push(
        `| ${formatDateTimeRu(game.startedAt)} | ${mdInline(input.personas[game.personaId].name)} | ${TIME_CONTROLS[game.timeControlId].label} | ${COLOR_RU[game.childColor]} | ${outcome} (${game.result}) | ${Math.round(game.accuracy)}% | ${game.blunders} | ${journal} |`,
      );
    }
    out.push('');
  }

  out.push('## Заметки тренера', '');
  const notes = input.coachNotes.filter((n) => n.takeaways.length > 0 || n.suggestedThemeTitle !== null).slice(0, 5);
  if (notes.length === 0) {
    out.push('_Появятся после первого разбора партии._', '');
  } else {
    for (const note of notes) {
      out.push(`**${formatDateShortRu(note.startedAt)}, партия с ботом ${mdInline(input.personas[note.personaId].name)}**`);
      for (const takeaway of note.takeaways) out.push(`- ${mdInline(takeaway)}`);
      if (note.suggestedThemeTitle !== null) out.push(`- Потренировать: ${mdInline(note.suggestedThemeTitle)}`);
      out.push('');
    }
  }

  out.push(parentNotesBlock(input.parentNotes), '');
  return out.join('\n');
}
