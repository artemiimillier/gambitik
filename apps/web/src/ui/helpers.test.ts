import { afterEach, describe, expect, it } from 'vitest';
import { parseHex, shade, toHex, withAlpha } from './color.ts';
import { celebrate, planCelebration } from './confetti.ts';
import { cx } from './cx.ts';
import { getReducedMotionOverride, prefersReducedMotion, setReducedMotion } from './motion.ts';
import { pluralRu } from './plural.ts';

describe('color helpers', () => {
  it('parses short and long hex', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('26304F')).toEqual([38, 48, 79]);
    expect(parseHex('teal')).toBeNull();
  });

  it('shades towards black or white and survives bad input', () => {
    expect(shade('#808080', -1)).toBe('#000000');
    expect(shade('#808080', 1)).toBe('#ffffff');
    expect(shade('#204060', 0)).toBe('#204060');
    expect(shade('#ff0000', -0.5)).toBe('#800000');
    expect(shade('tomato', -0.5)).toBe('tomato');
    expect(toHex([300, -5, 127.6])).toBe('#ff0080');
  });

  it('adds alpha', () => {
    expect(withAlpha('#0F6F69', 0.5)).toBe('rgba(15, 111, 105, 0.5)');
    expect(withAlpha('#000', 4)).toBe('rgba(0, 0, 0, 1)');
  });
});

describe('pluralRu', () => {
  it('follows Russian plural rules', () => {
    const f = (n: number) => pluralRu(n, 'год', 'года', 'лет');
    expect([1, 2, 4, 5, 6, 11, 12, 14, 15, 17, 21, 22, 25, 101, 111].map(f)).toEqual(['год', 'года', 'года', 'лет', 'лет', 'лет', 'лет', 'лет', 'лет', 'лет', 'год', 'года', 'лет', 'год', 'лет']);
  });
});

describe('cx', () => {
  it('joins truthy parts', () => {
    expect(cx('a', false, undefined, 'b', null, '')).toBe('a b');
    expect(cx()).toBe('');
  });
});

describe('reduced motion', () => {
  afterEach(() => setReducedMotion(null));

  it('defaults to false outside the browser and honours the override', () => {
    expect(prefersReducedMotion()).toBe(false);
    setReducedMotion(true);
    expect(getReducedMotionOverride()).toBe(true);
    expect(prefersReducedMotion()).toBe(true);
    setReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('celebrate() reports false (show a static star) when motion is reduced or there is no DOM', async () => {
    setReducedMotion(true);
    await expect(celebrate('win')).resolves.toBe(false);
    setReducedMotion(null);
    await expect(celebrate('star')).resolves.toBe(false);
  });
});

describe('planCelebration', () => {
  it('plans modest bursts from the app palette', () => {
    const win = planCelebration('win');
    expect(win).toHaveLength(3);
    expect(win.every((b) => (b.options.particleCount ?? 0) <= 100)).toBe(true);
    expect(planCelebration('star', { x: 0.2, y: 0.3 })[0]?.options.origin).toEqual({ x: 0.2, y: 0.3 });
    const stage = planCelebration('stage');
    expect(Math.max(...stage.map((b) => b.delayMs))).toBeLessThanOrEqual(2500);
  });
});
