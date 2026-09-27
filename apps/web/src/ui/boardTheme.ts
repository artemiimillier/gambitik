/**
 * Board colours for the board module (TrainerBoard / react-chessboard v5 `options`).
 * Pure data + tiny helpers: no React runtime, no react-chessboard import — the shapes below are structurally
 * compatible with `squareStyles: Record<string, CSSProperties>` and `arrows: { startSquare, endSquare, color }[]`.
 *
 * Accessibility (research 08 §9): highlight colours differ by SHAPE too — green is a ringed square, red a ringed
 * circle, yellow a rounded blob without ring, blue a ring without fill — distinguishable without colour vision.
 */
import type { CSSProperties } from 'react';
import type { AnnotationColor, BoardAnnotations, Square } from '@gambit/shared';

export type BoardThemeId = 'mint' | 'sky' | 'lavender' | 'tournament';

export interface BoardTheme {
  id: BoardThemeId;
  /** Russian name for the settings screen. */
  nameRu: string;
  lightSquare: string;
  darkSquare: string;
  /** coordinate label colour on a light / dark square */
  notationOnLight: string;
  notationOnDark: string;
}

/** Outlines of the «Гамбит» pieces (ui/pieces) reach ≥ 6.7:1 against every square of every theme — enforced by ui/pieces tests. */
export const BOARD_THEMES: Record<BoardThemeId, BoardTheme> = {
  mint: { id: 'mint', nameRu: 'Мята', lightSquare: '#F3EBD8', darkSquare: '#8CB8A8', notationOnLight: '#5E8C7B', notationOnDark: '#F3EBD8' },
  sky: { id: 'sky', nameRu: 'Небо', lightSquare: '#EAF2FB', darkSquare: '#8FB4DC', notationOnLight: '#5B86B5', notationOnDark: '#EAF2FB' },
  lavender: { id: 'lavender', nameRu: 'Лаванда', lightSquare: '#EEF1FB', darkSquare: '#93A6E0', notationOnLight: '#6378BD', notationOnDark: '#EEF1FB' },
  tournament: { id: 'tournament', nameRu: 'Турнир', lightSquare: '#FFFFDD', darkSquare: '#86A666', notationOnLight: '#5F7D43', notationOnDark: '#FFFFDD' },
};

export const DEFAULT_BOARD_THEME_ID: BoardThemeId = 'mint';
export const DEFAULT_BOARD_THEME: BoardTheme = BOARD_THEMES.mint;

/** Base RGB of every annotation colour. 'red' is a warm coral-red, never an alarming pure red. */
export const ANNOTATION_RGB: Record<AnnotationColor, readonly [number, number, number]> = {
  green: [46, 158, 91],
  red: [235, 87, 74],
  yellow: [255, 201, 60],
  blue: [47, 111, 222],
};

function rgba(color: AnnotationColor, alpha: number): string {
  const [r, g, b] = ANNOTATION_RGB[color];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Square fill per annotation colour (translucent: the square colour and the piece stay readable). */
export const HIGHLIGHT_COLORS: Record<AnnotationColor, string> = {
  green: rgba('green', 0.5),
  red: rgba('red', 0.55),
  yellow: rgba('yellow', 0.7),
  blue: rgba('blue', 0.4),
};

/** Arrow colours; the library applies its own opacity on top, so these are nearly opaque. */
export const ARROW_COLORS: Record<AnnotationColor, string> = {
  green: rgba('green', 0.92),
  red: rgba('red', 0.92),
  yellow: rgba('yellow', 0.95),
  blue: rgba('blue', 0.92),
};

/** Non-annotation marks used by the board itself. */
export const BOARD_MARKS = {
  /** from/to squares of the last move */
  lastMove: 'rgba(255, 210, 63, 0.45)',
  /** ring around the selected piece */
  selectedRing: '#0F6F69',
  selectedFill: 'rgba(15, 111, 105, 0.18)',
  /** dot on an empty legal target (28 % of the square) */
  legalDot: 'rgba(29, 53, 64, 0.28)',
  /** ring on a legal capture target */
  legalCaptureRing: 'rgba(29, 53, 64, 0.3)',
  /** king in check */
  check: 'rgba(235, 87, 74, 0.6)',
  /** square under the dragged piece */
  dropTarget: 'rgba(15, 111, 105, 0.3)',
  /** veil over the board while the coach asks about a take-back */
  dimOverlay: 'rgba(29, 53, 64, 0.18)',
} as const;

/** Default ring thickness in px (box-shadow cannot use %). Boards with 72–96 px squares look right with 5–6 px. */
export const DEFAULT_RING_PX = 5;

function ring(color: string, px: number): string {
  return `inset 0 0 0 ${Math.max(1, Math.round(px))}px ${color}`;
}

/** Inline style for a coach highlight of the given colour. `ringPx` ≈ 7 % of the square size. */
export function highlightStyle(color: AnnotationColor, ringPx: number = DEFAULT_RING_PX): CSSProperties {
  switch (color) {
    case 'yellow':
      // a rounded blob, so it cannot be mistaken for the flat last-move tint
      return { background: HIGHLIGHT_COLORS.yellow, borderRadius: '32%' };
    case 'blue':
      return { boxShadow: ring(rgba('blue', 0.9), ringPx), borderRadius: '18%' };
    case 'green':
      return { background: HIGHLIGHT_COLORS.green, boxShadow: ring(rgba('green', 0.95), ringPx) };
    case 'red':
      return { background: HIGHLIGHT_COLORS.red, boxShadow: ring(rgba('red', 1), ringPx), borderRadius: '50%' };
  }
}

export function lastMoveStyle(): CSSProperties {
  return { background: BOARD_MARKS.lastMove };
}

export function selectedSquareStyle(ringPx: number = DEFAULT_RING_PX): CSSProperties {
  return { background: BOARD_MARKS.selectedFill, boxShadow: ring(BOARD_MARKS.selectedRing, ringPx), borderRadius: '14%' };
}

/** Big dot for an empty target square, ring for a capture — kids see where the piece can go. */
export function legalTargetStyle(isCapture: boolean): CSSProperties {
  return isCapture
    ? { background: `radial-gradient(circle, transparent 0 58%, ${BOARD_MARKS.legalCaptureRing} 59% 70%, transparent 71%)`, cursor: 'pointer' }
    : { background: `radial-gradient(circle, ${BOARD_MARKS.legalDot} 0 27%, transparent 28%)`, cursor: 'pointer' };
}

export function checkSquareStyle(): CSSProperties {
  return { background: `radial-gradient(circle, ${BOARD_MARKS.check} 0 45%, rgba(235, 87, 74, 0.15) 75%, transparent 100%)` };
}

export interface SquareStyleInput {
  lastMove?: { from: Square; to: Square } | null;
  selected?: Square | null;
  legalTargets?: readonly { square: Square; capture: boolean }[];
  checkSquare?: Square | null;
  annotations?: Pick<BoardAnnotations, 'highlights'> | null;
  /** Ring thickness in px for selected / highlighted squares. Default 5; pass ≈ squareSize × 0.07. */
  ringPx?: number;
}

/**
 * Merges every mark into one `squareStyles` object. Later layers win per CSS property, in this order:
 * last move → check → selected → legal targets → coach highlights.
 */
export function buildSquareStyles(input: SquareStyleInput): Record<string, CSSProperties> {
  const styles: Record<string, CSSProperties> = {};
  const add = (square: Square, style: CSSProperties) => {
    styles[square] = { ...styles[square], ...style };
  };
  if (input.lastMove) {
    add(input.lastMove.from, lastMoveStyle());
    add(input.lastMove.to, lastMoveStyle());
  }
  if (input.checkSquare) add(input.checkSquare, checkSquareStyle());
  const ringPx = input.ringPx ?? DEFAULT_RING_PX;
  if (input.selected) add(input.selected, selectedSquareStyle(ringPx));
  for (const target of input.legalTargets ?? []) add(target.square, legalTargetStyle(target.capture));
  for (const highlight of input.annotations?.highlights ?? []) add(highlight.square, highlightStyle(highlight.color, ringPx));
  return styles;
}

export interface BoardArrow {
  startSquare: string;
  endSquare: string;
  color: string;
}

/** Coach arrows in the shape react-chessboard v5 expects (`options.arrows`). */
export function buildArrows(annotations: Pick<BoardAnnotations, 'arrows'> | null | undefined): BoardArrow[] {
  return (annotations?.arrows ?? []).map((arrow) => ({ startSquare: arrow.from, endSquare: arrow.to, color: ARROW_COLORS[arrow.color] }));
}

/** Ready-made `lightSquareStyle` / `darkSquareStyle` / notation styles for a theme. */
export function boardThemeStyles(theme: BoardTheme = DEFAULT_BOARD_THEME): {
  lightSquareStyle: CSSProperties;
  darkSquareStyle: CSSProperties;
  lightSquareNotationStyle: CSSProperties;
  darkSquareNotationStyle: CSSProperties;
  dropSquareStyle: CSSProperties;
  boardStyle: CSSProperties;
} {
  return {
    lightSquareStyle: { backgroundColor: theme.lightSquare },
    darkSquareStyle: { backgroundColor: theme.darkSquare },
    lightSquareNotationStyle: { color: theme.notationOnLight, fontWeight: 800 },
    darkSquareNotationStyle: { color: theme.notationOnDark, fontWeight: 800 },
    dropSquareStyle: { boxShadow: `inset 0 0 0 5px ${BOARD_MARKS.dropTarget}` },
    boardStyle: { borderRadius: 16, overflow: 'hidden', boxShadow: '0 8px 0 rgba(29, 53, 64, 0.16)' },
  };
}
