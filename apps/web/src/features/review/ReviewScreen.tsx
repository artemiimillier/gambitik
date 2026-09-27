/**
 * ReviewScreen — the post-game review: board with move navigation, coloured move list, accuracy
 * summary, the timeline of take-backs and hints, solve-first key moments («Найди ход лучше!») and the
 * written review (LLM or template) rendered by our own safe markdown renderer.
 *
 * Solve first, for real: while a task moment is untouched, nothing on the page prints
 * its answer — the written review and the practice advice stay closed, «Какой ход сильнее?» is replaced by
 * the task itself, and «Показать ответ» appears only after a try (or 20 s). A try is checked by the judge
 * engine, so every good move counts, not only the engine's first choice.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { getPersona } from '@gambit/content';
import { buildTemplateReview, childOutcome, moveClassLabelRu, sanToBubbleRu } from '@gambit/core';
import type { BoardAnnotations, ConceptCard, GameRecord, GameReview, MoveClass, Square, StudentProfile } from '@gambit/shared';
import { TIME_CONTROLS } from '@gambit/shared';
import { getGame, getGameReview, getStudent, isApiError } from '../../api/client.ts';
import type { GameReviewWithAdvice } from '../../api/client.ts';
import { coach } from '../../coach/index.ts';
import { Badge, Button, Card, Icon, PersonaAvatar, ProgressBar, Screen, Spinner, cx, playSound, pluralRu } from '../../ui/index.ts';
import { ConceptCardModal } from '../curriculum/ConceptCardModal.tsx';
import { MiniBoard } from '../puzzles/MiniBoard.tsx';
import type { MiniBoardMove } from '../puzzles/MiniBoard.tsx';
import { makeLocalEvent } from '../puzzles/puzzleCoach.ts';
import { applyUci } from '../puzzles/puzzleLine.ts';
import { Markdown } from './Markdown.tsx';
import { conceptCardForMoment, suggestPractice } from './reviewAdvice.ts';
import styles from './ReviewScreen.module.css';
import { CLASS_MARK, CLASS_TONE, REVIEW_POLL_INTERVAL_MS, boardAt, buildReviewModel, cursorOfPosition, shouldKeepPolling, toMoveRows } from './reviewModel.ts';
import type { ReviewMove, TimelineItem } from './reviewModel.ts';
import {
  MAX_MOMENT_TRIES,
  SHOW_ANSWER_DELAY_MS,
  answersUnlocked,
  buildReviewMomentEvent,
  canShowAnswer,
  hintAnnotations,
  isCorrectVerdict,
  judgeTry,
  momentCaptionRu,
  refineVerdict,
  resolveMoment,
  revealAnnotations,
  tryFeedbackRu,
  untouchedTaskCount,
} from './reviewMoment.ts';
import type { MomentProgress, ResolvedMoment, TryVerdict } from './reviewMoment.ts';
import { createBrowserTryEvaluator } from './reviewTry.ts';
import type { TryEvaluator } from './reviewTry.ts';
import { INITIAL_NAV, canGoBack, canGoForward, keyToNavAction, navReducer } from './reviewNav.ts';

export interface ReviewScreenProps {
  gameId: string;
  onExit(): void;
  /** «Потренировать» — opens a puzzle session on the suggested theme (optional: without it the button is not shown). */
  onStartPuzzles?(theme: string): void;
}

type LoadState = { status: 'loading' } | { status: 'notFound' } | { status: 'error' } | { status: 'ready'; record: GameRecord };
type ReviewState = { status: 'waiting'; review: GameReviewWithAdvice | null } | { status: 'done'; review: GameReviewWithAdvice } | { status: 'gaveUp'; review: GameReviewWithAdvice | null };

interface MomentSession {
  index: number;
  tries: number;
  feedback: string | null;
  /** null while the child is still searching */
  outcome: 'found' | 'revealed' | null;
  /** position to show after the child found a correct move (or, with `checking`, while the engine looks at the try) */
  solvedFen: string | null;
  /** the move that led to `solvedFen` */
  shownMove: { from: Square; to: Square } | null;
  /** the judge engine is looking at the try: the board waits */
  checking: boolean;
  /** «Подсказка»: the piece to look at is highlighted */
  hintShown: boolean;
  /** «Показать ответ» may be offered (after the first try or after 20 s) */
  answerOffered: boolean;
}

const OUTCOME_TITLE = { win: 'Победа!', loss: 'Поражение — это тоже урок', draw: 'Ничья', unfinished: 'Партия не доиграна' } as const;
const PROVIDER_LABEL: Record<GameReview['provider'], string> = {
  codex: 'написал ИИ-тренер',
  openrouter: 'написал ИИ-тренер',
  'openai-api': 'написал ИИ-тренер',
  template: 'составлен автоматически',
};
const COUNT_ORDER: MoveClass[] = ['best', 'excellent', 'inaccuracy', 'mistake', 'blunder', 'missedWin'];
const COUNT_LABEL: Record<MoveClass, [string, string, string]> = {
  best: ['лучший ход', 'лучших хода', 'лучших ходов'],
  excellent: ['отличный ход', 'отличных хода', 'отличных ходов'],
  good: ['хороший ход', 'хороших хода', 'хороших ходов'],
  inaccuracy: ['неточность', 'неточности', 'неточностей'],
  mistake: ['ошибка', 'ошибки', 'ошибок'],
  blunder: ['зевок', 'зевка', 'зевков'],
  missedWin: ['упущенный шанс', 'упущенных шанса', 'упущенных шансов'],
};
const TONE_BADGE = { great: 'green', fine: 'neutral', careful: 'sunny', oops: 'coral' } as const;

const FALLBACK_PROFILE: StudentProfile = {
  nickname: '',
  address: 'm',
  stage: 1,
  totals: { games: 0, wins: 0, losses: 0, draws: 0, puzzlesAttempted: 0, puzzlesSolved: 0, minutesPlayed: 0 },
  puzzleRating: { rating: 600, rd: 300, vol: 0.06, attempts: 0, solved: 0, lastSeen: null },
  themeSkills: {},
  recentAccuracy: [],
  weaknesses: [],
  strengths: [],
  bestWin: null,
  updatedAt: '',
};

function formatDateRu(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function ReviewScreen({ gameId, onExit, onStartPuzzles }: ReviewScreenProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [reviewState, setReviewState] = useState<ReviewState>({ status: 'waiting', review: null });
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [nav, dispatch] = useReducer(navReducer, INITIAL_NAV);
  const [session, setSession] = useState<MomentSession | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [extraMarks, setExtraMarks] = useState<{ cursor: number; annotations: BoardAnnotations } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /** what the child already did with each task moment (index → progress); untouched moments have no entry */
  const [progress, setProgress] = useState<Record<number, MomentProgress>>({});
  /** the written review was opened by hand although a task is still untouched */
  const [openedByHand, setOpenedByHand] = useState(false);
  /** the «open anyway» button appears after the same pause as «Показать ответ» */
  const [mayOpenByHand, setMayOpenByHand] = useState(false);
  const [card, setCard] = useState<ConceptCard | null>(null);
  const currentMoveRef = useRef<HTMLButtonElement | null>(null);
  const momentPanelRef = useRef<HTMLElement | null>(null);
  const greetedGame = useRef<string | null>(null);
  const sessionRef = useRef<MomentSession | null>(null);
  const evaluatorRef = useRef<TryEvaluator | null>(null);
  /** bumped whenever the open task changes, so a late engine answer for an old try is ignored */
  const tryToken = useRef(0);
  sessionRef.current = session;

  const record = load.status === 'ready' ? load.record : null;

  // ───────────── the game itself ─────────────
  useEffect(() => {
    const abort = new AbortController();
    setLoad({ status: 'loading' });
    setSession(null);
    setProgress({});
    setOpenedByHand(false);
    setMayOpenByHand(false);
    tryToken.current += 1;
    getGame(gameId, { signal: abort.signal })
      .then((loaded) => {
        if (!abort.signal.aborted) setLoad({ status: 'ready', record: loaded });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setLoad({ status: isApiError(error) && error.status === 404 ? 'notFound' : 'error' });
      });
    getStudent({ signal: abort.signal })
      .then((student) => {
        if (!abort.signal.aborted) setProfile(student);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [gameId, reloadKey]);

  // ───────────── the written review: poll while it is being generated (max ~60 s) ─────────────
  useEffect(() => {
    const abort = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setReviewState({ status: 'waiting', review: null });

    const tick = async () => {
      try {
        const review = await getGameReview(gameId, { signal: abort.signal });
        if (abort.signal.aborted) return;
        if (review.status !== 'pending') {
          setReviewState({ status: 'done', review });
        } else if (shouldKeepPolling(review.status, Date.now() - startedAt)) {
          setReviewState({ status: 'waiting', review });
          timer = setTimeout(() => void tick(), REVIEW_POLL_INTERVAL_MS);
        } else {
          setReviewState({ status: 'gaveUp', review });
        }
      } catch {
        if (!abort.signal.aborted) setReviewState({ status: 'gaveUp', review: null });
      }
    };
    void tick();
    return () => {
      abort.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [gameId, reloadKey]);

  useEffect(
    () => () => {
      coach.clearAnnotations();
      tryToken.current += 1;
      evaluatorRef.current?.dispose();
      evaluatorRef.current = null;
    },
    [],
  );

  // ───────────── derived model ─────────────
  const model = useMemo(() => (record ? buildReviewModel(record) : null), [record]);
  const persona = record ? getPersona(record.personaId) : undefined;
  const moments = useMemo<ResolvedMoment[]>(() => (record ? record.summary.keyMoments.map((m) => resolveMoment(m, record.judgements)) : []), [record]);
  const rows = useMemo(() => (model ? toMoveRows(model.moves) : []), [model]);

  useEffect(() => {
    if (!model || !record) return;
    dispatch({ type: 'reset', length: model.moves.length, cursor: 0 });
    if (greetedGame.current === record.id) return; // StrictMode runs effects twice in dev
    greetedGame.current = record.id;
    const count = record.summary.keyMoments.length;
    const text =
      count > 0
        ? `Давай посмотрим партию! Я отметил ${count} ${pluralRu(count, 'интересный момент', 'интересных момента', 'интересных моментов')}. Попробуешь найти ходы сильнее?`
        : 'Давай посмотрим партию! Листай ходы стрелками.';
    void coach.say(makeLocalEvent({ kind: 'reviewMoment', priority: 1, pose: 'wave', text }));
  }, [model, record]);

  // ───────────── navigation ─────────────
  useEffect(() => {
    if (!model || session !== null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
      if (document.querySelector('dialog[open]')) return;
      const action = keyToNavAction(event.key);
      if (!action) return;
      event.preventDefault();
      dispatch(action);
      coach.noteActivity();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [model, session]);

  useEffect(() => {
    currentMoveRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    // arrows drawn for one position must not reappear on another
    setExtraMarks((marks) => (marks && marks.cursor !== nav.cursor ? null : marks));
  }, [nav.cursor]);

  const goto = useCallback((cursor: number) => {
    tryToken.current += 1;
    setSession(null);
    dispatch({ type: 'goto', cursor });
    coach.noteActivity();
  }, []);

  // ───────────── key moments: solve first, then show ─────────────
  const activeMoment = session ? (moments[session.index] ?? null) : null;
  const openIndex = session?.index ?? null;
  const untouchedTasks = untouchedTaskCount(moments, progress);
  const answersOpen = answersUnlocked(untouchedTasks, openedByHand);

  useEffect(() => {
    if (openIndex !== null) momentPanelRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [openIndex]);

  // «Показать ответ» for a child who is stuck WITHOUT trying: only after 20 s with the task open
  const searchingIndex = session !== null && session.outcome === null ? session.index : null;
  useEffect(() => {
    if (searchingIndex === null) return;
    const timer = setTimeout(() => setSession((prev) => (prev && prev.index === searchingIndex ? { ...prev, answerOffered: true } : prev)), SHOW_ANSWER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchingIndex]);

  // the same pause before a grown-up may open the written review over untouched tasks
  useEffect(() => {
    if (!record) return;
    const timer = setTimeout(() => setMayOpenByHand(true), SHOW_ANSWER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [record]);

  /** 'found' / 'revealed' are final; a later miss never downgrades them. */
  const markProgress = useCallback((index: number, value: MomentProgress) => {
    setProgress((prev) => {
      const known = prev[index];
      if (known === value || known === 'found' || (known === 'revealed' && value === 'tried')) return prev;
      return { ...prev, [index]: value };
    });
  }, []);

  const reveal = useCallback(
    (resolved: ResolvedMoment, outcome: 'found' | 'revealed', solved: { fen: string; from: Square; to: Square; san: string } | null, feedback: string | null, alternative = false) => {
      const index = sessionRef.current?.index;
      setSession((prev) => (prev ? { ...prev, outcome, solvedFen: solved?.fen ?? null, shownMove: solved ? { from: solved.from, to: solved.to } : null, feedback, checking: false, hintShown: false } : prev));
      if (index !== undefined) markProgress(index, outcome);
      if (outcome === 'found') playSound('star');
      void coach.say(buildReviewMomentEvent(resolved, outcome, Math.random, alternative && solved ? solved : undefined));
    },
    [markProgress],
  );

  const openMoment = useCallback(
    (index: number) => {
      const resolved = moments[index];
      if (!resolved || !model) return;
      coach.noteActivity();
      tryToken.current += 1;
      setSession({
        index,
        tries: 0,
        feedback: null,
        outcome: resolved.isProud ? 'revealed' : null,
        solvedFen: null,
        shownMove: null,
        checking: false,
        hintShown: false,
        answerOffered: canShowAnswer(0, 0),
      });
      if (resolved.isProud) {
        void coach.say(buildReviewMomentEvent(resolved, 'revealed'));
        return;
      }
      // warm the judge engine up while the child looks at the position: the first try is then answered quickly
      evaluatorRef.current ??= createBrowserTryEvaluator();
      evaluatorRef.current.prepare(resolved.moment.fenBefore);
    },
    [model, moments],
  );

  /** A try that was not accepted: costs one of the three tries; after the last one the answer is shown. */
  const settleMiss = useCallback(
    (resolved: ResolvedMoment, verdict: TryVerdict) => {
      const current = sessionRef.current;
      if (!current || current.outcome !== null) return;
      const tries = current.tries + 1;
      const left = MAX_MOMENT_TRIES - tries;
      setShakeKey((key) => key + 1);
      markProgress(current.index, 'tried');
      const next: MomentSession = { ...current, tries, checking: false, solvedFen: null, shownMove: null, answerOffered: true };
      if (left <= 0) {
        setSession(next);
        reveal(resolved, 'revealed', null, tryFeedbackRu(verdict, 0));
      } else {
        setSession({ ...next, feedback: tryFeedbackRu(verdict, left) });
      }
    },
    [markProgress, reveal],
  );

  const handleTry = useCallback(
    (move: MiniBoardMove): boolean => {
      if (!session || !activeMoment || session.outcome !== null || session.checking) return false;
      coach.noteActivity();
      const verdict = judgeTry(activeMoment, move.uci);
      if (verdict === 'illegal') return false;
      const applied = applyUci(activeMoment.moment.fenBefore, move.uci);
      if (!applied) return false;
      const solved = { fen: applied.fenAfter, from: applied.from, to: applied.to, san: applied.san };
      if (isCorrectVerdict(verdict)) {
        reveal(activeMoment, 'found', solved, tryFeedbackRu(verdict, 0));
        return true;
      }
      if (verdict !== 'other' || evaluatorRef.current === null) {
        settleMiss(activeMoment, verdict);
        return false;
      }
      // Not the recorded best move — but maybe just as good. The judge engine decides; the piece waits on its new square.
      const token = ++tryToken.current;
      setSession({ ...session, checking: true, solvedFen: applied.fenAfter, shownMove: { from: applied.from, to: applied.to }, feedback: 'Хм, интересно! Проверяю этот ход…', hintShown: false });
      void evaluatorRef.current.evaluate(activeMoment.moment.fenBefore, applied.uci).then((evaluation) => {
        if (tryToken.current !== token) return; // the task was closed or changed meanwhile
        const refined = refineVerdict(verdict, evaluation, activeMoment.judgement);
        if (isCorrectVerdict(refined)) reveal(activeMoment, 'found', solved, tryFeedbackRu(refined, 0), true);
        else settleMiss(activeMoment, refined);
      });
      return true;
    },
    [activeMoment, reveal, session, settleMiss],
  );

  const showHint = useCallback(() => {
    if (!activeMoment || !hintAnnotations(activeMoment)) return;
    coach.noteActivity();
    setSession((prev) => (prev && prev.outcome === null ? { ...prev, hintShown: true } : prev));
    void coach.say(makeLocalEvent({ kind: 'hint', priority: 1, pose: 'think', text: 'Посмотри на эту фигуру. Куда она может пойти с пользой?' }));
  }, [activeMoment]);

  const closeMoment = useCallback(() => {
    if (activeMoment && model) {
      const cursor = cursorOfPosition(model, activeMoment.moment.fenBefore);
      if (cursor >= 0) dispatch({ type: 'goto', cursor });
    }
    tryToken.current += 1;
    setSession(null);
  }, [activeMoment, model]);

  // ───────────── render: loading / errors ─────────────
  if (load.status !== 'ready' || !record || !model) {
    return (
      <Screen title="Разбор партии" onBack={onExit}>
        {load.status === 'loading' ? (
          <div className={styles.center}>
            <Spinner size={64} label="Открываю партию…" showLabel />
          </div>
        ) : (
          <Card tone="tint" padding="lg" className={styles.notice}>
            <h2>{load.status === 'notFound' ? 'Такой партии нет' : 'Партия не открылась'}</h2>
            <p>{load.status === 'notFound' ? 'Наверное, она ещё не сохранилась. Сыграй новую — и мы её разберём!' : 'Похоже, шахматный сервер сейчас не отвечает.'}</p>
            <div className={styles.noticeActions}>
              {load.status === 'error' ? (
                <Button size="lg" icon={<Icon name="refresh" />} onClick={() => setReloadKey((k) => k + 1)}>
                  Попробовать ещё
                </Button>
              ) : null}
              <Button size="lg" variant="secondary" onClick={onExit}>
                Назад
              </Button>
            </div>
          </Card>
        )}
      </Screen>
    );
  }

  // ───────────── render: board state ─────────────
  const outcome = childOutcome(record.result, record.childColor);
  const current = boardAt(model, nav.cursor);
  const upcoming = model.moves[nav.cursor] ?? null;
  const inMoment = session !== null && activeMoment !== null;
  const searching = inMoment && session.outcome === null;

  let boardFen = current.fen;
  let boardLastMove = current.lastMove;
  let annotations: BoardAnnotations | null = extraMarks && extraMarks.cursor === nav.cursor ? extraMarks.annotations : null;
  if (inMoment) {
    boardFen = session.solvedFen ?? activeMoment.moment.fenBefore;
    boardLastMove = session.solvedFen ? session.shownMove : null;
    annotations = session.outcome === 'revealed' ? revealAnnotations(activeMoment) : searching && session.hintShown && !session.checking ? hintAnnotations(activeMoment) : null;
  }

  const judged = current.move?.judgement;
  /** the move under the cursor is itself a task the child has not tried yet: its answer must not be one click away */
  const taskIndexOfCurrent = judged
    ? moments.findIndex((resolved, index) => !resolved.isProud && progress[index] === undefined && resolved.judgement === judged)
    : -1;
  const practice = onStartPuzzles ? suggestPractice(record, reviewState.review?.suggestedTheme) : null;
  const momentCard = inMoment && session.outcome !== null ? conceptCardForMoment(activeMoment.moment) : null;
  /** the child's own good move was accepted although the engine prefers another one */
  const foundAlternative =
    inMoment && session.outcome === 'found' && session.shownMove !== null && activeMoment.best !== null && (session.shownMove.from !== activeMoment.best.from || session.shownMove.to !== activeMoment.best.to);
  const accuracy = record.judgements.length > 0 ? Math.round(record.summary.accuracy) : null;

  const showBestOfCurrent = () => {
    if (!current.move || !judged) return;
    const best = applyUci(judged.fenBefore, judged.bestUci);
    if (!best) return;
    // the best move belongs to the position BEFORE the played move
    dispatch({ type: 'goto', cursor: nav.cursor - 1 });
    setExtraMarks({
      cursor: nav.cursor - 1,
      annotations: { arrows: [{ from: current.move.from, to: current.move.to, color: 'red' }, { from: best.from, to: best.to, color: 'green' }], highlights: [] },
    });
  };

  const showTimelineItem = (item: TimelineItem) => {
    goto(item.cursor);
    const j = 'judgement' in item ? item.judgement : undefined;
    const attempted = j ? applyUci(j.fenBefore, j.uci) : null;
    setExtraMarks(attempted && item.kind === 'takenBack' ? { cursor: item.cursor, annotations: { arrows: [{ from: attempted.from, to: attempted.to, color: 'red' }], highlights: [] } } : null);
  };

  const written = reviewState.review && reviewState.review.markdown.trim() !== '' ? reviewState.review : null;
  const fallbackMarkdown = !written && reviewState.status !== 'waiting' && persona ? buildTemplateReview(record, persona, profile ?? FALLBACK_PROFILE) : null;

  const renderMove = (move: ReviewMove | null) => {
    if (!move) return <span className={styles.moveEmpty}>…</span>;
    const j = move.judgement;
    const active = nav.cursor === move.ply && !inMoment;
    return (
      <button
        type="button"
        ref={active ? currentMoveRef : undefined}
        className={cx(styles.move, active && styles.moveActive)}
        data-tone={j ? CLASS_TONE[j.classification] : undefined}
        aria-current={active ? 'step' : undefined}
        title={j ? moveClassLabelRu(j.classification) : undefined}
        onClick={() => goto(move.ply)}
      >
        <span>{sanToBubbleRu(move.san)}</span>
        {j && CLASS_MARK[j.classification] !== '' ? (
          <span className={styles.mark} aria-label={moveClassLabelRu(j.classification)}>
            {CLASS_MARK[j.classification]}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <Screen
      title="Разбор партии"
      subtitle={`${persona ? `Соперник: ${persona.name}` : 'Партия'} · ${formatDateRu(record.startedAt)} · ${TIME_CONTROLS[record.timeControlId].label}`}
      onBack={onExit}
      width="wide"
      className={styles.screen}
    >
      <div className={styles.layout} data-solving={searching || undefined}>
        {/* ───────── board column ───────── */}
        <div className={styles.boardColumn}>
          <MiniBoard
            id="review-board"
            fen={boardFen}
            orientation={record.childColor}
            interactive={searching && !session.checking}
            onMove={handleTry}
            lastMove={boardLastMove}
            annotations={annotations}
            shakeKey={shakeKey}
            maxSize={600}
            label="Доска разбора"
          />

          {inMoment ? null : (
            <>
              <div className={styles.navRow} role="group" aria-label="Листать ходы">
                <Button variant="secondary" size="lg" aria-label="В начало" icon={<Icon name="back" />} disabled={!canGoBack(nav)} onClick={() => dispatch({ type: 'first' })} className={styles.navEdge} />
                <Button variant="primary" size="xl" icon={<Icon name="back" />} disabled={!canGoBack(nav)} onClick={() => dispatch({ type: 'prev' })}>
                  Назад
                </Button>
                <Button variant="primary" size="xl" iconAfter={<Icon name="forward" />} disabled={!canGoForward(nav)} onClick={() => dispatch({ type: 'next' })}>
                  Вперёд
                </Button>
                <Button variant="secondary" size="lg" aria-label="В конец" icon={<Icon name="forward" />} disabled={!canGoForward(nav)} onClick={() => dispatch({ type: 'last' })} className={styles.navEdge} />
              </div>
              <p className={styles.currentMove} role="status" aria-live="polite">
                {current.move ? (
                  <>
                    <strong>
                      {current.move.moveNumber}
                      {current.move.color === 'w' ? '.' : '…'} {sanToBubbleRu(current.move.san)}
                    </strong>
                    {judged ? (
                      <Badge tone={TONE_BADGE[CLASS_TONE[judged.classification]]}>
                        {moveClassLabelRu(judged.classification)} {CLASS_MARK[judged.classification]}
                      </Badge>
                    ) : (
                      <span className={styles.muted}>{current.move.byChild ? '' : `ход соперника`}</span>
                    )}
                    {taskIndexOfCurrent >= 0 ? (
                      <Button variant="ghost" size="md" icon={<Icon name="bulb" />} onClick={() => openMoment(taskIndexOfCurrent)}>
                        Найди ход лучше!
                      </Button>
                    ) : judged && judged.bestUci !== judged.uci && CLASS_TONE[judged.classification] !== 'great' && CLASS_TONE[judged.classification] !== 'fine' ? (
                      <Button variant="ghost" size="md" icon={<Icon name="bulb" />} onClick={showBestOfCurrent}>
                        Какой ход сильнее?
                      </Button>
                    ) : null}
                  </>
                ) : upcoming ? (
                  <span className={styles.muted}>Начало партии. Листай ходы кнопками или стрелками ← →</span>
                ) : (
                  <span className={styles.muted}>В этой партии нет ходов.</span>
                )}
              </p>
            </>
          )}
        </div>

        {/* ───────── side column ───────── */}
        <div className={styles.side}>
          {inMoment ? (
            <Card ref={momentPanelRef} tone={session.outcome === 'found' ? 'green' : 'sunny'} padding="md" className={styles.momentPanel} as="section" aria-label="Задание">
              <p className={styles.momentCaption}>{momentCaptionRu(activeMoment)}</p>
              <h2 className={styles.momentTitle}>
                {activeMoment.isProud ? 'Твой сильный ход!' : session.outcome === null ? 'Найди ход лучше!' : session.outcome === 'found' ? 'Нашёлся!' : 'Вот ход сильнее'}
              </h2>
              {searching ? (
                <p className={styles.momentText}>
                  В партии было сыграно <strong>{sanToBubbleRu(activeMoment.moment.playedSan)}</strong>. Сделай на доске ход сильнее.
                </p>
              ) : null}
              <p className={styles.momentFeedback} role="status" aria-live="polite">
                {session.feedback ?? ''}
              </p>
              {session.outcome !== null ? (
                <>
                  {!activeMoment.isProud ? (
                    <p className={styles.momentText}>
                      {foundAlternative ? 'Компьютеру больше всего нравится ' : session.outcome === 'found' ? 'Лучший ход — ' : 'Сильнее было '}
                      <strong>{`${activeMoment.moveLabel} ${sanToBubbleRu(activeMoment.best?.san ?? activeMoment.moment.bestSan)}`}</strong>
                    </p>
                  ) : null}
                  <p className={styles.momentText}>{activeMoment.moment.explanation}</p>
                  {momentCard ? (
                    <Button variant="accent" size="md" icon={<Icon name="bulb" />} onClick={() => setCard(momentCard)} className={styles.momentCardLink}>
                      Карточка: {momentCard.title}
                    </Button>
                  ) : null}
                </>
              ) : (
                <p className={styles.tries} aria-label={`Осталось попыток: ${MAX_MOMENT_TRIES - session.tries}`}>
                  {Array.from({ length: MAX_MOMENT_TRIES }, (_, i) => (
                    <span key={i} className={styles.tryDot} data-used={i < session.tries || undefined} />
                  ))}
                </p>
              )}
              <div className={styles.momentActions}>
                {searching ? (
                  <>
                    {!session.hintShown && hintAnnotations(activeMoment) ? (
                      <Button variant="accent" size="lg" icon={<Icon name="bulb" />} disabled={session.checking} onClick={showHint}>
                        Подсказка
                      </Button>
                    ) : null}
                    {/* solve first: the answer is offered only after a real try — or 20 s for a child who is stuck */}
                    {session.answerOffered || canShowAnswer(session.tries, 0) ? (
                      <Button variant="secondary" size="lg" disabled={session.checking} onClick={() => reveal(activeMoment, 'revealed', null, null)}>
                        Показать ответ
                      </Button>
                    ) : null}
                  </>
                ) : session.index + 1 < moments.length ? (
                  <Button size="lg" iconAfter={<Icon name="forward" />} onClick={() => openMoment(session.index + 1)}>
                    Следующий момент
                  </Button>
                ) : null}
                <Button variant={!searching && session.index + 1 >= moments.length ? 'primary' : 'ghost'} size="lg" onClick={closeMoment}>
                  К партии
                </Button>
              </div>
            </Card>
          ) : null}

          <Card padding="md" as="section" className={styles.summary} aria-label="Итог партии">
            <div className={styles.summaryHead}>
              {persona ? <PersonaAvatar persona={persona} size={72} mood={outcome === 'loss' ? 'happy' : 'neutral'} /> : null}
              <div>
                <h2 className={styles.outcome}>{OUTCOME_TITLE[outcome]}</h2>
                <p className={styles.muted}>
                  Ты играешь {record.childColor === 'w' ? 'белыми' : 'чёрными'}
                  {record.examMode ? ' · экзамен без подсказок' : ''}
                </p>
              </div>
            </div>
            {accuracy !== null ? (
              <ProgressBar value={accuracy} label="Точность ходов" valueText={`${accuracy}%`} tone={accuracy >= 80 ? 'green' : accuracy >= 60 ? 'teal' : 'sunny'} size="lg" />
            ) : (
              <p className={styles.muted}>Ходов для оценки точности пока мало.</p>
            )}
            <div className={styles.counts}>
              {COUNT_ORDER.filter((cls) => record.summary.counts[cls] > 0).map((cls) => (
                <Badge key={cls} tone={TONE_BADGE[CLASS_TONE[cls]]}>
                  {CLASS_MARK[cls]} {record.summary.counts[cls]} {pluralRu(record.summary.counts[cls], ...COUNT_LABEL[cls])}
                </Badge>
              ))}
            </div>
            {record.summary.takebacksOffered > 0 || record.summary.hintsUsed > 0 ? (
              <p className={styles.muted}>
                {record.summary.takebacksOffered > 0 ? `Возвратов хода: ${record.summary.takebacksAccepted} из ${record.summary.takebacksOffered}. ` : ''}
                {record.summary.hintsUsed > 0 ? `Подсказок: ${record.summary.hintsUsed}.` : ''}
              </p>
            ) : null}
          </Card>

          {moments.length > 0 ? (
            <Card padding="md" as="section" title="Интересные моменты" className={styles.moments}>
              <ul className={styles.momentList}>
                {moments.map((resolved, index) => (
                  <li key={`${resolved.moment.ply}-${index}`}>
                    <button type="button" className={cx(styles.momentCard, session?.index === index && styles.momentCardActive)} data-proud={resolved.isProud || undefined} onClick={() => openMoment(index)}>
                      <span className={styles.momentIcon} aria-hidden="true">
                        <Icon name={resolved.isProud ? 'star' : 'bulb'} />
                      </span>
                      <span className={styles.momentCardText}>
                        <span className={styles.momentCardTitle}>{resolved.isProud ? 'Твой сильный ход' : 'Найди ход лучше!'}</span>
                        <span className={styles.muted}>{momentCaptionRu(resolved)}</span>
                      </span>
                      <Icon name="forward" />
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card padding="md" as="section" title="Ходы партии">
            {rows.length === 0 ? (
              <p className={styles.muted}>Ходов нет.</p>
            ) : (
              <ol className={styles.moveList}>
                {rows.map((row, i) => (
                  <li key={i} className={styles.moveRow}>
                    <span className={styles.moveNumber}>{row.moveNumber}.</span>
                    {renderMove(row.white)}
                    {renderMove(row.black)}
                  </li>
                ))}
              </ol>
            )}
            <p className={styles.legend}>★ лучший · ✓ отличный · ?! неточность · ? ошибка · ?? зевок · ◇ упущенный шанс. Оцениваются только твои ходы.</p>
          </Card>

          {model.timeline.length > 0 ? (
            <Card padding="md" as="section" title="Что было в партии">
              <ul className={styles.timeline}>
                {model.timeline.map((item) => (
                  <li key={item.id}>
                    <button type="button" className={styles.timelineItem} data-kind={item.kind} onClick={() => showTimelineItem(item)}>
                      <span className={styles.timelineIcon} aria-hidden="true">
                        <Icon name={item.kind === 'takenBack' ? 'undo' : item.kind === 'hint' ? 'bulb' : item.kind === 'childSaid' ? 'mic' : 'flag'} />
                      </span>
                      <span>
                        {item.kind === 'takenBack' ? (
                          <>
                            Ход <strong>{sanToBubbleRu(item.san)}</strong> возвращён{item.improved ? ' — и найден ход лучше. Вот это работа головой!' : ' — было время подумать ещё раз.'}
                          </>
                        ) : item.kind === 'keptMove' ? (
                          <>
                            Гамбитик предлагал вернуть ход <strong>{sanToBubbleRu(item.san)}</strong>, ход оставлен.
                          </>
                        ) : item.kind === 'hint' ? (
                          <>Подсказка{item.level !== null ? ` (ступенька ${item.level} из 4)` : ''}</>
                        ) : (
                          <>Ты: «{item.text}»</>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card padding="md" as="section" title="Разбор от тренера">
            {/* under the title, not beside it: the story column is only ~300 px wide on an iPad-like window */}
            {written && answersOpen ? <p className={styles.provider}>{PROVIDER_LABEL[written.provider]}</p> : null}
            {!answersOpen ? (
              <div className={styles.reviewLocked}>
                <p>
                  Сначала попробуй сам! В разборе есть ответы — он откроется, когда ты попробуешь{' '}
                  {untouchedTasks === 1 ? 'интересный момент' : `интересные моменты (осталось: ${untouchedTasks})`}.
                </p>
                {mayOpenByHand ? (
                  <Button variant="ghost" size="md" onClick={() => setOpenedByHand(true)}>
                    Открыть разбор сейчас
                  </Button>
                ) : null}
              </div>
            ) : written ? (
              <Markdown source={written.markdown} />
            ) : reviewState.status === 'waiting' ? (
              <div className={styles.reviewWaiting}>
                <Spinner size={40} label="Гамбитик пишет разбор…" showLabel />
              </div>
            ) : fallbackMarkdown !== null ? (
              <>
                <p className={styles.muted}>Подробный разбор ещё готовится — загляни сюда позже. А пока короткий:</p>
                <Markdown source={fallbackMarkdown} />
              </>
            ) : (
              <p className={styles.muted}>Разбор пока не готов. Загляни сюда чуть позже.</p>
            )}
          </Card>

          {practice && answersOpen ? (
            <Card padding="md" as="section" tone="tint" title="Что потренировать" className={styles.practice}>
              <p>
                Гамбитик советует задачи на тему <strong>«{practice.title}»</strong> — она встретилась в этой партии.
              </p>
              <Button size="md" block icon={<Icon name="play" />} onClick={() => onStartPuzzles?.(practice.theme)}>
                Потренировать
              </Button>
            </Card>
          ) : null}
        </div>
      </div>

      <ConceptCardModal card={card} onClose={() => setCard(null)} />
    </Screen>
  );
}
