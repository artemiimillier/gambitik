/**
 * Test doubles of the «Записи» layer (unit tests only — plain Node, fake timers, never a sound): a fake AudioContext
 * whose clock is `Date.now()` (vi fake timers move it) and stands still while suspended, fake "MP3" bytes that decode
 * to synthetic tones with known silent edges, and a fake `fetch` serving a library from memory.
 */
import { CLIP_VOICE_KEY, clipFile } from '@gambit/core';
import type { ClipIndex } from '@gambit/core';
import type { ClipBufferLike, ClipContextLike, ClipGainLike, ClipNodeLike, ClipParamLike, ClipSourceLike } from './clipAudio.ts';
import type { ClipFetch, ClipResponseLike } from './clipLibrary.ts';

export const FAKE_RATE = 32_000;

// ───────────────────────── nodes ─────────────────────────

export interface ParamEvent {
  type: 'set' | 'ramp' | 'curve' | 'cancel' | 'hold';
  value?: number;
  time: number;
  duration?: number;
  curve?: number[];
}

export class FakeParam implements ClipParamLike {
  value = 1;
  readonly events: ParamEvent[] = [];
  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'set', value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'ramp', value, time });
    return this;
  }
  setValueCurveAtTime(curve: Float32Array, time: number, duration: number): this {
    this.events.push({ type: 'curve', time, duration, curve: [...curve] });
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ type: 'cancel', time });
    return this;
  }
  cancelAndHoldAtTime(time: number): this {
    this.events.push({ type: 'hold', time });
    return this;
  }
}

class FakeNode implements ClipNodeLike {
  readonly connections: ClipNodeLike[] = [];
  connect(destination: ClipNodeLike): ClipNodeLike {
    this.connections.push(destination);
    return destination;
  }
  disconnect(): void {
    this.connections.length = 0;
  }
}

export class FakeGain extends FakeNode implements ClipGainLike {
  readonly gain = new FakeParam();
}

export class FakeBuffer implements ClipBufferLike {
  readonly numberOfChannels = 1;
  readonly sampleRate: number;
  private readonly data: Float32Array;
  constructor(length: number, sampleRate: number = FAKE_RATE, data?: Float32Array) {
    this.sampleRate = sampleRate;
    this.data = data ?? new Float32Array(length);
  }
  get length(): number {
    return this.data.length;
  }
  get duration(): number {
    return this.data.length / this.sampleRate;
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

export class FakeSource extends FakeNode implements ClipSourceLike {
  buffer: ClipBufferLike | null = null;
  onended: (() => void) | null = null;
  started: { when: number; offset: number; duration: number } | null = null;
  stoppedAt: number | null = null;
  private fired = false;
  private readonly ctx: FakeAudioContext;
  constructor(ctx: FakeAudioContext) {
    super();
    this.ctx = ctx;
  }
  start(when = 0, offset = 0, duration?: number): void {
    const dur = duration ?? (this.buffer ? this.buffer.duration - offset : 0);
    this.started = { when, offset, duration: dur };
    this.ctx.sources.push(this);
    this.ctx.watch(this, when + dur);
  }
  stop(when?: number): void {
    const at = when ?? this.ctx.currentTime;
    this.stoppedAt = at;
    this.ctx.watch(this, at);
  }
  /** the context reached this source's end (or its stop time) */
  fire(): void {
    if (this.fired) return;
    this.fired = true;
    this.onended?.();
  }
  get end(): number {
    const natural = this.started ? this.started.when + this.started.duration : Infinity;
    return this.stoppedAt !== null ? Math.min(natural, this.stoppedAt) : natural;
  }
}

// ───────────────────────── the context ─────────────────────────

export interface FakeAudioContextOptions {
  state?: 'running' | 'suspended';
  /** resume() keeps it suspended (an autoplay-locked page) */
  resumeBlocked?: boolean;
  outputLatency?: number;
  clock?: () => number;
}

export class FakeAudioContext implements ClipContextLike {
  readonly sampleRate = FAKE_RATE;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  readonly silentFrames: FakeSource[] = [];
  outputLatency: number;
  resumeBlocked: boolean;
  resumeCalls = 0;
  decodeCalls = 0;
  private _state: string;
  private readonly clock: () => number;
  /** ms of context time accumulated while running, and since when it runs */
  private elapsed = 0;
  private runningSince: number | null;
  private readonly watched = new Set<{ src: FakeSource; at: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: FakeAudioContextOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this._state = options.state ?? 'running';
    this.resumeBlocked = options.resumeBlocked ?? false;
    this.outputLatency = options.outputLatency ?? 0;
    this.runningSince = this._state === 'running' ? this.clock() : null;
  }

  get state(): string {
    return this._state;
  }

  get currentTime(): number {
    const running = this.runningSince !== null ? this.clock() - this.runningSince : 0;
    return (this.elapsed + running) / 1000;
  }

  setState(state: 'running' | 'suspended' | 'closed' | 'interrupted'): void {
    if (this.runningSince !== null) this.elapsed += this.clock() - this.runningSince;
    this.runningSince = state === 'running' ? this.clock() : null;
    this._state = state;
    this.pump();
  }

  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }

  createBufferSource(): FakeSource {
    return new FakeSource(this);
  }

  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(length, sampleRate);
  }

  createDynamicsCompressor(): FakeNode & { threshold: { value: number }; knee: { value: number }; ratio: { value: number }; attack: { value: number }; release: { value: number } } {
    return Object.assign(new FakeNode(), { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } });
  }

  decodeAudioData(bytes: ArrayBuffer): Promise<ClipBufferLike> {
    this.decodeCalls += 1;
    try {
      return Promise.resolve(decodeFakeClip(bytes));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('decode'));
    }
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (!this.resumeBlocked && this._state !== 'closed') this.setState('running');
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.setState('closed');
    return Promise.resolve();
  }

  /** sources whose playback was scheduled (the 1-frame unlock buffers excluded) */
  get played(): FakeSource[] {
    return this.sources.filter((s) => (s.buffer?.length ?? 0) > 1);
  }

  watch(src: FakeSource, at: number): void {
    for (const w of this.watched) if (w.src === src) this.watched.delete(w);
    this.watched.add({ src, at });
    this.pump();
  }

  /** fires `onended` of every source the (running) clock has passed; re-arms a timer for the next one */
  private pump(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this._state !== 'running') return;
    const now = this.currentTime;
    let next = Infinity;
    for (const w of [...this.watched]) {
      const at = Math.min(w.at, w.src.end);
      if (at <= now + 1e-9) {
        this.watched.delete(w);
        w.src.fire();
      } else next = Math.min(next, at);
    }
    if (next !== Infinity) this.timer = setTimeout(() => this.pump(), Math.max(1, Math.ceil((next - this.currentTime) * 1000)));
  }
}

// ───────────────────────── fake "MP3" bytes ─────────────────────────

const MAGIC = 0x434c4950; // 'CLIP'

/** A clip that decodes to: `leadMs` of silence, `ms` of a tone at `amp`, `tailMs` of silence. */
export function fakeClipBytes(o: { ms: number; leadMs?: number; tailMs?: number; amp?: number }): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(20));
  view.setUint32(0, MAGIC);
  view.setFloat32(4, o.ms);
  view.setFloat32(8, o.leadMs ?? 35);
  view.setFloat32(12, o.tailMs ?? 60);
  view.setFloat32(16, o.amp ?? 0.3);
  return view.buffer;
}

export function decodeFakeClip(bytes: ArrayBuffer): FakeBuffer {
  if (bytes.byteLength !== 20) throw new Error('not a fake clip');
  const view = new DataView(bytes);
  if (view.getUint32(0) !== MAGIC) throw new Error('not a fake clip');
  const ms = view.getFloat32(4);
  const lead = view.getFloat32(8);
  const tail = view.getFloat32(12);
  const amp = view.getFloat32(16);
  const n = (x: number): number => Math.round((x / 1000) * FAKE_RATE);
  const data = new Float32Array(n(lead) + n(ms) + n(tail));
  for (let i = 0; i < n(ms); i++) data[n(lead) + i] = amp * Math.sin((2 * Math.PI * 220 * i) / FAKE_RATE) + (i % 2 === 0 ? amp * 0.2 : -amp * 0.2);
  return new FakeBuffer(data.length, FAKE_RATE, data);
}

// ───────────────────────── a library served from memory ─────────────────────────

export interface FakeServer {
  fetch: ClipFetch;
  /** every URL asked for, in order */
  readonly requests: string[];
  /** make a URL answer 404 / a network error / slowly */
  fail(url: string, how: 404 | 'network'): void;
  delay(url: string, ms: number): void;
  readonly files: Map<string, string | ArrayBuffer>;
}

export const FAKE_BASE = '/voice/';

function response(body: string | ArrayBuffer | null, status = 200): ClipResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : ''),
    arrayBuffer: () => Promise.resolve(body instanceof ArrayBuffer ? body.slice(0) : new ArrayBuffer(0)),
  };
}

/**
 * Serves `index` (a planner index, e.g. core's `fixtureIndex()`) as a published library: index.json, the manifest and
 * one fake "MP3" per unit whose tone lasts the unit's audible ms (`off − on`).
 */
export function createFakeServer(
  index: ClipIndex | null,
  opts: {
    voiceKey?: string;
    libraryVersion?: number;
    spaFallback?: boolean;
    /** where the library is served (default FAKE_BASE; the recorded overlay: FAKE_OVERLAY) */
    base?: string;
    /** the manifest's content hash (a new one = a newly published manifest) */
    hash?: string;
    /** more manifest fields (`blocked`) */
    extra?: Record<string, unknown>;
  } = {},
): FakeServer {
  const voiceKey = opts.voiceKey ?? CLIP_VOICE_KEY;
  const root = opts.base ?? FAKE_BASE;
  const files = new Map<string, string | ArrayBuffer>();
  const requests: string[] = [];
  const failures = new Map<string, 404 | 'network'>();
  const delays = new Map<string, number>();
  if (index) publishFakeLibrary(files, index, { voiceKey, root, libraryVersion: opts.libraryVersion ?? 3, hash: opts.hash ?? 'abcdef123456', extra: opts.extra ?? {} });
  const fetch: ClipFetch = (url) => {
    requests.push(url);
    const failure = failures.get(url);
    const answer = (): Promise<ClipResponseLike> => {
      if (failure === 'network') return Promise.reject(new Error('network'));
      if (failure === 404) return Promise.resolve(response('not found', 404));
      const body = files.get(url);
      // the SPA's fallback: a missing file answers index.html with 200
      if (body === undefined) return Promise.resolve(opts.spaFallback === false ? response('not found', 404) : response('<!doctype html><html></html>', 200));
      return Promise.resolve(response(body, 200));
    };
    const wait = delays.get(url);
    return wait ? new Promise((resolve) => setTimeout(() => resolve(answer()), wait)) : answer();
  };
  return {
    fetch,
    requests,
    files,
    fail: (url, how) => failures.set(url, how),
    delay: (url, ms) => delays.set(url, ms),
  };
}

export function clipUrl(id: string, voiceKey = CLIP_VOICE_KEY, root = FAKE_BASE): string {
  return `${root}${voiceKey}/${clipFile(id)}`;
}

/** where the fake local server serves the recorded overlay («Дозапись голоса») */
export const FAKE_OVERLAY = '/api/voice/clips/overlay/';

/** (Re)publishes a library into a fake server's files: index.json last names the manifest, one fake MP3 per unit. */
export function publishFakeLibrary(
  files: Map<string, string | ArrayBuffer>,
  index: ClipIndex,
  o: { voiceKey?: string; root?: string; libraryVersion?: number; hash?: string; extra?: Record<string, unknown> } = {},
): void {
  const voiceKey = o.voiceKey ?? CLIP_VOICE_KEY;
  const root = o.root ?? FAKE_BASE;
  const rel = `${voiceKey}/manifest.${o.hash ?? 'abcdef123456'}.json`;
  for (const [id, meta] of Object.entries(index.units)) {
    const audible = Math.max(10, (meta.off ?? meta.ms) - (meta.on ?? 0));
    files.set(`${root}${voiceKey}/${clipFile(id)}`, fakeClipBytes({ ms: audible, leadMs: meta.on ?? 30 }));
  }
  files.set(`${root}${rel}`, JSON.stringify({ v: 1, voiceKey, libraryVersion: o.libraryVersion ?? 3, ...index, ...(o.extra ?? {}) }));
  files.set(`${root}index.json`, JSON.stringify({ default: voiceKey, voices: { [voiceKey]: rel } }));
}

/** One fetch for two fake origins: the static library and the local server's overlay. */
export function joinFakeServers(staticServer: FakeServer, overlayServer: FakeServer, overlayRoot = FAKE_OVERLAY): ClipFetch {
  return (url, init) => (url.startsWith(overlayRoot) ? overlayServer.fetch(url, init) : staticServer.fetch(url, init));
}
