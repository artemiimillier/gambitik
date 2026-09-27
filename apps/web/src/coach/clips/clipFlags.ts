/**
 * Switches of the «Записи» voice that tests and the developer tools read (docs/voice-clips/SPEC.md §11 «e2e»):
 *
 *  - `gambit.e2eClips` = `on` (localStorage) or `?e2eClips=on` (page URL, the hash's query too): an automated browser
 *    (navigator.webdriver) may run the REAL clips layer — into a muted GainNode(0), never audible — so an e2e test can
 *    assert `clip.plan` / `clip.end` in the black box (`__gambitVoiceDiag.recent()`; in memory only, never sent —
 *    voiceDiag.ts). Without it automation stays on the silent layer, as everywhere.
 *  - `?clipsDemo=<seed>` (dev server only, behind the parental lock): the demo replay of a harvested game
 *    (docs/voice-clips/demo-format.md).
 */
import { isAutomatedBrowser } from '../../automation.ts';
import type { AutomationProbe } from '../../automation.ts';

export const E2E_CLIPS_STORAGE_KEY = 'gambit.e2eClips';
export const E2E_CLIPS_QUERY_PARAM = 'e2eClips';
export const CLIPS_DEMO_QUERY_PARAM = 'clipsDemo';

/** localStorage keys of the layer (all read and written inside try/catch; any of them may come back empty) */
export const CLIP_RECENCY_STORAGE_KEY = 'gambit.clipRecency';
export const CLIP_STATS_STORAGE_KEY = 'gambit.clipStats';
export const CLIP_MISSES_STORAGE_KEY = 'gambit.clipMisses';

function browserProbe(): AutomationProbe {
  const probe: AutomationProbe = {};
  if (typeof navigator !== 'undefined') probe.webdriver = navigator.webdriver === true;
  if (typeof window !== 'undefined') {
    probe.readStorage = (key) => window.localStorage.getItem(key);
    probe.search = pageQuery();
  }
  return probe;
}

/** `location.search` plus the query of the hash route (`#/settings?clipsDemo=w0g0`). */
export function pageQuery(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash;
  const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  return `${window.location.search.replace(/^\?/, '')}&${hashQuery}`;
}

/** true = an automated run asked for the real clips layer (muted). Always false for a real child. */
export function e2eClipsOptIn(probe: AutomationProbe = browserProbe()): boolean {
  if (!isAutomatedBrowser(probe)) return false;
  try {
    if (probe.readStorage?.(E2E_CLIPS_STORAGE_KEY) === 'on') return true;
  } catch {
    // blocked storage
  }
  return new URLSearchParams((probe.search ?? '').replace(/^\?/, '')).get(E2E_CLIPS_QUERY_PARAM) === 'on';
}

const DEMO_SEED_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** The `?clipsDemo=<seed>` of the page, or null (also for a malformed seed). */
export function clipsDemoSeed(search: string = pageQuery()): string | null {
  const seed = new URLSearchParams(search.replace(/^\?/, '')).get(CLIPS_DEMO_QUERY_PARAM);
  return seed !== null && DEMO_SEED_RE.test(seed) ? seed : null;
}
