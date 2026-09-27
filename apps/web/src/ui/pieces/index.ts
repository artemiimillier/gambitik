/**
 * «Гамбит» — the trainer's own chess pieces (original inline-SVG set, see gambitSet.ts).
 *
 *   <Chessboard options={{ ...options, pieces: gambitPieces }} />   // react-chessboard 5.12.1
 *   <PieceIcon code="wN" size={28} />                               // anywhere else
 *   gambitPieceSvg('bQ')                                            // plain SVG markup
 */
export { PieceIcon, gambitPieces } from './gambitPieces.tsx';
export type { PieceIconProps } from './gambitPieces.tsx';
export {
  GAMBIT_PIECE_CODES,
  GAMBIT_PIECE_PALETTE,
  GAMBIT_STROKE,
  gambitPieceElements,
  gambitPieceLabel,
  gambitPieceSvg,
  isPieceCode,
} from './gambitSet.ts';
export type { PieceCode, PieceColor, PieceKind, PiecePalette, SvgElementSpec } from './gambitSet.ts';
