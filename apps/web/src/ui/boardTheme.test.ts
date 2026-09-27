import { describe, expect, it } from 'vitest';
import { ARROW_COLORS, BOARD_THEMES, DEFAULT_BOARD_THEME, HIGHLIGHT_COLORS, boardThemeStyles, buildArrows, buildSquareStyles, highlightStyle, legalTargetStyle } from './boardTheme.ts';

const RGBA = /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0(\.\d+)?|1)\)$/;

describe('boardTheme', () => {
  it('uses the calm mint board by default', () => {
    expect(DEFAULT_BOARD_THEME.lightSquare).toBe('#F3EBD8');
    expect(DEFAULT_BOARD_THEME.darkSquare).toBe('#8CB8A8');
    expect(Object.keys(BOARD_THEMES)).toEqual(['mint', 'sky', 'lavender', 'tournament']);
  });

  it('exposes rgba colours for all four annotation colours, all different', () => {
    for (const map of [HIGHLIGHT_COLORS, ARROW_COLORS]) {
      const values = [map.green, map.red, map.yellow, map.blue];
      for (const v of values) expect(v).toMatch(RGBA);
      expect(new Set(values).size).toBe(4);
    }
  });

  it('distinguishes highlights by shape as well as colour', () => {
    expect(highlightStyle('yellow').boxShadow).toBeUndefined();
    expect(highlightStyle('blue').background).toBeUndefined();
    expect(highlightStyle('green', 6).boxShadow).toContain('inset 0 0 0 6px');
    expect(highlightStyle('red').borderRadius).toBe('50%');
  });

  it('draws a dot for quiet moves and a ring for captures', () => {
    expect(String(legalTargetStyle(false).background)).toContain('0 27%');
    expect(String(legalTargetStyle(true).background)).toContain('transparent 0 58%');
  });

  it('merges marks per square; coach highlights win over the last move', () => {
    const styles = buildSquareStyles({
      lastMove: { from: 'e2', to: 'e4' },
      selected: 'g1',
      legalTargets: [{ square: 'f3', capture: false }],
      checkSquare: 'e8',
      annotations: { highlights: [{ square: 'e4', color: 'red' }] },
      ringPx: 4,
    });
    expect(Object.keys(styles).sort()).toEqual(['e2', 'e4', 'e8', 'f3', 'g1']);
    expect(styles.e2?.background).toBe('rgba(255, 210, 63, 0.45)');
    expect(styles.e4?.background).toBe(HIGHLIGHT_COLORS.red);
    expect(styles.e4?.boxShadow).toContain('4px');
    expect(styles.g1?.boxShadow).toContain('#0F6F69');
    expect(buildSquareStyles({})).toEqual({});
  });

  it('converts coach arrows to the react-chessboard v5 shape', () => {
    expect(buildArrows({ arrows: [{ from: 'g1', to: 'f3', color: 'green' }] })).toEqual([{ startSquare: 'g1', endSquare: 'f3', color: ARROW_COLORS.green }]);
    expect(buildArrows(null)).toEqual([]);
  });

  it('builds option styles for a theme', () => {
    const s = boardThemeStyles(BOARD_THEMES.sky);
    expect(s.lightSquareStyle.backgroundColor).toBe('#EAF2FB');
    expect(s.darkSquareStyle.backgroundColor).toBe('#8FB4DC');
  });
});
