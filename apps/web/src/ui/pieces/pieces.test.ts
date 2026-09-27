import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BOARD_THEMES } from '../boardTheme.ts';
import { GAMBIT_PIECE_CODES, GAMBIT_PIECE_PALETTE, PieceIcon, gambitPieceElements, gambitPieceLabel, gambitPieceSvg, gambitPieces } from './index.ts';

const EXPECTED_KEYS = ['bB', 'bK', 'bN', 'bP', 'bQ', 'bR', 'wB', 'wK', 'wN', 'wP', 'wQ', 'wR'];

// ── tiny helpers ──

/** Minimal XML well-formedness check: one root, balanced tags, quoted unique attributes, escaped text. */
function isWellFormedXml(xml: string): boolean {
  const entity = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/;
  const token = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  const stack: string[] = [];
  let roots = 0;
  let pos = 0;
  for (const m of xml.matchAll(token)) {
    if (m.index !== pos) return false;
    pos = m.index + m[0].length;
    const [, close, name, attrs = '', selfClose, text, stray] = m;
    if (stray) return false;
    if (text !== undefined) {
      if ((stack.length === 0 && text.trim() !== '') || entity.test(text)) return false;
      continue;
    }
    if (entity.test(attrs)) return false;
    const names = [...attrs.matchAll(/([\w:.-]+)="/g)].map((a) => a[1]);
    if (new Set(names).size !== names.length) return false;
    if (close) {
      if (attrs !== '' || selfClose || stack.pop() !== name) return false;
      if (stack.length === 0) roots += 1;
    } else if (selfClose) {
      if (stack.length === 0) roots += 1;
    } else {
      stack.push(name!);
    }
  }
  return pos === xml.length && stack.length === 0 && roots === 1;
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const render = (code: string, props?: Parameters<NonNullable<(typeof gambitPieces)[string]>>[0]): string =>
  renderToStaticMarkup(gambitPieces[code]!(props));

/** Children of the root <svg>, with React's `<path …></path>` folded into `<path …/>`. */
const inner = (svg: string): string => svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '').replace(/><\/path>/g, '/>');

// ── tests ──

describe('gambitPieces (react-chessboard 5.12.1 contract)', () => {
  it('has exactly the twelve piece keys', () => {
    expect(Object.keys(gambitPieces).sort()).toEqual(EXPECTED_KEYS);
    expect([...GAMBIT_PIECE_CODES].sort()).toEqual(EXPECTED_KEYS);
  });

  it.each(EXPECTED_KEYS)('%s renders a 100×100 svg that fills its box and passes svgStyle through', (code) => {
    const html = render(code, { square: 'e4', svgStyle: { opacity: 0.5 } });
    expect(html).toMatch(/^<svg[^>]*viewBox="0 0 100 100"/);
    expect(html).toContain('width="100%"');
    expect(html).toContain('height="100%"');
    expect(html).toContain('opacity:0.5');
    expect(html).toContain(`aria-label="${gambitPieceLabel(code)}"`);
    expect(html).not.toMatch(/<(defs|filter|linearGradient|radialGradient|clipPath|mask|image|use)\b/);
  });

  it.each(EXPECTED_KEYS)('%s stays within the element budget and matches the string renderer', (code) => {
    const react = render(code);
    const plain = gambitPieceSvg(code);
    const count = (react.match(/<path\b/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(5);
    expect(count).toBeLessThanOrEqual(12);
    expect(count).toBe(gambitPieceElements(code).length);
    expect(inner(react)).toBe(inner(plain));
  });

  it('renders without the optional props react-chessboard may omit', () => {
    for (const code of EXPECTED_KEYS) expect(render(code)).toMatch(/^<svg/);
  });
});

describe('gambitPieceSvg (string renderer)', () => {
  it('the XML checker itself rejects broken markup', () => {
    expect(isWellFormedXml('<svg><path d="M0 0Z"/></svg>')).toBe(true);
    expect(isWellFormedXml('<svg><path d="M0 0Z"></svg>')).toBe(false);
    expect(isWellFormedXml('<svg a="1" a="2"></svg>')).toBe(false);
    expect(isWellFormedXml('<svg>&</svg>')).toBe(false);
    expect(isWellFormedXml('<svg/><svg/>')).toBe(false);
  });

  it.each(EXPECTED_KEYS)('%s is well-formed SVG with the 100×100 viewBox and a Russian label', (code) => {
    const svg = gambitPieceSvg(code);
    expect(isWellFormedXml(svg)).toBe(true);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100"/);
    expect(svg).toContain(`aria-label="${gambitPieceLabel(code)}"`);
    expect(svg).not.toMatch(/\bid="/);
  });

  it('gives an empty, still well-formed svg for an unknown code', () => {
    const svg = gambitPieceSvg('xZ');
    expect(isWellFormedXml(svg)).toBe(true);
    expect(svg).not.toContain('<path');
    expect(gambitPieceLabel('xZ')).toBe('');
  });

  it('names the pieces in Russian', () => {
    expect(gambitPieceLabel('wN')).toBe('белый конь');
    expect(gambitPieceLabel('bQ')).toBe('чёрный ферзь');
    expect(gambitPieceLabel('wP')).toBe('белая пешка');
  });
});

describe('many instances on one page', () => {
  it('never produces duplicate ids (two boards + icons)', () => {
    const twice = (): ReturnType<typeof createElement>[] =>
      EXPECTED_KEYS.flatMap((code) => [gambitPieces[code]!({ square: 'a1' }), createElement(PieceIcon, { code, size: 24 })]);
    const html = renderToStaticMarkup(createElement(Fragment, null, ...twice(), ...twice()));
    const ids = [...html.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([]);
  });
});

describe('PieceIcon', () => {
  it('renders one piece at the requested size with its Russian name', () => {
    const html = renderToStaticMarkup(createElement(PieceIcon, { code: 'wN', size: 28 }));
    expect(html).toMatch(/^<svg[^>]*viewBox="0 0 100 100"/);
    expect(html).toContain('width="28"');
    expect(html).toContain('height="28"');
    expect(html).toContain('aria-label="белый конь"');
    expect(inner(html)).toBe(inner(gambitPieceSvg('wN')));
  });

  it('can be decorative and renders nothing for an unknown code', () => {
    const decorative = renderToStaticMarkup(createElement(PieceIcon, { code: 'bK', label: '' }));
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain('aria-label');
    expect(renderToStaticMarkup(createElement(PieceIcon, { code: 'nope' }))).toBe('');
  });
});

describe('palette readability', () => {
  const { w, b } = GAMBIT_PIECE_PALETTE;
  const squares = Object.values(BOARD_THEMES).flatMap((theme) => [
    [`${theme.id} light`, theme.lightSquare],
    [`${theme.id} dark`, theme.darkSquare],
  ]) as [string, string][];

  it('white and black bodies differ by value, not only by hue (≥ 3:1)', () => {
    expect(contrast(w.body, b.body)).toBeGreaterThanOrEqual(3);
  });

  it.each(squares)('both outlines stand out on the %s square (≥ 3:1)', (_name, square) => {
    expect(contrast(w.line, square)).toBeGreaterThanOrEqual(3);
    expect(contrast(b.line, square)).toBeGreaterThanOrEqual(3);
  });

  it('keeps the white outline near 7:1 even on the darkest square of any theme', () => {
    for (const [, square] of squares) expect(contrast(w.line, square)).toBeGreaterThanOrEqual(6.5);
  });

  it('keeps the rims apart from the bodies, so the turned-wood grooves survive at 32 px', () => {
    expect(contrast(w.rim, w.body)).toBeGreaterThanOrEqual(1.25);
    expect(contrast(b.rim, b.body)).toBeGreaterThanOrEqual(2);
    expect(contrast(b.rim, b.line)).toBeGreaterThanOrEqual(3);
  });
});
