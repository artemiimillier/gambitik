import { coachStylesFor } from '@gambit/core';
import { PERSONA_IDS, TIME_CONTROL_IDS } from '@gambit/shared';
import type { CoachStyle, TimeControlId } from '@gambit/shared';
import { describe, expect, it } from 'vitest';
import { COACH_STYLES, HOME_ROUTE, ROUTER_UNKNOWN_STAGE, allowedCoachStyle, formatRoute, isCoachStyle, normalizeTheme, parseHash, playRoute, sameRoute } from './router.ts';
import type { Route } from './router.ts';

/** The styles a valid #/play route can carry for a time control: the offered ones, or the harmless 'helper' in bullet. */
function validStyles(tc: TimeControlId): CoachStyle[] {
  const offered = coachStylesFor(tc);
  return offered.length > 0 ? offered : ['helper'];
}

const ALL_ROUTES: Route[] = [
  { name: 'home' },
  { name: 'new' },
  { name: 'play', personaId: 'petya', timeControlId: 'training', childColor: 'w', coachStyle: 'teacher', examMode: false },
  { name: 'play', personaId: 'sonya', timeControlId: 'rapid10', childColor: 'b', coachStyle: 'exam', examMode: true },
  { name: 'play', personaId: 'vika', timeControlId: 'blitz5', childColor: 'w', coachStyle: 'helper', examMode: false },
  { name: 'play', personaId: 'dima', timeControlId: 'bullet1', childColor: 'b', coachStyle: 'helper', examMode: false },
  { name: 'review', gameId: '2026-09-21_0930_vs-sonya' },
  { name: 'review', gameId: 'id with spaces/slash?and#hash&amp=1' },
  { name: 'review', gameId: 'партия-7' },
  { name: 'puzzles' },
  { name: 'puzzles', theme: 'fork' },
  { name: 'puzzles', theme: 'mateIn2' },
  { name: 'puzzles', warmup: true },
  { name: 'puzzles', theme: 'fork', warmup: true },
  { name: 'progress' },
  { name: 'path' },
  { name: 'settings' },
  { name: 'playground', tool: 'mascot' },
  { name: 'playground', tool: 'ui' },
];

describe('hash router', () => {
  it('round-trips every route: parseHash(formatRoute(r)) equals r', () => {
    for (const route of ALL_ROUTES) {
      expect(parseHash(formatRoute(route)), formatRoute(route)).toEqual(route);
    }
  });

  it('round-trips every persona × time control × colour × offered coach style', () => {
    let count = 0;
    for (const personaId of PERSONA_IDS) {
      for (const timeControlId of TIME_CONTROL_IDS) {
        for (const childColor of ['w', 'b'] as const) {
          for (const coachStyle of validStyles(timeControlId)) {
            const route: Route = { name: 'play', personaId, timeControlId, childColor, coachStyle, examMode: coachStyle === 'exam' };
            expect(parseHash(formatRoute(route))).toEqual(route);
            count += 1;
          }
        }
      }
    }
    // 8 personas × 2 colours × (3 training + 3 rapid10 + 3 blitz5 + 1 bullet) — 5 minutes has the teacher too
    expect(count).toBe(8 * 2 * 10);
  });

  it('formats canonical hashes', () => {
    expect(formatRoute({ name: 'home' })).toBe('#/');
    expect(formatRoute({ name: 'new' })).toBe('#/new');
    expect(formatRoute({ name: 'play', personaId: 'vika', timeControlId: 'blitz5', childColor: 'b', coachStyle: 'exam', examMode: true })).toBe('#/play?persona=vika&tc=blitz5&color=b&coach=exam');
    expect(formatRoute({ name: 'play', personaId: 'petya', timeControlId: 'training', childColor: 'w', coachStyle: 'teacher', examMode: false })).toBe(
      '#/play?persona=petya&tc=training&color=w&coach=teacher',
    );
    expect(formatRoute({ name: 'play', personaId: 'petya', timeControlId: 'rapid10', childColor: 'w', coachStyle: 'helper', examMode: false })).toBe(
      '#/play?persona=petya&tc=rapid10&color=w&coach=helper',
    );
    expect(formatRoute({ name: 'review', gameId: 'a b' })).toBe('#/review/a%20b');
    expect(formatRoute({ name: 'puzzles', theme: 'pin' })).toBe('#/puzzles?theme=pin');
    expect(formatRoute({ name: 'puzzles' })).toBe('#/puzzles');
    // the three-puzzle warm-up of the today plan
    expect(formatRoute({ name: 'puzzles', warmup: true })).toBe('#/puzzles?warmup=1');
    expect(formatRoute({ name: 'puzzles', warmup: false })).toBe('#/puzzles');
    expect(parseHash('#/puzzles?warmup=1')).toEqual({ name: 'puzzles', warmup: true });
    expect(parseHash('#/puzzles?warmup=yes')).toEqual({ name: 'puzzles' });
    expect(formatRoute({ name: 'path' })).toBe('#/path');
    expect(formatRoute({ name: 'playground', tool: 'mascot' })).toBe('#/playground');
    expect(formatRoute({ name: 'playground', tool: 'ui' })).toBe('#/playground?tool=ui');
  });

  it('formatting is stable: format(parse(format(r))) === format(r)', () => {
    for (const route of ALL_ROUTES) {
      const hash = formatRoute(route);
      expect(formatRoute(parseHash(hash))).toBe(hash);
    }
  });

  it('treats an empty or bare hash as home', () => {
    for (const hash of ['', '#', '#/', '/', '#//']) expect(parseHash(hash)).toEqual(HOME_ROUTE);
  });

  it('is tolerant about the leading "#" and "/" and about trailing slashes', () => {
    expect(parseHash('settings')).toEqual({ name: 'settings' });
    expect(parseHash('/settings')).toEqual({ name: 'settings' });
    expect(parseHash('#settings')).toEqual({ name: 'settings' });
    expect(parseHash('#/settings/')).toEqual({ name: 'settings' });
    expect(parseHash('#/progress?utm=1')).toEqual({ name: 'progress' });
  });

  it('sends unknown or over-long paths home — never a dead end', () => {
    for (const hash of ['#/nope', '#/new/extra', '#/settings/voice', '#/review', '#/review/a/b', '#/review/%20', '#/review/%E0%A4%A', '#/puzzles/fork', '#/play/now']) {
      expect(parseHash(hash), hash).toEqual(HOME_ROUTE);
    }
    expect(parseHash(`#/review/${'x'.repeat(200)}`)).toEqual(HOME_ROUTE);
  });

  it('turns a broken #/play link into the wizard instead of guessing an opponent', () => {
    expect(parseHash('#/play')).toEqual({ name: 'new' });
    expect(parseHash('#/play?persona=kasparov&tc=blitz5')).toEqual({ name: 'new' });
    expect(parseHash('#/play?persona=petya&tc=classical')).toEqual({ name: 'new' });
    expect(parseHash('#/play?persona=petya')).toEqual({ name: 'new' });
    expect(parseHash('#/play?persona=__proto__&tc=constructor')).toEqual({ name: 'new' });
  });

  it('defaults the optional play parameters: white, «Подсказчик» (the behaviour before teacher mode)', () => {
    expect(parseHash('#/play?persona=petya&tc=rapid10')).toEqual({ name: 'play', personaId: 'petya', timeControlId: 'rapid10', childColor: 'w', coachStyle: 'helper', examMode: false });
    expect(parseHash('#/play?persona=petya&tc=rapid10&color=random&exam=yes')).toEqual({
      name: 'play',
      personaId: 'petya',
      timeControlId: 'rapid10',
      childColor: 'w',
      coachStyle: 'helper',
      examMode: false,
    });
    expect(parseHash('#/play?persona=petya&tc=rapid10&coach=boss')).toMatchObject({ coachStyle: 'helper', examMode: false });
    expect(parseHash('#/play?persona=petya&tc=rapid10&coach=TEACHER')).toMatchObject({ coachStyle: 'helper' });
  });

  it('reads coach=teacher|helper|exam; examMode is derived from it', () => {
    for (const coachStyle of COACH_STYLES) {
      expect(parseHash(`#/play?persona=petya&tc=training&color=b&coach=${coachStyle}`)).toEqual({
        name: 'play',
        personaId: 'petya',
        timeControlId: 'training',
        childColor: 'b',
        coachStyle,
        examMode: coachStyle === 'exam',
      });
    }
  });

  it('keeps old links working: exam=1 means «Экзамен», exam=0 means «Подсказчик»', () => {
    expect(parseHash('#/play?tc=rapid10&exam=1&color=b&persona=nika')).toEqual({
      name: 'play',
      personaId: 'nika',
      timeControlId: 'rapid10',
      childColor: 'b',
      coachStyle: 'exam',
      examMode: true,
    });
    expect(parseHash('#/play?persona=petya&tc=blitz5&color=w&exam=1')).toMatchObject({ coachStyle: 'exam', examMode: true });
    // the links of the e2e suite and the voice smoke tools
    expect(parseHash('#/play?persona=petya&tc=training&color=w&exam=0')).toEqual({
      name: 'play',
      personaId: 'petya',
      timeControlId: 'training',
      childColor: 'w',
      coachStyle: 'helper',
      examMode: false,
    });
    // an old link becomes the canonical new one (App.tsx rewrites the address bar with it)
    expect(formatRoute(parseHash('#/play?persona=petya&tc=rapid10&color=w&exam=1'))).toBe('#/play?persona=petya&tc=rapid10&color=w&coach=exam');
    expect(formatRoute(parseHash('#/play?persona=petya&tc=training&color=w&exam=0'))).toBe('#/play?persona=petya&tc=training&color=w&coach=helper');
    // coach= wins over a stale exam= next to it
    expect(parseHash('#/play?persona=petya&tc=training&coach=teacher&exam=1')).toMatchObject({ coachStyle: 'teacher', examMode: false });
    expect(parseHash('#/play?persona=petya&tc=training&coach=exam&exam=0')).toMatchObject({ coachStyle: 'exam', examMode: true });
  });

  it('never runs a style the time control does not offer (hand-edited links)', () => {
    // five minutes has the teacher too (5-minute games are common)
    expect(parseHash('#/play?persona=petya&tc=blitz5&coach=teacher')).toMatchObject({ coachStyle: 'teacher', examMode: false });
    expect(parseHash('#/play?persona=petya&tc=blitz5&coach=exam')).toMatchObject({ coachStyle: 'exam', examMode: true });
    // bullet has no style at all: the coach is silent, never an exam (as before: bullet games had examMode false)
    for (const coachStyle of COACH_STYLES) {
      expect(parseHash(`#/play?persona=petya&tc=bullet1&coach=${coachStyle}`)).toMatchObject({ coachStyle: 'helper', examMode: false });
    }
    expect(parseHash('#/play?persona=petya&tc=bullet1&exam=1')).toMatchObject({ coachStyle: 'helper', examMode: false });
    // a hand-built route with an unoffered style is formatted as the style the game will really run
    expect(formatRoute({ name: 'play', personaId: 'petya', timeControlId: 'bullet1', childColor: 'w', coachStyle: 'teacher', examMode: false })).toBe(
      '#/play?persona=petya&tc=bullet1&color=w&coach=helper',
    );
  });

  it('checks styles against the time control; the fallback is the stage default, never a guessed teacher', () => {
    expect(isCoachStyle('teacher')).toBe(true);
    expect(isCoachStyle('helper')).toBe(true);
    expect(isCoachStyle('exam')).toBe(true);
    for (const junk of ['', 'Teacher', 'off', null, undefined, 1, {}]) expect(isCoachStyle(junk)).toBe(false);

    expect(allowedCoachStyle('training', 'teacher')).toBe('teacher');
    expect(allowedCoachStyle('rapid10', 'exam')).toBe('exam');
    expect(allowedCoachStyle('blitz5', 'teacher')).toBe('teacher');
    expect(allowedCoachStyle('blitz5', 'teacher', 1)).toBe('teacher');
    expect(allowedCoachStyle('bullet1', 'teacher', 1)).toBe('helper');
    expect(allowedCoachStyle('bullet1', 'exam', 1)).toBe('helper');

    expect(playRoute({ personaId: 'sasha', timeControlId: 'rapid10', childColor: 'b', coachStyle: 'exam' })).toEqual({
      name: 'play',
      personaId: 'sasha',
      timeControlId: 'rapid10',
      childColor: 'b',
      coachStyle: 'exam',
      examMode: true,
    });
    expect(playRoute({ personaId: 'sasha', timeControlId: 'blitz5', childColor: 'w', coachStyle: 'teacher', stage: 1 })).toMatchObject({ coachStyle: 'teacher', examMode: false });
    expect(playRoute({ personaId: 'sasha', timeControlId: 'bullet1', childColor: 'w', coachStyle: 'teacher', stage: 1 })).toMatchObject({ coachStyle: 'helper', examMode: false });
  });

  it('an unknown stage is judged as stage 5, explicitly (docs/TEACHING.md §2.10), whatever the core constant says', () => {
    expect(ROUTER_UNKNOWN_STAGE).toBe(5);
    // today every fallback without a stage is bullet → «Подсказчик»; the other time controls offer every style
    for (const style of COACH_STYLES) expect(allowedCoachStyle('bullet1', style)).toBe('helper');
    for (const tc of ['training', 'rapid10', 'blitz5'] as const) for (const style of COACH_STYLES) expect(allowedCoachStyle(tc, style)).toBe(style);
    // a link without a stage parses exactly as before
    expect(parseHash('#/play?persona=sasha&tc=bullet1&color=w&coach=teacher')).toMatchObject({ coachStyle: 'helper', examMode: false });
    expect(parseHash('#/play?persona=sasha&tc=rapid10&color=w&coach=teacher')).toMatchObject({ coachStyle: 'teacher', examMode: false });
  });

  it('accepts only lichess-style theme keys', () => {
    expect(normalizeTheme('hangingPiece')).toBe('hangingPiece');
    expect(normalizeTheme('mateIn1')).toBe('mateIn1');
    expect(normalizeTheme('')).toBeUndefined();
    expect(normalizeTheme(null)).toBeUndefined();
    expect(normalizeTheme('fork;drop table')).toBeUndefined();
    expect(normalizeTheme('вилка')).toBeUndefined();
    expect(normalizeTheme('x'.repeat(41))).toBeUndefined();
    expect(parseHash('#/puzzles?theme=<script>')).toEqual({ name: 'puzzles' });
    expect(parseHash('#/puzzles?theme=')).toEqual({ name: 'puzzles' });
    expect(formatRoute({ name: 'puzzles', theme: 'not valid!' })).toBe('#/puzzles');
  });

  it('decodes game ids and keeps them intact', () => {
    expect(parseHash('#/review/%D0%BF%D0%B0%D1%80%D1%82%D0%B8%D1%8F')).toEqual({ name: 'review', gameId: 'партия' });
    expect(parseHash('#/review/abc?from=progress')).toEqual({ name: 'review', gameId: 'abc' });
  });

  it('picks the playground tool', () => {
    expect(parseHash('#/playground')).toEqual({ name: 'playground', tool: 'mascot' });
    expect(parseHash('#/playground?tool=ui')).toEqual({ name: 'playground', tool: 'ui' });
    expect(parseHash('#/playground?tool=other')).toEqual({ name: 'playground', tool: 'mascot' });
  });

  it('compares routes by their canonical hash', () => {
    expect(sameRoute({ name: 'puzzles', theme: 'fork' }, { name: 'puzzles', theme: 'fork' })).toBe(true);
    expect(sameRoute({ name: 'puzzles', theme: 'fork' }, { name: 'puzzles' })).toBe(false);
    expect(sameRoute({ name: 'home' }, parseHash('#/whatever'))).toBe(true);
  });
});
