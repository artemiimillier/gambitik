/**
 * «Учитель» end to end (docs/TEACHER-MODE.md §8.3; docs/TEACHING.md §2, §4.6): the wizard offers three
 * coach styles for 10 minutes and for 5 minutes too («Учитель» in blitz, chosen by default up to stage 5); a teacher game
 * with the real engine in the browser starts with ONE line (after a one-word hello, when the app's hello was not heard) —
 * the THEME of the game, one sentence and never a move (journaled as coachSaid with teach.moment 'theme'; the wizard
 * prefetched the strategy, an automated run gets the server's free template strategist) and the «Тема: …» badge —, shows
 * the green advice arrow before the first move (a calm advice's arrow comes after its sentence: it may take a moment) and
 * new advice after the bot's reply; a question card is answered with its first button; no coach bubble ever reads out the
 * clock; the panel button is «Совет», never «Подсказка». Silent and free, as every e2e run (automation.ts: silent voice
 * layer, no paid session, X-Gambit-Automation on every request).
 */
import { expect, expectSilentRun, test } from './fixtures.ts';
import type { GameState } from '../apps/web/src/features/game/gameTypes.ts';
import { clickMove, ensureStudent, openApp, pickSafeMove, shot, waitForGame, watchConsole } from './helpers.ts';

function arrowColors(state: GameState): string[] {
  return (state.annotations?.arrows ?? []).map((arrow) => arrow.color);
}

function adviceKey(state: GameState): string {
  return (state.advice ?? []).map((a) => a.uci).join(',');
}

declare global {
  interface Window {
    /** every text the mascot's speech bubble showed since the recorder started (in order, no repeats in a row) */
    __bubbles?: string[];
  }
}

/** Records every text of Гамбитик's speech bubble from now on (a MutationObserver — nothing is missed between polls). */
async function recordBubbles(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    window.__bubbles = seen;
    const read = (): void => {
      for (const node of document.querySelectorAll('.gmb-bubble')) {
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text !== '' && seen[seen.length - 1] !== text) seen.push(text);
      }
    };
    new MutationObserver(read).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-visible'] });
    read();
  });
}

async function bubbles(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => [...(window.__bubbles ?? [])]);
}

test('«Учитель»: the style choice, the advice arrows before every move, «Совет» instead of «Подсказка»', async ({ page, request }) => {
  test.setTimeout(120_000);
  await ensureStudent(request);
  const guard = watchConsole(page);
  await openApp(page);

  // ───── the wizard: 5 minutes → three tiles, «Учитель» already chosen (a fresh student is below stage 5) ─────
  await page.getByRole('navigation', { name: 'Главное меню' }).getByRole('button', { name: /Играть/ }).click();
  await expect(page).toHaveURL(/#\/new$/);
  await page.getByRole('button', { name: /5 минут/ }).click();
  await page.getByRole('button', { name: /Петя/ }).click();
  const styleTiles = page.getByRole('group', { name: 'Как помогает Гамбитик?' });
  await expect(styleTiles.getByRole('button')).toHaveCount(3);
  await expect(styleTiles.getByRole('button', { name: /Учитель/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(styleTiles.getByRole('button', { name: /Подсказчик/ })).toHaveAttribute('aria-pressed', 'false');

  // ───── 10 minutes → three tiles; «Учитель», White ─────
  // (a goto to the same '#/new' is a no-op and would leave the wizard on step 3: start over from home)
  await openApp(page, '#/');
  await page.getByRole('navigation', { name: 'Главное меню' }).getByRole('button', { name: /Играть/ }).click();
  await expect(page).toHaveURL(/#\/new$/);
  await page.getByRole('button', { name: /10 минут/ }).click();
  await page.getByRole('button', { name: /Петя/ }).click();
  await expect(styleTiles.getByRole('button')).toHaveCount(3);
  await styleTiles.getByRole('button', { name: /Учитель/ }).click();
  await shot(page, 'new-game-coach-style');
  // the colour tap starts the game AND the strategy request (prefetch) — from here on every bubble is recorded
  const strategyRequest = page.waitForRequest((r) => r.url().endsWith('/api/coach/strategy') && r.method() === 'POST', { timeout: 10_000 });
  await page.getByRole('button', { name: /Белые/ }).click();
  await recordBubbles(page);
  await expect(page).toHaveURL(/#\/play\?.*coach=teacher/);
  // the wizard asked the smart strategist before the board opened; an automated run is marked (free template answer)
  const asked = await strategyRequest;
  expect(asked.headers()['x-gambit-automation']).toBe('1');
  expect(asked.postDataJSON()).toMatchObject({ childColor: 'w', personaId: 'petya', timeControlId: 'rapid10' });

  const board = page.getByTestId('trainer-board');
  await expect(board).toBeVisible();
  await waitForGame(page, (s) => s.phase === 'childTurn', 'engines ready, child to move', 45_000);

  // ───── the ONE start line: the theme of this game (an idea, never a move), and its badge ─────
  const withStrategy = await waitForGame(page, (s) => s.strategy !== null, 'the strategy of the game', 15_000);
  const title = withStrategy.strategy?.titleRu ?? '';
  expect(title).not.toBe('');
  // the «Тема: …» badge: the short label of the card's family; stages 3–5 the card's title only once the lesson has
  // said the opening's name and the game is still on its line (a UI label, never spoken)
  const withBadge = await waitForGame(page, (s) => s.themeBadge !== null, 'the theme badge', 15_000);
  const badgeText = withBadge.themeBadge ?? '';
  const panel = page.getByRole('complementary', { name: 'Партия' });
  await expect(panel.getByText(`Тема: ${badgeText}`)).toBeVisible();
  // (which of the two — unit-tested in gameStore.strategy.test.ts; here: a label, never a move)
  expect(badgeText).not.toMatch(/\b[a-h][1-8]\b|[A-Za-z]/);
  // (read from the recorder: the bubble may already have gone when the test looks — the recorder saw it)
  await expect.poll(async () => (await bubbles(page)).length, { timeout: 20_000, message: 'the first words of the teacher' }).toBeGreaterThan(0);
  // the intro is the theme: it never names a move, never «В этот раз разыграем …, начни …»
  for (const text of await bubbles(page)) {
    expect(text).not.toMatch(/В этот раз разыграем/);
    expect(text).not.toMatch(/\b[a-h][1-8]\b|Начни пешкой|Начни конём/);
  }

  // ───── the first advice: the green arrow before the first move (§2.1; after its sentence, §2.2) ─────
  const first = await waitForGame(page, (s) => s.phase === 'childTurn' && arrowColors(s).includes('green'), 'the first advice arrows', 20_000);
  expect(first.coachStyle).toBe('teacher');
  expect(first.advice?.[0]?.arrow).toBe('green');

  // «Совет» is there, «Подсказка» is not (panel and dock)
  const advice = page.getByRole('button', { name: /^Совет/ }).first();
  await expect(advice).toBeVisible();
  await expect(page.getByRole('button', { name: /Подсказка/ })).toHaveCount(0);
  await shot(page, 'game-teacher-first-advice');

  // ───── 1.e4 → the bot answers → new arrows for the new position, quickly (≤ 1.5 s + the real engine's margin) ─────
  // an in-page probe (20 ms) times the bot's move appearing and the new advice — the 100 ms test polling is too coarse
  await page.evaluate((firstKey) => {
    const probe: { botAt: number | null; adviceAt: number | null } = { botAt: null, adviceAt: null };
    (window as unknown as { __teachProbe?: typeof probe }).__teachProbe = probe;
    const timer = setInterval(() => {
      const s = window.__gambit?.game?.state();
      if (!s) return;
      if (probe.botAt === null && s.moves.length >= 2) probe.botAt = performance.now();
      const key = (s.advice ?? []).map((a) => a.uci).join(',');
      if (probe.botAt !== null && key !== '' && key !== firstKey) {
        probe.adviceAt = performance.now();
        clearInterval(timer);
      }
    }, 20);
  }, adviceKey(first));
  const firstMove = first.advice?.[0]?.uci ?? 'e2e4';
  await clickMove(page, board, { from: firstMove.slice(0, 2), to: firstMove.slice(2, 4) });
  const cleared = await waitForGame(page, (s) => s.moves.length >= 1, 'the child\'s move');
  expect(cleared.moves[0]?.uci).toBe(firstMove);
  // the journal (the resume snapshot, written with the first move): the theme with its moment, before any advice
  const journaled = await page.evaluate(() => {
    const raw = window.localStorage.getItem('gambit.resumeGame');
    const events = raw ? ((JSON.parse(raw) as { events?: { type: string; data: { kind?: string; teach?: { moment?: string } } }[] }).events ?? []) : [];
    return events.filter((e) => e.type === 'coachSaid').map((e) => ({ kind: e.data.kind ?? '', moment: e.data.teach?.moment ?? '' }));
  });
  const themeAt = journaled.findIndex((e) => e.moment === 'theme');
  expect(themeAt, 'a coachSaid with teach.moment «theme»').toBeGreaterThanOrEqual(0);
  expect(journaled[themeAt]?.kind).toBe('gameStart');
  expect(journaled.slice(0, themeAt).some((e) => e.kind === 'teachTurn'), 'the theme comes before the first advice').toBe(false);
  const replied = await waitForGame(page, (s) => s.phase === 'childTurn' && s.moves.length >= 2, 'the bot\'s reply', 30_000);
  const second = await waitForGame(
    page,
    (s) => s.moves.length === replied.moves.length && arrowColors(s).includes('green') && adviceKey(s) !== adviceKey(first),
    'the advice after the bot\'s reply',
    15_000,
  );
  const probe = await page.evaluate(() => (window as unknown as { __teachProbe?: { botAt: number | null; adviceAt: number | null } }).__teachProbe ?? null);
  expect(probe?.botAt, 'the probe saw the bot\'s move').not.toBeNull();
  expect(probe?.adviceAt, 'the probe saw the new advice').not.toBeNull();
  const adviceMs = Math.round((probe?.adviceAt ?? 0) - (probe?.botAt ?? 0));
  console.log(`the advice after the bot's move: ${adviceMs} ms (teachDeadlineMs 1500, spec §8.3: ≤ 3 s)`);
  expect(adviceMs, 'the advice appears ≤ 3 s after the bot\'s move (§8.3)').toBeLessThan(3_000);
  expect(second.advice?.[0]?.arrow).toBe('green');

  // «Совет» brings the same advice back
  await advice.click();
  const repeated = await waitForGame(page, (s) => arrowColors(s).includes('green'), 'the repeated advice', 10_000);
  expect(adviceKey(repeated)).toBe(adviceKey(second));
  await shot(page, 'game-teacher-second-advice');

  // ───── a few more moves (the green arrow, else a calm safe move): a question card is answered with its first button;
  // a hidden advice (a treasure, «Сам») comes by itself after its time; the coach never reads out the clock ─────
  let quizzes = 0;
  for (let i = 0; i < 4; i++) {
    let now = await waitForGame(page, (s) => s.phase === 'childTurn' || s.phase === 'gameOver', 'the child\'s turn', 30_000);
    if (now.phase === 'gameOver') break;
    if (now.quiz && now.quiz.answeredId === null) {
      quizzes += 1;
      // the card sits at the top of the panel (above the board on a narrow screen): the visible one answers
      const card = page.getByRole('group', { name: now.quiz.question });
      await expect(card.getByRole('button')).toHaveCount(3);
      await shot(page, 'game-teacher-quiz');
      await card.getByRole('button').first().click();
      const answered = await waitForGame(page, (s) => s.quiz === null || s.quiz.answeredId !== null, 'the answer', 10_000);
      expect(answered.quiz === null || answered.quiz.answeredId === now.quiz.options[0]?.id).toBe(true);
      // the explanation brings the arrow
      now = await waitForGame(page, (s) => s.phase !== 'childTurn' || arrowColors(s).includes('green'), 'the arrow after the answer', 15_000);
      if (now.phase !== 'childTurn') break;
    } else if (!arrowColors(now).includes('green')) {
      // the arrow of a calm advice comes after its sentence; a hidden one after its time (≤ 25 s)
      now = await waitForGame(page, (s) => s.phase !== 'childTurn' || arrowColors(s).includes('green') || (s.quiz !== null && s.quiz.answeredId === null), 'the advice arrow', 30_000);
      if (now.phase !== 'childTurn') break;
      if (now.quiz && now.quiz.answeredId === null) {
        i -= 1; // the question of this very move: answered on the next pass
        continue;
      }
    }
    const green = now.advice?.find((a) => a.arrow === 'green');
    const move = green ? { from: green.uci.slice(0, 2), to: green.uci.slice(2, 4), ...(green.uci.length > 4 ? { promotion: green.uci.slice(4) } : {}) } : pickSafeMove(now.fen);
    const plies = now.moves.length;
    await clickMove(page, board, move);
    await waitForGame(
      page,
      (s) => s.phase === 'gameOver' || (s.phase === 'childTurn' && s.moves.length >= plies + 2 && (arrowColors(s).includes('green') || s.quiz !== null || s.treasure !== null || s.advice === null)),
      'the bot\'s reply and the new lesson turn',
      30_000,
    );
  }
  console.log(`question cards answered in this game: ${quizzes}`);
  const said = await bubbles(page);
  expect(said.length, 'the coach spoke during the game').toBeGreaterThan(1);
  for (const text of said) expect(text, 'a coach bubble must never read out the clock').not.toMatch(/минут|секунд/i);

  guard.assertClean();
  await expectSilentRun(page);
});
