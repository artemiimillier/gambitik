/**
 * A fake browser WebRTC environment for the voice-layer unit tests (plain Node, no DOM):
 * RTCPeerConnection + data channel, a hidden <audio> element, navigator.mediaDevices.getUserMedia.
 * There is deliberately NO AudioContext, so the layers run with a "deaf" analyser — the hardest case.
 */
import { vi } from 'vitest';

type Listener = (event: unknown) => void;

class FakeTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void {
    const wrapped: Listener = options?.once
      ? (event) => {
          this.removeEventListener(type, wrapped);
          listener(event);
        }
      : listener;
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(wrapped);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

export class FakeDataChannel extends FakeTarget {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  readonly sent: Record<string, unknown>[] = [];
  readonly label: string;

  constructor(label: string) {
    super();
    this.label = label;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
  }

  open(): void {
    this.readyState = 'open';
    this.emit('open');
  }

  /** an event from the OpenAI side */
  receive(event: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(event) });
  }

  types(): string[] {
    return this.sent.map((event) => String(event.type));
  }
}

export interface FakeTrack {
  kind: 'audio';
  enabled: boolean;
  readyState: 'live' | 'ended';
  stop(): void;
}

export function makeFakeTrack(): FakeTrack {
  const track: FakeTrack = {
    kind: 'audio',
    enabled: true,
    readyState: 'live',
    stop() {
      track.readyState = 'ended';
    },
  };
  return track;
}

export class FakePeerConnection extends FakeTarget {
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  channel: FakeDataChannel | null = null;
  closed = false;
  /** what `replaceTrack` put on the wire last (null = the silent placeholder) */
  sentTrack: FakeTrack | null = null;

  createDataChannel(label: string): FakeDataChannel {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  }

  /** the placeholder track of a browser WITH an AudioContext (the comfort noise) goes on the wire first */
  addTrack(track: FakeTrack): { replaceTrack: (track: FakeTrack) => Promise<void> } {
    this.sentTrack = track;
    return {
      replaceTrack: (next) => {
        this.sentTrack = next;
        return Promise.resolve();
      },
    };
  }

  /** the remote audio arrives (what the browser does after setRemoteDescription) */
  emitTrack(stream: unknown = { id: 'remote' }, track: unknown = { kind: 'audio', muted: false }): void {
    this.emit('track', { streams: [stream], track });
  }

  addTransceiver(): { sender: { replaceTrack: (track: FakeTrack) => Promise<void> } } {
    return {
      sender: {
        replaceTrack: (track) => {
          this.sentTrack = track;
          return Promise.resolve();
        },
      },
    };
  }

  createOffer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'offer', sdp: 'v=0 fake-offer' });
  }

  setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = description;
    this.connectionState = 'connected';
    // the data channel opens once both descriptions are set
    queueMicrotask(() => this.channel?.open());
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

export interface FakeRtcEnvironment {
  readonly connections: FakePeerConnection[];
  /** the most recent peer connection */
  pc(): FakePeerConnection;
  /** its data channel */
  dc(): FakeDataChannel;
  readonly getUserMedia: ReturnType<typeof vi.fn>;
  readonly micTracks: FakeTrack[];
  readonly audioElements: { muted: boolean; removed: boolean }[];
  /** deny the microphone permission from now on */
  denyMicrophone(): void;
}

/** Installs the fakes as globals; `vi.unstubAllGlobals()` removes them. */
export function installFakeRtc(): FakeRtcEnvironment {
  const connections: FakePeerConnection[] = [];
  const micTracks: FakeTrack[] = [];
  const audioElements: { muted: boolean; removed: boolean }[] = [];
  let micDenied = false;

  class TrackedPeerConnection extends FakePeerConnection {
    constructor() {
      super();
      connections.push(this);
    }
  }

  const getUserMedia = vi.fn((_constraints: unknown) => {
    if (micDenied) return Promise.reject(new Error('NotAllowedError'));
    const track = makeFakeTrack();
    micTracks.push(track);
    return Promise.resolve({ getAudioTracks: () => [track], getTracks: () => [track] });
  });

  vi.stubGlobal('RTCPeerConnection', TrackedPeerConnection);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia }, userActivation: { hasBeenActive: true } });
  vi.stubGlobal('document', {
    hidden: false,
    body: { appendChild: () => undefined },
    createElement: () => {
      const element = {
        autoplay: false,
        muted: false,
        removed: false,
        srcObject: null as unknown,
        style: {} as Record<string, string>,
        dataset: {} as Record<string, string>,
        setAttribute: () => undefined,
        play: () => Promise.resolve(),
        pause: () => undefined,
        remove() {
          element.removed = true;
        },
      };
      audioElements.push(element);
      return element;
    },
  });

  const pc = (): FakePeerConnection => {
    const last = connections.at(-1);
    if (!last) throw new Error('no RTCPeerConnection was created');
    return last;
  };

  return {
    connections,
    pc,
    dc() {
      const channel = pc().channel;
      if (!channel) throw new Error('no data channel was created');
      return channel;
    },
    getUserMedia,
    micTracks,
    audioElements,
    denyMicrophone() {
      micDenied = true;
    },
  };
}
