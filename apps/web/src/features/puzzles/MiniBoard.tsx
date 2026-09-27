/**
 * MiniBoard — the small shared board of the secondary screens (puzzles, review, concept cards).
 * A thin wrapper around react-chessboard v5 (single `options` prop) with chess.js for legality:
 * click-to-move AND drag, big legal-move dots, last-move / check marks, coach annotations,
 * a kid-sized promotion chooser and a gentle "no" shake. Colours come from ui/boardTheme.
 *
 * The board is CONTROLLED: it never changes the position by itself. A legal move is offered to
 * `onMove`; the parent answers true (and then passes the new `fen`) or false (the piece goes back).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type { ChessboardOptions, PieceDropHandlerArgs, PieceHandlerArgs, SquareHandlerArgs } from 'react-chessboard';
import { gambitPieces } from '../../ui/pieces/index.ts';
import type { BoardAnnotations, Color, Square } from '@gambit/shared';
import { BOARD_THEMES, DEFAULT_BOARD_THEME_ID, boardThemeStyles, buildArrows, buildSquareStyles, cx, prefersReducedMotion } from '../../ui/index.ts';
import type { BoardThemeId } from '../../ui/index.ts';
import styles from './MiniBoard.module.css';
import { toUci } from './puzzleLine.ts';
import type { PromotionPiece } from './puzzleLine.ts';

export interface MiniBoardMove {
  from: Square;
  to: Square;
  promotion?: PromotionPiece;
  uci: string;
}

export interface MiniBoardProps {
  /** Position to show. A full FEN is required for `interactive`; the placement part alone is enough to display. */
  fen: string;
  /** Which colour sits at the bottom. Default 'w'. */
  orientation?: Color;
  /** The child may move the pieces of the side to move. Default false. */
  interactive?: boolean;
  /** Receives a LEGAL move. Return true to accept it (then pass the new `fen`), false to send the piece back. */
  onMove?: (move: MiniBoardMove) => boolean;
  lastMove?: { from: Square; to: Square } | null;
  annotations?: BoardAnnotations | null;
  /** Change the number to play the gentle "not this one" shake. */
  shakeKey?: number;
  /** Piece animation in ms. Default 280. */
  animationMs?: number;
  showNotation?: boolean;
  /** Upper bound of the board side in px. Default 560. The board also never exceeds its container or `maxViewportShare` of the viewport height. */
  maxSize?: number;
  /** Share of the viewport height the board may take, 0..1. Default 0.8; use less inside modals. */
  maxViewportShare?: number;
  themeId?: BoardThemeId;
  /** Accessible name of the board (Russian). */
  label?: string;
  /** Unique id when several boards are on one page. */
  id?: string;
  className?: string;
}

interface LegalTarget {
  square: Square;
  capture: boolean;
  promotion: boolean;
}

const PROMOTION_CHOICES: readonly { piece: PromotionPiece; nameRu: string }[] = [
  { piece: 'q', nameRu: 'Ферзь' },
  { piece: 'r', nameRu: 'Ладья' },
  { piece: 'b', nameRu: 'Слон' },
  { piece: 'n', nameRu: 'Конь' },
];

function loadChess(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

function kingSquare(chess: Chess, color: Color): Square | null {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) return cell.square;
    }
  }
  return null;
}

let boardCounter = 0;

export function MiniBoard({
  fen,
  orientation = 'w',
  interactive = false,
  onMove,
  lastMove = null,
  annotations = null,
  shakeKey = 0,
  animationMs = 280,
  showNotation = true,
  maxSize = 560,
  maxViewportShare = 0.8,
  themeId = DEFAULT_BOARD_THEME_ID,
  label = 'Шахматная доска',
  id,
  className,
}: MiniBoardProps) {
  const [autoId] = useState(() => `mini-board-${++boardCounter}`);
  const boardId = id ?? autoId;
  const frameRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [ringPx, setRingPx] = useState(5);

  const chess = useMemo(() => loadChess(fen), [fen]);
  const turn: Color | null = chess ? chess.turn() : null;
  const canPlay = interactive && chess !== null && onMove !== undefined && !chess.isGameOver();

  // a new position always clears the selection and the promotion chooser
  useEffect(() => {
    setSelected(null);
    setPendingPromotion(null);
  }, [fen, interactive]);

  // ring thickness follows the real square size (≈ 7 %)
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setRingPx(Math.max(3, Math.round((width / 8) * 0.07)));
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // the gentle "no": a short horizontal wiggle, skipped with reduced motion
  useEffect(() => {
    const frame = frameRef.current;
    if (shakeKey === 0 || !frame || typeof frame.animate !== 'function' || prefersReducedMotion()) return;
    const animation = frame.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(7px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }],
      { duration: 380, easing: 'ease-in-out' },
    );
    return () => animation.cancel();
  }, [shakeKey]);

  const legalTargets = useMemo<LegalTarget[]>(() => {
    if (!canPlay || !chess || selected === null) return [];
    const seen = new Map<Square, LegalTarget>();
    for (const move of chess.moves({ square: selected as Parameters<Chess['get']>[0], verbose: true })) {
      // chess.js 1.4: isCapture() is false for en passant — the square still needs the capture ring
      if (!seen.has(move.to)) seen.set(move.to, { square: move.to, capture: move.isCapture() || move.isEnPassant(), promotion: move.isPromotion() });
    }
    return [...seen.values()];
  }, [canPlay, chess, selected]);

  const findTarget = useCallback(
    (from: Square, to: Square): LegalTarget | null => {
      if (!chess) return null;
      const move = chess.moves({ square: from as Parameters<Chess['get']>[0], verbose: true }).find((m) => m.to === to);
      return move ? { square: move.to, capture: move.isCapture() || move.isEnPassant(), promotion: move.isPromotion() } : null;
    },
    [chess],
  );

  const offer = useCallback(
    (from: Square, to: Square, promotion?: PromotionPiece): boolean => {
      if (!onMove) return false;
      const accepted = onMove(promotion === undefined ? { from, to, uci: toUci(from, to) } : { from, to, promotion, uci: toUci(from, to, promotion) });
      setSelected(null);
      return accepted;
    },
    [onMove],
  );

  /** Returns true when the move was accepted right away (false also while the promotion chooser is open). */
  const tryMove = useCallback(
    (from: Square, to: Square): boolean => {
      if (!canPlay) return false;
      const target = findTarget(from, to);
      if (!target) return false;
      if (target.promotion) {
        setPendingPromotion({ from, to });
        setSelected(null);
        return false;
      }
      return offer(from, to);
    },
    [canPlay, findTarget, offer],
  );

  const options = useMemo<ChessboardOptions>(() => {
    const theme = boardThemeStyles(BOARD_THEMES[themeId]);
    const checkSquare = chess && chess.inCheck() ? kingSquare(chess, chess.turn()) : null;
    return {
      id: boardId,
      position: fen,
      boardOrientation: orientation === 'b' ? 'black' : 'white',
      showNotation,
      pieces: gambitPieces,
      animationDurationInMs: animationMs,
      showAnimations: animationMs > 0,
      allowDragging: canPlay && pendingPromotion === null,
      allowDrawingArrows: false,
      clearArrowsOnPositionChange: false,
      // a sloppy tap must stay a tap (click-to-move), not turn into a drag
      dragActivationDistance: 6,
      canDragPiece: ({ piece }: PieceHandlerArgs) => canPlay && turn !== null && piece.pieceType.startsWith(turn),
      onPieceDrop: ({ sourceSquare, targetSquare }: PieceDropHandlerArgs) => (targetSquare === null ? false : tryMove(sourceSquare, targetSquare)),
      onSquareClick: ({ square, piece }: SquareHandlerArgs) => {
        if (!canPlay || pendingPromotion !== null) return;
        if (selected !== null && selected !== square && tryMove(selected, square)) return;
        if (selected !== null && findTarget(selected, square)?.promotion) return; // chooser opened
        const own = piece !== null && turn !== null && piece.pieceType.startsWith(turn);
        setSelected(own && selected !== square ? square : null);
      },
      arrows: buildArrows(annotations),
      squareStyles: buildSquareStyles({ lastMove, selected, legalTargets, checkSquare, annotations, ringPx }),
      ...theme,
    };
  }, [annotations, animationMs, boardId, canPlay, chess, fen, findTarget, lastMove, legalTargets, orientation, pendingPromotion, ringPx, selected, showNotation, themeId, tryMove, turn]);

  const promotionColor = turn === 'b' ? 'b' : 'w';

  return (
    <div className={cx(styles.wrap, className)} style={{ maxWidth: `min(${maxSize}px, ${Math.round(Math.max(0.2, Math.min(1, maxViewportShare)) * 100)}vh)` }} role="group" aria-label={label}>
      <div ref={frameRef} className={styles.frame} data-interactive={canPlay || undefined}>
        <Chessboard options={options} />
        {pendingPromotion ? (
          <div className={styles.promotion} role="dialog" aria-label="В кого превратить пешку?">
            <p className={styles.promotionTitle}>В кого превратить пешку?</p>
            <div className={styles.promotionChoices}>
              {PROMOTION_CHOICES.map(({ piece, nameRu }) => {
                const Piece = gambitPieces[`${promotionColor}${piece.toUpperCase()}`];
                return (
                  <button
                    key={piece}
                    type="button"
                    className={styles.promotionButton}
                    aria-label={nameRu}
                    onClick={() => {
                      const pending = pendingPromotion;
                      setPendingPromotion(null);
                      offer(pending.from, pending.to, piece);
                    }}
                  >
                    {Piece ? <Piece /> : nameRu}
                    <span className={styles.promotionName}>{nameRu}</span>
                  </button>
                );
              })}
            </div>
            <button type="button" className={styles.promotionCancel} onClick={() => setPendingPromotion(null)}>
              Отмена
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
