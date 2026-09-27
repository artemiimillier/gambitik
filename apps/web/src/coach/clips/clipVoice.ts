/**
 * «Записи» — the voice layer of pre-recorded Giselle clips (docs/voice-clips/SPEC.md §5, §6), `kind: 'clips'`.
 * Free, no microphone, no network during a game: every word is a recording made once in advance.
 *
 *   coach.say(event) → controller queue → play(): layer.speakEvent(event, { interrupt, blitz })
 *     → planClips(clipInputOf(event, { name }), library index, { recency, prevBark, allowedSans, caps, blitz, … }) ≤ 2 ms
 *     → library.ensure(ids): memory hit | local fetch + decode (≤ 1.5 s, else re-planned without the slow take)
 *     → player: WebAudio, the planned gaps, 5 ms fades → speaking(true) at the audible start … resolve at the audible end
 *
 * The missing-clip ladder (§6.1) is the planner's: L1 another take · L2 split move · L3 sibling / dropped tail ·
 * L4 an optional sentence dropped · L5 the moment's generic line · L6 nothing (silent timing + bubble). A take that
 * failed to load is skipped like a missing one. Nothing is ever generated; no second voice ever joins a sentence.
 *
 * `init()` loads the manifest; without a library it REJECTS and the controller moves down its chain to the silent
 * layer (dev / e2e builds have no recordings). Under automation the factory never builds this layer — except with
 * the e2e opt-in (`gambit.e2eClips`), and then into a muted GainNode(0).
 *
 * The lesson model (docs/TEACHING.md §4.5): a lesson phrase (it carries `say`) is either played from its own recorded twin
 * or not at all; a twin whose plan would need the moment's generic line is dropped too. An old generic line («Смотри на
 * зелёную стрелку!») never stands in for a lesson phrase — whatever the core's `clipInputOf` returns.
 * «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): a lesson phrase without a twin is played from its own recorded units by their
 * exact keys (core `planLessonClips`: the static library and the recorded overlay, no generic line, no sentence caps) —
 * the whole utterance or nothing. A silent plan tells the controller which sentences could be recorded
 * (`ClipPlanInfo.lessonMissing`); the controller asks the server (./clipOnDemand.ts) and marks the bubble. The book's
 * probe (`lessonProbe`) reads the library live, so a newly published phrase counts from the next pick.
 * «Дозапись голоса» for every phrase (G1): a non-lesson event's clip twin is planned with the wording its bubble
 * really reads (core `twinWordingsOf` → `PlanContext.wordings`: that exact take first, else the pool); the
 * whole sentences whose exact wording has no take are named for recording (`ClipPlanInfo.lineMissing`).
 * Same turn (G2): `playLate` plays an utterance that was silent a moment ago once its recording arrived — whole, as its
 * bubble reads, only into a running context and only while this layer says nothing else (../coachController.ts decides
 * when). It is never reported as a plan and never asks for a gesture.
 *
 * Black box (`voiceDiag`, codes only — never the Russian words): clip.init, clip.plan, clip.miss, clip.mismatch,
 * clip.long, clip.load, clip.end, clip.gesture, clip.lesson.
 */
import { clipCapsFor, clipInputOf, createClipRecency, planClips, planLessonClips, poolKeyOf, slotFormOf, slotGuardOf, slotKeyOf, slotUnitKey, splitOf, stripName, twinWholeWordings, twinWordingsOf } from '@gambit/core';
import type { ClipPlan, ClipRecency, PlanContext } from '@gambit/core';
import type { CoachEvent, VoiceLayer } from '@gambit/shared';
import { createGestureGate } from '../gestureGate.ts';
import type { GestureGate } from '../gestureGate.ts';
import type { AudioUnlockResult, HearingProblem } from '../rtcSession.ts';
import { getBrowserStorage } from '../settings.ts';
import type { SettingsStorage } from '../settings.ts';
import { createSilentVoice } from '../silentVoice.ts';
import { diag } from '../voiceDiag.ts';
import type { DiagValue } from '../voiceDiag.ts';
import type { ClipExtras, ClipLateOptions, ClipLateResult, ClipLibraryStatus, ClipPlanInfo, ClipPrewarmHint, ClipSpeakOptions, GestureGated, LessonTakeProbe } from '../voiceTypes.ts';
import { createEmitter } from '../voiceUtils.ts';
import type { Unsubscribe } from '../voiceUtils.ts';
import { createClipAudio } from './clipAudio.ts';
import type { ClipAudio } from './clipAudio.ts';
import { createClipLibrary } from './clipLibrary.ts';
import type { ClipLibrary, LoadedClip } from './clipLibrary.ts';
import { cachedChildName, emptyGameStats, missDiagKey, readRecency, recordClipMisses, writeClipStats, writeRecency } from './clipMemory.ts';
import type { ClipGameStats } from './clipMemory.ts';
import { createClipPlayer } from './clipPlayer.ts';
import type { ClipEndHow, ClipPlayItem, ClipPlayback, ClipPlayer } from './clipPlayer.ts';

export interface ClipVoiceOptions {
  library?: ClipLibrary;
  audio?: ClipAudio;
  player?: ClipPlayer;
  /** localStorage for recency / stats / misses (default the browser's; null = remember nothing) */
  storage?: SettingsStorage | null;
  /** the child's name as the templates say it (stripped from compiled text); default: the cached profile */
  childName?: () => string | undefined;
  rng?: () => number;
  now?: () => number;
  /** probe for sticky user activation (the gesture gate); default navigator.userActivation */
  hasUserActivation?: () => boolean;
  /** the gate's first-gesture listeners (default window; null = none — tests) */
  gestureTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** how long a phrase waits for its clips (local fetch + decode) before it is re-planned without them */
  loadTimeoutMs?: number;
  /** how long a suspended context may take to resume outside a gesture before the phrase goes silent */
  resumeTimeoutMs?: number;
  /** the internal silent timing (L6, locked audio); default the app's silent layer */
  createSilent?: () => VoiceLayer;
}

export type ClipVoice = VoiceLayer &
  GestureGated &
  ClipExtras & {
    readonly kind: 'clips';
    speakEvent(event: CoachEvent, opts?: ClipSpeakOptions): Promise<void>;
    /** the dock's «Не слышно? Нажми сюда» (feature-detected as VoiceHealthExtras) */
    onHearingProblem(cb: (problem: HearingProblem) => void): Unsubscribe;
    onHearingOk(cb: () => void): Unsubscribe;
    recheckAudio(): Promise<AudioUnlockResult | null>;
    /** there is no microphone in this mode */
    retryMicrophone(): Promise<boolean>;
  };

const DEFAULT_LOAD_TIMEOUT_MS = 1500;
const DEFAULT_RESUME_TIMEOUT_MS = 400;
/** a late play (G2) waits this long for its takes: nothing else is said meanwhile, and a new phrase cuts the wait */
export const LATE_LOAD_TIMEOUT_MS = 3000;

/**
 * A lesson phrase (`say`) with no recorded twin (`clip`, docs/TEACHING.md §4.5): «Записи» plays it only from its own
 * recorded units, whole or not at all (`planLessonClips`); a layer without that planner plays nothing for it.
 */
export function isUnrecordedLesson(event: Pick<CoachEvent, 'say' | 'clip'>): boolean {
  return event.say !== undefined && event.clip === undefined;
}

/**
 * «Дозапись голоса»: a free-worded answer's line is recorded up to this many wordings (the cheapest first, one at a
 * time), so the child hears it said in a few ways — as the lesson book's P(3) keeps three recorded wordings a pool.
 */
export const ANSWER_VARIETY = 3;

/**
 * An answer with no board facts in its words (a poke, a «Спроси» answer, a thought reply): the planner picks any take
 * of its pools, `text` is only the first wording — the bubble shows the words really heard (../coachController.ts).
 */
export function isFreeWordedAnswer(event: Pick<CoachEvent, 'kind' | 'clip' | 'teach'>): boolean {
  return event.kind === 'answer' && event.clip !== undefined && event.teach === undefined;
}

/** the same words, whatever the spacing, «...» / «…», the dash or the case («Привет-привет!» ~ «привет-привет!») */
function wordsOf(text: string): string {
  return text.normalize('NFC').replace(/\.\.\./gu, '…').replace(/[–−]/gu, '—').replace(/\s+/gu, ' ').trim().toLowerCase();
}

interface Current {
  token: number;
  playback: ClipPlayback | null;
  plan: ClipPlan;
  event: CoachEvent;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export function createClipVoice(options: ClipVoiceOptions = {}): ClipVoice {
  const audio = options.audio ?? createClipAudio();
  const library = options.library ?? createClipLibrary({ audio });
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  const childName = options.childName ?? (() => cachedChildName(storage));
  const rng = options.rng ?? Math.random;
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const resumeTimeoutMs = options.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS;

  const level = createEmitter<number>();
  const speakingChange = createEmitter<boolean>();
  const gestureChange = createEmitter<boolean>();
  const planned = createEmitter<ClipPlanInfo>();
  const hearingProblem = createEmitter<HearingProblem>();
  const hearingOk = createEmitter<void>();

  const player =
    options.player ??
    createClipPlayer({
      audio,
      onSpeaking: (value) => speakingChange.emit(value),
      onLevel: (value) => level.emit(value),
    });
  const silent = (options.createSilent ?? (() => createSilentVoice()))();
  silent.onLevel((value) => level.emit(value));
  silent.onSpeakingChange((value) => speakingChange.emit(value));

  const recency: ClipRecency = createClipRecency({ init: readRecency(storage) });
  let prevBark = false;
  let seq = 0;
  let current: Current | null = null;
  /** the token of a phrase still loading its takes (null = none) */
  let inFlight: number | null = null;
  let last: { plan: ClipPlan; clips: LoadedClip[]; items: ClipPlayItem[] } | null = null;
  let disposed = false;
  let hearingSuspected = false;
  let game: { timeControlId: string; stats: ClipGameStats } | null = null;

  const gate: GestureGate = createGestureGate({
    onUnlock: () => {
      audio.unlockInGesture();
      diag('clip.gesture', { state: audio.state() });
      prewarmHotDecode();
    },
    ...(options.hasUserActivation ? { hasUserActivation: options.hasUserActivation } : {}),
    ...(options.gestureTarget !== undefined ? { target: options.gestureTarget } : {}),
  });
  gate.onChange((needs) => gestureChange.emit(needs));

  // ───────────────────────── planning ─────────────────────────

  /** `late`: a G2 play — never a bark in front (the child has read the bubble already) */
  function planFor(event: CoachEvent, blitz: boolean, available: (id: string) => boolean, opts: { late?: boolean } = {}): ClipPlan {
    const ctx: PlanContext = {
      rng,
      recency,
      available,
      blitz,
      priority: event.priority,
      prevBark: opts.late === true ? true : prevBark,
      caps: clipCapsFor({ kind: event.kind, ...(event.teach?.style ? { style: event.teach.style } : {}), blitz }),
    };
    // a lesson phrase without its twin: its own recorded units by exact keys, the whole utterance or nothing (never its
    // compiled text — it would fall to a generic line)
    if (isUnrecordedLesson(event)) return planLessonClips(event, library.index, { rng, recency, available, blitz });
    const allowed = slotGuardOf(event);
    if (allowed !== undefined) ctx.allowedSans = allowed;
    const name = childName();
    // a clip twin: the wording its bubble really reads is played first when it has a take (and named for recording
    // when it has none) — the pool's other wordings only stand in. A free-worded answer has no such wording (its
    // bubble takes the words heard): any recorded wording plays, by recency, and its pool grows to a few wordings
    if (event.clip !== undefined && event.say === undefined) {
      if (isFreeWordedAnswer(event)) ctx.grow = ANSWER_VARIETY;
      else ctx.wordings = twinWordingsOf(event, name ? { name } : {});
    }
    const plan = planClips(clipInputOf(event, name ? { name } : {}), library.index, ctx);
    // a lesson twin that could only be said with the moment's generic line: silence instead (§4.5)
    if (event.say !== undefined && (plan.src === 'generic' || plan.stats.generic > 0)) {
      diag('clip.lesson', { kind: event.kind, dropped: 'generic' });
      return planClips(null, library.index, ctx);
    }
    return plan;
  }

  function report(event: CoachEvent, plan: ClipPlan): void {
    const fields: Record<string, DiagValue> = {
      kind: event.kind,
      src: plan.src,
      level: plan.level,
      units: plan.stats.units,
      slots: plan.stats.slots,
      split: plan.stats.split,
      generic: plan.stats.generic,
      dropped: plan.stats.dropped,
      ms: Math.round(plan.ms),
      bark: plan.bark,
    };
    const lines = (plan.lineMissing ?? []).length;
    if (lines > 0) fields.lines = lines;
    diag('clip.plan', fields);
    for (const miss of plan.misses.slice(0, 6)) diag('clip.miss', { level: miss.level, what: missDiagKey(miss.key), kind: event.kind });
    if (plan.mismatch) diag('clip.mismatch', { kind: event.kind });
    if (plan.long) diag('clip.long', { kind: event.kind, ms: Math.round(plan.ms) });
    recordClipMisses(storage, plan.misses.filter((m) => m.level >= 2));
    const missing = plan.clips.length === 0 ? (plan.lessonMissing ?? []) : [];
    if (isUnrecordedLesson(event)) diag('clip.lesson', { kind: event.kind, voiced: plan.clips.length > 0, missing: missing.length });
    if (game) {
      game.stats.utterances += 1;
      if (plan.clips.length === 0) game.stats.silent += 1;
      else if (plan.stats.generic > 0) game.stats.generic += 1;
      else game.stats.recorded += 1;
    }
    const info: ClipPlanInfo = { eventId: event.id, kind: event.kind, src: plan.src, level: plan.level, heard: plan.heard, ms: plan.ms, clips: plan.clips.length };
    if (missing.length > 0) info.lessonMissing = [...missing];
    if (lines > 0) info.lineMissing = (plan.lineMissing ?? []).map((l) => ({ ...l }));
    if (!sayableWhole(event)) info.partial = true;
    planned.emit(info);
  }

  /**
   * Can the recordings ever say this bubble whole (what a late play needs)? A lesson phrase without its twin (its own
   * units, whole or nothing), a free-worded answer (its bubble takes the words heard), a twin of whole sentences whose
   * bubble is exactly a combination of their wordings. A twin of whole sentences that says only part of its bubble — an
   * opener naming the opponent, the game end's practice idea — never is. A twin with a move sentence (a head, a slot,
   * a tail) is told only when it plays (`voicedWhole`).
   */
  function sayableWhole(event: CoachEvent): boolean {
    if (isUnrecordedLesson(event) || isFreeWordedAnswer(event) || event.clip === undefined) return true;
    const onlyWhole = event.clip.sentences.every((sentence) => sentence.items.length === 1 && 'line' in (sentence.items[0] as object));
    if (!onlyWhole) return true;
    const name = childName();
    return twinWholeWordings(event, name ? { name } : {}) !== null;
  }

  function itemsOf(plan: ClipPlan, loaded: ReadonlyMap<string, LoadedClip>): ClipPlayItem[] | null {
    const items: ClipPlayItem[] = [];
    for (const c of plan.clips) {
      const clip = loaded.get(c.id);
      if (!clip) return null;
      items.push({ clip, gapBeforeMs: c.gapBeforeMs, sentence: c.sentence });
    }
    return items;
  }

  // ───────────────────────── audio ─────────────────────────

  /** a running context, or null (then: silent timing, and a gesture is asked for) */
  async function runningAudio(): Promise<boolean> {
    const state = audio.state();
    if (state === 'running') return true;
    if (audio.context() === null) return false;
    // sticky activation lets a context resume outside a gesture (Chrome); a locked page stays suspended
    const after = await withTimeout(audio.resume(), resumeTimeoutMs, audio.state());
    if (after === 'running') return true;
    if (!gate.needsUserGesture) {
      // the child has touched the page before, still no sound: the dock offers «Не слышно? Нажми сюда»
      hearingSuspected = true;
      hearingProblem.emit('notPlaying');
    }
    gate.lock();
    diag('clip.gesture', { state: after, needs: true });
    return false;
  }

  function silentTiming(event: CoachEvent): Promise<void> {
    const text = (event.bubbleText || event.text || '').trim();
    return silent.speak(text);
  }

  // ───────────────────────── speaking ─────────────────────────

  async function play(event: CoachEvent, plan: ClipPlan, items: ClipPlayItem[], token: number): Promise<void> {
    if (!(await runningAudio()) || token !== seq || disposed) {
      if (token === seq && !disposed) await silentTiming(event);
      return;
    }
    const playback = player.play(items);
    if (!playback) {
      await silentTiming(event);
      return;
    }
    current = { token, playback, plan, event };
    const startedAt = now();
    const how: ClipEndHow = await playback.ended;
    const heard = playback.heardIds();
    if (heard.length > 0) {
      recency.note(heard);
      writeRecency(storage, recency.snapshot());
    }
    if (hearingSuspected && how !== 'watchdog') {
      hearingSuspected = false;
      hearingOk.emit();
    }
    diag('clip.end', { how, ms: Math.round(now() - startedAt), planMs: playback.ms });
    if (current?.token === token) current = null;
  }

  async function speakEvent(event: CoachEvent, opts: ClipSpeakOptions = {}): Promise<void> {
    if (disposed) return;
    stopCurrent();
    const token = ++seq;
    // loading its takes, nothing is `current` yet: a late play (G2) must still see that the layer is busy
    inFlight = token;
    try {
      await speakPlanned(event, opts, token);
    } finally {
      if (inFlight === token) inFlight = null;
    }
  }

  async function speakPlanned(event: CoachEvent, opts: ClipSpeakOptions, token: number): Promise<void> {
    const blitz = opts.blitz === true;
    let plan = planFor(event, blitz, (id) => !library.failed(id));
    prevBark = plan.bark;
    if (plan.clips.length === 0) {
      report(event, plan);
      current = { token, playback: null, plan, event };
      await silentTiming(event);
      if (current?.token === token) current = null;
      return;
    }
    const loadStarted = now();
    let loaded = await library.ensure(
      plan.clips.map((c) => c.id),
      { timeoutMs: loadTimeoutMs },
    );
    if (token !== seq || disposed) return;
    let items = itemsOf(plan, loaded);
    if (!items) {
      // a take did not load (missing file, decode error, too slow): plan again without it — never a hole in a sentence
      const slow = new Set(plan.clips.map((c) => c.id).filter((id) => !loaded.has(id)));
      plan = planFor(event, blitz, (id) => !library.failed(id) && !slow.has(id));
      prevBark = plan.bark;
      loaded = plan.clips.length > 0 ? await library.ensure(plan.clips.map((c) => c.id), { timeoutMs: loadTimeoutMs }) : new Map();
      if (token !== seq || disposed) return;
      items = itemsOf(plan, loaded);
    }
    diag('clip.load', { n: plan.clips.length, ok: items !== null, ms: Math.round(now() - loadStarted) });
    report(event, plan);
    if (!items || items.length === 0) {
      current = { token, playback: null, plan, event };
      await silentTiming(event);
      if (current?.token === token) current = null;
      return;
    }
    last = { plan, clips: items.map((i) => i.clip), items };
    await play(event, plan, items, token);
  }

  // ───────────────────────── a late play (G2) ─────────────────────────

  /** the plan says the utterance whole, exactly as its bubble reads — else a late play waits (or never happens) */
  function voicedWhole(event: CoachEvent, plan: ClipPlan): boolean {
    if (plan.clips.length === 0) return false;
    // the lesson planner plays the whole utterance by its exact keys or nothing
    if (isUnrecordedLesson(event)) return true;
    if (plan.src === 'generic' || plan.stats.generic > 0 || plan.stats.dropped > 0) return false;
    // an answer twin's bubble takes the words really heard when it starts
    if (isFreeWordedAnswer(event)) return true;
    const name = childName();
    const heard = wordsOf(plan.heard);
    return [event.text, event.bubbleText].some((t) => typeof t === 'string' && t.trim() !== '' && wordsOf(stripName(t, name)) === heard);
  }

  async function playLate(event: CoachEvent, opts: ClipLateOptions = {}): Promise<ClipLateResult> {
    if (disposed || current !== null || (inFlight !== null && inFlight === seq)) return 'busy';
    // never a resume, never a gesture asked for, never the silent timing: a locked or suspended page simply stays quiet
    if (audio.state() !== 'running') return 'no-audio';
    const plan = planFor(event, opts.blitz === true, (id) => !library.failed(id), { late: true });
    if (!voicedWhole(event, plan)) return 'not-voiced';
    const token = ++seq;
    inFlight = token;
    try {
      const loaded = await library.ensure(
        plan.clips.map((c) => c.id),
        { timeoutMs: LATE_LOAD_TIMEOUT_MS },
      );
      if (token !== seq || disposed) return 'stopped';
      const items = itemsOf(plan, loaded);
      // a take that did not load: never half an utterance — a later try plans without it
      if (!items || items.length === 0) return 'not-voiced';
      if (opts.stillCurrent && !opts.stillCurrent()) return 'stopped';
      if (audio.state() !== 'running') return 'no-audio';
      const playback = player.play(items);
      if (!playback) return 'no-audio';
      current = { token, playback, plan, event };
      last = { plan, clips: items.map((i) => i.clip), items };
      if (game) game.stats.late += 1;
      opts.onStart?.(plan.heard);
      const startedAt = now();
      const how: ClipEndHow = await playback.ended;
      const heard = playback.heardIds();
      if (heard.length > 0) {
        recency.note(heard);
        writeRecency(storage, recency.snapshot());
      }
      diag('clip.end', { how, ms: Math.round(now() - startedAt), planMs: playback.ms, late: true });
      if (current?.token === token) current = null;
      return how === 'stop' ? 'stopped' : 'played';
    } finally {
      if (inFlight === token) inFlight = null;
    }
  }

  function stopCurrent(): void {
    seq += 1;
    const c = current;
    current = null;
    c?.playback?.stop();
    silent.stop();
  }

  // ───────────────────────── prewarm ─────────────────────────

  let hotDecoded = false;
  function prewarmHotDecode(): void {
    if (hotDecoded || !library.index) return;
    hotDecoded = true;
    // barks and the generic lines first: they are the ones that may never wait (≈ 40 short clips)
    const index = library.index;
    const ids = Object.entries(index.pools)
      .filter(([pool]) => pool.startsWith('bark.') || pool === 'generic' || pool.startsWith('generic.'))
      .flatMap(([, list]) => list)
      .slice(0, 48);
    library.prewarm(ids);
  }

  function prewarm(hint: ClipPrewarmHint): void {
    const index = library.index;
    if (!index || disposed) return;
    const ids = new Set<string>();
    for (const move of hint.moves?.slice(0, 8) ?? []) {
      for (const prefer of ['ins', 'nom'] as const) {
        const form = slotFormOf(move.san, move.fen, prefer);
        const key = form ? slotKeyOf(move.san, move.fen, form) : null;
        if (!key) continue;
        for (const id of index.keys[slotUnitKey(key)] ?? []) ids.add(id);
        const split = splitOf(key);
        if (split) for (const part of split) for (const id of (index.keys[slotUnitKey(part)] ?? []).slice(0, 1)) ids.add(id);
      }
    }
    for (const event of hint.events?.slice(0, 4) ?? []) {
      // a dry run: the recency memory is only written when a plan is really heard
      for (const c of planFor(event, false, (id) => !library.failed(id)).clips) ids.add(c.id);
    }
    for (const pool of hint.pools ?? []) for (const id of (index.pools[pool] ?? index.pools[poolKeyOf(pool)] ?? []).slice(0, 6)) ids.add(id);
    library.prewarm([...ids]);
  }

  // ───────────────────────── the layer ─────────────────────────

  const voice: ClipVoice = {
    kind: 'clips',
    async init() {
      const started = now();
      try {
        const info = await library.load();
        diag('clip.init', { voice: info.voiceKey, version: info.libraryVersion, units: info.units, phrases: info.phrases, ms: Math.round(now() - started) });
      } catch (error) {
        diag('clip.init.fail', { why: error instanceof Error ? error.message.slice(0, 40) : 'error' });
        throw error instanceof Error ? error : new Error('no clip library');
      }
      // compressed bytes of the hot set in idle time; decoding waits for the first gesture (or runs now if unlocked)
      library.prefetch(library.hotIds());
      if (!gate.needsUserGesture) prewarmHotDecode();
    },
    speak(text, opts) {
      const clean = text.trim();
      if (clean === '') return Promise.resolve();
      return speakEvent({ id: `text-${seq + 1}`, kind: 'answer', priority: 1, text: clean, bubbleText: clean, pose: 'talk', pauseClock: false }, opts ?? {});
    },
    speakEvent,
    stop: stopCurrent,
    onLevel: (cb) => level.on(cb),
    onSpeakingChange: (cb) => speakingChange.on(cb),
    dispose() {
      if (disposed) return;
      disposed = true;
      stopCurrent();
      if (game) voice.setGame(null);
      gate.dispose();
      silent.dispose();
      level.clear();
      speakingChange.clear();
      gestureChange.clear();
      planned.clear();
      hearingProblem.clear();
      hearingOk.clear();
    },

    // ── gesture gate ──
    get needsUserGesture() {
      return gate.needsUserGesture;
    },
    onNeedsUserGestureChange: (cb) => gestureChange.on(cb),
    unlock() {
      if (gate.needsUserGesture) gate.unlock();
      else audio.unlockInGesture();
    },

    // ── clip extras ──
    msToSentenceEnd: () => current?.playback?.msToSentenceEnd() ?? null,
    endAfterSentence: () => current?.playback?.endAfterSentence() ?? false,
    async replayLast() {
      const previous = last;
      if (!previous || disposed) return;
      stopCurrent();
      const token = seq;
      await play(current?.event ?? { id: 'replay', kind: 'answer', priority: 1, text: previous.plan.heard, bubbleText: previous.plan.heard, pose: 'talk', pauseClock: false }, previous.plan, previous.items, token);
    },
    onPlan: (cb) => planned.on(cb),
    prewarm,
    libraryStatus(): ClipLibraryStatus | null {
      const info = library.info();
      return info ? { voiceKey: info.voiceKey, libraryVersion: info.libraryVersion, phrases: info.phrases, units: info.units } : null;
    },

    // ── «Дозапись голоса» ──
    lessonProbe(): LessonTakeProbe | null {
      if (disposed || !library.index) return null;
      // the library's CURRENT index on every call (an overlay reload counts at once)
      return { voiced: (unitKey, text) => library.hasTake(unitKey, text), blocked: (unitKey) => library.isBlocked(unitKey) };
    },
    canVoiceLesson(event) {
      if (disposed || !isUnrecordedLesson(event) || !library.index) return false;
      // fixed randomness, no jitter: the layer's own rng stream is not touched by this dry run
      return planLessonClips(event, library.index, { rng: () => 0, jitter: false, recency, available: (id) => !library.failed(id) }).clips.length > 0;
    },
    reloadOverlay: () => (disposed ? Promise.resolve(false) : library.reloadOverlay()),
    playLate,
    overlayVersion: () => library.overlayVersion(),
    setGame(next) {
      if (game && game.stats.utterances > 0) {
        writeClipStats(storage, { ...game.stats, at: new Date().toISOString(), timeControlId: game.timeControlId });
      }
      game = next ? { timeControlId: next.timeControlId, stats: emptyGameStats() } : null;
    },

    // ── hearing self-check ──
    onHearingProblem: (cb) => hearingProblem.on(cb),
    onHearingOk: (cb) => hearingOk.on(() => cb()),
    recheckAudio() {
      // inside the click: resume + a silent frame, then report what the context says
      audio.unlockInGesture();
      if (gate.needsUserGesture) gate.unlock();
      return Promise.resolve({ play: 'clips', ctx: audio.state() });
    },
    retryMicrophone: () => Promise.resolve(false),
  };
  return voice;
}

// ───────────────────────── the app's layer ─────────────────────────

let sharedAudio: { audio: ClipAudio; library: ClipLibrary; muted: boolean } | null = null;

/**
 * The layer the app's coach builds (`createBrowserVoice('clips')`): one AudioContext and one library for the page,
 * shared by every layer instance (a settings change re-creates the layer; the decoded cache survives).
 * `muted` = the e2e opt-in: the real pipeline into a GainNode(0).
 */
export function createBrowserClipVoice(opts: { muted?: boolean } = {}): ClipVoice {
  const muted = opts.muted === true;
  if (!sharedAudio || sharedAudio.muted !== muted) {
    const audio = createClipAudio({ muted });
    sharedAudio = { audio, library: createClipLibrary({ audio }), muted };
  }
  return createClipVoice({ audio: sharedAudio.audio, library: sharedAudio.library });
}
