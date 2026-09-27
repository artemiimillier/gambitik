/**
 * «Гамбит» — the original piece set of the Гамбитик trainer. Pure data + a string renderer.
 *
 * No React and no DOM here: the same element specs feed the React renderers (gambitPieces.tsx), the plain-string
 * renderer `gambitPieceSvg` (previews, contact sheets, data-URIs) and the unit tests, so the two can never drift.
 *
 * Construction rules shared by all 12 pieces (viewBox 0 0 100 100, 5–8 <path>s each):
 *  - flat fills, one outline weight with round joins; no <defs>, ids, gradients or filters;
 *  - three tones per army: BODY (ivory / charcoal-teal), RIM (collars + the pill plinth — Гамбитик's own teal
 *    pedestal: pale mint on the ivory army, slate on the dark one, a mid value that keeps the dark army's structure
 *    visible at 32 px) and one TONE shape (a warm shadow on the right of the ivory army, a highlight on the left of
 *    the dark army — light always comes from the top-left);
 *  - parts overlap and every part carries the outline, so the joins read like the grooves of turned wood;
 *  - one baseline: every plinth ends at y = 91 (93 with the outline). Heights with the outline:
 *    K 88 % · Q 86 % · N 85.5 % · B 84.5 % · R 80 % · P 79 %. Plinths stay left of x = 82 so the file letters of
 *    react-chessboard's notation (bottom-right corner of rank 1) never touch them;
 *  - the knight is Гамбитик's cousin: rounded foal muzzle, one pointed ear, a scalloped mane and a two-lobed forelock
 *    (the ivory knight wears the mascot's orange mane and pink inner ear), and a single small eye — no other faces.
 *
 * 100 % original geometry: only the public-domain Staunton archetypes are kept (round pawn head, battlements,
 * slit mitre, horse head, crown with points and balls, crown with a cross). No existing set was traced or adapted.
 */

export type PieceColor = 'w' | 'b';
export type PieceKind = 'P' | 'N' | 'B' | 'R' | 'Q' | 'K';
export type PieceCode = `${PieceColor}${PieceKind}`;

export const GAMBIT_PIECE_CODES: readonly PieceCode[] = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'];

export interface PiecePalette {
  /** main surface */
  body: string;
  /** collars and the plinth: a mid value between body and outline */
  rim: string;
  /** outline of every part */
  line: string;
  /** the one tonal shape: shadow (ivory army) or highlight (dark army) */
  tone: string;
  /** engraved marks: bishop slit, knight eye */
  detail: string;
  /** rook door */
  door: string;
  /** knight mane and forelock */
  mane: string;
  /** knight inner ear */
  ear: string;
}

/**
 * Colours of both armies, in one object so the contrast tests and the previews read the same values.
 * Measured (WCAG): body w/b 10:1; ivory outline ≥ 6.7:1 on every square of every board theme (≥ 5:1 under the red and
 * check marks); ivory rim / body 1.28:1 and slate rim / charcoal body 2.2:1, so the grooves survive at 32 px.
 */
export const GAMBIT_PIECE_PALETTE: Readonly<Record<PieceColor, Readonly<PiecePalette>>> = {
  w: {
    body: '#FFF6E6',
    rim: '#C6E2D8',
    line: '#0A161D',
    tone: '#E9D3AB',
    detail: '#0A161D',
    door: '#0A161D',
    mane: '#F5B863',
    ear: '#FF9DB0',
  },
  b: {
    body: '#2B4145',
    rim: '#587779',
    line: '#060F12',
    tone: '#46646A',
    detail: '#E6F2EE',
    door: '#060F12',
    mane: '#587779',
    ear: '#7E9A9A',
  },
};

/** Outline weight in viewBox units (100 = one square): 1.3 px at 32 px, 4.4 px at 110 px. */
export const GAMBIT_STROKE = 4;

// ───────────────────────── geometry helpers ─────────────────────────

const n = (value: number): string => String(Math.round(value * 100) / 100);

/** Rounded rectangle as a path. */
function rr(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + h - r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}V${n(y + r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`
  );
}

/** Capsule centred on x = 50 — collars and plinths (Гамбитик stands on the same pill pedestal). */
function pill(half: number, y: number, h: number): string {
  return rr(50 - half, y, half * 2, h, h / 2);
}

function circle(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx - r)} ${n(cy)}Z`;
}

/** Concave, flared skirt between a collar (half-width `a` at y0) and the plinth (half-width `b` at y1). */
function skirt(y0: number, a: number, y1: number, b: number): string {
  const h = y1 - y0;
  const c1 = y0 + 0.5 * h;
  const c2 = y1 - 0.22 * h;
  const k = 0.35 * (b - a);
  return (
    `M${n(50 - a)} ${n(y0)}C${n(50 - a)} ${n(c1)} ${n(50 - b + k)} ${n(c2)} ${n(50 - b)} ${n(y1)}` +
    `H${n(50 + b)}C${n(50 + b - k)} ${n(c2)} ${n(50 + a)} ${n(c1)} ${n(50 + a)} ${n(y0)}Z`
  );
}

/**
 * A band just inside one edge of `skirt(...)` (side 1 = right, -1 = left): `inset` from the edge, `t` wide.
 * Its ends run under the collar and the plinth, which are drawn after it.
 */
function skirtBand(y0: number, a: number, y1: number, b: number, inset: number, t: number, side: 1 | -1): string {
  const h = y1 - y0;
  const c1 = y0 + 0.5 * h;
  const c2 = y1 - 0.22 * h;
  const k = 0.35 * (b - a);
  const x = (dx: number): string => n(50 + side * dx);
  const o = inset;
  const i = inset + t;
  return (
    `M${x(a - o)} ${n(y0)}C${x(a - o)} ${n(c1)} ${x(b - k - o)} ${n(c2)} ${x(b - o)} ${n(y1)}` +
    `H${x(b - i)}C${x(b - k - i)} ${n(c2)} ${x(a - i)} ${n(c1)} ${x(a - i)} ${n(y0)}Z`
  );
}

/**
 * Crescent inside a circle (cx, cy, R): the part of the circle NOT covered by the same circle shifted by `d`
 * towards (lx, ly). With the light direction it is a shadow; with the opposite direction, a highlight.
 */
function crescent(cx: number, cy: number, R: number, d: number, lx: number, ly: number): string {
  const len = Math.hypot(lx, ly);
  const ux = lx / len;
  const uy = ly / len;
  const mx = cx + (d / 2) * ux;
  const my = cy + (d / 2) * uy;
  const h = Math.sqrt(R * R - (d * d) / 4);
  const vx = -uy;
  const vy = ux;
  const p1 = [mx + h * vx, my + h * vy];
  const p2 = [mx - h * vx, my - h * vy];
  return `M${n(p1[0]!)} ${n(p1[1]!)}A${n(R)} ${n(R)} 0 1 1 ${n(p2[0]!)} ${n(p2[1]!)}A${n(R)} ${n(R)} 0 0 0 ${n(p1[0]!)} ${n(p1[1]!)}Z`;
}

/**
 * Scale an absolute path (M L H V C Q A Z only) by `s` around (ox, oy), then move it by (dx, 0).
 * Used to fit the knight — drawn on a roomier grid — to the same footprint as the other pieces.
 */
function scalePath(d: string, s: number, ox: number, oy: number, dx = 0): string {
  const X = (v: number): string => n(ox + (v - ox) * s + dx);
  const Y = (v: number): string => n(oy + (v - oy) * s);
  let out = '';
  for (const [, cmd, args] of d.matchAll(/([MLHVCQAZ])([^MLHVCQAZ]*)/g)) {
    const v = (args ?? '').trim() === '' ? [] : (args ?? '').trim().split(/[\s,]+/).map(Number);
    switch (cmd) {
      case 'H':
        out += `H${v.map(X).join(' ')}`;
        break;
      case 'V':
        out += `V${v.map(Y).join(' ')}`;
        break;
      case 'A':
        for (let i = 0; i + 6 < v.length + 1; i += 7) {
          out += `A${n(v[i]! * s)} ${n(v[i + 1]! * s)} ${v[i + 2]} ${v[i + 3]} ${v[i + 4]} ${X(v[i + 5]!)} ${Y(v[i + 6]!)}`;
        }
        break;
      case 'Z':
        out += 'Z';
        break;
      default: {
        const pts: string[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push(`${X(v[i]!)} ${Y(v[i + 1]!)}`);
        out += `${cmd}${pts.join(' ')}`;
      }
    }
  }
  return out;
}

// ───────────────────────── shapes ─────────────────────────

type Paint = keyof PiecePalette;

/**
 * One <path> of a piece: `outlined` parts carry the shared outline, `flat` parts are fills only (tone, door, eye,
 * inner ear), `mark` parts are open round-capped strokes (the bishop slit). `only` limits a part to one army.
 */
interface Part {
  d: string;
  paint: Paint;
  kind: 'outlined' | 'flat' | 'mark';
  width?: number;
  only?: PieceColor;
}

const part = (d: string, paint: Paint = 'body'): Part => ({ d, paint, kind: 'outlined' });
const rim = (d: string): Part => part(d, 'rim');
const flat = (d: string, paint: Paint, only?: PieceColor): Part => ({ d, paint, kind: 'flat', only });
const mark = (d: string, paint: Paint, width: number): Part => ({ d, paint, kind: 'mark', width });
/** the one tonal shape: pass the ivory shadow (right) and the dark highlight (left) */
const tones = (shadow: string, highlight: string): Part[] => [flat(shadow, 'tone', 'w'), flat(highlight, 'tone', 'b')];

const plinth = (half: number): Part => rim(pill(half, 80, 11));

/** Light comes from the top-left: shadows fall to the lower right, highlights sit on the upper left. */
const LIGHT: readonly [number, number] = [-0.6, -0.8];
const shadeOf = (cx: number, cy: number, R: number, d: number): string => crescent(cx, cy, R, d, LIGHT[0], LIGHT[1]);
const litOf = (cx: number, cy: number, R: number, d: number): string => crescent(cx, cy, R, d, -LIGHT[0], -LIGHT[1]);

// Pawn — a big round head on a collar and a flared skirt.
const PAWN: Part[] = [
  part(skirt(55, 9.5, 80.5, 21)),
  part(circle(50, 32.5, 16.5)),
  ...tones(shadeOf(50, 32.5, 13.3, 5) + skirtBand(55, 9.5, 80.5, 21, 3.4, 4.5, 1), litOf(50, 32.5, 13.3, 4.4) + skirtBand(55, 9.5, 80.5, 21, 3.4, 3.5, -1)),
  rim(pill(19, 47, 9)),
  plinth(26),
];

// Rook — a castle tower: three merlons, a rim string-course and a tapered body with a small arched door.
const ROOK: Part[] = [
  part('M30.5 44H69.5L72.5 80.5H27.5Z'),
  part('M21 17.5Q21 15 23.5 15H32.5Q35 15 35 17.5V25H44V17.5Q44 15 46.5 15H53.5Q56 15 56 17.5V25H65V17.5Q65 15 67.5 15H76.5Q79 15 79 17.5V37L73 44H27L21 37Z'),
  ...tones('M64.5 47H67L69.3 80.5H66.2ZM71 19H75.2V35.5L71 39.5Z', 'M35.5 47H33L30.7 80.5H33.8ZM29 19H24.8V35.5L29 39.5Z'),
  flat('M44.5 81V72A5.5 5.5 0 0 1 55.5 72V81Z', 'door'),
  rim(pill(25, 39.5, 8.5)),
  plinth(29.5),
];

// Bishop — a pointed mitre with a diagonal slit and a ball finial.
const BISHOP: Part[] = [
  part(skirt(63, 9, 80.5, 22)),
  part(circle(50, 16.8, 6.4)),
  part('M50 21C60.5 27 69.5 34.5 69.5 46C69.5 55.5 60.5 61.5 50 61.5C39.5 61.5 30.5 55.5 30.5 46C30.5 34.5 39.5 27 50 21Z'),
  ...tones(shadeOf(50, 46, 15.5, 5) + skirtBand(63, 9, 80.5, 22, 3.4, 4.5, 1), litOf(50, 46, 15.5, 4.4) + skirtBand(63, 9, 80.5, 22, 3.4, 3.5, -1)),
  mark('M60.8 30.5L47.8 44.5', 'detail', 5),
  rim(pill(16, 57, 8.5)),
  plinth(28),
];

// Queen — a V coronet with five well-separated balls (they never merge into a fringe, even at 32 px).
const QUEEN: Part[] = [
  part(skirt(63, 10, 80.5, 24)),
  part(
    'M37 61L21.5 30.5C26 34 29.5 36.5 32.5 38.5L35 23C38.5 27.5 41.5 30.5 44.5 33L50 18.5L55.5 33C58.5 30.5 61.5 27.5 65 23L67.5 38.5C70.5 36.5 74 34 78.5 30.5L63 61Z',
  ),
  rim(circle(20.5, 28.5, 5.6) + circle(34.5, 20.5, 5.6) + circle(50, 14.8, 6.1) + circle(65.5, 20.5, 5.6) + circle(79.5, 28.5, 5.6)),
  ...tones(
    'M60 58L66.2 41.5L71.5 37.5L61.5 58Z' + skirtBand(63, 10, 80.5, 24, 3.4, 4.8, 1),
    'M40 58L33.8 41.5L28.5 37.5L38.5 58Z' + skirtBand(63, 10, 80.5, 24, 3.4, 3.8, -1),
  ),
  rim(pill(17.5, 57, 8.5)),
  plinth(30),
];

// King — a crown that flares like a cup, a rim band, an orb dome and a chunky cross: never a mitre, never a coronet.
const KING: Part[] = [
  part(skirt(64, 10, 80.5, 24)),
  part('M45 7H55V10.5H61Q62.5 10.5 62.5 12V17.5Q62.5 19 61 19H55V28H45V19H39Q37.5 19 37.5 17.5V12Q37.5 10.5 39 10.5H45Z'),
  part('M31.5 38C31.5 29.5 39.5 24 50 24C60.5 24 68.5 29.5 68.5 38Z'),
  part('M38 61C33.5 56 29 49.5 27.5 42H72.5C71 49.5 66.5 56 62 61Z'),
  ...tones(
    'M57.5 27.4C62.6 29.2 65.6 33 65.6 38H61.8C61.8 33.6 60.3 30.2 57.5 27.4Z' +
      'M60.5 58.5C64.5 54 67.8 49.5 69.3 45H65.8C64.6 49.5 61.8 53.5 58.5 57.5Z' +
      skirtBand(64, 10, 80.5, 24, 3.4, 4.8, 1),
    'M42.5 27.4C37.4 29.2 34.4 33 34.4 38H38.2C38.2 33.6 39.7 30.2 42.5 27.4Z' +
      'M39.5 58.5C35.5 54 32.2 49.5 30.7 45H34.2C35.4 49.5 38.2 53.5 41.5 57.5Z' +
      skirtBand(64, 10, 80.5, 24, 3.4, 3.8, -1),
  ),
  rim(pill(25.5, 35.5, 8.5)),
  rim(pill(17.5, 58, 8.5)),
  plinth(30),
];

// Knight — drawn on a roomier grid, then fitted by `kn` (scale 0.95 around the middle of the plinth top).
const kn = (d: string): string => scalePath(d, 0.95, 50, 80.5, 0.5);
const KNIGHT: Part[] = [
  // scalloped mane behind the neck (its inner edge hides under the head)
  part(kn('M52 16C59 10.5 68.5 12 72 19C79 19.5 84.5 26 83.5 33.5C89 38 90 47 85.5 53C90 58.5 89.5 67.5 83.5 71.5C83 75 81.5 78.5 78.5 80.5H66L60 30Z'), 'mane'),
  // head and neck, facing left: foal muzzle, one pointed ear
  part(
    kn(
      'M27 80.5C26 71 29.5 64.5 38.5 59.5C33 61.5 26.5 62.5 20 61.5C11.5 60.5 7 55 8 48.5C9 42.5 13.5 38.5 19.5 37C23 31 28 25.5 34 22.5C36.5 21 39 20 41.5 19.5C41 13.5 43.5 9 48 6C52.5 9.5 55 13.5 55.5 18C67 19.5 75 27 77 38.5C79 51 78 66 76 80.5Z',
    ),
  ),
  ...tones(
    kn('M70 40C71.8 52 71.5 66 70 80.5H73C74.5 66 74.8 52 73.3 41C72.8 38 71.8 36 70.5 35Z'),
    kn('M22.5 41C25.5 35.5 29.5 31 34.5 28L35.8 30.8C31.2 33.2 27.8 37 25.8 42Z'),
  ),
  flat(kn('M48 11C46 13.5 45 16 45 19C47 18.6 49.5 18.6 51.5 19C51.5 16 50.5 13.5 48 11Z'), 'ear'),
  // two-lobed forelock, like Гамбитик's
  part(kn('M45.5 21C43.5 16 38 14 33 16.5C30 18 28.5 21 29 24.5C31 22.5 33.5 22 35.8 22.6C35.8 24.3 36.6 25.8 38.3 27C39.2 24.5 41.4 22.4 45.5 21Z'), 'mane'),
  flat(kn('M33.6 34.5A3 3.8 0 1 0 39.6 34.5A3 3.8 0 1 0 33.6 34.5Z'), 'detail'),
  plinth(29.5),
];

const SHAPES: Record<PieceKind, Part[]> = { P: PAWN, N: KNIGHT, B: BISHOP, R: ROOK, Q: QUEEN, K: KING };

// ───────────────────────── rendering ─────────────────────────

export interface SvgElementSpec {
  tag: 'path';
  attrs: Record<string, string | number>;
}

export function isPieceCode(code: string): code is PieceCode {
  return (GAMBIT_PIECE_CODES as readonly string[]).includes(code);
}

/** Resolved SVG elements (attribute names in SVG spelling) for a piece code like 'wN'. Unknown codes → []. */
export function gambitPieceElements(code: string): SvgElementSpec[] {
  if (!isPieceCode(code)) return [];
  const color = code[0] as PieceColor;
  const palette = GAMBIT_PIECE_PALETTE[color];
  return SHAPES[code[1] as PieceKind]
    .filter((p) => p.only === undefined || p.only === color)
    .map((p): SvgElementSpec => {
      const colour = palette[p.paint];
      switch (p.kind) {
        case 'outlined':
          return { tag: 'path', attrs: { d: p.d, fill: colour, stroke: palette.line, 'stroke-width': GAMBIT_STROKE, 'stroke-linejoin': 'round' } };
        case 'mark':
          return { tag: 'path', attrs: { d: p.d, fill: 'none', stroke: colour, 'stroke-width': p.width ?? GAMBIT_STROKE, 'stroke-linecap': 'round' } };
        case 'flat':
          return { tag: 'path', attrs: { d: p.d, fill: colour } };
      }
    });
}

const NAMES_RU: Record<PieceKind, readonly [string, string]> = {
  P: ['белая пешка', 'чёрная пешка'],
  N: ['белый конь', 'чёрный конь'],
  B: ['белый слон', 'чёрный слон'],
  R: ['белая ладья', 'чёрная ладья'],
  Q: ['белый ферзь', 'чёрный ферзь'],
  K: ['белый король', 'чёрный король'],
};

/** Russian accessible name, e.g. «белый конь». Empty string for an unknown code. */
export function gambitPieceLabel(code: string): string {
  if (!isPieceCode(code)) return '';
  return NAMES_RU[code[1] as PieceKind][code[0] === 'w' ? 0 : 1];
}

const escapeAttr = (value: string | number): string => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Standalone SVG markup for one piece (viewBox 0 0 100 100, fills its box). Unknown codes give an empty SVG. */
export function gambitPieceSvg(code: string): string {
  const label = gambitPieceLabel(code);
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%"`;
  if (!label) return `${open}></svg>`;
  const children = gambitPieceElements(code)
    .map((el) => `<${el.tag} ${Object.entries(el.attrs).map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(' ')}/>`)
    .join('');
  return `${open} role="img" aria-label="${label}">${children}</svg>`;
}
