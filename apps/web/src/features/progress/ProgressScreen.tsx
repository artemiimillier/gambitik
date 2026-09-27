/**
 * ProgressScreen — the dashboard for the parent and the child: where we are on the «Путь пешки»,
 * how accurate the games are, how the puzzle rating moves, which themes are strong or need practice,
 * every game page by page (→ review) and plain-language notes for the parent. Behind the parent gate: mark a game
 * «играл взрослый / проверка», «Начать прогресс заново» (archives, never deletes), read the journal of a game.
 *
 * No leaderboards, no comparison with other children, no lost streaks: every number is compared only
 * with the child's own past (research 08 §1.4, 05 §8).
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { getPersona } from '@gambit/content';
import type { GameListItem, ProgressSnapshot } from '@gambit/shared';
import { getProgress } from '../../api/client.ts';
import { getGateStorage, isGateOpen } from '../../app/parentGate.ts';
import { Badge, Button, Card, Icon, Modal, PersonaAvatar, ProgressBar, Screen, Spinner, pluralRu } from '../../ui/index.ts';
import { GamesCard } from './GamesCard.tsx';
import { GAMES_PAGE_SIZE, appendPage, countedGames, exclusionOf, splitPage, withExclusion } from './gamesModel.ts';
import { JournalModal } from './JournalModal.tsx';
import { ParentLock } from './ParentLock.tsx';
import { listGamesPage, resetProgress, setGameExcluded } from './progressApi.ts';
import styles from './ProgressScreen.module.css';
import { THEME_LEVEL_LABEL, average, formatDateTimeRu, formatMinutesRu, rankThemes, toGameChartData, toRatingChartData, trendOf } from './progressModel.ts';
import type { ThemeLevel, Trend } from './progressModel.ts';

const ProgressCharts = lazy(() => import('./ProgressCharts.tsx'));

export interface ProgressScreenProps {
  onExit(): void;
  onOpenGame(gameId: string): void;
}

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; snapshot: ProgressSnapshot; games: GameListItem[]; hasMore: boolean };

const TREND_TEXT: Record<Exclude<Trend, 'none'>, string> = { up: 'растёт', down: 'немного ниже, чем раньше', flat: 'держится ровно' };
const LEVEL_TONE: Record<ThemeLevel, 'green' | 'sunny' | 'neutral' | 'blue'> = { strong: 'green', weak: 'sunny', steady: 'neutral', new: 'blue' };
const LEVEL_BAR: Record<ThemeLevel, 'green' | 'sunny' | 'teal'> = { strong: 'green', weak: 'sunny', steady: 'teal', new: 'teal' };

/** The parent's tools under the games list: the way in, the gate, or the tools themselves. */
type ParentMode = 'closed' | 'lock' | 'open';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue} data-numeric>
        {value}
      </span>
      <span className={styles.statLabel}>{label}</span>
      {hint ? <span className={styles.statHint}>{hint}</span> : null}
    </div>
  );
}

export function ProgressScreen({ onExit, onOpenGame }: ProgressScreenProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [parent, setParent] = useState<ParentMode>(() => (isGateOpen(getGateStorage(), Date.now()) ? 'open' : 'closed'));
  const [busyGameId, setBusyGameId] = useState<string | null>(null);
  const [parentNote, setParentNote] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [journalGame, setJournalGame] = useState<GameListItem | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setLoad({ status: 'loading' });
    setMore('idle');
    Promise.all([getProgress({ signal: abort.signal }), listGamesPage(GAMES_PAGE_SIZE + 1, 0, { signal: abort.signal }).catch((): GameListItem[] => [])])
      .then(([snapshot, rows]) => {
        const page = splitPage(rows);
        if (!abort.signal.aborted) setLoad({ status: 'ready', snapshot, games: page.rows, hasMore: page.hasMore });
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoad({ status: 'error' });
      });
    return () => abort.abort();
  }, [reloadKey]);

  const shown = load.status === 'ready' ? load.games.length : 0;
  const loadMore = useCallback(() => {
    setMore('loading');
    listGamesPage(GAMES_PAGE_SIZE + 1, shown)
      .then((rows) => {
        const page = splitPage(rows);
        setLoad((current) => (current.status === 'ready' ? { ...current, games: appendPage(current.games, page.rows), hasMore: page.hasMore } : current));
        setMore('idle');
      })
      .catch(() => setMore('failed'));
  }, [shown]);

  /** The numbers after a mark or a reset: the snapshot is fetched again, the list stays where the parent scrolled. */
  const refreshSnapshot = useCallback(() => {
    getProgress()
      .then((snapshot) => setLoad((current) => (current.status === 'ready' ? { ...current, snapshot } : current)))
      .catch(() => undefined);
  }, []);

  const toggleAdult = useCallback(
    (game: GameListItem) => {
      const next = exclusionOf(game) === null ? 'adult' : null;
      setBusyGameId(game.id);
      setParentNote(null);
      setGameExcluded(game.id, next)
        .then((answer) => {
          setLoad((current) => (current.status === 'ready' ? { ...current, games: withExclusion(current.games, game.id, answer.excluded) } : current));
          setParentNote(answer.excluded !== null ? 'Партия больше не считается в успехах ребёнка. Файлы партии остались на месте.' : 'Партия снова считается в успехах ребёнка.');
          refreshSnapshot();
        })
        .catch(() => setParentNote('Не получилось сохранить отметку: сервер не ответил. Попробуйте ещё раз.'))
        .finally(() => setBusyGameId(null));
    },
    [refreshSnapshot],
  );

  const doReset = useCallback(() => {
    setResetting(true);
    resetProgress()
      .then((answer) => {
        setConfirmReset(false);
        setParentNote(`Прогресс начат заново: ${answer.archivedGames} ${pluralRu(answer.archivedGames, 'партия ушла', 'партии ушли', 'партий ушли')} в архив. Ничего не удалено — любую партию можно вернуть кнопкой «Вернуть в прогресс».`);
        setReloadKey((k) => k + 1);
      })
      .catch(() => setParentNote('Не получилось начать заново: сервер не ответил. Попробуйте ещё раз.'))
      .finally(() => setResetting(false));
  }, []);

  const snapshot = load.status === 'ready' ? load.snapshot : null;
  const gameData = useMemo(() => (snapshot ? toGameChartData(snapshot.games) : []), [snapshot]);
  const ratingData = useMemo(() => (snapshot ? toRatingChartData(snapshot.puzzleRatingHistory) : []), [snapshot]);
  const themes = useMemo(() => (snapshot ? rankThemes(snapshot.themeTable, snapshot.profile.puzzleRating.rating) : []), [snapshot]);

  if (load.status !== 'ready' || !snapshot) {
    return (
      <Screen title="Мои успехи" onBack={onExit} backLabel="Домой">
        {load.status === 'loading' ? (
          <div className={styles.center}>
            <Spinner size={64} label="Считаю успехи…" showLabel />
          </div>
        ) : (
          <Card tone="tint" padding="lg" className={styles.notice}>
            <h2>Не получилось загрузить успехи</h2>
            <p>Похоже, шахматный сервер сейчас не отвечает.</p>
            <Button size="lg" icon={<Icon name="refresh" />} onClick={() => setReloadKey((k) => k + 1)}>
              Попробовать ещё
            </Button>
          </Card>
        )}
      </Screen>
    );
  }

  const { profile, stage, nextStage } = snapshot;
  const { totals } = profile;
  const bestWin = profile.bestWin ? getPersona(profile.bestWin) : undefined;
  const accuracyTrend = trendOf(gameData.map((g) => g.accuracy));
  const recentAccuracy = average(gameData.slice(-5).map((g) => g.accuracy));
  const recentBlunders = average(gameData.slice(-5).map((g) => g.blunders));
  const nothingYet = totals.games === 0 && totals.puzzlesAttempted === 0;
  const strong = themes.filter((t) => t.level === 'strong').slice(0, 3);
  const weak = themes.filter((t) => t.level === 'weak').slice(-3).reverse();

  return (
    <Screen title="Мои успехи" subtitle={profile.nickname ? `${profile.nickname} · ступень ${stage.stage} из 10` : `Ступень ${stage.stage} из 10`} onBack={onExit} backLabel="Домой">
      <div className={styles.stack}>
        {/* ───────── header ───────── */}
        <Card padding="lg" tone="teal" as="section" aria-label="Коротко" className={styles.hero}>
          <div className={styles.heroStage}>
            <span className={styles.heroPawn} aria-hidden="true">
              <Icon name="pawn" />
            </span>
            <div>
              <p className={styles.heroKicker}>Ступень {stage.stage} · «Путь пешки»</p>
              <h2 className={styles.heroTitle}>{stage.title}</h2>
              <p className={styles.heroGoal}>{stage.goal}</p>
            </div>
          </div>
          <div className={styles.stats}>
            <Stat label="рейтинг в задачах" value={String(Math.round(profile.puzzleRating.rating))} hint={profile.puzzleRating.attempts < 10 ? 'ещё уточняется' : undefined} />
            <Stat label={pluralRu(totals.games, 'партия', 'партии', 'партий')} value={String(totals.games)} hint={totals.games > 0 ? `побед ${totals.wins} · ничьих ${totals.draws} · поражений ${totals.losses}` : undefined} />
            <Stat label="решено задач" value={String(totals.puzzlesSolved)} hint={totals.puzzlesAttempted > 0 ? `из ${totals.puzzlesAttempted}` : undefined} />
            <Stat label="за шахматами" value={formatMinutesRu(totals.minutesPlayed)} />
          </div>
          {bestWin ? (
            <p className={styles.bestWin}>
              <PersonaAvatar persona={bestWin} size={44} label="" /> Самый сильный соперник, которого удалось победить: {bestWin.name}.
            </p>
          ) : null}
        </Card>

        {nothingYet ? (
          <Card padding="lg" tone="sunny" className={styles.notice}>
            <h2>Здесь появятся твои успехи</h2>
            <p>Сыграй первую партию или реши несколько задач — и тут вырастут графики. Гамбитик уже ждёт!</p>
            <Button size="xl" icon={<Icon name="play" />} onClick={onExit}>
              Пойдём играть
            </Button>
          </Card>
        ) : null}

        {/* ───────── games ───────── */}
        {!nothingYet ? (
          <Card padding="lg" as="section" title="Партии">
            {gameData.length === 0 ? (
              <p className={styles.empty}>Партий пока нет. Сыграй с Петей или Соней — после партии Гамбитик сделает разбор, и тут появится первая точка.</p>
            ) : (
              <>
                <p className={styles.lead}>
                  {recentAccuracy !== null ? `Средняя точность в последних партиях — ${Math.round(recentAccuracy)}%` : ''}
                  {accuracyTrend !== 'none' ? `, ${TREND_TEXT[accuracyTrend]}` : ''}
                  {recentBlunders !== null ? `. Зевков за партию: ${(Number.isInteger(recentBlunders) ? String(recentBlunders) : recentBlunders.toFixed(1)).replace('.', ',')}.` : '.'}
                </p>
                {gameData.length === 1 ? <p className={styles.empty}>График появится после второй партии.</p> : null}
              </>
            )}
            <Suspense
              fallback={
                <div className={styles.center}>
                  <Spinner size={40} />
                </div>
              }
            >
              <ProgressCharts games={gameData} rating={[]} />
            </Suspense>
          </Card>
        ) : null}

        {/* ───────── puzzles ───────── */}
        {!nothingYet ? (
          <Card padding="lg" as="section" title="Задачи">
            {ratingData.length < 2 ? (
              <p className={styles.empty}>Реши несколько задач — и тут появится линия рейтинга. Рейтинг растёт, когда задача решена с первой попытки.</p>
            ) : (
              <Suspense
                fallback={
                  <div className={styles.center}>
                    <Spinner size={40} />
                  </div>
                }
              >
                <ProgressCharts games={[]} rating={ratingData} />
              </Suspense>
            )}

            {themes.length > 0 ? (
              <>
                <h3 className={styles.subTitle}>Темы</h3>
                {strong.length > 0 || weak.length > 0 ? (
                  <p className={styles.lead}>
                    {strong.length > 0 ? `Лучше всего получается: ${strong.map((t) => t.title).join(', ')}. ` : ''}
                    {weak.length > 0 ? `Стоит потренировать: ${weak.map((t) => t.title).join(', ')}.` : ''}
                  </p>
                ) : null}
                <table className={styles.themeTable}>
                  <thead>
                    <tr>
                      <th scope="col">Тема</th>
                      <th scope="col">Рейтинг</th>
                      <th scope="col" className={styles.num}>
                        Решено
                      </th>
                      <th scope="col">Как идёт</th>
                    </tr>
                  </thead>
                  <tbody>
                    {themes.map((row) => (
                      <tr key={row.theme}>
                        <th scope="row">{row.title}</th>
                        <td>
                          <div className={styles.barCell}>
                            <ProgressBar value={row.bar} aria-label={`${row.title}: рейтинг ${row.rating}`} tone={LEVEL_BAR[row.level]} size="sm" />
                            <span data-numeric>{row.rating}</span>
                          </div>
                        </td>
                        <td className={styles.num} data-numeric>
                          {row.solved} из {row.attempts}
                        </td>
                        <td>
                          <Badge tone={LEVEL_TONE[row.level]} size="sm" icon={row.level === 'strong' ? <Icon name="star" /> : row.level === 'weak' ? <Icon name="bulb" /> : undefined}>
                            {THEME_LEVEL_LABEL[row.level]}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
          </Card>
        ) : null}

        {/* ───────── strengths & growth ───────── */}
        {profile.strengths.length > 0 || profile.weaknesses.length > 0 ? (
          <div className={styles.twoCards}>
            {profile.strengths.length > 0 ? (
              <Card padding="md" tone="green" as="section" title="Что уже получается">
                <ul className={styles.bullets}>
                  {profile.strengths.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </Card>
            ) : null}
            {profile.weaknesses.length > 0 ? (
              <Card padding="md" tone="sunny" as="section" title="Над чем работаем">
                <ul className={styles.bullets}>
                  {profile.weaknesses.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        ) : null}

        {/* ───────── every game ───────── */}
        {load.games.length > 0 ? (
          <GamesCard
            games={load.games}
            hasMore={load.hasMore}
            loadingMore={more === 'loading'}
            moreFailed={more === 'failed'}
            onLoadMore={loadMore}
            onOpenGame={onOpenGame}
            parent={parent === 'open'}
            busyGameId={busyGameId}
            onToggleAdult={toggleAdult}
            onOpenJournal={setJournalGame}
            footer={
              <div className={styles.parentTools}>
                {parent === 'closed' ? (
                  <div className={styles.parentEntry}>
                    <p>Для взрослых: отметить партии, которые играл взрослый, начать прогресс заново, открыть журнал партии.</p>
                    <Button variant="ghost" size="md" icon={<Icon name="lock" />} onClick={() => setParent('lock')}>
                      Для взрослых
                    </Button>
                  </div>
                ) : parent === 'lock' ? (
                  <ParentLock onPass={() => setParent('open')} onCancel={() => setParent('closed')} />
                ) : (
                  <div className={styles.parentOpen}>
                    <p>
                      Партию, которую играл взрослый или которая была проверкой, отметьте кнопкой «Это играл взрослый»: она останется в списке и в папке
                      data/games, но пропадёт из успехов, графиков, ступени и из того, что Гамбитик знает об ученике.
                    </p>
                    <div className={styles.parentActions}>
                      <Button variant="secondary" size="md" icon={<Icon name="refresh" />} onClick={() => setConfirmReset(true)}>
                        Начать прогресс заново
                      </Button>
                      <Button variant="ghost" size="md" onClick={() => setParent('closed')}>
                        Готово
                      </Button>
                    </div>
                  </div>
                )}
                {parentNote !== null ? (
                  <p className={styles.parentNote} role="status">
                    {parentNote}
                  </p>
                ) : null}
              </div>
            }
          />
        ) : null}

        {/* ───────── what is next ───────── */}
        <Card padding="lg" tone="tint" as="section" title="Что дальше" className={styles.prose}>
          <p>{stage.mastery.description}</p>
          {nextStage ? (
            <p className={styles.lead}>
              Следующая ступень — <strong>{nextStage.title}</strong>. Ступени не отнимаются: если что-то забылось, Гамбитик просто добавит повторений.
            </p>
          ) : (
            <p className={styles.lead}>Это последняя ступень пути — дальше только мастерство!</p>
          )}
        </Card>

        {/* ───────── parent notes ───────── */}
        <Card padding="lg" as="section" title="Родителям" flat>
          <div className={styles.parent}>
            <h4>Что значат числа</h4>
            <ul className={styles.bullets}>
              <li>
                <strong>Точность</strong> — насколько ходы ребёнка близки к лучшим ходам шахматного движка (0–100%, формула как на Lichess). Против слабого соперника она обычно выше, поэтому сравнивайте партии с одним и тем же ботом.
              </li>
              <li>
                <strong>Зевок</strong> — ход, после которого шансы на победу резко упали (на 20 и более пунктов из 100): чаще всего потерянная фигура или пропущенный мат. Цель — чтобы их становилось меньше, а не чтобы их не было совсем.
              </li>
              <li>
                <strong>Рейтинг в задачах</strong> считается по системе Glicko-2 на шкале задач Lichess. Он обычно заметно выше игрового рейтинга и нужен только для подбора задач по силам. Первые десять–двадцать задач он сильно прыгает — это нормально.
              </li>
              <li>
                <strong>Ступень</strong> — место в программе «Путь пешки» (10 ступеней от первых ходов до мастерства). Переход происходит, когда навык виден и в задачах, и в партиях.
              </li>
            </ul>
            <h4>Где лежат файлы</h4>
            <ul className={styles.bullets}>
              <li>
                Каждая партия: <code>data/games/ГГГГ/ММ/</code> — файл <code>.pgn</code> (открывается в любой шахматной программе) и журнал <code>.md</code> с ходами, подсказками, словами тренера, мыслями ребёнка после партии и разбором. Журнал можно открыть и здесь: «Все партии» → «Для взрослых» → «Журнал».
              </li>
              <li>
                Портрет ученика: <code>data/student/profile.md</code> — сильные стороны, темы для работы, последние партии. Внизу есть блок для ваших заметок: программа его не перезаписывает.
              </li>
              <li>
                Числа для графиков: <code>data/student/progress.json</code>. Всё хранится только на этом компьютере.
              </li>
            </ul>
            <h4>Как помочь</h4>
            <ul className={styles.bullets}>
              <li>Хвалите за старание и внимательность («ты проверил ход!»), а не за победу или «ум».</li>
              <li>Короткие занятия по 15–25 минут почти каждый день полезнее одного длинного.</li>
              <li>После поражения сначала посочувствуйте, потом посмотрите вместе один момент из разбора — не больше.</li>
            </ul>
          </div>
        </Card>
      </div>

      <JournalModal
        gameId={journalGame?.id ?? null}
        title={journalGame ? `Журнал: ${getPersona(journalGame.personaId)?.name ?? 'соперник'}, ${formatDateTimeRu(journalGame.startedAt)}` : 'Журнал партии'}
        onClose={() => setJournalGame(null)}
      />
      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Начать прогресс заново?"
        size="lg"
        actions={
          <>
            <Button variant="ghost" size="lg" onClick={() => setConfirmReset(false)} disabled={resetting}>
              Отмена
            </Button>
            <Button variant="primary" size="lg" onClick={doReset} disabled={resetting}>
              {resetting ? 'Начинаю…' : 'Да, начать заново'}
            </Button>
          </>
        }
      >
        <p>
          Партии, которые сейчас считаются в успехах ({countedGames(load.games)}
          {load.hasMore ? ' среди показанных' : ''}), уйдут в архив, и успехи начнутся с нуля. Ничего не удаляется: партии и журналы останутся в
          списке и в папке data/games, любую можно вернуть. Задачи и ступень не меняются.
        </p>
      </Modal>
    </Screen>
  );
}
