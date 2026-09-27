import { describe, expect, it } from 'vitest';
import { loadResumeTile, resumeTileFrom } from './resumeGame.ts';
import { formatRoute } from './router.ts';

const info = { gameId: 'g-1', config: { personaId: 'sasha', timeControlId: 'rapid10', childColor: 'b', examMode: false }, personaName: 'Саша', moveCount: 25, savedAt: '2026-09-21T10:00:00.000Z' };

describe('«Продолжить партию» tile', () => {
  it('leads to the same #/play link the game was started with', () => {
    expect(resumeTileFrom(info)).toEqual({
      route: { name: 'play', personaId: 'sasha', timeControlId: 'rapid10', childColor: 'b', coachStyle: 'helper', examMode: false },
      personaId: 'sasha',
      movesPlayed: 13,
    });
  });

  it('keeps the coach style of the interrupted game (TEACHER-MODE §7.5)', () => {
    for (const coachStyle of ['teacher', 'helper', 'exam'] as const) {
      const tile = resumeTileFrom({ ...info, config: { ...info.config, coachStyle, examMode: coachStyle === 'exam' } });
      expect(tile?.route).toMatchObject({ coachStyle, examMode: coachStyle === 'exam' });
    }
    expect(formatRoute(resumeTileFrom({ ...info, config: { ...info.config, coachStyle: 'teacher' } })?.route ?? { name: 'home' })).toBe(
      '#/play?persona=sasha&tc=rapid10&color=b&coach=teacher',
    );
  });

  it('derives the style of a snapshot from before teacher mode from examMode', () => {
    expect(resumeTileFrom({ ...info, config: { ...info.config, examMode: true } })?.route).toMatchObject({ coachStyle: 'exam', examMode: true });
    expect(resumeTileFrom({ ...info, config: { ...info.config, examMode: false } })?.route).toMatchObject({ coachStyle: 'helper', examMode: false });
    expect(resumeTileFrom({ ...info, config: { ...info.config, coachStyle: 'boss', examMode: true } })?.route).toMatchObject({ coachStyle: 'exam' });
  });

  it('never resumes a style the time control does not offer', () => {
    // (5 minutes offers the teacher — it is kept; bullet offers no style at all)
    expect(resumeTileFrom({ ...info, config: { ...info.config, timeControlId: 'blitz5', coachStyle: 'teacher' } })?.route).toMatchObject({ coachStyle: 'teacher', examMode: false });
    expect(resumeTileFrom({ ...info, config: { ...info.config, timeControlId: 'bullet1', coachStyle: 'teacher' } })?.route).toMatchObject({ coachStyle: 'helper', examMode: false });
    expect(resumeTileFrom({ ...info, config: { ...info.config, timeControlId: 'bullet1', examMode: true } })?.route).toMatchObject({ coachStyle: 'helper', examMode: false });
  });

  it('shows nothing for a game without moves or a report it does not understand', () => {
    expect(resumeTileFrom({ ...info, moveCount: 0 })).toBeNull();
    for (const junk of [null, undefined, 'game', 7, [], {}, { config: { personaId: 'nobody', timeControlId: 'rapid10' }, moveCount: 9 }, { config: { personaId: 'sasha', timeControlId: 'hour' }, moveCount: 9 }]) {
      expect(resumeTileFrom(junk)).toBeNull();
    }
  });

  it('never rejects: a missing module, a changed export or a throwing reader mean «no tile»', async () => {
    await expect(loadResumeTile(() => Promise.reject(new Error('Cannot find module')))).resolves.toBeNull();
    await expect(loadResumeTile(() => Promise.resolve({}))).resolves.toBeNull();
    await expect(loadResumeTile(() => Promise.resolve({ resumableGameInfo: 'soon' }))).resolves.toBeNull();
    await expect(
      loadResumeTile(() =>
        Promise.resolve({
          resumableGameInfo: () => {
            throw new Error('localStorage is blocked');
          },
        }),
      ),
    ).resolves.toBeNull();
    await expect(loadResumeTile(() => Promise.resolve({ resumableGameInfo: () => null }))).resolves.toBeNull();
    await expect(loadResumeTile(() => Promise.resolve({ resumableGameInfo: () => info }))).resolves.toMatchObject({ personaId: 'sasha', movesPlayed: 13 });
  });
});
