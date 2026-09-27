/**
 * PuzzlesScreen — a calm session of 10 adaptive puzzles.
 *
 * Pedagogy (research 05 §1.7, 08 §1.4): solve first, then show · no visible timer · a wrong move is
 * «Попробуй ещё», never a failure screen · stars reward effort · the theme is revealed AFTER solving
 * (unless the child chose the theme) · natural stopping point after 10 puzzles, nothing auto-starts.
 *
 * A theme session keeps its promise: under «Её можно забрать бесплатно» the child is not served
 * mates in one — such puzzles are filtered out, and if one still has to fill the session, its instruction is neutral.
 * The warm-up of the today plan is a short session of three (`sessionSize`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MIXED_THEME_KEY, THEME_DESCRIPTIONS_RU, THEME_TITLES_RU } from '@gambit/content';
import type { BoardAnnotations, Puzzle, Square } from '@gambit/shared';
import { getStudent, nextPuzzles, submitPuzzleAttempt } from '../../api/client.ts';
import { coach } from '../../coach/index.ts';
import { registerDevHook } from '../../devHook.ts';
import type { GambitPuzzleSnapshot } from '../../devHook.ts';
import { Badge, Button, Card, Icon, ProgressBar, Screen, Spinner, Stars, celebrate, playSound, pluralRu } from '../../ui/index.ts';
import { MiniBoard } from './MiniBoard.tsx';
import type { MiniBoardMove } from './MiniBoard.tsx';
import { buildPuzzleHint, buildPuzzleMiss, buildPuzzleSessionStart, buildPuzzleSolved, buildSessionSummary, buildSolutionShown } from './puzzleCoach.ts';
import { checkPuzzleMove, expectedMove, isPlayablePuzzle, parseUci, placementBeforeLastMove, remainingLine, sideToMove } from './puzzleLine.ts';
import type { AppliedMove } from './puzzleLine.ts';
import {
  EMPTY_RUN,
  SESSION_SIZE,
  finishRun,
  formatRatingDelta,
  nextStreak,
  normaliseSessionSize,
  pickRevealTheme,
  requestCountFor,
  selectSessionPuzzles,
  sessionStars,
  summarizeSession,
  themeInstructionRu,
  toAttempt,
} from './puzzleSession.ts';
import type { PuzzleOutcome, PuzzleRun } from './puzzleSession.ts';
import styles from './PuzzlesScreen.module.css';
import { useTimers } from './useTimers.ts';

export interface PuzzlesScreenProps {
  theme?: string;
  onExit(): void;
  /** puzzles in the FIRST session (default 10; the warm-up of the today plan asks for 3); «ещё» always brings ten */
  sessionSize?: number;
  /** a puzzle was finished (solved or shown) — the shell counts them for the today plan */
  onPuzzleDone?(): void;
}

type Status = 'loading' | 'error' | 'empty' | 'playing' | 'summary';
type Phase = 'intro' | 'solving' | 'replying' | 'solution' | 'solved';
type Note = 'find' | 'retry' | 'good' | 'reply' | 'watch' | 'done';

interface BoardView {
  fen: string;
  lastMove: { from: Square; to: Square } | null;
}

const INTRO_DELAY_MS = 450;
const MOVE_ANIMATION_MS = 300;
const REPLY_DELAY_MS = 550;
const SOLUTION_STEP_MS = 1100;

const NOTE_TEXT: Record<Note, string> = {
  find: 'Найди лучший ход!',
  retry: 'Попробуй ещё!',
  good: 'Верно! А теперь?',
  reply: 'Соперник отвечает…',
  watch: 'Смотри решение…',
  done: 'Решено!',
};

function hasTitle(theme: string): boolean {
  return Object.hasOwn(THEME_TITLES_RU, theme);
}

function moveSound(move: AppliedMove): void {
  playSound(move.isCheck ? 'check' : move.isCapture ? 'capture' : 'move');
}

export function PuzzlesScreen({ theme, onExit, sessionSize, onPuzzleDone }: PuzzlesScreenProps) {
  const sessionTheme = theme !== undefined && theme !== '' && theme !== MIXED_THEME_KEY ? theme : undefined;
  const sessionThemeTitle = sessionTheme !== undefined && hasTitle(sessionTheme) ? THEME_TITLES_RU[sessionTheme] : undefined;
  const sessionThemeDescription = sessionTheme !== undefined ? THEME_DESCRIPTIONS_RU[sessionTheme] : undefined;

  const firstSessionSize = normaliseSessionSize(sessionSize);
  const onPuzzleDoneRef = useRef(onPuzzleDone);
  onPuzzleDoneRef.current = onPuzzleDone;

  const [status, setStatus] = useState<Status>('loading');
  const [batchNo, setBatchNo] = useState(0);
  const [puzzles, setPuzzles] = useState<Puzzle[]>([]);
  const [index, setIndex] = useState(0);
  const [outcomes, setOutcomes] = useState<PuzzleOutcome[]>([]);
  const [streak, setStreak] = useState(0);
  const [ratingBefore, setRatingBefore] = useState<number | null>(null);
  const [ratingNow, setRatingNow] = useState<number | null>(null);

  // per-puzzle state
  const [phase, setPhase] = useState<Phase>('intro');
  const [view, setView] = useState<BoardView | null>(null);
  const [solIndex, setSolIndex] = useState(0);
  const [note, setNote] = useState<Note>('find');
  const [hint, setHint] = useState<BoardAnnotations | null>(null);
  /** hint ladder of the CURRENT move: 0 = none, 1 = piece highlighted, 2 = arrow shown */
  const [hintStep, setHintStep] = useState<0 | 1 | 2>(0);
  const [shakeKey, setShakeKey] = useState(0);
  const [lastOutcome, setLastOutcome] = useState<PuzzleOutcome | null>(null);
  const [altMate, setAltMate] = useState(false);

  const timers = useTimers();
  const runRef = useRef<PuzzleRun>(EMPTY_RUN);
  const streakRef = useRef(0);
  const startedAtRef = useRef(0);
  const ratingNowRef = useRef<number | null>(null);
  const submitChain = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

  const puzzle = status === 'playing' ? puzzles[index] : undefined;
  const childColor = puzzle ? sideToMove(puzzle.fen) : 'w';

  // dev server only (e2e introspection) — compiled out of the production bundle
  const devSnapshot = useRef<GambitPuzzleSnapshot | null>(null);
  useEffect(() => {
    if (import.meta.env.DEV) devSnapshot.current = { status, phase, index, total: puzzles.length, solutionIndex: solIndex, puzzle: puzzle ?? null };
  });
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return registerDevHook('puzzles', {
      current: () => devSnapshot.current ?? { status: 'loading', phase: 'intro', index: 0, total: 0, solutionIndex: 0, puzzle: null },
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      coach.clearAnnotations();
    };
  }, []);

  // ───────────── load a batch ─────────────
  useEffect(() => {
    const abort = new AbortController();
    setStatus('loading');
    const size = batchNo === 0 ? firstSessionSize : SESSION_SIZE;
    const load = async () => {
      try {
        const [batch, student] = await Promise.all([
          nextPuzzles({ theme: sessionTheme, count: requestCountFor(sessionTheme, size) }, { signal: abort.signal }),
          getStudent({ signal: abort.signal }).catch(() => null),
        ]);
        if (abort.signal.aborted) return;
        const playable = selectSessionPuzzles(batch.filter(isPlayablePuzzle), sessionTheme, size);
        if (playable.length === 0) {
          setStatus('empty');
          return;
        }
        const knownRating = ratingNowRef.current ?? student?.puzzleRating.rating ?? null;
        setRatingBefore(knownRating);
        setRatingNow(knownRating);
        ratingNowRef.current = knownRating;
        setPuzzles(playable);
        setIndex(0);
        setOutcomes([]);
        setStreak(0);
        streakRef.current = 0;
        setStatus('playing');
        if (batchNo === 0) void coach.say(buildPuzzleSessionStart(sessionThemeTitle));
      } catch {
        if (!abort.signal.aborted) setStatus('error');
      }
    };
    void load();
    return () => abort.abort();
  }, [batchNo, firstSessionSize, sessionTheme, sessionThemeTitle]);

  // ───────────── start a puzzle: animate the opponent's move in ─────────────
  useEffect(() => {
    if (!puzzle) return;
    timers.clear();
    runRef.current = EMPTY_RUN;
    setSolIndex(0);
    setHint(null);
    setHintStep(0);
    setLastOutcome(null);
    setAltMate(false);
    setNote('find');
    setPhase('intro');
    setView({ fen: placementBeforeLastMove(puzzle.fen, puzzle.lastMoveUci), lastMove: null });
    const last = parseUci(puzzle.lastMoveUci);
    timers.after(INTRO_DELAY_MS, () => {
      setView({ fen: puzzle.fen, lastMove: last ? { from: last.from, to: last.to } : null });
      playSound('move');
    });
    timers.after(INTRO_DELAY_MS + MOVE_ANIMATION_MS, () => {
      startedAtRef.current = performance.now();
      setPhase('solving');
    });
    return () => timers.clear();
  }, [puzzle, timers]);

  // ───────────── finishing a puzzle ─────────────
  const finishPuzzle = useCallback(
    (current: Puzzle, finalRun: PuzzleRun, alternateMate: boolean) => {
      const outcome = finishRun(current, finalRun, performance.now() - startedAtRef.current);
      const newStreak = nextStreak(streakRef.current, outcome);
      streakRef.current = newStreak;
      setStreak(newStreak);
      setOutcomes((prev) => [...prev, outcome]);
      setLastOutcome(outcome);
      setAltMate(alternateMate);
      setHint(null);
      setNote('done');
      setPhase('solved');
      coach.noteActivity();
      onPuzzleDoneRef.current?.();

      if (!outcome.solutionShown) {
        playSound('star');
        const revealKey = sessionTheme === undefined ? pickRevealTheme(current.themes, hasTitle) : undefined;
        void coach.say(
          buildPuzzleSolved({
            clean: outcome.solvedClean && outcome.hintsUsed === 0,
            streak: newStreak,
            alternateMate,
            ...(revealKey !== undefined ? { revealTitle: THEME_TITLES_RU[revealKey] } : {}),
          }),
        );
      }

      // attempts are sent one after another so the last answer really is the latest rating
      const attempt = toAttempt(current, outcome);
      submitChain.current = submitChain.current
        .then(() => submitPuzzleAttempt(attempt))
        .then((response) => {
          ratingNowRef.current = response.puzzleRating.rating;
          if (mounted.current) setRatingNow(response.puzzleRating.rating);
        })
        .catch(() => {
          // offline or server hiccup: the child keeps solving, the rating simply does not move
        });
    },
    [sessionTheme],
  );

  // ───────────── the child's move ─────────────
  const handleMove = useCallback(
    (move: MiniBoardMove): boolean => {
      if (!puzzle || phase !== 'solving') return false;
      coach.noteActivity();
      const verdict = checkPuzzleMove(puzzle, solIndex, move.uci);
      if (verdict.kind === 'illegal') return false;

      if (verdict.kind === 'wrong') {
        const nextRun: PuzzleRun = { ...runRef.current, wrongAttempts: runRef.current.wrongAttempts + 1 };
        runRef.current = nextRun;
        setShakeKey((key) => key + 1);
        setNote('retry');
        playSound('oops');
        void coach.say(buildPuzzleMiss(nextRun.wrongAttempts));
        return false;
      }

      const { played, reply } = verdict;
      setHint(null);
      setHintStep(0);
      setView({ fen: played.fenAfter, lastMove: { from: played.from, to: played.to } });
      moveSound(played);

      if (reply) {
        setPhase('replying');
        setNote('reply');
        timers.after(REPLY_DELAY_MS, () => {
          setView({ fen: reply.fenAfter, lastMove: { from: reply.from, to: reply.to } });
          moveSound(reply);
        });
        timers.after(REPLY_DELAY_MS + MOVE_ANIMATION_MS, () => {
          if (verdict.done) {
            finishPuzzle(puzzle, runRef.current, false);
          } else {
            setSolIndex(verdict.nextIndex);
            setNote('good');
            setPhase('solving');
          }
        });
      } else {
        setPhase('replying');
        timers.after(MOVE_ANIMATION_MS, () => finishPuzzle(puzzle, runRef.current, verdict.alternateMate));
      }
      return true;
    },
    [finishPuzzle, phase, puzzle, solIndex, timers],
  );

  // ───────────── hints: 1st = which piece, 2nd = the arrow ─────────────
  const handleHint = useCallback(() => {
    if (!puzzle || phase !== 'solving') return;
    const target = expectedMove(puzzle, solIndex);
    if (!target) return;
    const step: 1 | 2 = hintStep === 0 ? 1 : 2;
    const used = Math.max(runRef.current.hintsUsed, step) as PuzzleRun['hintsUsed'];
    const nextRun: PuzzleRun = { ...runRef.current, hintsUsed: used };
    runRef.current = nextRun;
    setHintStep(step);
    const event = buildPuzzleHint(step, target);
    setHint(event.board ?? null);
    coach.noteActivity();
    void coach.say(event);
  }, [hintStep, phase, puzzle, solIndex]);

  // ───────────── «Показать решение» ─────────────
  const handleShowSolution = useCallback(() => {
    if (!puzzle || phase !== 'solving') return;
    const line = remainingLine(puzzle, solIndex);
    const nextRun: PuzzleRun = { ...runRef.current, solutionShown: true };
    runRef.current = nextRun;
    setPhase('solution');
    setNote('watch');
    const first = line[0];
    setHint(first ? { arrows: [{ from: first.from, to: first.to, color: 'green' }], highlights: [] } : null);
    void coach.say(buildSolutionShown());
    line.forEach((step, i) => {
      timers.after(900 + i * SOLUTION_STEP_MS, () => {
        setHint(null);
        setView({ fen: step.fenAfter, lastMove: { from: step.from, to: step.to } });
        moveSound(step);
      });
    });
    timers.after(900 + line.length * SOLUTION_STEP_MS, () => finishPuzzle(puzzle, runRef.current, false));
  }, [finishPuzzle, phase, puzzle, solIndex, timers]);

  // ───────────── next puzzle / summary ─────────────
  const handleNext = useCallback(() => {
    if (index + 1 < puzzles.length) {
      setIndex(index + 1);
      return;
    }
    setStatus('summary');
    const stats = summarizeSession(outcomes);
    playSound('win');
    void celebrate('star');
    void coach.say(buildSessionSummary(stats));
  }, [index, outcomes, puzzles.length]);

  const handleMore = useCallback(() => setBatchNo((n) => n + 1), []);

  const stats = useMemo(() => summarizeSession(outcomes), [outcomes]);
  const themeInstruction = themeInstructionRu(sessionTheme, sessionThemeDescription, puzzle);
  const revealKey = puzzle && sessionTheme === undefined ? pickRevealTheme(puzzle.themes, hasTitle) : undefined;

  // ───────────── render ─────────────
  let body;
  if (status === 'loading') {
    body = (
      <div className={styles.center}>
        <Spinner size={64} label="Подбираю задачи…" showLabel />
      </div>
    );
  } else if (status === 'error') {
    body = (
      <Card tone="tint" padding="lg" className={styles.notice}>
        <h2>Задачи не загрузились</h2>
        <p>Похоже, шахматный сервер сейчас не отвечает. Попробуем ещё раз?</p>
        <div className={styles.noticeActions}>
          <Button size="lg" icon={<Icon name="refresh" />} onClick={handleMore}>
            Попробовать ещё
          </Button>
          <Button size="lg" variant="secondary" icon={<Icon name="home" />} onClick={onExit}>
            Домой
          </Button>
        </div>
      </Card>
    );
  } else if (status === 'empty') {
    body = (
      <Card tone="tint" padding="lg" className={styles.notice}>
        <h2>{sessionThemeTitle ? `Задач на тему «${sessionThemeTitle}» пока нет` : 'Задач пока нет'}</h2>
        <p>Можно порешать задачи на разные темы или сыграть партию — после неё появятся новые идеи для тренировки.</p>
        <div className={styles.noticeActions}>
          <Button size="lg" variant="secondary" icon={<Icon name="home" />} onClick={onExit}>
            Домой
          </Button>
        </div>
      </Card>
    );
  } else if (status === 'summary') {
    const delta = ratingBefore !== null && ratingNow !== null ? formatRatingDelta(ratingBefore, ratingNow) : null;
    body = (
      <Card padding="lg" className={styles.summary} as="section" aria-label="Итоги тренировки">
        <h2 className={styles.summaryTitle}>{batchNo === 0 && firstSessionSize < SESSION_SIZE ? 'Разминка закончена!' : 'Тренировка закончена!'}</h2>
        <Stars value={sessionStars(stats)} size={64} animate />
        <p className={styles.summaryLead}>
          {stats.stars} {pluralRu(stats.stars, 'звезда', 'звезды', 'звёзд')} за старание
        </p>
        <ul className={styles.summaryList}>
          <li>
            <span>С первой попытки</span>
            <strong data-numeric>
              {stats.solvedClean} из {stats.total}
            </strong>
          </li>
          {stats.solvedWithHelp > 0 ? (
            <li>
              <span>Со второй попытки или с подсказкой</span>
              <strong data-numeric>{stats.solvedWithHelp}</strong>
            </li>
          ) : null}
          {stats.bestStreak >= 2 ? (
            <li>
              <span>Лучшая серия подряд</span>
              <strong data-numeric>{stats.bestStreak}</strong>
            </li>
          ) : null}
          {ratingNow !== null ? (
            <li>
              <span>Рейтинг в задачах</span>
              <strong data-numeric>
                {Math.round(ratingNow)}
                {delta !== null && delta !== '0' ? <span className={styles.delta}> ({delta})</span> : null}
              </strong>
            </li>
          ) : null}
        </ul>
        <p className={styles.summaryHint}>Рейтинг растёт, когда задача решена с первой попытки. Трудные задачи — это нормально: так и учатся.</p>
        <div className={styles.noticeActions}>
          <Button size="xl" icon={<Icon name="refresh" />} onClick={handleMore}>
            Ещё {SESSION_SIZE}
          </Button>
          <Button size="xl" variant="secondary" icon={<Icon name="home" />} onClick={onExit}>
            Домой
          </Button>
        </div>
      </Card>
    );
  } else if (puzzle && view) {
    const solved = phase === 'solved';
    const isLast = index + 1 >= puzzles.length;
    body = (
      <div className={styles.layout}>
        <div className={styles.boardColumn}>
          <MiniBoard
            id="puzzle-board"
            fen={view.fen}
            orientation={childColor}
            interactive={phase === 'solving'}
            onMove={handleMove}
            lastMove={view.lastMove}
            annotations={hint}
            shakeKey={shakeKey}
            animationMs={MOVE_ANIMATION_MS}
            maxSize={620}
            label="Доска с задачей"
          />
        </div>

        <aside className={styles.panel}>
          {/* order: what to do → the buttons → progress (the mascot's bubble may cover the bottom on small windows) */}
          <Card padding="md" tone={solved ? 'green' : note === 'retry' ? 'sunny' : 'surface'} className={styles.statusCard}>
            <p className={styles.turn}>
              <span className={styles.turnDot} data-color={childColor} aria-hidden="true" />
              Ты играешь {childColor === 'w' ? 'белыми' : 'чёрными'}
            </p>
            <p className={styles.note} role="status" aria-live="polite">
              {solved && lastOutcome?.solutionShown ? 'Решение показано' : NOTE_TEXT[note]}
            </p>

            {solved && lastOutcome ? (
              <div className={styles.reveal}>
                <Stars value={lastOutcome.stars} size={40} animate />
                {/* the way forward stays right under the stars, above the longer theme text */}
                <Button size="xl" block iconAfter={<Icon name="forward" />} onClick={handleNext}>
                  {isLast ? 'Итоги' : 'Дальше'}
                </Button>
                {altMate ? <p>Твой мат тоже засчитан — мат есть мат!</p> : null}
                {revealKey !== undefined ? (
                  <>
                    <p className={styles.revealTitle}>Это тема «{THEME_TITLES_RU[revealKey]}»</p>
                    {THEME_DESCRIPTIONS_RU[revealKey] ? <p className={styles.revealText}>{THEME_DESCRIPTIONS_RU[revealKey]}</p> : null}
                  </>
                ) : null}
                {lastOutcome.solutionShown ? <p className={styles.revealText}>Такая идея ещё встретится — теперь ты её знаешь.</p> : null}
              </div>
            ) : null}
          </Card>

          {solved ? null : (
            <div className={styles.actions}>
              <Button size="lg" variant="accent" block icon={<Icon name="bulb" />} onClick={handleHint} disabled={phase !== 'solving' || hintStep === 2}>
                {hintStep === 0 ? 'Подсказка' : 'Ещё подсказка'}
              </Button>
              <Button size="md" variant="ghost" block onClick={handleShowSolution} disabled={phase !== 'solving'}>
                Показать решение
              </Button>
            </div>
          )}
          <Card padding="md" className={styles.progressCard}>
            <ProgressBar value={outcomes.length} max={puzzles.length} label={`Задача ${Math.min(index + 1, puzzles.length)} из ${puzzles.length}`} tone="sunny" />
            <div className={styles.badges}>
              <Badge tone="sunny" icon={<Icon name="star" />}>
                {stats.stars} {pluralRu(stats.stars, 'звезда', 'звезды', 'звёзд')}
              </Badge>
              {streak >= 2 ? <Badge tone="green">Подряд: {streak}</Badge> : null}
            </div>
          </Card>
        </aside>
      </div>
    );
  } else {
    body = (
      <div className={styles.center}>
        <Spinner size={64} />
      </div>
    );
  }

  return (
    <Screen title="Задачи" subtitle={sessionThemeTitle ?? 'Думай спокойно — часов тут нет'} onBack={onExit} backLabel="Домой" width="wide">
      {themeInstruction !== undefined && status === 'playing' ? <p className={styles.themeLine}>{themeInstruction}</p> : null}
      {body}
    </Screen>
  );
}
