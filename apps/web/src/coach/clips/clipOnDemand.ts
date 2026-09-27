/**
 * «Дозапись голоса» in the browser (docs/voice-clips/ONDEMAND.md): asks the local server to record the sentences
 * the child just saw without a voice — a lesson's parts, or a whole catalogue sentence of any older event (a greeting,
 * an answer, a take-back reply…) — and notices when a recording is published.
 *
 *   silent / inexact plan → controller → request(event, lessonMissing) | requestLines(kind, lineMissing)
 *     → POST /api/voice/clips/request (ids only)
 *   accepted ('queued' / 'recording') → poller: GET /api/voice/clips/status every 4 s (1.5 s while a bubble on screen
 *   waits for its voice, `hurry`) → a new overlay version → the clip layer's `reloadOverlay()` → the next plan hears it
 *
 * Rules:
 *  - never in an automated browser: every request and `check()` return before any fetch (stricter than the silenced
 *    automation switch: an e2e voice opt-in records nothing either); the server refuses the automation header too;
 *  - only while the server says it records (`clipGenAccepts`): off, or a pause only a person can lift, sends nothing;
 *  - ids only (`requestSentenceOf`, `ClipGenLine`): the server renders the words itself from @gambit/content and never
 *    accepts text; a lesson utterance with a sentence that can never be recorded is never requested (whole or nothing, D4);
 *  - each sentence at most once while its answer holds (dedup by its ids), ≤ 6 sentences per POST;
 *  - nothing ever waits for a recording: the phrase is shown at once; the poller refreshes the library, and the
 *    controller may still play a phrase whose bubble is up when its recording lands (G2, ../coachController.ts);
 *  - the poller runs only while something is outstanding (the server's queue is not empty or a job runs) and for at
 *    most 5 min after the last accepted request; one status check at page load and at a game start.
 * The controller decides WHEN a request may go out (a clip layer that really speaks, a live game or the child's own
 * screens, never an exam — ../coachController.ts).
 */
import { lessonSentencesOf, requestSentenceOf } from '@gambit/core';
import type { ClipGenHealth, ClipGenLine, ClipGenOutcome, ClipGenRequest, ClipGenRequestResult, ClipGenSentence, ClipGenStatus, CoachEvent, CoachEventKind } from '@gambit/shared';
import { isApiError } from '../../api/client.ts';
import { isAutomatedBrowser } from '../../automation.ts';

/** The two routes the browser uses (tests pass fakes; the app the typed client, ../../api/client.ts). */
export interface ClipGenApi {
  /** POST /voice/clips/request; null = not sent (an automated browser) */
  request(body: ClipGenRequest): Promise<ClipGenRequestResult | null>;
  /** GET /voice/clips/status */
  status(): Promise<ClipGenStatus | null>;
}

/** The recorded overlay of the clip layer that speaks now. */
export interface ClipOverlayHandle {
  /** re-read it; true = the library changed */
  reload(): Promise<boolean>;
  /** the overlay version the library holds now (null = none); absent = unknown */
  version?(): number | null;
}

export interface ClipOnDemandOptions {
  api: ClipGenApi;
  /** default `isAutomatedBrowser()` (../../automation.ts) */
  isAutomated?: () => boolean;
  /** the speaking clip layer's overlay; null = no clip layer (nothing to reload) */
  overlay?: () => ClipOverlayHandle | null;
  now?: () => number;
  /** status poll period while something is outstanding (default 4 s) */
  pollMs?: number;
  /** …while a bubble on screen waits for its voice (`hurry`, default 1.5 s) */
  fastPollMs?: number;
  /** the poller stops this long after the last accepted request (default 5 min) */
  pollForMs?: number;
}

export interface ClipOnDemand {
  /** what /api/health (or a status / a request answer) says about recording; null = the server has no such feature */
  setHealth(health: ClipGenHealth | null | undefined): void;
  health(): ClipGenHealth | null;
  /**
   * Asks the server to record the sentences `missing` (indexes into `lessonSentencesOf(event)`) of one silent utterance.
   * Resolves with one outcome per index (a sentence asked for before and still in hand repeats its answer), or null
   * when nothing was sent: an automated browser, recording off / paused, a sentence that can never be recorded, a
   * failure. Never rejects.
   */
  request(event: Pick<CoachEvent, 'kind' | 'say' | 'saySentences' | 'text'>, missing: readonly number[]): Promise<ClipGenOutcome[] | null>;
  /**
   * Asks the server to record whole catalogue sentences of an older event's clip twin (ids only: line, wording number,
   * piece / gender variant). One outcome per line, as `request`; null when nothing was sent.
   */
  requestLines(kind: CoachEventKind, lines: readonly ClipGenLine[]): Promise<ClipGenOutcome[] | null>;
  /** The common path of both: sentences already built from ids (1..n, sent ≤ 6 per POST). */
  requestSentences(kind: CoachEventKind, sentences: readonly ClipGenSentence[]): Promise<ClipGenOutcome[] | null>;
  /**
   * Why a request would send nothing right now (a Latin code for the black box), null = it may go: 'automation',
   * 'no-health' (an old server / not answered yet), 'off', 'paused', 'quiet' (a failed POST a moment ago), 'disposed'.
   */
  refusal(): ClipGenRefusal | null;
  /**
   * A bubble on screen waits for its recording (G2): the status is looked at every 1.5 s instead of 4 s for the next
   * `ms` (the poller still stops as soon as nothing is outstanding).
   */
  hurry(ms: number): void;
  /** one status check (page load, game start); a busy server starts the poller. null = not asked / failed */
  check(): Promise<ClipGenStatus | null>;
  /** the status poller is running */
  readonly polling: boolean;
  dispose(): void;
}

export type ClipGenRefusal = 'automation' | 'no-health' | 'off' | 'paused' | 'quiet' | 'disposed';

export const CLIP_GEN_POLL_MS = 4_000;
/** the poll period while a bubble on screen waits for its voice (G2): a recording plays only while its bubble is up */
export const CLIP_GEN_POLL_FAST_MS = 1_500;
export const CLIP_GEN_POLL_FOR_MS = 5 * 60_000;
/** the server takes at most this many sentences per request (the schema's 1..6) */
export const CLIP_GEN_MAX_SENTENCES = 6;
/** K of the book's policy P(K): recorded wordings a pool variant keeps before the book reuses them (docs/voice-clips/ONDEMAND.md) */
export const LESSON_VOICE_MIN = 3;

/** how long an answer about a sentence holds before the same sentence may be asked again */
const ANSWER_HOLDS_MS: Record<ClipGenOutcome, number> = {
  // the server's queue drops an item after 15 min
  queued: 15 * 60_000,
  recording: 15 * 60_000,
  // the overlay is reloaded once; asking again soon would get the same answer
  voiced: 60_000,
  // a cap / a pause / a full queue may lift later
  budget: 2 * 60_000,
  paused: 2 * 60_000,
  'queue-full': 2 * 60_000,
  // never again in this page
  'given-up': Number.POSITIVE_INFINITY,
  invalid: Number.POSITIVE_INFINITY,
};

/** after a refused / failed POST nothing is sent for this long (a server under load, a crash) */
const QUIET_AFTER_ERROR_MS = 60_000;

/** The server records now: 'ready', or a timed pause whose time is over. Off, or a pause a person must lift: no. */
export function clipGenAccepts(health: ClipGenHealth | null | undefined, now: number): boolean {
  if (!health) return false;
  if (health.state === 'ready') return true;
  return health.state === 'paused' && typeof health.until === 'number' && health.until <= now;
}

/**
 * The library can grow on this machine: the server records now or after a timed pause (a day cap, a rate limit). The
 * book's «cheap growth» only makes sense then — without recordings coming it would only bias the wordings.
 */
export function clipGenGrows(health: ClipGenHealth | null | undefined): boolean {
  if (!health) return false;
  return health.state === 'ready' || (health.state === 'paused' && typeof health.until === 'number');
}

const isRecording = (outcome: ClipGenOutcome): boolean => outcome === 'queued' || outcome === 'recording';

export function createClipOnDemand(options: ClipOnDemandOptions): ClipOnDemand {
  const api = options.api;
  const isAutomated = options.isAutomated ?? (() => isAutomatedBrowser());
  const now = options.now ?? (() => Date.now());
  const pollMs = options.pollMs ?? CLIP_GEN_POLL_MS;
  const fastPollMs = Math.min(pollMs, options.fastPollMs ?? CLIP_GEN_POLL_FAST_MS);
  const pollForMs = options.pollForMs ?? CLIP_GEN_POLL_FOR_MS;

  let current: ClipGenHealth | null = null;
  let disposed = false;
  let quietUntil = -Infinity;
  /** the sentence's ids (JSON) → the server's last answer about it */
  const answers = new Map<string, { outcome: ClipGenOutcome; at: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** when the scheduled poll fires (epoch of `now()`) — a hurry may bring it forward */
  let timerAt = Infinity;
  let lastAcceptAt = -Infinity;
  /** until when the status is looked at every `fastPollMs` (G2) */
  let fastUntil = -Infinity;
  /**
   * the overlay version this page's library is known to hold (undefined = none seen yet) — committed only once a reload
   * brought it (or the library already had it): a failed or joined reload is tried again on the next look
   */
  let lastVersion: number | null | undefined;
  /** the version a reload is under way for (null = none) */
  let reloadingFor: number | null = null;
  /** the newest version a status named */
  let serverVersion: number | null | undefined;

  function setHealth(health: ClipGenHealth | null | undefined): void {
    current = health ?? null;
  }

  function known(sig: string): ClipGenOutcome | null {
    const answer = answers.get(sig);
    if (!answer) return null;
    if (now() - answer.at < ANSWER_HOLDS_MS[answer.outcome]) return answer.outcome;
    answers.delete(sig);
    return null;
  }

  function reloadOverlay(): void {
    const handle = options.overlay?.() ?? null;
    if (handle) void handle.reload().catch(() => false);
  }

  /** resolves when the reload it may start has settled (never rejects) */
  async function applyStatus(status: ClipGenStatus): Promise<void> {
    setHealth(status.health);
    const version = status.overlay?.version ?? null;
    serverVersion = version;
    if (version === lastVersion) return;
    if (version === null) {
      lastVersion = null;
      return;
    }
    const handle = options.overlay?.() ?? null;
    // no clip layer: nothing to re-read (a clip layer made later loads the overlay afresh)
    if (handle === null) {
      lastVersion = version;
      return;
    }
    if (reloadingFor === version) return;
    // the library holds it already (loaded at the page's start, or re-read by a 'voiced' answer)
    if (handle.version?.() === version) {
      lastVersion = version;
      return;
    }
    // a newly published phrase (or the first look): the library re-reads the overlay's index; the version counts as
    // seen only once the reload brought it — a failed one (a server restart, a torn index) is tried on the next look
    reloadingFor = version;
    try {
      const changed = await handle.reload().catch(() => false);
      // the version the library really holds, when it can tell (a reload may have brought an older one)
      const holds = handle.version?.();
      if (holds !== undefined ? holds === version : changed) lastVersion = version;
    } finally {
      if (reloadingFor === version) reloadingFor = null;
    }
  }

  /** the server published a version this page's library does not hold yet (a reload failed, or is under way) */
  function libraryBehind(): boolean {
    return serverVersion !== undefined && serverVersion !== null && serverVersion !== lastVersion;
  }

  async function fetchStatus(): Promise<ClipGenStatus | null> {
    try {
      const status = await api.status();
      if (disposed || !status) return null;
      await applyStatus(status);
      return status;
    } catch {
      return null;
    }
  }

  function outstanding(status: ClipGenStatus | null): boolean {
    // no answer: keep looking until the deadline (the server may be restarting)
    return status === null || status.queue > 0 || status.busy;
  }

  function periodNow(): number {
    return now() < fastUntil ? fastPollMs : pollMs;
  }

  function schedulePoll(): void {
    if (disposed) return;
    const period = periodNow();
    // a hurry brings a slow poll forward; a poll already due sooner stays as it is
    if (timer !== null) {
      if (timerAt - now() <= period) return;
      clearTimeout(timer);
    }
    timerAt = now() + period;
    timer = setTimeout(() => {
      timer = null;
      timerAt = Infinity;
      void pollOnce();
    }, period);
  }

  async function pollOnce(): Promise<void> {
    if (disposed) return;
    const status = await fetchStatus();
    if (disposed) return;
    // a publish this page could not read yet (a failed reload) is looked at again too, while the poller runs anyway
    if ((outstanding(status) || libraryBehind()) && now() - lastAcceptAt < pollForMs) schedulePoll();
  }

  function onRequestError(error: unknown): void {
    quietUntil = now() + QUIET_AFTER_ERROR_MS;
    // the server says recording is off (or refuses this browser): nothing more is asked until a status says otherwise
    if (isApiError(error) && error.status === 503 && (error.code === 'clip-gen-off' || error.code === 'automation')) {
      setHealth({ state: 'off', overlay: current?.overlay ?? false });
    }
  }

  function refusal(): ClipGenRefusal | null {
    if (disposed) return 'disposed';
    if (isAutomated()) return 'automation';
    if (current === null) return 'no-health';
    if (!clipGenAccepts(current, now())) return current.state === 'off' ? 'off' : 'paused';
    return now() < quietUntil ? 'quiet' : null;
  }

  async function requestSentences(kind: CoachEventKind, wanted: readonly ClipGenSentence[]): Promise<ClipGenOutcome[] | null> {
    // an automated browser never asks — before anything else, so not even the ids are looked at
    if (disposed || isAutomated()) return null;
    if (wanted.length === 0 || refusal() !== null) return null;
    const sigs = wanted.map((ids) => JSON.stringify(ids));
    const toSend: number[] = [];
    const seen = new Set<string>();
    sigs.forEach((sig, i) => {
      if (known(sig) === null && !seen.has(sig)) {
        seen.add(sig);
        toSend.push(i);
      }
    });
    let voiced = false;
    for (let from = 0; from < toSend.length; from += CLIP_GEN_MAX_SENTENCES) {
      const chunk = toSend.slice(from, from + CLIP_GEN_MAX_SENTENCES);
      let result: ClipGenRequestResult | null;
      try {
        result = await api.request({ sentences: chunk.map((i) => wanted[i] as ClipGenSentence), kind });
      } catch (error) {
        onRequestError(error);
        return null;
      }
      if (disposed || !result) return null;
      setHealth(result.health);
      chunk.forEach((i, j) => {
        const outcome = result.results[j]?.outcome;
        if (outcome === undefined) return;
        answers.set(sigs[i] as string, { outcome, at: now() });
        if (isRecording(outcome)) lastAcceptAt = now();
        if (outcome === 'voiced') voiced = true;
      });
    }
    // «already recorded» while this page played nothing: its overlay is older than the server's (S8) — re-read once
    if (voiced) reloadOverlay();
    if (now() - lastAcceptAt < pollForMs) schedulePoll();
    const outcomes = sigs.map((sig) => known(sig));
    return outcomes.every((o): o is ClipGenOutcome => o !== null) ? outcomes : null;
  }

  function request(event: Pick<CoachEvent, 'kind' | 'say' | 'saySentences' | 'text'>, missing: readonly number[]): Promise<ClipGenOutcome[] | null> {
    // an automated browser never asks — before anything else, so not even the ids are built
    if (disposed || isAutomated()) return Promise.resolve(null);
    if (missing.length === 0 || refusal() !== null) return Promise.resolve(null);
    const sentences = lessonSentencesOf(event);
    const wanted: ClipGenSentence[] = [];
    for (const i of missing) {
      const s = sentences[i];
      const ids = s ? requestSentenceOf(event, s) : null;
      // one sentence can never be recorded: the utterance is never voiced — nothing is paid for its other sentences
      if (!ids) return Promise.resolve(null);
      wanted.push(ids);
    }
    return requestSentences(event.kind, wanted);
  }

  function requestLines(kind: CoachEventKind, lines: readonly ClipGenLine[]): Promise<ClipGenOutcome[] | null> {
    // ids only, in the shape the server's strict schema takes (never a stray field)
    const wanted: ClipGenSentence[] = lines.map((l) => ({
      line: { id: l.id, n: l.n, ...(l.piece !== undefined ? { piece: l.piece } : {}), ...(l.g !== undefined ? { g: l.g } : {}) },
    }));
    return requestSentences(kind, wanted);
  }

  function hurry(ms: number): void {
    if (disposed || isAutomated() || !Number.isFinite(ms) || ms <= 0) return;
    fastUntil = Math.max(fastUntil, now() + ms);
    // follow the server for that long even when no POST went out just now (the sentence's answer was still in hand —
    // the same phrase said again): the poller still stops as soon as nothing is outstanding
    lastAcceptAt = Math.max(lastAcceptAt, now() - pollForMs + ms);
    schedulePoll();
  }

  async function check(): Promise<ClipGenStatus | null> {
    if (disposed || isAutomated() || current === null) return null;
    const status = await fetchStatus();
    if (status && outstanding(status)) {
      // the server still records what this page (or its previous load) asked for: follow it
      lastAcceptAt = now();
      schedulePoll();
    }
    return status;
  }

  return {
    setHealth,
    health: () => current,
    request,
    requestLines,
    requestSentences,
    refusal,
    hurry,
    check,
    get polling() {
      return timer !== null;
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      timerAt = Infinity;
      answers.clear();
    },
  };
}
