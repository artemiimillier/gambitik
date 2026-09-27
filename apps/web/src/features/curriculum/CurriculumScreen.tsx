/**
 * CurriculumScreen — «Путь пешки»: ten stages on a winding path. The pawn stands on the current stage
 * and becomes a queen on the tenth. Every stage shows its goal, skills, mastery criteria with the
 * child's own progress, buttons to train its puzzle themes and its concept cards.
 *
 * Nothing is locked and nothing can be lost: stages ahead are simply «впереди», finished ones stay finished.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as content from '@gambit/content';
import { THEMES_NOT_FOR_DRILL, THEME_TITLES_RU, getConceptCardsForStage, getPersona } from '@gambit/content';
import type { ConceptCard, CurriculumStage, ProgressSnapshot } from '@gambit/shared';
import { getCurriculum, getProgress } from '../../api/client.ts';
import { coach } from '../../coach/index.ts';
import { Badge, Button, Card, Icon, PersonaAvatar, ProgressBar, Screen, Spinner, cx } from '../../ui/index.ts';
import { makeLocalEvent } from '../puzzles/puzzleCoach.ts';
import { ConceptCardModal } from './ConceptCardModal.tsx';
import styles from './CurriculumScreen.module.css';
import { drillThemes, masteryCriteria, repertoireForStage, sideOf, stageProgressPct, stageState } from './curriculumModel.ts';
import type { RepertoireView, StageState } from './curriculumModel.ts';
import { OpeningModal } from './OpeningModal.tsx';

export interface CurriculumScreenProps {
  onExit(): void;
  onStartPuzzles(theme: string): void;
}

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; stages: CurriculumStage[]; current: number; snapshot: ProgressSnapshot | null };

const STATE_LABEL: Record<StageState, string> = { done: 'пройдено', current: 'ты здесь', ahead: 'впереди' };

/**
 * The opening repertoire «по идеям» of @gambit/content (taught from stage 5). Read through the namespace so a
 * content package without it (or with a changed shape) only hides the buttons — it can never break the screen.
 */
function repertoireOf(stage: number): RepertoireView[] {
  try {
    return repertoireForStage(stage, (content as Record<string, unknown>).OPENING_REPERTOIRE);
  } catch {
    return [];
  }
}

/** The piece on the path: a pawn, and a queen on the last stage. */
function PathPiece({ queen }: { queen: boolean }) {
  return queen ? (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="4" cy="7" r="1.8" />
      <circle cx="9" cy="4.6" r="1.8" />
      <circle cx="15" cy="4.6" r="1.8" />
      <circle cx="20" cy="7" r="1.8" />
      <path d="M4 8.5l2.4 8.5h11.2L20 8.5l-3.9 4.6L15 6.4l-3 6.2-3-6.2-1.1 6.7z" />
      <path d="M5.6 18.4h12.8v2.4H5.6z" />
    </svg>
  ) : (
    <Icon name="pawn" />
  );
}

export function CurriculumScreen({ onExit, onStartPuzzles }: CurriculumScreenProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [openStage, setOpenStage] = useState<number | null>(null);
  const [card, setCard] = useState<ConceptCard | null>(null);
  const [opening, setOpening] = useState<RepertoireView | null>(null);
  const currentRef = useRef<HTMLLIElement | null>(null);
  const greeted = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    setLoad({ status: 'loading' });
    Promise.all([getCurriculum({ signal: abort.signal }), getProgress({ signal: abort.signal }).catch(() => null)])
      .then(([curriculum, snapshot]) => {
        if (abort.signal.aborted) return;
        const stages = [...curriculum.stages].sort((a, b) => a.stage - b.stage);
        setLoad({ status: 'ready', stages, current: curriculum.current, snapshot });
        setOpenStage(curriculum.current);
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoad({ status: 'error' });
      });
    return () => abort.abort();
  }, [reloadKey]);

  const ready = load.status === 'ready' ? load : null;

  useEffect(() => {
    if (!ready) return;
    // Bring the current step to the top — but only when it starts below the fold. Centring the (tall, expanded)
    // step would cut its own heading off and hide the title of the screen on stage 1.
    const step = currentRef.current;
    if (step && typeof step.getBoundingClientRect === 'function' && step.getBoundingClientRect().top > window.innerHeight * 0.6) {
      step.style.scrollMarginTop = '16px';
      step.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    }
    const stage = ready.stages.find((s) => s.stage === ready.current);
    if (stage && !greeted.current) {
      greeted.current = true;
      void coach.say(
        makeLocalEvent({ kind: 'greeting', priority: 1, pose: 'wave', text: `Это твой путь пешки! Сейчас ты на ступени ${ready.current}. Шаг за шагом пешка дойдёт до конца и станет ферзём.` }),
      );
    }
    // only when the data arrives, not on every re-render
  }, [ready]);

  const lastStage = useMemo(() => (ready ? Math.max(...ready.stages.map((s) => s.stage)) : 10), [ready]);

  if (!ready) {
    return (
      <Screen title="Путь пешки" onBack={onExit} backLabel="Домой">
        {load.status === 'loading' ? (
          <div className={styles.center}>
            <Spinner size={64} label="Рисую карту пути…" showLabel />
          </div>
        ) : (
          <Card tone="tint" padding="lg" className={styles.notice}>
            <h2>Карта пути не загрузилась</h2>
            <p>Похоже, шахматный сервер сейчас не отвечает.</p>
            <Button size="lg" icon={<Icon name="refresh" />} onClick={() => setReloadKey((k) => k + 1)}>
              Попробовать ещё
            </Button>
          </Card>
        )}
      </Screen>
    );
  }

  const { stages, current, snapshot } = ready;

  return (
    <Screen title="Путь пешки" subtitle="Шаг за шагом — до самого ферзя" onBack={onExit} backLabel="Домой">
      <ol className={styles.path}>
        {stages.map((stage, index) => {
          const state = stageState(stage.stage, current);
          const isOpen = openStage === stage.stage;
          const criteria = snapshot ? masteryCriteria(stage, snapshot) : [];
          const themes = drillThemes(stage, THEME_TITLES_RU, THEMES_NOT_FOR_DRILL, snapshot?.profile.themeSkills);
          const cards = getConceptCardsForStage(stage.stage);
          const repertoire = isOpen ? repertoireOf(stage.stage) : [];
          const isQueen = stage.stage === lastStage;
          const panelId = `stage-panel-${stage.stage}`;

          return (
            <li key={stage.stage} ref={state === 'current' ? currentRef : undefined} className={styles.step} data-state={state} data-side={sideOf(index)}>
              <div className={styles.node} aria-hidden="true">
                {state === 'current' ? (
                  <span className={styles.marker}>
                    <PathPiece queen={isQueen} />
                  </span>
                ) : state === 'done' ? (
                  <Icon name="check" />
                ) : isQueen ? (
                  <PathPiece queen />
                ) : (
                  <span className={styles.nodeNumber}>{stage.stage}</span>
                )}
              </div>

              <Card padding="md" tone={state === 'current' ? 'sunny' : state === 'done' ? 'green' : 'surface'} className={cx(styles.stageCard, isOpen && styles.stageCardOpen)} as="section">
                <button type="button" className={styles.stageHead} aria-expanded={isOpen} aria-controls={panelId} onClick={() => setOpenStage(isOpen ? null : stage.stage)}>
                  <span className={styles.stageHeadText}>
                    <span className={styles.stageKicker}>
                      Ступень {stage.stage} · {STATE_LABEL[state]}
                    </span>
                    <span className={styles.stageTitle}>{stage.title}</span>
                  </span>
                  <span className={styles.chevron} data-open={isOpen || undefined} aria-hidden="true">
                    <Icon name="forward" />
                  </span>
                </button>

                {state === 'current' && criteria.length > 0 && !isOpen ? <ProgressBar value={stageProgressPct(criteria)} aria-label="Прогресс ступени" tone="sunny" size="sm" /> : null}

                {isOpen ? (
                  <div id={panelId} className={styles.stageBody}>
                    <p className={styles.goal}>{stage.goal}</p>

                    <div>
                      <h3 className={styles.blockTitle}>Чему учимся</h3>
                      <ul className={styles.skills}>
                        {stage.skills.map((skill) => (
                          <li key={skill}>{skill}</li>
                        ))}
                      </ul>
                    </div>

                    {themes.length > 0 ? (
                      <div>
                        <h3 className={styles.blockTitle}>Потренироваться</h3>
                        <div className={styles.chips}>
                          {themes.map((t) => (
                            <Button key={t.theme} variant={state === 'current' ? 'primary' : 'secondary'} size="md" icon={<Icon name="play" />} onClick={() => onStartPuzzles(t.theme)}>
                              {t.title}
                              {t.rating !== null ? <span className={styles.chipRating}> · {t.rating}</span> : null}
                            </Button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {cards.length > 0 ? (
                      <div>
                        <h3 className={styles.blockTitle}>Карточки с идеями</h3>
                        <div className={styles.chips}>
                          {cards.map((c) => (
                            <Button key={c.id} variant="accent" size="md" icon={<Icon name="bulb" />} onClick={() => setCard(c)}>
                              {c.title}
                            </Button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div>
                      <h3 className={styles.blockTitle}>Когда ступень пройдена</h3>
                      <p className={styles.masteryText}>{stage.mastery.description}</p>
                      {state === 'done' ? (
                        <Badge tone="green" icon={<Icon name="check" />}>
                          Ступень пройдена
                        </Badge>
                      ) : criteria.length > 0 ? (
                        <ul className={styles.criteria}>
                          {criteria.map((c) => (
                            <li key={c.id}>
                              <ProgressBar value={c.met ? 100 : c.pct} label={`${c.label}: ${c.target}`} valueText={c.met ? 'готово ✓' : (c.current ?? 'пока нет данных')} tone={c.met ? 'green' : 'teal'} />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {state === 'ahead' ? <p className={styles.muted}>До этой ступени ещё есть время — но заглянуть вперёд всегда можно.</p> : null}
                    </div>

                    {stage.endgames.length > 0 ? (
                      <div>
                        <h3 className={styles.blockTitle}>Эндшпили ступени</h3>
                        <ul className={styles.skills}>
                          {stage.endgames.map((e) => (
                            <li key={e}>{e}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <div>
                      <h3 className={styles.blockTitle}>Дебют</h3>
                      <p>{stage.openingFocus}</p>
                      {repertoire.length > 0 ? (
                        <>
                          <p className={styles.muted}>Наш репертуар — не учим ходы наизусть, а понимаем идеи:</p>
                          <div className={styles.chips}>
                            {repertoire.map((entry) => (
                              <Button key={entry.id} variant="secondary" size="md" icon={<Icon name="play" />} onClick={() => setOpening(entry)}>
                                {entry.title}
                              </Button>
                            ))}
                          </div>
                        </>
                      ) : null}
                    </div>

                    {stage.recommendedPersonas.length > 0 ? (
                      <div>
                        <h3 className={styles.blockTitle}>С кем играть</h3>
                        <div className={styles.personas}>
                          {stage.recommendedPersonas.map((id) => {
                            const persona = getPersona(id);
                            return persona ? (
                              <span key={id} className={styles.persona}>
                                <PersonaAvatar persona={persona} size={48} label="" />
                                {persona.name}
                              </span>
                            ) : null;
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ol>

      <ConceptCardModal card={card} onClose={() => setCard(null)} />
      <OpeningModal entry={opening} onClose={() => setOpening(null)} />
    </Screen>
  );
}
