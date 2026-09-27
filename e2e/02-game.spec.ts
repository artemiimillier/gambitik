/**
 * (b) wizard → training game vs Петя as White, click-to-move, the bot answers every time, ≥ 6 full moves;
 * (c) a deliberately hung queen → take-back offer → accept → position restored, buttons gone;
 * (d) resign → result card → review screen; the server wrote the PGN, the markdown journal and profile.md.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { expect, expectSilentRun, test } from './fixtures.ts';
import type { GameRecord } from '../packages/shared/src/contracts.ts';
import type { PickedMove } from './helpers.ts';
import { clickMove, ensureStudent, expectBubbleClearOf, gameState, legalMove, openApp, pickBlunder, pickSafeMove, shot, square, waitForGame, watchConsole } from './helpers.ts';

const DIARY_NOTE = 'Трудно было заметить, что ферзь под боем';

/** SAN → the Russian piece letters the review screen prints (Кр Ф Л С К). */
function sanRu(san: string): string {
  const letters: Record<string, string> = { K: 'Кр', Q: 'Ф', R: 'Л', B: 'С', N: 'К' };
  return san.replace(/O-O-O/g, '0-0-0').replace(/O-O/g, '0-0').replace(/[KQRBN]/g, (piece) => letters[piece] ?? piece);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test('a full training game: moves, take-back offer, resign, review, files on disk', async ({ page, request }) => {
  await ensureStudent(request);
  const guard = watchConsole(page);
  await openApp(page);

  // ───── the wizard: 3 taps ─────
  await page.getByRole('navigation', { name: 'Главное меню' }).getByRole('button', { name: /Играть/ }).click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByRole('button', { name: /Без часов/ })).toBeVisible();
  await shot(page, 'new-game-time');
  await page.getByRole('button', { name: /Без часов/ }).click();
  await expect(page.getByRole('button', { name: /Петя/ })).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, 'opponent-select');
  await page.getByRole('button', { name: /Петя/ }).click();
  await expect(page.getByRole('button', { name: /Белые/ })).toBeVisible();
  await shot(page, 'new-game-color');
  // this game checks the hint ladder («Подсказка» 1→4): «Подсказчик», not the stage-1 default «Учитель» (08-teacher)
  const styleTiles = page.getByRole('group', { name: 'Как помогает Гамбитик?' });
  await expect(styleTiles.getByRole('button', { name: /Учитель/ })).toHaveAttribute('aria-pressed', 'true');
  await styleTiles.getByRole('button', { name: /Подсказчик/ }).click();
  await expect(styleTiles.getByRole('button', { name: /Подсказчик/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Белые/ }).click();
  await expect(page).toHaveURL(/#\/play\?persona=petya&tc=training&color=w&coach=helper$/);

  // ───── the board ─────
  const board = page.getByTestId('trainer-board');
  await expect(board).toBeVisible();
  await expect(square(board, 'e2')).toBeVisible();
  await expect(board.locator('[data-square]')).toHaveCount(64);
  const box = await board.boundingBox();
  expect(box, 'board has a box').not.toBeNull();
  expect(Math.abs((box?.width ?? 0) - (box?.height ?? 1)), 'the board is square').toBeLessThanOrEqual(1);
  expect(box?.width ?? 0, 'the board is big enough for a child').toBeGreaterThanOrEqual(480);

  await waitForGame(page, (s) => s.phase === 'childTurn', 'engines ready, child to move', 45_000);

  // docs/TEACHING.md §4.4: the big «Звук вкл / выкл» sits in the panel head (above the board on a narrow
  // window — one of the two is shown); its name never collides with «Подсказка» / «Совет» / the dock's mute button
  const panel = page.getByRole('complementary', { name: 'Партия' });
  const soundToggle = page.getByRole('button', { name: /^Звук (вкл|выкл)$/ });
  await expect(soundToggle).toHaveCount(1);
  await expect(soundToggle).toBeVisible();
  await expect(panel.getByRole('button', { name: /Подсказка/ })).toHaveCount(1);
  // «Подсказчик» has no lesson: no quiz card, no theme badge
  await expect(panel.getByText(/^Тема:/)).toHaveCount(0);

  // ───── play: first hang the queen, then play calmly ─────
  let takebackSeen = false;
  let secondBlunder: string | null = null;
  let offersDeclined = 0;
  const botReplyMs: number[] = [];

  const blundersWithoutOffer: string[] = [];

  for (let turn = 0; turn < 30; turn += 1) {
    const before = await gameState(page);
    if (before.phase === 'gameOver') break;
    expect(before.phase).toBe('childTurn');
    const fullMoves = Math.floor(before.moves.length / 2);
    // one more blunder is played on purpose later (and kept): it becomes the «Найди ход лучше!» task of the review
    if (takebackSeen && fullMoves >= 6 && (secondBlunder !== null || fullMoves >= 12)) break;

    // Hang the queen EARLY: once the random bot has dropped half its army, even a lost queen no longer costs
    // 20 win-% and the coach (rightly) stays quiet. Two unanswered blunders are enough evidence of a defect.
    const wantSecond: boolean = takebackSeen && secondBlunder === null && fullMoves >= 5;
    const blunder: PickedMove | null = wantSecond ? pickBlunder(before.fen) : takebackSeen || fullMoves > 12 || blundersWithoutOffer.length >= 2 ? null : pickBlunder(before.fen);
    if (wantSecond && blunder) secondBlunder = blunder.san;
    // 1.e4 and 2.Qh5 put the queen where it can be hung (…Qxh7, …Qg6, …Qxf7+); afterwards any calm move will do
    const opener =
      before.moves.length === 0
        ? { from: 'e2', to: 'e4', san: 'e4' }
        : !takebackSeen && before.moves.length === 2
          ? legalMove(before.fen, 'd1', 'h5')
          : null;
    const move = blunder ?? opener ?? pickSafeMove(before.fen);
    const startedAt = Date.now();
    await clickMove(page, board, move);

    // By design the bot does not move while the coach holds the clock (e.g. the explanation after a declined
    // offer that got punished): such replies are not a measure of the engine's speed.
    let coachHeldTheClock = false;
    const after = await waitForGame(
      page,
      (s) => {
        if (s.phase === 'botThinking' && s.clock.paused) coachHeldTheClock = true;
        return s.phase === 'gameOver' || s.phase === 'coachIntervention' || (s.phase === 'childTurn' && s.moves.length >= before.moves.length + 2);
      },
      `the answer to ${move.san}`,
    );

    if (after.phase === 'coachIntervention') {
      const accept = page.getByRole('button', { name: 'Верну ход и подумаю' });
      const decline = page.getByRole('button', { name: 'Оставлю свой ход' });
      await expect(accept).toBeVisible();
      await expect(decline).toBeVisible();
      expect(after.takeback?.san).toBe(move.san);
      expect(after.takeback?.judgement.confidence).toBe('confirmed');
      expect(after.takeback?.judgement.winPctLoss ?? 0).toBeGreaterThanOrEqual(20);

      if (!takebackSeen) {
        takebackSeen = true;
        await page.waitForTimeout(600); // the mascot's bubble and the red marks are up
        await shot(page, 'game-takeback-offer');
        await expectBubbleClearOf(page, { 'the board': board, '«Верну ход»': accept, '«Оставлю свой ход»': decline });
        await accept.click();
        const restored = await waitForGame(page, (s) => s.phase === 'childTurn' && s.takeback === null, 'the move to be taken back');
        expect(restored.fen, 'the position before the blunder is back').toBe(before.fen);
        expect(restored.moves.length).toBe(before.moves.length);
        await expect(accept).toHaveCount(0);
        await expect(decline).toHaveCount(0);

        // the hint ladder: question → zone → piece → the move itself (green arrow on the board)
        const hintButton = panel.getByRole('button', { name: /Подсказка/ });
        for (const level of [1, 2, 3, 4]) {
          await hintButton.click();
          await waitForGame(page, (s) => s.hintLevel === level && !s.hintBusy, `hint level ${level}`);
        }
        const hinted = await gameState(page);
        expect(hinted.annotations?.arrows[0]?.color, 'level 4 shows the move').toBe('green');
        await page.waitForTimeout(400);
        await shot(page, 'game-hint');
        // (the panel head is one row taller with the sound switch — the buttons below it stay clear of the bubble)
        await expectBubbleClearOf(page, { 'the board': board, '«Подсказка»': hintButton, '«Звук»': soundToggle });
      } else {
        // a later offer: the child may always keep the move
        offersDeclined += 1;
        await decline.click();
        await expect(accept).toHaveCount(0);
        // «почему оставляем ход?» — three tappable reasons, never required (they vanish by themselves)
        const reasons = page.getByRole('group', { name: 'Почему оставляем ход?' });
        if (await reasons.isVisible().catch(() => false)) {
          await shot(page, 'game-decline-reasons');
          await reasons.getByRole('button').first().click({ timeout: 3_000 }).catch(() => undefined);
        }
        await waitForGame(page, (s) => s.phase === 'gameOver' || (s.phase === 'childTurn' && s.moves.length >= before.moves.length + 2), 'the bot after a declined offer');
      }
      continue;
    }

    if (after.phase === 'childTurn') {
      if (blunder && !takebackSeen) blundersWithoutOffer.push(`${blunder.san} in ${before.fen}`);
      if (!coachHeldTheClock) botReplyMs.push(Date.now() - startedAt);
      const reply = after.moves[after.moves.length - 1];
      expect(reply?.by).toBe('bot');
    }
  }

  const played = await gameState(page);
  expect(takebackSeen, `a hung queen must produce a take-back offer (blunders without an offer: ${blundersWithoutOffer.join(' | ') || 'none were available'})`).toBe(true);
  expect(Math.floor(played.moves.length / 2), 'at least 6 full moves were played').toBeGreaterThanOrEqual(6);
  expect(botReplyMs.length).toBeGreaterThanOrEqual(4);
  const sorted = [...botReplyMs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(`bot replies (judge + think), ms: ${botReplyMs.join(', ')} — median ${median}; later offers declined: ${offersDeclined}`);
  expect(median, 'the bot answers within about two seconds').toBeLessThan(3_000);
  // the very first reply does not wait for the coach's opening phrases (12–14 s)
  expect(botReplyMs[0] ?? 0, 'the first bot reply does not wait for the opening speech').toBeLessThan(6_000);
  expect(Math.max(...botReplyMs), 'no reply hangs').toBeLessThan(10_000);
  await shot(page, 'game');

  // ───── resign → result card ─────
  if (played.phase !== 'gameOver') {
    await page.getByRole('button', { name: 'Сдаться' }).click();
    await page.getByRole('button', { name: 'Да, сдаюсь' }).click();
  }
  const result = page.getByRole('region', { name: 'Итог партии' });
  await expect(result).toBeVisible();
  // the diary: one optional sentence, asked BEFORE the record is written (so it lands in the journal); the tap answers
  // «Как тебе партия?» wait until it is answered (both at once pushed the diary buttons under the mascot)
  const thoughts = result.getByRole('region', { name: 'Как тебе партия?' });
  const diary = result.getByRole('form', { name: 'Дневник партии' });
  await expect(diary).toBeVisible({ timeout: 60_000 });
  await expect(thoughts).toHaveCount(0);
  await expect(diary.getByRole('button', { name: 'Пропустить' })).toBeVisible();
  await expect(diary.getByRole('button', { name: 'Записать' })).toBeDisabled();
  await diary.getByLabel('Что было самым трудным в этой партии?').fill(DIARY_NOTE);
  await page.waitForTimeout(300);
  await shot(page, 'game-result-note');
  await expectBubbleClearOf(page, { 'the diary question': diary });
  await diary.getByRole('button', { name: 'Записать' }).click();
  await expect(result.getByText('Записал в дневник. Спасибо!')).toBeVisible();
  // the tap answers are there with every voice (the silent one of automation too, §4.4)
  await expect(thoughts).toBeVisible();
  const reviewButton = result.getByRole('button', { name: 'Разбор партии' });
  await expect(reviewButton).toBeVisible({ timeout: 90_000 });
  const finished = await gameState(page);
  expect(finished.ending?.save).toBe('saved');
  const gameId = finished.savedGameId;
  expect(gameId).toBeTruthy();
  await shot(page, 'game-result');
  await expectBubbleClearOf(page, { 'the board': board, '«Разбор партии»': reviewButton, '«Домой»': result.getByRole('button', { name: 'Домой' }) });

  // ───── the saved record has real engine judgements ─────
  const record = (await (await request.get(`/api/games/${gameId}`)).json()) as GameRecord;
  expect(record.personaId).toBe('petya');
  expect(record.timeControlId).toBe('training');
  expect(record.judgements.length).toBeGreaterThanOrEqual(6);
  for (const judgement of record.judgements) {
    expect(judgement.color).toBe('w');
    expect(judgement.winPctBefore).toBeGreaterThanOrEqual(0);
    expect(judgement.winPctBefore).toBeLessThanOrEqual(100);
    expect(judgement.bestUci).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
    expect(judgement.evalBefore.cp !== null || judgement.evalBefore.mate !== null).toBe(true);
  }
  // 1.e4 from the start position is never a disaster
  const first = record.judgements[0];
  expect(first?.san).toBe('e4');
  expect(first?.winPctLoss ?? 100).toBeLessThan(10);
  expect(Math.abs(first?.evalBefore.cp ?? 999)).toBeLessThan(150);
  // the hung queen is in the journal as a confirmed blunder that was taken back
  const hung = record.judgements.find((j) => j.confidence === 'confirmed' && j.winPctLoss >= 20);
  expect(hung, 'the taken-back blunder is part of the record').toBeTruthy();
  expect(record.events.some((e) => e.type === 'takebackOffered')).toBe(true);
  expect(record.events.some((e) => e.type === 'takebackAccepted')).toBe(true);
  expect(record.summary.takebacksAccepted).toBeGreaterThanOrEqual(1);
  // the child's own sentence is part of the record (typed, not spoken)
  const typed = record.events.find((e) => e.type === 'childSaid' && e.data.source === 'typed');
  expect(typed?.data.text).toBe(DIARY_NOTE);

  // ───── review screen ─────
  await reviewButton.click();
  await expect(page).toHaveURL(new RegExp(`#/review/${gameId}$`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Разбор');
  await expect(page.locator('[data-square]').first()).toBeVisible();
  // the written (template) review arrives from the server
  await expect
    .poll(async () => ((await (await request.get(`/api/games/${gameId}/review`)).json()) as { status: string }).status, { timeout: 30_000 })
    .toBe('template');
  await page.waitForTimeout(3_500); // the screen polls every 3 s
  await shot(page, 'review');

  // ───── solve first: a task shows no answer until the child has tried ─────
  const taskCard = page.getByRole('button', { name: /Найди ход лучше/ }).first();
  if ((await taskCard.count()) > 0) {
    // while a task is untried the written review (it names the answers) stays closed
    await expect(page.getByText(/Сначала попробуй сам/)).toBeVisible();
    await taskCard.click();
    const task = page.getByRole('region', { name: 'Задание' });
    await expect(task.getByRole('heading', { name: 'Найди ход лучше!' })).toBeVisible();
    await expect(task.getByRole('button', { name: 'Показать ответ' }), 'no answer before the first try').toHaveCount(0);
    await expect(task.getByText(/Сильнее было/)).toHaveCount(0);
    await page.waitForTimeout(400);
    await shot(page, 'review-task');

    // play the engine's move of THIS moment (found through the move the panel quotes) → «Нашёлся!»
    const quoted = ((await task.locator('strong').first().textContent()) ?? '').trim();
    const moment = record.summary.keyMoments.find((m) => sanRu(m.playedSan) === quoted);
    expect(moment, `the key moment for «${quoted}»`).toBeTruthy();
    const best = new Chess(moment?.fenBefore ?? '').moves({ verbose: true }).find((m) => m.san === moment?.bestSan);
    expect(best, `${moment?.bestSan} is legal in the task position`).toBeTruthy();
    const reviewBoard = page.locator('[data-square]').first().locator('xpath=ancestor::*[@role="group"][1]');
    await clickMove(page, reviewBoard, { from: best?.from ?? '', to: best?.to ?? '', ...(best?.promotion ? { promotion: best.promotion } : {}) });
    await expect(task.getByRole('heading', { name: 'Нашёлся!' })).toBeVisible({ timeout: 20_000 });
    await shot(page, 'review-task-solved');
    await task.getByRole('button', { name: 'К партии' }).click();
  } else {
    console.log(`review: this game produced no «Найди ход лучше!» task (second blunder: ${secondBlunder ?? 'none was available'}) — solve-first steps skipped`);
  }
  await expectBubbleClearOf(page, { 'the review board': page.locator('[data-square]').first().locator('xpath=ancestor::*[@role="group"][1]'), 'the key moments': page.getByRole('button', { name: /Найди ход лучше/ }).first() });

  // ───── files on disk (temp DATA_DIR of this run) ─────
  const dataDir = process.env.GAMBIT_E2E_DATA_DIR ?? '';
  expect(dataDir).not.toBe('');
  const gameFiles = walk(join(dataDir, 'games'));
  const pgnFile = gameFiles.find((file) => file.endsWith('_vs-petya.pgn'));
  const journalFile = gameFiles.find((file) => file.endsWith('_vs-petya.md'));
  expect(pgnFile, `a .pgn under ${dataDir}/games`).toBeTruthy();
  expect(journalFile, `a .md journal under ${dataDir}/games`).toBeTruthy();
  const pgn = readFileSync(pgnFile ?? '', 'utf8');
  expect(pgn).toContain('1. e4');
  expect(pgn).toContain(`[Result "${record.result}"]`);
  const journal = readFileSync(journalFile ?? '', 'utf8');
  expect(journal).toContain('Петя');
  expect(journal).toMatch(/верн/i); // the take-back is in the timeline
  const profileMd = readFileSync(join(dataDir, 'student', 'profile.md'), 'utf8');
  expect(profileMd).toContain('Тигр');
  expect(existsSync(join(dataDir, 'student', 'progress.json'))).toBe(true);

  await expectSilentRun(page);
  guard.assertClean();
});
