/**
 * TrainerBoard — the ONLY file that imports react-chessboard (research 01 §8: keep the board library behind a
 * narrow interface). react-chessboard v5 takes a single `options` prop; nothing from the v4 API exists.
 *
 * Presentational: position, marks and callbacks come from the game store. Dragging and click-to-move both work;
 * promotion is our own picker (v5 has none). The board fills min(available width, available height).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Chessboard } from 'react-chessboard';
import type { ChessboardOptions, PieceDropHandlerArgs, PieceHandlerArgs, SquareHandlerArgs } from 'react-chessboard';
import { gambitPieces } from '../../ui/pieces/index.ts';
import type { BoardAnnotations, Color, Square } from '@gambit/shared';
import { BOARD_MARKS, BOARD_THEMES, boardThemeStyles, buildArrows, buildSquareStyles, prefersReducedMotion } from '../../ui/index.ts';
import type { BoardThemeId } from '../../ui/index.ts';
import type { LegalTarget, PendingPromotion, PromotionPiece } from './gameTypes.ts';
import styles from './TrainerBoard.module.css';

export interface TrainerBoardProps {
  fen: string;
  orientation: Color;
  /** colour of the pieces the child may move */
  childColor: Color;
  /** false while it is not the child's turn: no dragging, no clicks */
  interactive: boolean;
  lastMove: { from: Square; to: Square } | null;
  checkSquare: Square | null;
  selected: Square | null;
  legalTargets: readonly LegalTarget[];
  annotations: BoardAnnotations | null;
  pendingPromotion: PendingPromotion | null;
  /** soft veil while the coach asks about a take-back */
  dimmed?: boolean;
  themeId?: BoardThemeId;
  onSquareClick(square: Square): void;
  onDragStart(square: Square): void;
  /** returns true when the move was played */
  onDrop(from: Square, to: Square): boolean;
  onPromotion(piece: PromotionPiece | null): void;
}

const ANIMATION_MS = 200;
const DRAG_ACTIVATION_PX = 6;
const MIN_BOARD_PX = 160;

/** Largest multiple of 8 px that fits the element (whole-pixel squares keep the grid crisp). */
function useBoardSize(): { ref: React.RefObject<HTMLDivElement | null>; size: number } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void => {
      const side = Math.floor(Math.min(element.clientWidth, element.clientHeight) / 8) * 8;
      setSize(Math.max(MIN_BOARD_PX, side));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}

export function TrainerBoard(props: TrainerBoardProps): ReactElement {
  const { fen, orientation, childColor, interactive, lastMove, checkSquare, selected, legalTargets, annotations, pendingPromotion, themeId } = props;
  const { ref, size } = useBoardSize();

  // handlers live in a ref so the memoised `options` object does not change with every parent render
  const handlers = useRef(props);
  useEffect(() => {
    handlers.current = props;
  });

  const theme = useMemo(() => boardThemeStyles(BOARD_THEMES[themeId ?? 'mint']), [themeId]);
  const squareStyles = useMemo(
    () => buildSquareStyles({ lastMove, checkSquare, selected, legalTargets, annotations, ringPx: Math.max(3, Math.round((size / 8) * 0.07)) }),
    [lastMove, checkSquare, selected, legalTargets, annotations, size],
  );
  const arrows = useMemo(() => buildArrows(annotations), [annotations]);

  const options = useMemo<ChessboardOptions>(
    () => ({
      id: 'gambit-game-board',
      position: fen,
      boardOrientation: orientation === 'w' ? 'white' : 'black',
      allowDragging: interactive,
      allowDragOffBoard: false,
      allowDrawingArrows: false,
      clearArrowsOnPositionChange: false,
      clearArrowsOnClick: false,
      dragActivationDistance: DRAG_ACTIVATION_PX,
      animationDurationInMs: ANIMATION_MS,
      showAnimations: !prefersReducedMotion(),
      showNotation: true,
      pieces: gambitPieces,
      arrows,
      squareStyles,
      boardStyle: theme.boardStyle,
      lightSquareStyle: theme.lightSquareStyle,
      darkSquareStyle: theme.darkSquareStyle,
      lightSquareNotationStyle: theme.lightSquareNotationStyle,
      darkSquareNotationStyle: theme.darkSquareNotationStyle,
      dropSquareStyle: theme.dropSquareStyle,
      canDragPiece: ({ piece }: PieceHandlerArgs) => interactive && piece.pieceType.startsWith(childColor),
      onPieceDrag: ({ square }: PieceHandlerArgs) => {
        if (square) handlers.current.onDragStart(square);
      },
      onPieceDrop: ({ sourceSquare, targetSquare }: PieceDropHandlerArgs) => {
        // whether a move is allowed right now is the game store's decision (it checks the phase itself)
        if (!targetSquare) return false;
        return handlers.current.onDrop(sourceSquare, targetSquare);
      },
      onSquareClick: ({ square }: SquareHandlerArgs) => {
        handlers.current.onSquareClick(square);
      },
    }),
    [fen, orientation, interactive, arrows, squareStyles, theme, childColor],
  );

  return (
    <div ref={ref} className={styles.area}>
      {size > 0 ? (
        <div className={styles.board} style={{ width: size, height: size }} data-interactive={interactive} data-testid="trainer-board">
          <Chessboard options={options} />
          {props.dimmed ? <div className={styles.veil} style={{ background: BOARD_MARKS.dimOverlay }} aria-hidden="true" /> : null}
          {pendingPromotion ? <PromotionPicker color={pendingPromotion.color} onChoose={props.onPromotion} /> : null}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────── promotion ─────────────────────────

const PROMOTION_CHOICES: readonly { piece: PromotionPiece; letter: string; label: string }[] = [
  { piece: 'q', letter: 'Q', label: 'Ферзь' },
  { piece: 'r', letter: 'R', label: 'Ладья' },
  { piece: 'b', letter: 'B', label: 'Слон' },
  { piece: 'n', letter: 'N', label: 'Конь' },
];

export interface PromotionPickerProps {
  color: Color;
  onChoose(piece: PromotionPiece | null): void;
}

/** Four big piece buttons over the board; Esc or «Отмена» puts the pawn back. */
export function PromotionPicker({ color, onChoose }: PromotionPickerProps): ReactElement {
  const first = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onChoose(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose]);

  return (
    <div className={styles.promotion} role="dialog" aria-modal="true" aria-label="В кого превратить пешку?">
      <p className={styles.promotionTitle}>В кого превратить пешку?</p>
      <div className={styles.promotionChoices}>
        {PROMOTION_CHOICES.map(({ piece, letter, label }, index) => {
          const render = gambitPieces[`${color}${letter}`];
          return (
            <button key={piece} ref={index === 0 ? first : undefined} type="button" className={styles.promotionButton} onClick={() => onChoose(piece)}>
              <span className={styles.promotionPiece} aria-hidden="true">
                {render ? render() : null}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className={styles.promotionCancel} onClick={() => onChoose(null)}>
        Отмена
      </button>
    </div>
  );
}
