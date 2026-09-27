/**
 * The `test` every spec imports. Belt and braces on top of the app's own automation guard
 * (apps/web/src/automation.ts keeps the coach and the sound effects silent under `navigator.webdriver`):
 *  - every page gets an init script that replaces `speechSynthesis.speak` with a counting no-op, so even a
 *    bug in the app cannot talk through the speakers;
 *  - the browser itself is launched with --mute-audio (playwright*.config.ts).
 */
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

declare global {
  interface Window {
    /** how many times the page tried to speak (must stay 0) */
    __e2eSpeakCalls?: number;
  }
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      window.__e2eSpeakCalls = 0;
      const synth = window.speechSynthesis as SpeechSynthesis | undefined;
      if (!synth) return;
      Object.defineProperty(synth, 'speak', {
        configurable: true,
        value: (utterance: SpeechSynthesisUtterance) => {
          window.__e2eSpeakCalls = (window.__e2eSpeakCalls ?? 0) + 1;
          // finish at once so nothing in the page waits for a voice that will never come
          setTimeout(() => utterance.dispatchEvent(new Event('end')), 0);
        },
      });
    });
    await use(context);
  },
});

export { expect };

/** The app must not even TRY to speak or to open a paid voice session during an automated run. */
export async function expectSilentRun(page: Page): Promise<void> {
  expect(await page.evaluate(() => navigator.webdriver), 'Playwright browsers report navigator.webdriver').toBe(true);
  expect(await page.evaluate(() => window.__e2eSpeakCalls ?? 0), 'speechSynthesis.speak was never called').toBe(0);
}
