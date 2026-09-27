/**
 * GameScreen — the live game against a bot persona with the coach watching (ARCHITECTURE §2, §5, §6).
 *
 * Layout: opponent strip · board · child strip on the left; status, take-back choice, move list and the two
 * buttons on the right. The bottom-right corner stays free for the global <MascotDock/> (rendered by the shell).
 * All game logic lives in gameStore.ts; this file only renders its state and forwards clicks.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useStore } from 'zustand';
import { PERSONAS } from '@gambit/content';
import { TAKEBACK_DECLINE_REASONS, childOutcome, declineReasonLabelRu, sanToBubbleRu } from '@gambit/core';
import { TIME_CONTROLS } from '@gambit/shared';
import type { BoardAnnotations, CoachStyle, Color, Persona, PersonaId, PieceType, TimeControlId } from '@gambit/shared';
import { useCoachStore } from '../../coach/index.ts';
import { SoundToggle } from '../../coach/SoundToggle.tsx';
import { ThoughtChips } from '../../coach/clips/ThoughtChips.tsx';
import { registerDevHook } from '../../devHook.ts';
import { BOARD_THEMES, Badge, Button, Card, Icon, Modal, PersonaAvatar, ProgressBar, Spinner, Stars, cx, pluralRu, setSoundDucked } from '../../ui/index.ts';
import type { BoardThemeId } from '../../ui/index.ts';
import { capturedFromFen } from './captured.ts';
import { PieceIcon } from '../../ui/pieces/index.ts';
import { formatClock } from './clock.ts';
import { createBrowserGameDeps } from './gameDeps.ts';
import { createGameController } from './gameStore.ts';
import type { GameController } from './gameStore.ts';
import { CHILD_NOTE_MAX_CHARS, CHILD_NOTE_QUESTION_RU } from './gameTypes.ts';
import type { GameCoachStyle, GameState, MoveEntry } from './gameTypes.ts';
import { QuizCard } from './QuizCard.tsx';
import { clearResumableGame, resumableGame } from './resume.ts';
import type { ResumableGame } from './resume.ts';
import { browserStorage } from './storage.ts';
import { TrainerBoard } from './TrainerBoard.tsx';
import styles from './GameScreen.module.css';

export interface GameScreenProps {
  personaId: PersonaId;
  timeControlId: TimeControlId;
  childColor: Color;
  examMode: boolean;
  /**
   * How the coach helps (docs/TEACHER-MODE.md §1). Absent (an old route without `coach=`): «Экзамен» when `examMode`,
   * else the default for the time control and the child's stage (`defaultCoachStyle`, resolved once the profile is in).
   */
  coachStyle?: CoachStyle;
  onExit(gameId?: string): void;
}

/** The style the game controller is asked for: the route's, else what `examMode` says, else the stage default. */
export function requestedCoachStyle(props: Pick<GameScreenProps, 'coachStyle' | 'examMode'>): GameCoachStyle {
  return props.coachStyle ?? (props.examMode ? 'exam' : 'auto');
}

/** «Ещё партию» remounts the whole session (fresh engines, fresh journal) with the same settings. */
export function GameScreen(props: GameScreenProps): ReactElement {
  const [round, setRound] = useState(0);
  return <GameSession key={round} {...props} onRematch={() => setRound((n) => n + 1)} />;
}

interface SessionProps extends GameScreenProps {
  onRematch(): void;
}

function GameSession(props: SessionProps): ReactElement {
  const { onExit, onRematch } = props;
  const [game, setGame] = useState<GameController | null>(null);
  // An interrupted game (closed tab, reload, «Назад» in the middle) is offered first: «Продолжить партию?»
  const [interrupted] = useState<ResumableGame | null>(() => resumableGame(browserStorage()));
  const [choice, setChoice] = useState<'ask' | 'resume' | 'new'>(interrupted ? 'ask' : 'new');

  // a continued game keeps its own settings, whatever the route says
  const resume = choice === 'resume' ? interrupted : null;
  const { personaId, timeControlId, childColor, examMode } = resume ? resume.config : props;
  const coachStyle = resume ? (resume.config.coachStyle ?? (resume.config.examMode ? 'exam' : 'helper')) : requestedCoachStyle(props);

  useEffect(() => {
    if (choice === 'ask') return undefined;
    // created in an effect (not during render): StrictMode's extra mount gets its own, properly disposed instance
    const controller = createGameController(createBrowserGameDeps());
    setGame(controller);
    // dev server only (e2e introspection) — compiled out of the production bundle
    const unregisterHook = import.meta.env.DEV ? registerDevHook('game', { state: () => controller.store.getState() }) : undefined;
    void controller.start({ personaId, timeControlId, childColor, examMode, coachStyle }, { resume });
    // the journal is written after every move anyway; this catches the last clock values when the page goes away
    const onHide = (): void => {
      controller.persistNow();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      unregisterHook?.();
      controller.dispose();
      setGame(null);
    };
  }, [choice, resume, personaId, timeControlId, childColor, examMode, coachStyle]);

  // sound effects step back while the mascot speaks or listens
  useEffect(() => {
    const apply = (): void => {
      const coachState = useCoachStore.getState();
      setSoundDucked(coachState.speaking || coachState.listening);
    };
    apply();
    const unsubscribe = useCoachStore.subscribe(apply);
    return () => {
      unsubscribe();
      setSoundDucked(false);
    };
  }, []);

  if (choice === 'ask' && interrupted) {
    return (
      <ResumePrompt
        interrupted={interrupted}
        onResume={() => setChoice('resume')}
        onNewGame={() => {
          // nothing is lost: the interrupted game goes to the journal as an unfinished one
          clearResumableGame(browserStorage());
          setChoice('new');
        }}
      />
    );
  }
  if (!game) return <Loading persona={PERSONAS[personaId]} onExit={() => onExit()} />;
  return <GameView game={game} personaId={personaId} timeControlId={timeControlId} childColor={childColor} examMode={examMode} onExit={onExit} onRematch={onRematch} />;
}

// ───────────────────────── «Продолжить партию?» ─────────────────────────

function ResumePrompt({ interrupted, onResume, onNewGame }: { interrupted: ResumableGame; onResume(): void; onNewGame(): void }): ReactElement {
  const persona = PERSONAS[interrupted.config.personaId];
  const fullMoves = Math.max(1, Math.ceil(interrupted.moves.length / 2));
  return (
    <div className={styles.loading}>
      <Modal
        open
        // not dismissible: one of the two buttons answers; a stray native 'close' must never pick for the child
        onClose={() => undefined}
        title="Продолжить партию?"
        icon={<PersonaAvatar persona={persona} size={96} mood="happy" />}
        dismissible={false}
        size="sm"
        actions={
          <>
            <Button variant="primary" size="lg" icon={<Icon name="forward" />} onClick={onResume}>
              Продолжить
            </Button>
            <Button variant="secondary" size="lg" onClick={onNewGame}>
              Новая партия
            </Button>
          </>
        }
      >
        <p className={styles.modalText}>
          Партия с соперником по имени {persona.name} не доиграна: {fullMoves} {pluralRu(fullMoves, 'ход', 'хода', 'ходов')} уже на доске. Я всё запомнил!
        </p>
      </Modal>
    </div>
  );
}

// ───────────────────────── helpers ─────────────────────────

function readBoardTheme(): BoardThemeId {
  try {
    const raw = browserStorage()?.getItem('gambit.settings');
    if (!raw) return 'mint';
    const parsed: unknown = JSON.parse(raw);
    const theme = typeof parsed === 'object' && parsed !== null && 'boardTheme' in parsed ? parsed.boardTheme : undefined;
    return typeof theme === 'string' && Object.hasOwn(BOARD_THEMES, theme) ? (theme as BoardThemeId) : 'mint';
  } catch {
    return 'mint';
  }
}

function mergeAnnotations(a: BoardAnnotations | null, b: BoardAnnotations | null): BoardAnnotations | null {
  if (!a) return b;
  if (!b) return a;
  const arrows = [...a.arrows];
  for (const arrow of b.arrows) if (!arrows.some((x) => x.from === arrow.from && x.to === arrow.to)) arrows.push(arrow);
  const highlights = [...a.highlights];
  for (const mark of b.highlights) if (!highlights.some((x) => x.square === mark.square)) highlights.push(mark);
  return { arrows, highlights };
}

function statusText(state: Pick<GameState, 'phase' | 'persona'>): string {
  switch (state.phase) {
    case 'idle':
      return 'Расставляю фигуры…';
    case 'childTurn':
      return 'Твой ход!';
    case 'judging':
      return 'Гамбитик смотрит на ход…';
    case 'coachIntervention':
      return 'Гамбитик просит подумать ещё';
    case 'botThinking':
      return `${state.persona?.name ?? 'Соперник'} думает…`;
    case 'gameOver':
      return 'Партия окончена';
  }
}

// ───────────────────────── loading ─────────────────────────

function Loading({ persona, onExit }: { persona: Persona; onExit(): void }): ReactElement {
  return (
    <div className={styles.loading}>
      <PersonaAvatar persona={persona} size={120} mood="happy" />
      <Spinner label="Расставляю фигуры…" showLabel />
      <Button variant="secondary" size="lg" icon={<Icon name="back" />} onClick={onExit}>
        Назад
      </Button>
    </div>
  );
}

// ───────────────────────── main view ─────────────────────────

interface ViewProps extends SessionProps {
  game: GameController;
}

function GameView({ game, personaId, timeControlId, childColor, examMode, onExit, onRematch }: ViewProps): ReactElement {
  const store = game.store;
  const phase = useStore(store, (s) => s.phase);
  const fen = useStore(store, (s) => s.fen);
  const turn = useStore(store, (s) => s.turn);
  const moves = useStore(store, (s) => s.moves);
  const lastMove = useStore(store, (s) => s.lastMove);
  const checkSquare = useStore(store, (s) => s.checkSquare);
  const selected = useStore(store, (s) => s.selected);
  const legalTargets = useStore(store, (s) => s.legalTargets);
  const pendingPromotion = useStore(store, (s) => s.pendingPromotion);
  const gameAnnotations = useStore(store, (s) => s.annotations);
  const takeback = useStore(store, (s) => s.takeback);
  const botBubble = useStore(store, (s) => s.botBubble);
  const persona = useStore(store, (s) => s.persona) ?? PERSONAS[personaId];
  const profile = useStore(store, (s) => s.profile);
  const openingName = useStore(store, (s) => s.openingName);
  const judgeUnavailable = useStore(store, (s) => s.judgeUnavailable);
  const botUnavailable = useStore(store, (s) => s.botUnavailable);
  const declineReasons = useStore(store, (s) => s.declineReasons);
  const teacher = useStore(store, (s) => s.coachStyle === 'teacher');
  const teachMode = useStore(store, (s) => s.teachMode);
  // «Учитель» (docs/TEACHING.md §2.4, §4.6): the lesson's question card and the theme of the game
  const quiz = useStore(store, (s) => s.quiz);
  const themeBadge = useStore(store, (s) => s.themeBadge);
  const coachAnnotations = useCoachStore((s) => s.annotations);

  const [resignOpen, setResignOpen] = useState(false);
  const [themeId] = useState(readBoardTheme);
  const annotations = useMemo(() => mergeAnnotations(gameAnnotations, coachAnnotations), [gameAnnotations, coachAnnotations]);
  const captured = useMemo(() => capturedFromFen(fen), [fen]);
  const timeControl = TIME_CONTROLS[timeControlId];
  const botColor: Color = childColor === 'w' ? 'b' : 'w';
  const over = phase === 'gameOver';
  const playing = phase !== 'idle' && !over;
  const childDiff = childColor === 'w' ? captured.diff : -captured.diff;
  // the question with three buttons: the top of the panel — on a narrow screen above the board (never under the bubble)
  const quizCard = (placement: 'panel' | 'narrow'): ReactElement | null =>
    quiz && !over && !takeback ? <QuizCard key={quiz.id} quiz={quiz} onAnswer={(id) => game.answerQuiz(id)} className={placement === 'panel' ? styles.wideOnly : undefined} /> : null;

  const openResign = (): void => {
    game.setModalOpen(true);
    setResignOpen(true);
  };
  const closeResign = (): void => {
    setResignOpen(false);
    game.setModalOpen(false);
  };
  const confirmResign = (): void => {
    closeResign();
    game.resign();
  };

  // the game can end (flag, mate) while the dialog is open
  useEffect(() => {
    if (over && resignOpen) {
      setResignOpen(false);
      game.setModalOpen(false);
    }
  }, [over, resignOpen, game]);

  return (
    <div className={styles.screen} data-phase={phase}>
      <div className={styles.boardColumn}>
        <PlayerStrip
          side="bot"
          name={persona.name}
          detail={`рейтинг ${persona.nominalElo}`}
          avatar={<PersonaAvatar persona={persona} size={64} mood={over ? 'happy' : 'neutral'} />}
          active={playing && turn === botColor}
          lost={captured.lost[childColor]}
          lostColor={childColor}
          advantage={-childDiff}
          clock={<ClockFace game={game} color={botColor} timed={timeControl.initialMs !== null} />}
          bubble={botBubble ? { text: botBubble.text, onDismiss: over ? undefined : () => game.dismissBotBubble() } : null}
        />

        {/* narrow windows (≤ 899 px, the panel goes below the board): the sound switch and the question above the board */}
        <div className={styles.narrowTop}>
          {quizCard('narrow')}
          <SoundToggle size="md" className={styles.soundToggle} />
        </div>

        <div className={styles.boardArea}>
          <TrainerBoard
            fen={fen}
            orientation={childColor}
            childColor={childColor}
            interactive={phase === 'childTurn'}
            lastMove={lastMove}
            checkSquare={checkSquare}
            selected={selected}
            legalTargets={legalTargets}
            annotations={annotations}
            pendingPromotion={pendingPromotion}
            dimmed={phase === 'coachIntervention'}
            themeId={themeId}
            onSquareClick={(square) => game.selectSquare(square)}
            onDragStart={(square) => game.beginDrag(square)}
            onDrop={(from, to) => game.dropPiece(from, to)}
            onPromotion={(piece) => game.choosePromotion(piece)}
          />
        </div>

        <PlayerStrip
          side="child"
          name={profile?.nickname ?? 'Ты'}
          detail={childColor === 'w' ? 'белые' : 'чёрные'}
          avatar={
            <span className={styles.childBadge} data-color={childColor} aria-hidden="true">
              <PieceIcon code={`${childColor}P`} size="1.4em" label="" />
            </span>
          }
          active={playing && turn === childColor}
          lost={captured.lost[botColor]}
          lostColor={botColor}
          advantage={childDiff}
          clock={<ClockFace game={game} color={childColor} timed={timeControl.initialMs !== null} />}
          bubble={null}
        />
      </div>

      <aside className={styles.panel} aria-label="Партия">
        <div className={styles.panelHead}>
          {/* after the game the result card carries the headline; during a take-back offer the sunny card does */}
          <p className={cx(styles.status, (over || takeback !== null) && styles.srOnly)} role="status" aria-live="polite" data-phase={phase}>
            {statusText({ phase, persona })}
          </p>
          <div className={styles.tags}>
            <Badge tone="teal" size="sm" icon={<Icon name="clock" />}>
              {timeControl.label}
            </Badge>
            {examMode ? (
              <Badge tone="sunny" size="sm">
                Экзамен: без подсказок
              </Badge>
            ) : null}
            {teacher ? (
              <Badge tone="sunny" size="sm" icon={<Icon name="bulb" />}>
                Учитель
              </Badge>
            ) : null}
            {/* the theme of the game (stages 3–5 the opening's name, 1–2 its idea in two words) — a label, never spoken */}
            {teacher && themeBadge ? (
              <Badge tone="teal" size="sm" icon={<Icon name="star" />}>
                Тема: {themeBadge}
              </Badge>
            ) : null}
            {/* the big «Звук вкл / выкл» (voice and move sounds together, until midnight) */}
            <SoundToggle size="md" className={cx(styles.soundToggle, styles.wideOnly)} />
          </div>
        </div>

        {quizCard('panel')}

        {/* Order matters: everything a child has to PRESS sits at the top of the panel. Гамбитик's speech bubble
            grows upwards from the bottom-right corner and may briefly cover the move list — never a button. */}
        {takeback ? (
          <Card tone="sunny" padding="md" className={styles.takeback} role="group" aria-label="Вернуть ход?">
            <p className={styles.takebackTitle}>Вернём ход {sanToBubbleRu(takeback.san)}?</p>
            <Button variant="primary" size="xl" block icon={<Icon name="undo" />} className={styles.choice} onClick={() => game.acceptTakeback()}>
              Верну ход и подумаю
            </Button>
            <Button variant="secondary" size="lg" block className={styles.choice} onClick={() => game.declineTakeback()}>
              Оставлю свой ход
            </Button>
          </Card>
        ) : null}

        {/* «почему?» after «Оставлю свой ход»: three taps instead of typing; it never blocks the game and goes away by itself */}
        {declineReasons && !over && !takeback ? (
          <Card tone="surface" padding="sm" className={styles.reasons} role="group" aria-label="Почему оставляем ход?">
            <p className={styles.reasonsTitle}>Расскажешь, почему?</p>
            {TAKEBACK_DECLINE_REASONS.map((reason) => (
              <Button key={reason} variant="secondary" size="md" block className={styles.reasonChoice} onClick={() => game.giveDeclineReason(reason)}>
                {declineReasonLabelRu(reason, profile?.address ?? 'm')}
              </Button>
            ))}
          </Card>
        ) : null}

        {over ? (
          <ResultCard game={game} childColor={childColor} onExit={onExit} onRematch={onRematch} />
        ) : takeback ? null : (
          // while the coach waits for the take-back answer the two big choices are the only buttons
          <>
            <Actions game={game} onResign={openResign} onLeave={() => onExit()} />
            <MoveList moves={moves} openingName={openingName} />
          </>
        )}

        {/* «Учитель» without an engine advises only the known opening moves (TEACHER-MODE §2.1) — and says so */}
        {teacher && (judgeUnavailable || teachMode === 'rules') && !over ? (
          <p className={styles.note}>Гамбитик сейчас без шахматного движка — советы только в начале партии.</p>
        ) : judgeUnavailable && !over ? (
          <p className={styles.note}>Сегодня играем без проверки ходов. Когда партия закончится, я попробую посмотреть её ещё раз.</p>
        ) : null}
        {botUnavailable && !over ? <p className={styles.note}>{persona.name} сегодня ходит наугад: шахматный мотор соперника не завёлся.</p> : null}
        <div className={styles.dockSpace} aria-hidden="true" />
      </aside>

      <Modal
        open={resignOpen}
        onClose={closeResign}
        title="Сдаться?"
        icon={<Icon name="flag" size={48} />}
        dismissible={false}
        size="sm"
        actions={
          <>
            <Button variant="primary" size="lg" onClick={closeResign}>
              Играю дальше
            </Button>
            <Button variant="secondary" size="lg" onClick={confirmResign}>
              Да, сдаюсь
            </Button>
          </>
        }
      >
        <p className={styles.modalText}>Партия закончится. А можно ещё побороться — даже в трудной позиции бывают шансы!</p>
      </Modal>
    </div>
  );
}

// ───────────────────────── player strips ─────────────────────────

interface StripProps {
  side: 'bot' | 'child';
  name: string;
  detail: string;
  avatar: ReactElement;
  active: boolean;
  /** pieces of `lostColor` that this player has captured */
  lost: PieceType[];
  lostColor: Color;
  /** material balance from this player's point of view, in pawns */
  advantage: number;
  clock: ReactElement;
  bubble: { text: string; onDismiss?: () => void } | null;
}

function PlayerStrip({ side, name, detail, avatar, active, lost, lostColor, advantage, clock, bubble }: StripProps): ReactElement {
  return (
    <div className={styles.strip} data-side={side} data-active={active} data-bubble={bubble ? 'true' : 'false'}>
      <div className={styles.avatar}>{avatar}</div>
      <div className={styles.who}>
        <span className={styles.name}>{name}</span>
        <span className={styles.detail}>{detail}</span>
      </div>
      <div className={styles.captured} aria-label={lost.length > 0 ? `Взято фигур: ${lost.length}` : undefined}>
        <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
          {lost.map((piece, i) => (
            <PieceIcon key={`${piece}-${i}`} code={`${lostColor}${piece.toUpperCase()}`} size="1.3em" label="" />
          ))}
        </span>
        {advantage > 0 ? <span className={styles.advantage}>+{advantage}</span> : null}
      </div>
      {clock}
      {bubble ? (
        <button type="button" className={styles.bubble} onClick={bubble.onDismiss} disabled={!bubble.onDismiss} aria-label={`${name}: ${bubble.text}`}>
          {bubble.text}
        </button>
      ) : null}
    </div>
  );
}

/** Subscribes to the clock slice only, so the ten ticks per second do not re-render the board. */
function ClockFace({ game, color, timed }: { game: GameController; color: Color; timed: boolean }): ReactElement | null {
  const ms = useStore(game.store, (s) => s.clock[color]);
  const running = useStore(game.store, (s) => s.clock.running === color && !s.clock.paused);
  const paused = useStore(game.store, (s) => s.clock.paused && s.clock.running === color);
  if (!timed || ms === null) return null;
  return (
    <span className={styles.clock} data-running={running} data-paused={paused} data-low={ms < 20_000} role="timer" aria-label={`Осталось ${formatClock(ms)}`}>
      {formatClock(ms)}
    </span>
  );
}

// ───────────────────────── move list ─────────────────────────

function MoveList({ moves, openingName }: { moves: readonly MoveEntry[]; openingName: string | null }): ReactElement {
  const end = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [moves.length]);

  const rows: { number: number; white?: MoveEntry; black?: MoveEntry }[] = [];
  for (const move of moves) {
    const number = Math.ceil(move.ply / 2);
    const row = rows[number - 1] ?? (rows[number - 1] = { number });
    if (move.color === 'w') row.white = move;
    else row.black = move;
  }
  const last = moves[moves.length - 1];

  return (
    <Card padding="sm" className={styles.moves} aria-label="Ходы партии">
      {openingName ? <p className={styles.opening}>{openingName}</p> : null}
      {rows.length === 0 ? (
        <p className={styles.movesEmpty}>Здесь появятся ходы</p>
      ) : (
        <ol className={styles.moveRows}>
          {rows.map((row, index) => (
            <li key={row.number} className={styles.moveRow} ref={index === rows.length - 1 ? end : undefined}>
              <span className={styles.moveNumber}>{row.number}.</span>
              <span className={styles.moveSan} data-last={row.white !== undefined && row.white === last}>
                {row.white ? sanToBubbleRu(row.white.san) : '…'}
              </span>
              <span className={styles.moveSan} data-last={row.black !== undefined && row.black === last}>
                {row.black ? sanToBubbleRu(row.black.san) : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ───────────────────────── buttons ─────────────────────────

function Actions({ game, onResign, onLeave }: { game: GameController; onResign(): void; onLeave(): void }): ReactElement {
  const phase = useStore(game.store, (s) => s.phase);
  const hintsEnabled = useStore(game.store, (s) => s.hintsEnabled);
  const hintLevel = useStore(game.store, (s) => s.hintLevel);
  const hintBusy = useStore(game.store, (s) => s.hintBusy);
  const hintPulse = useStore(game.store, (s) => s.hintPulse);
  const canUndo = useStore(game.store, (s) => s.canUndo);
  // «Учитель»: the button repeats the advice (arrows again) — «Совет», no ladder dots (TEACHER-MODE §1.4)
  const teacher = useStore(game.store, (s) => s.coachStyle === 'teacher');
  // «Вернуть ход» lives only in untimed training games (never in an exam): a slip of the hand is not a mistake
  const undoPossible = useStore(game.store, (s) => s.timeControl?.initialMs === null && s.config?.examMode === false);

  return (
    <div className={styles.actions}>
      {hintsEnabled && teacher ? (
        <Button
          variant="accent"
          size="lg"
          block
          icon={<Icon name="bulb" />}
          disabled={phase !== 'childTurn'}
          loading={hintBusy}
          title="Покажу мой совет ещё раз"
          onClick={() => void game.requestHint('button')}
        >
          Совет
        </Button>
      ) : hintsEnabled ? (
        <Button
          variant="accent"
          size="lg"
          block
          icon={<Icon name="bulb" />}
          className={cx(hintPulse && styles.pulse)}
          disabled={phase !== 'childTurn'}
          loading={hintBusy}
          onClick={() => void game.requestHint('button')}
        >
          Подсказка
          <span className={styles.hintDots} aria-label={hintLevel > 0 ? `Ступенька ${hintLevel} из 4` : undefined}>
            {[1, 2, 3, 4].map((step) => (
              <span key={step} className={styles.hintDot} data-on={step <= hintLevel} aria-hidden="true" />
            ))}
          </span>
        </Button>
      ) : null}
      {undoPossible && phase !== 'idle' ? (
        <Button variant="secondary" size="md" block icon={<Icon name="undo" />} disabled={!canUndo || phase !== 'childTurn'} onClick={() => game.undoLastMove()}>
          Вернуть ход
        </Button>
      ) : null}
      {phase === 'idle' ? (
        // the engines are still waking up: nothing to resign from yet, but the way back must always be open
        <Button variant="ghost" size="md" block icon={<Icon name="back" />} onClick={onLeave}>
          Назад
        </Button>
      ) : (
        <Button variant="ghost" size="md" block icon={<Icon name="flag" />} onClick={onResign}>
          Сдаться
        </Button>
      )}
    </div>
  );
}

// ───────────────────────── result ─────────────────────────

const PROUD_ACCURACY = 70;

const TERMINATION_RU: Record<NonNullable<GameState['termination']>, string> = {
  checkmate: 'Мат на доске',
  resign: 'Партия сдана',
  timeout: 'Время вышло',
  stalemate: 'Пат — ходов больше нет',
  draw: 'Ничья по правилам',
  abandoned: 'Партия не доиграна',
};

interface ResultProps {
  game: GameController;
  childColor: Color;
  onExit(gameId?: string): void;
  onRematch(): void;
}

function ResultCard({ game, childColor, onExit, onRematch }: ResultProps): ReactElement {
  const result = useStore(game.store, (s) => s.result);
  const termination = useStore(game.store, (s) => s.termination);
  const ending = useStore(game.store, (s) => s.ending);
  const stars = useStore(game.store, (s) => s.stars);
  const summary = useStore(game.store, (s) => s.summary);
  const savedGameId = useStore(game.store, (s) => s.savedGameId);
  const note = useStore(game.store, (s) => s.note);
  const profile = useStore(game.store, (s) => s.profile);
  const takeaway = useStore(game.store, (s) => s.takeaway);
  const quizScore = useStore(game.store, (s) => s.quizScore);
  // the child's thoughts about the game are big tap answers (docs/voice-clips/SPEC.md §8.3) — with every voice now
  // (docs/TEACHING.md §4.4: «Как тебе партия?» like «Спроси»), never while «Спроси» is hidden for a question card
  const askSuppressed = useCoachStore((s) => s.askSuppressed);

  const outcome = childOutcome(result, childColor);
  const title = outcome === 'win' ? 'Победа!' : outcome === 'draw' ? 'Ничья!' : outcome === 'loss' ? 'Партия окончена' : 'Партия не сыграна';
  const done = ending?.stage === 'done';
  const reviewReady = done && ending.save === 'saved' && savedGameId !== null;

  return (
    <Card tone={outcome === 'win' ? 'sunny' : 'surface'} padding="md" className={styles.result} as="section" aria-label="Итог партии">
      <h2 className={styles.resultTitle}>{title}</h2>
      {termination ? <p className={styles.resultReason}>{TERMINATION_RU[termination]}</p> : null}
      {stars && stars.total > 0 ? <Stars value={stars.total} size={40} animate /> : null}

      {/* the middle of the card scrolls on a low window; the way forward stays at its bottom, clear of his bubble */}
      <div className={styles.resultBody}>
        {/* one optional sentence for the diary — asked before the game is written down, never required */}
        {note === 'asking' ? <DiaryNote game={game} /> : null}
        {/* under the diary question: on a low window its buttons come first */}
        {ending?.stage === 'analysing' ? (
          <div className={styles.progress}>
            <ProgressBar value={ending.judged} max={Math.max(1, ending.toJudge)} size="sm" label="Гамбитик вспоминает ходы…" />
          </div>
        ) : null}
        {ending?.stage === 'saving' ? <Spinner size={32} label="Записываю партию в дневник…" showLabel /> : null}
        {/* the ONE takeaway of the lesson and how the questions went (docs/TEACHING.md §2.9, §2.4) — the lesson first */}
        <LessonSummary takeaway={takeaway} quizScore={quizScore} address={profile?.address ?? 'm'} />
        {/* the quick tap answers come after the diary question (both at once pushed its buttons under the mascot) */}
        {askSuppressed || note === 'asking' ? null : <ThoughtChips address={profile?.address ?? 'm'} onTap={(chip) => game.tapThought(chip)} />}
        {note === 'saved' ? <p className={styles.resultFact}>Записал в дневник. Спасибо!</p> : null}
        {stars && stars.total > 0 ? (
          <ul className={styles.effort}>
            {/* a resignation after a long fight earns the star too — but it was not «played to the end» */}
            <EffortLine
              earned={stars.finished}
              text={termination === 'resign' ? 'Долгая борьба — это уже старание' : 'Партия сыграна до конца'}
              nextTime="В следующий раз доиграем до конца"
            />
            <EffortLine earned={stars.careful} text="Фигуры под присмотром" nextTime="В следующий раз бережём каждую фигуру" />
            <EffortLine earned={stars.listened} text="Думаем вместе с Гамбитиком" nextTime="В следующий раз подумаем ещё разок" />
            {/* the stars must add up on screen: hints cost a little, and the card says so (kindly) */}
            {stars.hintPenalty > 0 ? (
              <li className={styles.effortLine} data-earned="false">
                <Icon name="bulb" />
                <span>С подсказками — полезно! В следующий раз попробуем чаще без них</span>
              </li>
            ) : null}
          </ul>
        ) : null}

        {/* a number is shown only when it is something to be proud of; the full picture lives in the review */}
        {summary && done && ending.save !== 'skipped' && summary.accuracy >= PROUD_ACCURACY ? <p className={styles.resultFact}>Точность ходов: {Math.round(summary.accuracy)}%</p> : null}
        {done && ending.save === 'local' ? <p className={styles.note}>Партия сохранена на этом компьютере. В дневник она попадёт чуть позже.</p> : null}
      </div>

      {/* the way forward: always at the bottom of the card, which ends above his bubble (never a button covered) */}
      <div className={styles.resultButtons}>
        {reviewReady ? (
          <Button variant="primary" size="lg" block icon={<Icon name="chart" />} onClick={() => onExit(savedGameId)}>
            Разбор партии
          </Button>
        ) : null}
        <div className={styles.resultRow}>
          <Button variant={reviewReady ? 'secondary' : 'primary'} size="md" block disabled={!done} onClick={onRematch}>
            Ещё партию
          </Button>
          <Button variant="secondary" size="md" block onClick={() => onExit()}>
            Домой
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** «Ответил на 3 из 4 вопросов» (only when the game asked questions); the verb agrees with the child. */
export function quizScoreRu(score: { right: number; total: number }, address: 'm' | 'f'): string {
  const verb = address === 'f' ? 'Ответила' : 'Ответил';
  return `${verb} на ${score.right} из ${score.total} ${pluralRu(score.total, 'вопроса', 'вопросов', 'вопросов')}`;
}

/** The result card's lesson lines: the takeaway of the game and the quiz score (nothing when there is neither). */
export function LessonSummary({ takeaway, quizScore, address }: { takeaway: string | null; quizScore: { right: number; total: number } | null; address: 'm' | 'f' }): ReactElement | null {
  if (!takeaway && !quizScore) return null;
  return (
    <div className={styles.lesson}>
      {takeaway ? <p className={styles.takeaway}>{takeaway}</p> : null}
      {quizScore && quizScore.total > 0 ? <p className={styles.quizScore}>{quizScoreRu(quizScore, address)}</p> : null}
    </div>
  );
}

/** «Что было самым трудным в этой партии?» — big input, optional, «Пропустить» always there. */
function DiaryNote({ game }: { game: GameController }): ReactElement {
  const [text, setText] = useState('');
  const clean = text.trim();
  return (
    <form
      className={styles.diary}
      aria-label="Дневник партии"
      onSubmit={(event) => {
        event.preventDefault();
        if (clean !== '') game.submitChildNote(clean);
      }}
    >
      <label className={styles.diaryLabel} htmlFor="game-diary-note">
        {CHILD_NOTE_QUESTION_RU}
      </label>
      {/* two visible lines: a child's sentence must not scroll out of sight while it is being typed; Enter still saves */}
      <textarea
        id="game-diary-note"
        className={styles.diaryInput}
        rows={2}
        value={text}
        maxLength={CHILD_NOTE_MAX_CHARS}
        autoComplete="off"
        enterKeyHint="done"
        placeholder="Напиши одно предложение"
        onChange={(event) => {
          setText(event.target.value.replace(/[\r\n]+/g, ' '));
          game.touchChildNote();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (clean !== '') game.submitChildNote(clean);
        }}
      />
      <div className={styles.resultRow}>
        <Button type="submit" variant="primary" size="md" block disabled={clean === ''}>
          Записать
        </Button>
        <Button type="button" variant="ghost" size="md" block onClick={() => game.submitChildNote(null)}>
          Пропустить
        </Button>
      </div>
    </form>
  );
}

function EffortLine({ earned, text, nextTime }: { earned: boolean; text: string; nextTime: string }): ReactElement {
  return (
    <li className={styles.effortLine} data-earned={earned}>
      <Icon name={earned ? 'star' : 'forward'} />
      <span>{earned ? text : nextTime}</span>
    </li>
  );
}
