import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GameScreen, requestedCoachStyle } from './GameScreen.tsx';
import { createGameController } from './gameStore.ts';
import { RESUME_GAME_KEY } from './resume.ts';
import { MemoryStorage, createTestHarness } from './testing/fakes.ts';

const PROPS = { personaId: 'petya', timeControlId: 'training', childColor: 'w', examMode: false, onExit: () => undefined } as const;

function withLocalStorage(storage: MemoryStorage | undefined): void {
  if (storage) Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  else Reflect.deleteProperty(globalThis, 'localStorage');
}

afterEach(() => withLocalStorage(undefined));

describe('GameScreen — «Продолжить партию?»', () => {
  it('starts a new game straight away when nothing was interrupted', () => {
    withLocalStorage(new MemoryStorage());
    const html = renderToStaticMarkup(<GameScreen {...PROPS} />);
    expect(html).toContain('Расставляю фигуры');
    expect(html).not.toContain('Продолжить партию?');
  });

  it('offers the interrupted game first: two big answers, the opponent by name, how much was played', async () => {
    const h = createTestHarness();
    const game = createGameController(h.deps);
    h.bot.replies = ['e7e5', 'b8c6', 'g8f6'];
    await game.start({ personaId: 'vika', timeControlId: 'rapid10', childColor: 'w', examMode: false });
    for (const [from, to] of [['e2', 'e4'], ['g1', 'f3'], ['f1', 'c4']] as const) {
      expect(game.dropPiece(from, to)).toBe(true);
      await game.whenSettled();
    }
    game.dispose(); // the tab goes away mid-game
    expect(h.storage.getItem(RESUME_GAME_KEY)).not.toBeNull();

    withLocalStorage(h.storage);
    // the route asks for another opponent: the question is about the game that was interrupted
    const html = renderToStaticMarkup(<GameScreen {...PROPS} />);
    expect(html).toContain('Продолжить партию?');
    expect(html).toContain('Вика');
    expect(html).toContain('3 хода уже на доске');
    expect(html).toContain('Продолжить');
    expect(html).toContain('Новая партия');
    expect(html).not.toContain('Расставляю фигуры');
    // asking does not consume the snapshot
    expect(h.storage.getItem(RESUME_GAME_KEY)).not.toBeNull();
  });
});

describe('GameScreen — the coach style prop (docs/TEACHER-MODE.md §1.3)', () => {
  it('the route\'s style wins; an old route asks for the exam or the stage default', () => {
    expect(requestedCoachStyle({ coachStyle: 'teacher', examMode: false })).toBe('teacher');
    expect(requestedCoachStyle({ coachStyle: 'helper', examMode: false })).toBe('helper');
    // an old link / caller without `coach=`: exam=1 stays an exam, otherwise the default for the child's stage
    expect(requestedCoachStyle({ examMode: true })).toBe('exam');
    expect(requestedCoachStyle({ examMode: false })).toBe('auto');
  });

  it('renders with a coach style like before', () => {
    withLocalStorage(new MemoryStorage());
    const html = renderToStaticMarkup(<GameScreen {...PROPS} coachStyle="teacher" />);
    expect(html).toContain('Расставляю фигуры');
  });
});
