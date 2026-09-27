/**
 * Home — four big doors, a soft plan for today and the last game. Little text, no scrolling on a
 * laptop screen; Гамбитик lives in his corner (the global dock) and does the talking.
 */
import { useMemo } from 'react';
import { getCurriculumStage, getPersona, CURRICULUM } from '@gambit/content';
import type { GameListItem, StudentProfile } from '@gambit/shared';
import { TIME_CONTROLS } from '@gambit/shared';
import { Badge, BigChoice, Button, Card, Icon, PersonaAvatar, cx, pluralRu } from '../ui/index.ts';
import styles from './Home.module.css';
import type { ResumeTile } from './resumeGame.ts';
import type { Route } from './router.ts';
import { buildTodayPlan } from './todayPlan.ts';
import type { PlanStep } from './todayPlan.ts';

export interface HomeProps {
  profile: StudentProfile;
  /** newest first */
  games: readonly GameListItem[];
  reviewedToday: readonly string[];
  /** puzzles finished today on this computer (the warm-up of the plan is three) */
  puzzlesToday?: number;
  /** an interrupted game the child can go on with (closed tab, reload) — null / absent = none */
  resume?: ResumeTile | null;
  onNavigate: (route: Route) => void;
  now?: Date;
}

type Outcome = 'win' | 'loss' | 'draw' | 'unfinished';

export function gameOutcome(game: Pick<GameListItem, 'result' | 'childColor'>): Outcome {
  if (game.result === '1/2-1/2') return 'draw';
  if (game.result === '*') return 'unfinished';
  return (game.result === '1-0') === (game.childColor === 'w') ? 'win' : 'loss';
}

/** Neutral words: a loss is never announced in red capitals (research 08 §9). */
const OUTCOME_RU: Record<Outcome, string> = {
  win: 'Победа!',
  draw: 'Ничья',
  loss: 'Победил соперник',
  unfinished: 'Не доиграна',
};

const OUTCOME_TONE: Record<Outcome, 'green' | 'blue' | 'neutral'> = { win: 'green', draw: 'blue', loss: 'neutral', unfinished: 'neutral' };

function formatGameDate(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / dayMs);
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function helloFor(hour: number): string {
  if (hour < 5) return 'Привет';
  if (hour < 12) return 'Доброе утро';
  if (hour < 18) return 'Привет';
  return 'Добрый вечер';
}

function PlanStepButton({ step, index, onNavigate }: { step: PlanStep; index: number; onNavigate: (route: Route) => void }) {
  const target = step.target;
  return (
    <li className={styles.planItem}>
      <button
        type="button"
        className={styles.planStep}
        data-done={step.done ? 'true' : 'false'}
        data-suggested={step.suggested ? 'true' : 'false'}
        disabled={target === null}
        onClick={() => {
          if (target !== null) onNavigate(target);
        }}
      >
        <span className={styles.planMark} aria-hidden="true">
          {step.done ? <Icon name="check" /> : index + 1}
        </span>
        <span className={styles.planText}>
          <span className={styles.planTitle}>
            {step.title}
            {step.done ? <span className={styles.srOnly}> — сделано</span> : null}
          </span>
          <span className={styles.planHint}>{step.hint}</span>
        </span>
        {step.suggested ? (
          <Badge tone="sunny" variant="solid" size="sm" className={styles.planBadge}>
            Гамбитик советует
          </Badge>
        ) : null}
      </button>
    </li>
  );
}

function LastGameCard({ game, now, onNavigate }: { game: GameListItem; now: Date; onNavigate: (route: Route) => void }) {
  const persona = getPersona(game.personaId);
  const outcome = gameOutcome(game);
  const reviewReady = game.reviewStatus === 'ready' || game.reviewStatus === 'template';
  return (
    <Card as="section" title="Последняя партия" padding="md" className={styles.lastGame}>
      <div className={styles.lastGameRow}>
        {persona ? <PersonaAvatar persona={persona} size={72} mood="happy" label="" /> : null}
        <div className={styles.lastGameText}>
          <p className={styles.lastGameTitle}>
            {persona ? `Соперник: ${persona.name}` : 'Партия'} <Badge tone={OUTCOME_TONE[outcome]}>{OUTCOME_RU[outcome]}</Badge>
          </p>
          <p className={styles.lastGameMeta}>
            {[formatGameDate(game.startedAt, now), TIME_CONTROLS[game.timeControlId].label.toLowerCase(), reviewReady ? 'разбор готов' : 'разбор готовится']
              .filter((part) => part !== '')
              .join(' · ')}
          </p>
        </div>
        <Button variant="secondary" size="lg" icon={<Icon name="bulb" />} onClick={() => onNavigate({ name: 'review', gameId: game.id })}>
          Разбор
        </Button>
      </div>
    </Card>
  );
}

function ResumeGameTile({ resume, onNavigate }: { resume: ResumeTile; onNavigate: (route: Route) => void }) {
  const persona = getPersona(resume.personaId);
  const moves = `${resume.movesPlayed} ${pluralRu(resume.movesPlayed, 'ход', 'хода', 'ходов')}`;
  return (
    <BigChoice
      accent="sunny"
      className={styles.resumeTile}
      icon={persona ? <PersonaAvatar persona={persona} size={64} mood="happy" label="" /> : '♟️'}
      title={<span className={styles.tileTitle}>Продолжить партию</span>}
      subtitle={persona ? `Соперник: ${persona.name} · уже сыграно: ${moves}` : `Уже сыграно: ${moves}`}
      badge={
        <Badge tone="sunny" variant="solid" size="sm">
          партия ждёт
        </Badge>
      }
      onClick={() => onNavigate(resume.route)}
    />
  );
}

export function Home({ profile, games, reviewedToday, puzzlesToday = 0, resume = null, onNavigate, now }: HomeProps) {
  const moment = useMemo(() => now ?? new Date(), [now]);
  const plan = useMemo(() => buildTodayPlan({ now: moment, games, reviewedToday, puzzlesToday }), [moment, games, reviewedToday, puzzlesToday]);
  const stage = getCurriculumStage(profile.stage);
  const lastGame = games[0];
  const nickname = profile.nickname.trim();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.hello}>
          <h1 className={styles.title}>{nickname === '' ? `${helloFor(moment.getHours())}!` : `${helloFor(moment.getHours())}, ${nickname}!`}</h1>
          <p className={styles.subtitle}>Во что поиграем сегодня?</p>
        </div>
        <Button variant="ghost" icon={<Icon name="gear" />} aria-label="Настройки для родителей" title="Настройки для родителей" onClick={() => onNavigate({ name: 'settings' })} />
      </header>

      <main className={styles.main}>
        {resume ? <ResumeGameTile resume={resume} onNavigate={onNavigate} /> : null}
        <nav className={styles.tiles} aria-label="Главное меню">
          <BigChoice
            layout="column"
            accent="sunny"
            className={cx(styles.tile, styles.playTile)}
            icon={<span className={styles.playGlyph}>♞</span>}
            title={<span className={styles.tileTitle}>Играть</span>}
            subtitle={<span className={styles.playSubtitle}>Партия с соперником</span>}
            onClick={() => onNavigate({ name: 'new' })}
          />
          <BigChoice
            layout="column"
            accent="coral"
            className={styles.tile}
            icon="🧩"
            title={<span className={styles.tileTitle}>Задачи</span>}
            subtitle="Найди лучший ход"
            onClick={() => onNavigate({ name: 'puzzles' })}
          />
          <BigChoice
            layout="column"
            accent="green"
            className={styles.tile}
            icon="🗺️"
            title={<span className={styles.tileTitle}>Путь пешки</span>}
            subtitle={`Ступень ${stage.stage} из ${CURRICULUM.length}`}
            onClick={() => onNavigate({ name: 'path' })}
          />
          <BigChoice
            layout="column"
            accent="blue"
            className={styles.tile}
            icon="⭐"
            title={<span className={styles.tileTitle}>Мои успехи</span>}
            subtitle="Графики и партии"
            onClick={() => onNavigate({ name: 'progress' })}
          />
        </nav>

        <section className={styles.plan} aria-label="План на сегодня" data-all-done={plan.allDone ? 'true' : 'false'}>
          <h2 className={styles.planHeadline}>{plan.headline}</h2>
          <ol className={styles.planSteps}>
            {plan.steps.map((step, index) => (
              <PlanStepButton key={step.id} step={step} index={index} onNavigate={onNavigate} />
            ))}
          </ol>
        </section>

        {lastGame ? <LastGameCard game={lastGame} now={moment} onNavigate={onNavigate} /> : null}
      </main>
    </div>
  );
}
