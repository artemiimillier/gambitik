/**
 * The «Поговорить» conversation (the coach talks on his own, not only when «Подсказка» is pressed).
 *
 * An automated browser can never open a real conversation (apps/web/src/automation.ts: silent voice layer, no session,
 * no microphone, no money) — so this spec checks exactly that, and then PAINTS the coach store through the dev hook
 * (`window.__gambit.coach.paint`, dev server only) to take screenshots of the button in every conversation state.
 * Painting opens nothing; a tap on the painted button must not open anything either.
 *
 * docs/TEACHING.md §4.4: «Поговорить» exists only with the server's runtime AI (`GAMBIT_RUNTIME_AI`, off
 * by default — and off on the e2e server). So the spec first checks that a painted live voice WITHOUT `runtimeAi` shows
 * no button, then paints `runtimeAi: true` for the screenshots. «Спроси» is in the game with the silent voice too.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, expectSilentRun, test } from './fixtures.ts';
import { SCREENSHOT_DIR, ensureStudent, openApp, shot, waitForGame, watchConsole } from './helpers.ts';

const STATES = ['off', 'connecting', 'listening', 'childSpeaking', 'thinking', 'coachSpeaking', 'error'] as const;

async function paint(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => {
    const hook = window.__gambit?.coach;
    if (!hook) throw new Error('window.__gambit.coach is missing — is this the Vite dev server?');
    hook.paint(p);
  }, patch);
}

test('a game under automation opens no conversation; the «Поговорить» button in each state (painted)', async ({ page, request }) => {
  await ensureStudent(request);
  const guard = watchConsole(page);
  const voiceRequests: string[] = [];
  page.on('request', (req) => {
    if (/\/api\/voice\/(live|session)$/.test(req.url()) || /api\.openai\.com/.test(req.url())) voiceRequests.push(req.url());
  });
  let getUserMediaCalls = 0;
  await page.exposeFunction('__e2eGetUserMedia', () => {
    getUserMediaCalls += 1;
  });
  await page.addInitScript(() => {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    if (!media) return;
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) => {
      void (window as unknown as { __e2eGetUserMedia: () => Promise<void> }).__e2eGetUserMedia();
      return original(constraints);
    };
  });

  // a 10-minute game — the auto-start case of the conversation for a real child
  await openApp(page, '#/play?persona=petya&tc=rapid10&color=w&exam=0');
  await waitForGame(page, (s) => s.phase === 'childTurn', 'engines ready', 45_000);
  await page.waitForTimeout(1500);

  // automation: the silent layer, conversation off, no button, no session, no microphone
  const coachState = await page.evaluate(() => window.__gambit?.coach?.state() ?? null);
  expect(coachState, 'the coach dev hook').not.toBeNull();
  expect(coachState?.voiceKind).toBe('silent');
  expect(coachState?.conversationState).toBe('off');
  expect(coachState?.conversationOn).toBe(false);
  // the e2e server runs without GAMBIT_RUNTIME_AI: no generative AI in the child's game
  expect(coachState?.runtimeAi, 'health.ai.runtime of the e2e server').toBe(false);
  const talk = page.locator('.gmb-talk');
  await expect(talk).toHaveCount(0);
  // «Подсказка», «Спроси» (every voice, the silent one too) and the mute button are there
  const dock = page.getByRole('complementary', { name: 'Тренер Гамбитик' });
  await expect(dock.getByRole('button', { name: 'Подсказка' })).toBeVisible();
  await expect(dock.getByRole('button', { name: /^Спроси Гамбитика/ })).toBeVisible();
  await expect(dock.getByRole('button', { name: 'Выключить голос Гамбитика' })).toBeVisible();

  // ───── no runtime AI: a live voice painted into the store still gets no «Поговорить» and no microphone UI ─────
  await paint(page, { voiceKind: 'openai-live', voiceModel: 'gpt-live-1', muted: false, micAvailable: true, bubbleText: '', runtimeAi: false, headphonesConfirmed: false });
  await page.waitForTimeout(150);
  await expect(talk).toHaveCount(0);
  await expect(dock.getByRole('group', { name: 'Наушники' })).toHaveCount(0);
  await expect(dock.getByRole('button', { name: /Нажми и держи/ })).toHaveCount(0);

  // ───── screenshots: the button as a child sees it with the live voice (painted store, runtime AI on) ─────
  await paint(page, { voiceKind: 'openai-live', voiceModel: 'gpt-live-1', muted: false, micAvailable: true, bubbleText: '', runtimeAi: true });
  await expect(talk).toBeVisible();
  const box = await talk.boundingBox();
  expect(box?.width ?? 0, 'a big target for a child').toBeGreaterThanOrEqual(64);
  for (const state of STATES) {
    await paint(page, {
      conversationState: state,
      micLevel: state === 'childSpeaking' ? 0.7 : 0,
      speaking: state === 'coachSpeaking',
      pose: state === 'childSpeaking' || state === 'listening' ? 'listen' : state === 'thinking' ? 'think' : state === 'coachSpeaking' ? 'talk' : 'idle',
      bubbleText: state === 'coachSpeaking' ? 'Привет! Я тебя слушаю — спрашивай что хочешь про партию.' : '',
    });
    await expect(talk).toHaveAttribute('data-state', state);
    const label = await talk.getAttribute('aria-label');
    expect(label, `aria-label in state ${state}`).toBeTruthy();
    await page.waitForTimeout(150);
    const dockBox = await dock.boundingBox();
    if (dockBox) {
      const vp = page.viewportSize() ?? { width: 1440, height: 900 };
      const dir = vp.width === 1440 && vp.height === 900 ? SCREENSHOT_DIR : join(SCREENSHOT_DIR, `${vp.width}x${vp.height}`);
      mkdirSync(dir, { recursive: true });
      const x = Math.max(0, dockBox.x - 24);
      const y = Math.max(0, dockBox.y - 24);
      await page.screenshot({
        path: join(dir, `dock-talk-${state}.png`),
        clip: { x, y, width: Math.min(vp.width - x, dockBox.width + 48), height: Math.min(vp.height - y, dockBox.height + 48) },
        animations: 'disabled',
      });
    }
  }
  await paint(page, { conversationState: 'listening', micLevel: 0, pose: 'listen', bubbleText: '' });
  await shot(page, 'game-talk-listening');

  // a tap on the painted button must not open a session or the microphone under automation
  await talk.click();
  await page.waitForTimeout(1000);
  expect(voiceRequests, 'no voice session was requested').toEqual([]);
  expect(getUserMediaCalls, 'the microphone was never asked for').toBe(0);

  await expectSilentRun(page);
  guard.assertClean();
});
