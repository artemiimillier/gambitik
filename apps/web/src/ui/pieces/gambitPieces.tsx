/**
 * «Гамбит» pieces for React: the react-chessboard 5.12.1 `options.pieces` object and a tiny <PieceIcon/> for use
 * outside the board (captured-material strips, promotion picker, persona tiles).
 *
 * Geometry and colours live in gambitSet.ts (pure data, shared with the string renderer and the tests).
 * No <defs>, ids, gradients or filters: any number of boards and icons can share one page.
 */
import { createElement } from 'react';
import type { CSSProperties, JSX, ReactElement } from 'react';
import type { PieceRenderObject } from 'react-chessboard';
import { GAMBIT_PIECE_CODES, gambitPieceElements, gambitPieceLabel, isPieceCode } from './gambitSet.ts';
import type { PieceCode } from './gambitSet.ts';

/** What react-chessboard passes to a piece renderer (5.12.1 only ever passes `square`). */
type BoardPieceProps = { fill?: string; square?: string; svgStyle?: CSSProperties };

/** SVG attribute spelling → React prop spelling (stroke-width → strokeWidth). */
function reactProps(attrs: Record<string, string | number>): Record<string, string | number> {
  const props: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(attrs)) props[name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  return props;
}

/** The geometry never changes at runtime: children are built once per piece code and shared by every square. */
const CHILDREN = {} as Record<PieceCode, readonly ReactElement[]>;
for (const code of GAMBIT_PIECE_CODES) {
  CHILDREN[code] = gambitPieceElements(code).map((el, i) => createElement(el.tag, { key: i, ...reactProps(el.attrs) }));
}

function makeRenderer(code: PieceCode): (props?: BoardPieceProps) => JSX.Element {
  const label = gambitPieceLabel(code);
  const children = CHILDREN[code];
  function GambitPiece(props?: BoardPieceProps): JSX.Element {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 100 100"
        width="100%"
        height="100%"
        style={props?.svgStyle}
        role="img"
        aria-label={label}
        focusable="false"
      >
        {children}
      </svg>
    );
  }
  GambitPiece.displayName = `GambitPiece(${code})`;
  return GambitPiece;
}

/** react-chessboard `options.pieces`, keyed 'wP' … 'bK'. Colours are fixed; the board's optional `fill` is ignored. */
export const gambitPieces: PieceRenderObject = Object.fromEntries(GAMBIT_PIECE_CODES.map((code) => [code, makeRenderer(code)]));

export interface PieceIconProps {
  /** 'wP' … 'bK' (react-chessboard spelling). An unknown code renders nothing. */
  code: string;
  /** CSS size of the square icon box: a number is px. Default '1em' (follows the surrounding text). */
  size?: number | string;
  /** Accessible name. Defaults to the Russian name («белый конь»); pass '' for a decorative icon. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/** One piece as an inline icon, outside the board. */
export function PieceIcon({ code, size = '1em', label, className, style }: PieceIconProps): ReactElement | null {
  if (!isPieceCode(code)) return null;
  const name = label ?? gambitPieceLabel(code);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      style={{ display: 'inline-block', flex: 'none', verticalAlign: '-0.15em', ...style }}
      role={name === '' ? undefined : 'img'}
      aria-label={name === '' ? undefined : name}
      aria-hidden={name === '' ? true : undefined}
      focusable="false"
    >
      {CHILDREN[code]}
    </svg>
  );
}
