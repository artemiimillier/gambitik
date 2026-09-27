/**
 * Home — the child's hub: four big doors, «Продолжить партию» when a game waits, and a soft plan for today whose last
 * step opens the last game's review. One clear way to every place and little text. A laptop (1280×640 and up,
 * «Продолжить партию» included) and a tablet show it all without scrolling; a phone shows the four doors and the start
 * of the plan on its first screen. Гамбитик lives in his corner (the global dock) and does the talking; the grown-ups'
 * door is the small «Для взрослых» in the top corner.
 */
import { useMemo, useState } from 'react';
import { getCurriculumStage, getPersona, CURRICULUM } from '@gambit/content';
import type { GameListItem, StudentProfile } from '@gambit/shared';
import { Badge, BigChoice, Button, Icon, PersonaAvatar, cx, pluralRu } from '../ui/index.ts';
import styles from './Home.module.css';
import type { ResumeTile } from './resumeGame.ts';
import type { Route } from './router.ts';
import { getBrowserStorage, loadShellSettings } from './shellSettings.ts';
import { buildTodayPlan } from './todayPlan.ts';
import type { PlanStep } from './todayPlan.ts';
import { useMediaQuery } from './useMediaQuery.ts';

/**
 * Where the four doors stand 2 × 2 with the icon on the left instead of in one row: a window too narrow for four next
 * to Гамбитик's strip (a small laptop window, an iPad on its side), and any computer with the parent's bigger text —
 * the page column never gets wider than ~900 px, and «Путь пешки» / «Мои успехи» in bigger letters do not fit a
 * quarter of it. So the titles never run out of their doors and the page stays one screen high. Phones (below 900 px)
 * keep their own 2 × 2 of upright doors.
 */
export function rowTilesQuery(fontScale: number): string {
  return fontScale > 1 ? '(min-width: 900px)' : '(min-width: 900px) and (max-width: 1239.98px)';
}

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

function ResumeGameTile({ resume, onNavigate }: { resume: ResumeTile; onNavigate: (route: Route) => void }) {
  const persona = getPersona(resume.personaId);
  const moves = `${resume.movesPlayed} ${pluralRu(resume.movesPlayed, 'ход', 'хода', 'ходов')}`;
  return (
    <BigChoice
      accent="sunny"
      className={styles.resumeTile}
      icon={persona ? <PersonaAvatar persona={persona} size={64} mood="happy" label="" /> : '♟️'}
      title={<span className={styles.tileTitle}>Продолжить партию</span>}
      subtitle={persona ? `Соперник: ${persona.name} · ${moves}` : `Уже сыграно: ${moves}`}
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
  const nickname = profile.nickname.trim();
  // the parent's text size is read once per mount: it is changed on another screen (Settings)
  const [fontScale] = useState(() => loadShellSettings(getBrowserStorage()).fontScale);
  const tileLayout = useMediaQuery(rowTilesQuery(fontScale)) ? 'row' : 'column';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.hello}>
          <h1 className={styles.title}>{nickname === '' ? `${helloFor(moment.getHours())}!` : `${helloFor(moment.getHours())}, ${nickname}!`}</h1>
          <p className={styles.subtitle}>Во что поиграем сегодня?</p>
        </div>
        {/* settings, sound, the account: behind the parent gate. A word, not just a cogwheel, so a grown-up finds it at
            once; on a phone only the cogwheel shows, the word stays its name */}
        <Button variant="ghost" icon={<Icon name="gear" />} className={styles.parentButton} onClick={() => onNavigate({ name: 'settings' })}>
          <span className={styles.parentLabel}>Для взрослых</span>
        </Button>
      </header>

      <main className={styles.main}>
        {resume ? <ResumeGameTile resume={resume} onNavigate={onNavigate} /> : null}
        <nav className={styles.tiles} data-doors={tileLayout} aria-label="Главное меню">
          <BigChoice
            layout={tileLayout}
            accent="sunny"
            className={cx(styles.tile, styles.playTile)}
            icon={<span className={styles.playGlyph}>♞</span>}
            title={<span className={styles.tileTitle}>Играть</span>}
            subtitle={<span className={cx(styles.tileSubtitle, styles.playSubtitle)}>С соперником</span>}
            onClick={() => onNavigate({ name: 'new' })}
          />
          <BigChoice
            layout={tileLayout}
            accent="coral"
            className={styles.tile}
            icon="🧩"
            title={<span className={styles.tileTitle}>Задачи</span>}
            subtitle={<span className={styles.tileSubtitle}>Найди лучший ход</span>}
            onClick={() => onNavigate({ name: 'puzzles' })}
          />
          <BigChoice
            layout={tileLayout}
            accent="green"
            className={styles.tile}
            icon="🗺️"
            title={<span className={styles.tileTitle}>Путь пешки</span>}
            subtitle={<span className={styles.tileSubtitle}>{`Ступень ${stage.stage} из ${CURRICULUM.length}`}</span>}
            onClick={() => onNavigate({ name: 'path' })}
          />
          <BigChoice
            layout={tileLayout}
            accent="blue"
            className={styles.tile}
            icon="⭐"
            title={<span className={styles.tileTitle}>Мои успехи</span>}
            subtitle={<span className={styles.tileSubtitle}>Графики и партии</span>}
            onClick={() => onNavigate({ name: 'progress' })}
          />
        </nav>

        {/* the routine of a good chess day; it names the last game, and its «Разбор» opens that game's review (no separate card) */}
        <section className={styles.plan} aria-label="План на сегодня" data-all-done={plan.allDone ? 'true' : 'false'}>
          <h2 className={styles.planHeadline}>{plan.headline}</h2>
          <ol className={styles.planSteps}>
            {plan.steps.map((step, index) => (
              <PlanStepButton key={step.id} step={step} index={index} onNavigate={onNavigate} />
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}
