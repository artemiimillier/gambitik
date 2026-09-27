/**
 * Automation guard: a browser driven by WebDriver / Playwright / Puppeteer (`navigator.webdriver === true`) must be
 * SILENT and FREE by default — no `speechSynthesis` (it speaks through the computer's real macOS voice, even from a
 * headless browser), no WebAudio sound effects, no OpenAI realtime session (money), no microphone.
 *
 * This lives in the app, not in a test config, on purpose: every tool that drives the app (e2e suite, agents,
 * ad-hoc scripts) gets the silent behaviour without having to know about it.
 *
 * Deliberate opt-in for a test that really wants sound: localStorage `gambit.e2eVoice` = `on`, or `?e2eVoice=on`
 * in the page URL.
 */

export const E2E_VOICE_STORAGE_KEY = 'gambit.e2eVoice';
export const E2E_VOICE_QUERY_PARAM = 'e2eVoice';
const OPT_IN_VALUE = 'on';

/** Everything the decision depends on, injectable for tests. */
export interface AutomationProbe {
  /** `navigator.webdriver` */
  webdriver?: boolean | undefined;
  /** reads one localStorage value; may throw (storage blocked) */
  readStorage?: ((key: string) => string | null) | undefined;
  /** `location.search` (and/or the query part of the hash) */
  search?: string | undefined;
}

function browserProbe(): AutomationProbe {
  const probe: AutomationProbe = {};
  if (typeof navigator !== 'undefined') probe.webdriver = navigator.webdriver === true;
  if (typeof window !== 'undefined') {
    probe.readStorage = (key) => window.localStorage.getItem(key);
    const hash = window.location.hash;
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?')) : '';
    // the app is a hash router: accept both `/?e2eVoice=on#/…` and `/#/play?…&e2eVoice=on`
    probe.search = `${window.location.search}&${hashQuery.replace(/^\?/, '')}`;
  }
  return probe;
}

/** True when the page runs inside an automation-controlled browser. */
export function isAutomatedBrowser(probe: AutomationProbe = browserProbe()): boolean {
  return probe.webdriver === true;
}

/** True when the automation run explicitly asked for real voice and sound. */
export function automationVoiceOptIn(probe: AutomationProbe = browserProbe()): boolean {
  try {
    if (probe.readStorage?.(E2E_VOICE_STORAGE_KEY) === OPT_IN_VALUE) return true;
  } catch {
    // blocked storage: no opt-in from there
  }
  const search = (probe.search ?? '').replace(/^\?/, '');
  return new URLSearchParams(search).get(E2E_VOICE_QUERY_PARAM) === OPT_IN_VALUE;
}

/**
 * THE switch: true = stay silent (automation without an explicit opt-in).
 * Always false for a real child in a real browser.
 */
export function automationSilenced(probe: AutomationProbe = browserProbe()): boolean {
  return isAutomatedBrowser(probe) && !automationVoiceOptIn(probe);
}
