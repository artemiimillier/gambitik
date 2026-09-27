/**
 * Tests of the WebRTC plumbing for hearing and being heard («я всё равно его не слышу, и походу он меня
 * тоже» — real Chrome, laptop speakers, open microphone + echo guard). Unlike the layer tests (testRtc.ts: no
 * AudioContext = a deaf analyser), this file gives the session a fake AudioContext whose analyser reads what the test
 * says is playing, a real-ish <audio> element (paused / volume / play() outcomes) and a window for gestures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARING_CHECK, RTC_TIMEOUTS, openRtcSession } from './rtcSession.ts';
import type { HearingProblem, RtcProtocol, RtcProtocolHooks, RtcSession, RtcSessionEvents } from './rtcSession.ts';
import { installFakeRtc } from './testRtc.ts';
import type { FakeRtcEnvironment, FakeTrack } from './testRtc.ts';
import { configureVoiceDiagForTests, resetMicPermissionForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';

type Listener = () => void;

class Listeners {
  private readonly map = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener): void {
    const set = this.map.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.map.set(type, set);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.map.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const listener of [...(this.map.get(type) ?? [])]) listener();
  }
  count(type: string): number {
    return this.map.get(type)?.size ?? 0;
  }
}

interface FakeElement extends Listeners {
  autoplay: boolean;
  muted: boolean;
  paused: boolean;
  volume: number;
  removed: boolean;
  srcObject: unknown;
  style: Record<string, string>;
  dataset: Record<string, string>;
  playCalls: number;
  /** what the next play() does */
  playResult: () => Promise<void>;
  setAttribute(): void;
  play(): Promise<void>;
  pause(): void;
  remove(): void;
}

function makeElement(): FakeElement {
  const el = new Listeners() as FakeElement;
  Object.assign(el, {
    autoplay: false,
    muted: false,
    paused: true,
    volume: 1,
    removed: false,
    srcObject: null,
    style: {},
    dataset: {},
    playCalls: 0,
    playResult: () => Promise.resolve(),
    setAttribute: () => undefined,
  });
  el.play = () => {
    el.playCalls += 1;
    return el.playResult().then(() => {
      el.paused = false;
      el.emit('playing');
    });
  };
  el.pause = () => {
    el.paused = true;
    el.emit('pause');
  };
  el.remove = () => {
    el.removed = true;
  };
  return el;
}

const domError = (name: string): Error => Object.assign(new Error(name), { name });

interface Env {
  rtc: FakeRtcEnvironment;
  elements: FakeElement[];
  win: Listeners;
  /** what the remote stream carries right now: the amplitude of a sine the analyser reads */
  setOutput(amplitude: number): void;
  ctx(): FakeAudioContextShape;
  comfortTrack(): FakeTrack;
}

interface FakeAudioContextShape {
  state: 'running' | 'suspended' | 'closed';
  resumeCalls: number;
  resumeAllowed: boolean;
}

function installEnv(opts: { ctxState?: 'running' | 'suspended' } = {}): Env {
  const rtc = installFakeRtc();
  const elements: FakeElement[] = [];
  const win = new Listeners();
  let amplitude = 0;
  const contexts: FakeAudioContextShape[] = [];
  const comfortTracks: FakeTrack[] = [];

  class FakeAudioContext extends Listeners implements FakeAudioContextShape {
    state: 'running' | 'suspended' | 'closed' = opts.ctxState ?? 'running';
    resumeCalls = 0;
    resumeAllowed = true;
    sampleRate = 8000;
    private analysers = 0;
    constructor() {
      super();
      contexts.push(this);
    }
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    createAnalyser() {
      const remote = this.analysers === 0;
      this.analysers += 1;
      return {
        fftSize: 512,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData: (buffer: Float32Array) => {
          const a = remote && this.state === 'running' ? amplitude : 0;
          for (let i = 0; i < buffer.length; i++) buffer[i] = a * Math.sin(i / 3);
        },
      };
    }
    createMediaStreamDestination() {
      const track: FakeTrack = { kind: 'audio', enabled: true, readyState: 'live', stop: () => undefined };
      comfortTracks.push(track);
      return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } };
    }
    createBuffer(_channels: number, length: number) {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }
    createBufferSource() {
      return { buffer: null, loop: false, connect: () => undefined, start: () => undefined, stop: () => undefined };
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => undefined };
    }
    resume() {
      this.resumeCalls += 1;
      if (!this.resumeAllowed) return Promise.reject(domError('NotAllowedError'));
      this.state = 'running';
      this.emit('statechange');
      return Promise.resolve();
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  vi.stubGlobal('window', win);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('document', {
    hidden: false,
    visibilityState: 'visible',
    body: { appendChild: () => undefined },
    createElement: () => {
      const el = makeElement();
      elements.push(el);
      return el;
    },
  });
  return {
    rtc,
    elements,
    win,
    setOutput(a) {
      amplitude = a;
    },
    ctx() {
      const last = contexts.at(-1);
      if (!last) throw new Error('no AudioContext');
      return last;
    },
    comfortTrack() {
      const last = comfortTracks.at(-1);
      if (!last) throw new Error('no comfort track');
      return last;
    },
  };
}

interface FakeProtocol extends RtcProtocol {
  outputActive: boolean;
  echoHold: boolean;
  speechEvidence: number;
  inputMuted: boolean[];
  hooks: RtcProtocolHooks | null;
}

function fakeProtocol(): FakeProtocol {
  const p: FakeProtocol = {
    outputActive: false,
    echoHold: false,
    speechEvidence: 0,
    usageSeconds: null,
    inputMuted: [],
    hooks: null,
    handleServerEvent(raw) {
      // the model's first word: the adapter's hold goes up while the event is handled
      if ((raw as { type?: string }).type === 'coach.word') {
        p.echoHold = true;
        p.speechEvidence += 1;
      }
    },
    speak: () => Promise.resolve('spoken'),
    speakBrief: () => Promise.resolve('spoken'),
    cancelOutput: () => undefined,
    pushContext: () => undefined,
    reset: () => undefined,
    onChannelOpen: () => Promise.resolve(),
    setMicMode: () => undefined,
    setInputMuted(muted) {
      p.inputMuted.push(muted);
    },
    noteOutputLevel: () => undefined,
    requestClose: () => undefined,
  };
  return p;
}

interface Opened {
  session: RtcSession;
  protocol: FakeProtocol;
  events: RtcSessionEvents & { problems: HearingProblem[]; ok: number; blocked: number; denied: number };
}

async function open(env: Env, overrides: { echoGuard?: boolean; micMode?: 'open' | 'push' } = {}): Promise<Opened> {
  const protocol = fakeProtocol();
  const events = {
    problems: [] as HearingProblem[],
    ok: 0,
    blocked: 0,
    denied: 0,
    onLevel: () => undefined,
    onSpeaking: () => undefined,
    onLost: () => undefined,
    onMicDenied() {
      events.denied += 1;
    },
    onMicReady: () => undefined,
    onPlaybackBlocked() {
      events.blocked += 1;
    },
    onHearingProblem(problem: HearingProblem) {
      events.problems.push(problem);
    },
    onHearingOk() {
      events.ok += 1;
    },
  };
  const opening = openRtcSession({
    kind: 'openai-live',
    createProtocol(hooks) {
      protocol.hooks = hooks;
      return protocol;
    },
    exchangeSdp: () => Promise.resolve('v=0 answer'),
    waitForIceGathering: false,
    micMode: overrides.micMode ?? 'open',
    micMuted: false,
    echoGuard: overrides.echoGuard ?? true,
    maxListenMs: 30_000,
    events,
  });
  await vi.advanceTimersByTimeAsync(0);
  const session = await opening;
  await vi.advanceTimersByTimeAsync(0);
  return { session, protocol, events };
}

/** a server event arrives on the data channel (anything; the fake protocol reacts to 'coach.word') */
function serverEvent(env: Env, type = 'noop'): void {
  env.rtc.dc().receive({ type });
}

describe('openRtcSession — hearing and being heard on laptop speakers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('the microphone gate never sends digital silence', () => {
    it('comfort noise goes out until the microphone is attached, the microphone while the gate is open, the comfort noise again while the echo guard closes it', async () => {
      const env = installEnv();
      const { protocol } = await open(env);
      const mic = env.rtc.micTracks[0];
      expect(mic).toBeDefined();
      expect(env.rtc.pc().sentTrack).toBe(mic);
      expect(mic?.enabled).toBe(true);

      protocol.outputActive = true;
      serverEvent(env);
      // closed: the API is told, the microphone is disabled AND off the wire — the model gets room noise, not zeros
      expect(protocol.inputMuted.at(-1)).toBe(true);
      expect(mic?.enabled).toBe(false);
      expect(env.rtc.pc().sentTrack).toBe(env.comfortTrack());

      protocol.outputActive = false;
      await vi.advanceTimersByTimeAsync(RTC_TIMEOUTS.echoTailMs + 200);
      expect(protocol.inputMuted.at(-1)).toBe(false);
      expect(env.rtc.pc().sentTrack).toBe(mic);
      expect(mic?.enabled).toBe(true);
    });

    it('a suspended AudioContext makes no comfort noise at all: the disabled microphone stays on the wire until it runs', async () => {
      const env = installEnv({ ctxState: 'suspended' });
      const pending = open(env);
      env.ctx().resumeAllowed = false;
      const { protocol } = await pending;
      const mic = env.rtc.micTracks[0];
      protocol.outputActive = true;
      serverEvent(env);
      expect(mic?.enabled).toBe(false);
      expect(env.rtc.pc().sentTrack).toBe(mic);
      // the child touches the page: the context runs, the comfort noise replaces the disabled microphone
      env.ctx().resumeAllowed = true;
      env.win.emit('pointerdown');
      await vi.advanceTimersByTimeAsync(0);
      expect(env.rtc.pc().sentTrack).toBe(env.comfortTrack());
    });

    it('push-to-talk: the comfort noise is on the wire until the button is held', async () => {
      const env = installEnv();
      const { session } = await open(env, { micMode: 'push' });
      expect(env.rtc.pc().sentTrack).toBe(env.comfortTrack());
      await session.startListening();
      expect(env.rtc.pc().sentTrack).toBe(env.rtc.micTracks[0]);
      session.stopListening();
      expect(env.rtc.pc().sentTrack).toBe(env.comfortTrack());
    });
  });

  describe('echo guard timing', () => {
    it('the first word of the model closes the microphone at once — in the same event, before any audio frame', async () => {
      const env = installEnv();
      const { protocol } = await open(env);
      const mic = env.rtc.micTracks[0];
      serverEvent(env, 'coach.word');
      expect(mic?.enabled).toBe(false);
      expect(protocol.inputMuted).toEqual([false, true]);
    });

    it('the SERVER says the answer is over while the local playback still sounds: the microphone waits until the room has been silent ≥ 400 ms', async () => {
      const env = installEnv();
      const { protocol } = await open(env);
      env.rtc.pc().emitTrack();
      const mic = env.rtc.micTracks[0];
      protocol.outputActive = true;
      env.setOutput(0.2);
      await vi.advanceTimersByTimeAsync(300);
      expect(mic?.enabled).toBe(false);

      // the server is done — the jitter buffer / the element still play the last words for 600 ms
      protocol.outputActive = false;
      await vi.advanceTimersByTimeAsync(600);
      expect(mic?.enabled).toBe(false);

      env.setOutput(0);
      await vi.advanceTimersByTimeAsync(300);
      expect(mic?.enabled).toBe(false); // silent for only 300 ms
      await vi.advanceTimersByTimeAsync(300);
      expect(RTC_TIMEOUTS.echoTailMs).toBeGreaterThanOrEqual(400);
      expect(mic?.enabled).toBe(true);
      expect(protocol.inputMuted.at(-1)).toBe(false);
    });

    it('a short pause between two sentences does not open the microphone (the model would hear its own next sentence)', async () => {
      const env = installEnv();
      const { protocol } = await open(env);
      env.rtc.pc().emitTrack();
      const mic = env.rtc.micTracks[0];
      env.setOutput(0.2);
      await vi.advanceTimersByTimeAsync(500);
      expect(mic?.enabled).toBe(false);
      env.setOutput(0);
      await vi.advanceTimersByTimeAsync(300);
      env.setOutput(0.2);
      await vi.advanceTimersByTimeAsync(500);
      expect(protocol.inputMuted).toEqual([false, true]);
    });

    it('a protocol flag that never ends cannot keep the child unheard for good (deaf analyser: the longer limit)', async () => {
      const env = installEnv();
      const { protocol } = await open(env);
      const mic = env.rtc.micTracks[0];
      protocol.outputActive = true;
      serverEvent(env);
      expect(mic?.enabled).toBe(false);
      // no remote track = no analyser: only the protocol's words could tell, so it waits longer…
      await vi.advanceTimersByTimeAsync(RTC_TIMEOUTS.echoStuckMs + 1000);
      expect(mic?.enabled).toBe(false);
      // …but not the 45 s of before
      await vi.advanceTimersByTimeAsync(RTC_TIMEOUTS.echoStuckDeafMs - RTC_TIMEOUTS.echoStuckMs + RTC_TIMEOUTS.echoTailMs);
      expect(mic?.enabled).toBe(true);
      expect(RTC_TIMEOUTS.echoStuckDeafMs).toBeLessThanOrEqual(15_000);
      expect(voiceDiagRecent().find((entry) => entry.e === 'mic.guard.stuck')).toMatchObject({ deaf: true });
    });

    it('a lost «stopped» event («он меня не слышит»): the microphone opens a few seconds after the LAST sound, not 45 s', async () => {
      const env = installEnv();
      const { protocol } = await open(env);
      env.rtc.pc().emitTrack();
      const mic = env.rtc.micTracks[0];
      // he speaks for 6 s — longer than the stuck limit: real sound keeps the guard closed all the time
      protocol.outputActive = true;
      env.setOutput(0.2);
      await vi.advanceTimersByTimeAsync(6000);
      expect(mic?.enabled).toBe(false);
      // the sound ends, the protocol's «still speaking» flag never does
      env.setOutput(0);
      await vi.advanceTimersByTimeAsync(RTC_TIMEOUTS.echoStuckMs - 500);
      expect(mic?.enabled).toBe(false);
      await vi.advanceTimersByTimeAsync(500 + RTC_TIMEOUTS.echoTailMs + 200);
      expect(RTC_TIMEOUTS.echoStuckMs).toBeLessThanOrEqual(5000);
      expect(mic?.enabled).toBe(true);
      expect(protocol.inputMuted.at(-1)).toBe(false);
      expect(voiceDiagRecent().find((entry) => entry.e === 'mic.guard.stuck')).toMatchObject({ deaf: false });

      // he really speaks again (new words): the guard closes again at once
      serverEvent(env, 'coach.word');
      expect(mic?.enabled).toBe(false);
    });

    it('with headphones (echo guard off) the microphone stays open while the coach talks', async () => {
      const env = installEnv();
      const { protocol } = await open(env, { echoGuard: false });
      protocol.outputActive = true;
      env.setOutput(0.2);
      serverEvent(env, 'coach.word');
      await vi.advanceTimersByTimeAsync(500);
      expect(env.rtc.micTracks[0]?.enabled).toBe(true);
      expect(protocol.inputMuted).toEqual([false]);
    });
  });

  describe('the <audio> element', () => {
    it('each session plays through its own fresh, unmuted element in the page; close() removes it', async () => {
      const env = installEnv();
      const first = await open(env);
      env.rtc.pc().emitTrack();
      await vi.advanceTimersByTimeAsync(0);
      const el1 = env.elements[0];
      expect(el1?.srcObject).not.toBeNull();
      expect(el1?.playCalls).toBe(1);
      expect(el1?.paused).toBe(false);
      first.session.close();
      await vi.advanceTimersByTimeAsync(RTC_TIMEOUTS.closeFlushMs + 10);
      expect(el1?.muted).toBe(true);
      expect(el1?.removed).toBe(true);

      await open(env);
      const el2 = env.elements[1];
      expect(el2).not.toBe(el1);
      expect(el2?.muted).toBe(false);
      expect(el2?.removed).toBe(false);
    });

    it('play() refused by the autoplay policy locks the playback; the next touch of the page plays it (and says so in the black box)', async () => {
      const env = installEnv();
      const { session, events } = await open(env);
      const el = env.elements[0];
      if (!el) throw new Error('no element');
      el.playResult = () => Promise.reject(domError('NotAllowedError'));
      env.rtc.pc().emitTrack();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.playbackBlocked).toBe(true);
      expect(events.blocked).toBe(1);
      expect(voiceDiagRecent().find((entry) => entry.e === 'out.play')).toMatchObject({ ok: false, err: 'NotAllowedError', src: 'track' });

      el.playResult = () => Promise.resolve();
      env.win.emit('pointerdown');
      await vi.advanceTimersByTimeAsync(0);
      expect(el.paused).toBe(false);
      expect(session.playbackBlocked).toBe(false);
      expect(voiceDiagRecent().find((entry) => entry.e === 'out.recover')).toMatchObject({ play: 'ok' });
      expect(env.win.count('pointerdown')).toBe(0);
    });

    it('unlockAudio(): a refusal inside the gesture is NOT swallowed — the playback stays locked and says why', async () => {
      const env = installEnv();
      const { session, events } = await open(env);
      env.rtc.pc().emitTrack();
      await vi.advanceTimersByTimeAsync(0);
      const el = env.elements[0];
      if (!el) throw new Error('no element');
      el.playResult = () => Promise.reject(domError('NotAllowedError'));
      const result = await session.unlockAudio();
      expect(result).toEqual({ play: 'NotAllowedError', ctx: 'running' });
      expect(session.playbackBlocked).toBe(true);
      expect(events.blocked).toBe(1);
    });

    it('an abort by our own teardown is not a «blocked playback»', async () => {
      const env = installEnv();
      const { session, events } = await open(env);
      const el = env.elements[0];
      if (!el) throw new Error('no element');
      let rejectPlay: (error: Error) => void = () => undefined;
      el.playResult = () => new Promise<void>((_resolve, reject) => (rejectPlay = reject));
      env.rtc.pc().emitTrack();
      session.close();
      rejectPlay(domError('AbortError'));
      await vi.advanceTimersByTimeAsync(RTC_TIMEOUTS.closeFlushMs + 10);
      expect(events.blocked).toBe(0);
    });

    it('a suspended AudioContext (no gesture yet) is resumed on the next touch of the page', async () => {
      const env = installEnv({ ctxState: 'suspended' });
      const pending = open(env);
      env.ctx().resumeAllowed = false;
      await pending;
      expect(env.ctx().state).toBe('suspended');
      env.ctx().resumeAllowed = true;
      env.win.emit('keydown');
      await vi.advanceTimersByTimeAsync(0);
      expect(env.ctx().state).toBe('running');
      expect(voiceDiagRecent().some((entry) => entry.e === 'ctx' && entry.state === 'running')).toBe(true);
    });
  });

  describe('per-utterance playback check (the dock\'s «Не слышно?»)', () => {
    async function utterance(env: Env, o: Opened, amplitude: number, ms = HEARING_CHECK.minUtteranceMs + 400): Promise<void> {
      o.protocol.outputActive = true;
      env.setOutput(amplitude);
      serverEvent(env, 'coach.word');
      o.protocol.speechEvidence += 3;
      await vi.advanceTimersByTimeAsync(ms);
      o.protocol.outputActive = false;
      o.protocol.echoHold = false;
      env.setOutput(0);
      await vi.advanceTimersByTimeAsync(RTC_TIMEOUTS.echoTailMs + 200);
    }

    it('heard: the remote stream carried sound and the element played → onHearingOk, the black box has the RMS peak', async () => {
      const env = installEnv();
      const o = await open(env);
      env.rtc.pc().emitTrack();
      await vi.advanceTimersByTimeAsync(0);
      await utterance(env, o, 0.2);
      expect(o.events.problems).toEqual([]);
      expect(o.events.ok).toBe(1);
      const utt = voiceDiagRecent().find((entry) => entry.e === 'utt');
      expect(utt).toMatchObject({ why: 'ok', play: 100, ctx: 'running' });
      expect(Number(utt?.peak)).toBeGreaterThan(0.1);
    });

    it('the model spoke, the element was paused → «notPlaying»', async () => {
      const env = installEnv();
      const o = await open(env);
      env.rtc.pc().emitTrack();
      await vi.advanceTimersByTimeAsync(0);
      env.elements[0]?.pause();
      await utterance(env, o, 0.2);
      expect(o.events.problems).toEqual(['notPlaying']);
    });

    it('the model spoke (transcript words), the element played, but not a single sample of sound arrived → «silent»', async () => {
      const env = installEnv();
      const o = await open(env);
      env.rtc.pc().emitTrack();
      await vi.advanceTimersByTimeAsync(0);
      await utterance(env, o, 0);
      expect(o.events.problems).toEqual(['silent']);
      expect(voiceDiagRecent().find((entry) => entry.e === 'utt')).toMatchObject({ why: 'silent', peak: 0 });
    });

    it('no speech from the model (an echo hold without words) is never judged', async () => {
      const env = installEnv();
      const o = await open(env);
      env.rtc.pc().emitTrack();
      await vi.advanceTimersByTimeAsync(0);
      o.protocol.outputActive = true;
      serverEvent(env);
      await vi.advanceTimersByTimeAsync(2000);
      o.protocol.outputActive = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(o.events.problems).toEqual([]);
    });
  });

  describe('a tap cuts him off (loudspeakers: he cannot be talked over)', () => {
    it('interrupt(): the output is cancelled, the playback hushed and the microphone opens in the same tick', async () => {
      const env = installEnv();
      const { session, protocol } = await open(env);
      env.rtc.pc().emitTrack();
      await vi.advanceTimersByTimeAsync(0);
      const mic = env.rtc.micTracks[0];
      const el = env.elements[0];
      let cancels = 0;
      protocol.cancelOutput = () => {
        cancels += 1;
      };
      protocol.outputActive = true;
      env.setOutput(0.2);
      serverEvent(env, 'coach.word');
      await vi.advanceTimersByTimeAsync(300);
      expect(mic?.enabled).toBe(false);

      session.interrupt();
      expect(cancels).toBe(1);
      expect(el?.muted).toBe(true);
      expect(mic?.enabled).toBe(true);
      expect(protocol.inputMuted.at(-1)).toBe(false);
      expect(env.rtc.pc().sentTrack).toBe(mic);
      expect(voiceDiagRecent().find((entry) => entry.e === 'out.stop')).toMatchObject({ why: 'tap' });

      // the jitter buffer's last words play into a muted element: the microphone stays open meanwhile
      await vi.advanceTimersByTimeAsync(RTC_TIMEOUTS.interruptHushMs - 100);
      expect(mic?.enabled).toBe(true);
      // the model obeyed: silence; the hush ends and the element is audible again for his next phrase
      protocol.outputActive = false;
      protocol.echoHold = false;
      env.setOutput(0);
      await vi.advanceTimersByTimeAsync(300);
      expect(el?.muted).toBe(false);
      expect(mic?.enabled).toBe(true);
      // a cut utterance is never judged as «not heard»
      expect(voiceDiagRecent().find((entry) => entry.e === 'utt')).toMatchObject({ why: 'tap' });
    });

    it('a protocol that ducks its own playback (Live: the app stopped him) does not keep the microphone closed either', async () => {
      const env = installEnv();
      const { protocol } = await open(env);
      env.rtc.pc().emitTrack();
      const mic = env.rtc.micTracks[0];
      protocol.outputActive = true;
      env.setOutput(0.2);
      serverEvent(env, 'coach.word');
      await vi.advanceTimersByTimeAsync(200);
      expect(mic?.enabled).toBe(false);
      protocol.hooks?.setDucked(true);
      serverEvent(env);
      expect(mic?.enabled).toBe(true);
      // unducked while he still speaks: closed again (his voice is in the room)
      protocol.hooks?.setDucked(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(mic?.enabled).toBe(false);
    });

    it('with headphones nothing changes: the microphone was open anyway, the tap only cancels', async () => {
      const env = installEnv();
      const { session, protocol } = await open(env, { echoGuard: false });
      let cancels = 0;
      protocol.cancelOutput = () => {
        cancels += 1;
      };
      protocol.outputActive = true;
      serverEvent(env, 'coach.word');
      expect(env.rtc.micTracks[0]?.enabled).toBe(true);
      session.interrupt();
      expect(cancels).toBe(1);
      expect(env.rtc.micTracks[0]?.enabled).toBe(true);
      expect(protocol.inputMuted).toEqual([false]);
    });
  });

  describe('the microphone', () => {
    it('refused (Chrome: prompt dismissed) → onMicDenied + the black box has the error name; retryMicrophone asks again on the SAME connection', async () => {
      const env = installEnv();
      env.rtc.denyMicrophone();
      const { session, events } = await open(env);
      expect(events.denied).toBe(1);
      expect(voiceDiagRecent().find((entry) => entry.e === 'mic.gum')).toMatchObject({ ok: false });
      expect(env.rtc.pc().sentTrack).toBe(env.comfortTrack());

      // allowed now: the retry attaches it without a new peer connection
      env.rtc.getUserMedia.mockImplementationOnce(() => {
        const track: FakeTrack = { kind: 'audio', enabled: true, readyState: 'live', stop: () => undefined };
        env.rtc.micTracks.push(track);
        return Promise.resolve({ getAudioTracks: () => [track], getTracks: () => [track] });
      });
      const connections = env.rtc.connections.length;
      expect(await session.retryMicrophone()).toBe(true);
      expect(env.rtc.connections).toHaveLength(connections);
      expect(env.rtc.pc().sentTrack).toBe(env.rtc.micTracks.at(-1));
    });

    it('refused, then allowed in the browser\'s site settings: the microphone is attached by itself (no tap, same session)', async () => {
      resetMicPermissionForTests();
      const status = new Listeners() as Listeners & { state: string };
      status.state = 'denied';
      const env = installEnv();
      // the Permissions API of the fake navigator (installEnv stubbed it): Chrome's PermissionStatus fires 'change'
      (navigator as unknown as { permissions: unknown }).permissions = { query: () => Promise.resolve(status) };
      env.rtc.denyMicrophone();
      const { events } = await open(env);
      await vi.advanceTimersByTimeAsync(0);
      expect(events.denied).toBe(1);
      const connections = env.rtc.connections.length;

      env.rtc.getUserMedia.mockImplementationOnce(() => {
        const track: FakeTrack = { kind: 'audio', enabled: true, readyState: 'live', stop: () => undefined };
        env.rtc.micTracks.push(track);
        return Promise.resolve({ getAudioTracks: () => [track], getTracks: () => [track] });
      });
      status.state = 'granted';
      status.emit('change');
      await vi.advanceTimersByTimeAsync(0);
      expect(env.rtc.connections).toHaveLength(connections);
      expect(env.rtc.pc().sentTrack).toBe(env.rtc.micTracks.at(-1));
      expect(voiceDiagRecent().some((entry) => entry.e === 'mic.perm.regained')).toBe(true);
      resetMicPermissionForTests();
    });

    it('refused, then the site setting is put back to «Спрашивать»: the session asks again at once (no tap, no reload)', async () => {
      resetMicPermissionForTests();
      const status = new Listeners() as Listeners & { state: string };
      status.state = 'denied';
      const env = installEnv();
      (navigator as unknown as { permissions: unknown }).permissions = { query: () => Promise.resolve(status) };
      env.rtc.denyMicrophone();
      const { events } = await open(env);
      await vi.advanceTimersByTimeAsync(0);
      expect(events.denied).toBe(1);
      const asked = env.rtc.getUserMedia.mock.calls.length;

      env.rtc.getUserMedia.mockImplementationOnce(() => {
        const track: FakeTrack = { kind: 'audio', enabled: true, readyState: 'live', stop: () => undefined };
        env.rtc.micTracks.push(track);
        return Promise.resolve({ getAudioTracks: () => [track], getTracks: () => [track] });
      });
      status.state = 'prompt';
      status.emit('change');
      await vi.advanceTimersByTimeAsync(0);
      expect(env.rtc.getUserMedia.mock.calls.length).toBe(asked + 1);
      expect(env.rtc.pc().sentTrack).toBe(env.rtc.micTracks.at(-1));
      expect(voiceDiagRecent().find((entry) => entry.e === 'mic.perm.regained')).toMatchObject({ state: 'prompt' });
      resetMicPermissionForTests();
    });

    it('a permission prompt nobody answers is noted in the black box', async () => {
      const env = installEnv();
      env.rtc.getUserMedia.mockImplementation(() => new Promise(() => undefined));
      await open(env);
      await vi.advanceTimersByTimeAsync(RTC_TIMEOUTS.micPendingMs + 10);
      expect(voiceDiagRecent().some((entry) => entry.e === 'mic.gum.pending')).toBe(true);
    });
  });
});
