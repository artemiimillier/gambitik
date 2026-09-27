/**
 * Shared helpers of the e2e suite: console guard, student set-up, board clicks, the dev hook, move pickers.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import type { Move } from 'chess.js';
import { expect } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type { GambitPuzzleSnapshot } from '../apps/web/src/devHook.ts';
import type { GameState } from '../apps/web/src/features/game/gameTypes.ts';

export const SCREENSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');

export const NICKNAME = 'Тигр';

/** The home heading greets by the time of day (Home.tsx): a run after noon must not fail on «Привет». */
export const HOME_GREETING = new RegExp(`^(Привет|Доброе утро|Добрый день|Добрый вечер), ${NICKNAME}!$`);

/** Viewport screenshot into docs/screenshots/ (1440×900, the default) or docs/screenshots/<width>x<height>/. */
export async function shot(page: Page, name: string): Promise<void> {
  const viewport = page.viewportSize();
  const isDefault = viewport === null || (viewport.width === 1440 && viewport.height === 900);
  const dir = isDefault ? SCREENSHOT_DIR : join(SCREENSHOT_DIR, `${viewport.width}x${viewport.height}`);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' });
}

// ───────────────────────── console guard ─────────────────────────

export interface ConsoleGuard {
  problems: string[];
  /** fails the test when the page logged an error or threw */
  assertClean(): void;
}

/** Messages that are not defects of the app. */
const BENIGN_CONSOLE = [
  // Vite dev server chatter
  /\[vite\]/i,
  // headless Chromium has no speech voices; the browser voice layer logs its own fallback
  /speech watchdog/i,
];

export function watchConsole(page: Page): ConsoleGuard {
  const problems: string[] = [];
  page.on('console', (message) => {
    // GAMBIT_E2E_LOG_CONSOLE=1 prints the warnings too (debugging aid; only errors fail a test)
    if (process.env.GAMBIT_E2E_LOG_CONSOLE === '1' && message.type() === 'warning') console.log(`[browser warning] ${message.text()}`);
    if (message.type() !== 'error') return;
    const text = message.text();
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return;
    problems.push(`console.error: ${text}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`);
  });
  return {
    problems,
    assertClean() {
      expect(problems, 'browser console must stay free of errors').toEqual([]);
    },
  };
}

// ───────────────────────── student ─────────────────────────

/** A real nickname on the server = the app skips onboarding (any spec can run on its own). */
export async function ensureStudent(request: APIRequestContext): Promise<void> {
  const response = await request.put('/api/student', { data: { nickname: NICKNAME, address: 'm' } });
  expect(response.ok(), `PUT /api/student → ${response.status()}`).toBe(true);
}

/** Opens the app on a hash route and waits until the shell has left its loading screen. */
export async function openApp(page: Page, hash = '#/'): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.locator('#root')).not.toBeEmpty();
}

// ───────────────────────── board ─────────────────────────

export function square(scope: Page | Locator, name: string): Locator {
  return scope.locator(`[data-square="${name}"]`);
}

/** Click-to-move: origin square, then target square (+ the promotion picker when it appears). */
export async function clickMove(page: Page, board: Locator, move: { from: string; to: string; promotion?: string }): Promise<void> {
  await square(board, move.from).click();
  await square(board, move.to).click();
  if (move.promotion) {
    const label = { q: 'Ферзь', r: 'Ладья', b: 'Слон', n: 'Конь' }[move.promotion] ?? 'Ферзь';
    // exact: «Ферзь» is also a substring of the board's piece buttons («чёрный ферзь») and of journal lines
    await page.getByRole('button', { name: label, exact: true }).click();
  }
}

// ───────────────────────── layout ─────────────────────────

/** Гамбитик's visible speech bubble (there is at most one). */
export function speechBubble(page: Page): Locator {
  return page.locator('.gmb-bubble[data-visible="true"]');
}

/**
 * The mascot's bubble must never cover something a child has to see or press.
 * A hidden bubble (he is silent right now) passes trivially.
 */
export async function expectBubbleClearOf(page: Page, targets: Record<string, Locator>): Promise<void> {
  const bubble = speechBubble(page);
  if ((await bubble.count()) === 0) return;
  const a = await bubble.boundingBox();
  if (a === null) return;
  for (const [name, target] of Object.entries(targets)) {
    // an optional target that is not on this screen (e.g. a review without tasks) has nothing to cover
    if ((await target.count()) === 0) continue;
    const b = await target.boundingBox();
    if (b === null) continue;
    const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    expect(overlapX > 1 && overlapY > 1, `the speech bubble covers ${name} (${Math.round(overlapX)}×${Math.round(overlapY)} px)`).toBe(false);
  }
}

// ───────────────────────── dev hook ─────────────────────────

export async function gameState(page: Page): Promise<GameState> {
  const state = await page.evaluate(() => window.__gambit?.game?.state() ?? null);
  if (state === null) throw new Error('window.__gambit.game is missing — is this the Vite dev server?');
  return state;
}

export async function waitForGame(page: Page, predicate: (state: GameState) => boolean, what: string, timeoutMs = 30_000): Promise<GameState> {
  const deadline = Date.now() + timeoutMs;
  let last: GameState | null = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.__gambit?.game?.state() ?? null);
    if (last !== null && predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for: ${what} (phase=${last?.phase ?? 'n/a'}, moves=${last?.moves.length ?? 'n/a'})`);
}

export async function puzzleSnapshot(page: Page): Promise<GambitPuzzleSnapshot> {
  const snapshot = await page.evaluate(() => window.__gambit?.puzzles?.current() ?? null);
  if (snapshot === null) throw new Error('window.__gambit.puzzles is missing — is this the Vite dev server?');
  return snapshot;
}

// ───────────────────────── move pickers ─────────────────────────

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

export interface PickedMove {
  from: string;
  to: string;
  promotion?: string;
  san: string;
}

function toPicked(move: Move): PickedMove {
  return { from: move.from, to: move.to, san: move.san, ...(move.promotion ? { promotion: move.promotion } : {}) };
}

/**
 * A move that simply loses the queen (or, without a queen, a rook): the piece lands on a square where the
 * opponent wins it — captured by something cheaper, or captured for free because nothing defends it — and it
 * wins nothing comparable on the way. A mere trade (queen takes queen back) is NOT a blunder and is skipped.
 * Returns the most obvious such blunder, or null when the position offers none.
 */
export function pickBlunder(fen: string): PickedMove | null {
  const chess = new Chess(fen);
  const mover = chess.turn();
  let best: { move: Move; score: number } | null = null;
  for (const move of chess.moves({ verbose: true })) {
    if (move.piece !== 'q' && move.piece !== 'r') continue;
    if (move.san.includes('#')) continue;
    const gained = move.captured ? (VALUE[move.captured] ?? 0) : 0;
    const lost = VALUE[move.piece] ?? 0;
    if (lost - gained < 4) continue;
    const after = new Chess(move.after);
    const recaptures = after.moves({ verbose: true }).filter((reply) => reply.to === move.to && reply.captured === move.piece);
    if (recaptures.length === 0) continue;
    const cheapest = Math.min(...recaptures.map((reply) => VALUE[reply.piece] ?? 0));
    const defended = after.isAttacked(move.to, mover);
    // defended AND taken by an equal piece = a trade, not a loss
    if (defended && cheapest >= lost) continue;
    // the queen hung to a pawn is the clearest lesson; a check narrows the replies to the capture
    const score = lost * 10 - gained * 10 - cheapest + (defended ? 0 : 5) + (move.san.includes('+') ? 0 : 3);
    if (best === null || score > best.score) best = { move, score };
  }
  return best ? toPicked(best.move) : null;
}

/** The move from → to when it is legal in this position, else null. */
export function legalMove(fen: string, from: string, to: string): PickedMove | null {
  const found = new Chess(fen).moves({ verbose: true }).find((move) => move.from === from && move.to === to);
  return found ? toPicked(found) : null;
}

/** A calm developing move that does not hang the moved piece (used to keep the game going). */
export function pickSafeMove(fen: string): PickedMove {
  const chess = new Chess(fen);
  const mover = chess.turn();
  const enemy = mover === 'w' ? 'b' : 'w';
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) throw new Error(`no legal moves in ${fen}`);
  let best: { move: Move; score: number } | null = null;
  for (const move of moves) {
    const after = new Chess(move.after);
    if (after.isStalemate() || after.isDraw()) continue;
    let score = 0;
    const moved = VALUE[move.promotion ?? move.piece] ?? 0;
    const attacked = after.isAttacked(move.to, enemy);
    const defended = after.isAttacked(move.to, mover);
    if (move.captured) score += (VALUE[move.captured] ?? 0) * 10;
    if (attacked) score -= defended && moved <= 1 ? 2 : moved * 10;
    // do not leave other pieces en prise
    for (const row of after.board()) {
      for (const cell of row) {
        if (!cell || cell.color !== mover || cell.type === 'k' || cell.square === move.to) continue;
        if (after.isAttacked(cell.square, enemy) && !after.isAttacked(cell.square, mover)) score -= (VALUE[cell.type] ?? 0) * 8;
      }
    }
    if (move.piece === 'n' || move.piece === 'b') score += 2; // develop
    if (move.piece === 'p' && ['d', 'e'].includes(move.from[0] ?? '')) score += 2;
    if (move.piece === 'k' && !move.san.startsWith('O-O')) score -= 3;
    if (move.san.startsWith('O-O')) score += 3;
    if (move.piece === 'q') score -= 1;
    if (best === null || score > best.score) best = { move, score };
  }
  return toPicked((best ?? { move: moves[0] as Move }).move);
}
