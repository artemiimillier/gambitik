import type { EngineTransport } from '../types.ts';

export interface FakeGoContext {
  /** The last `position ...` command. */
  position: string;
  /** FEN extracted from the position command ('' for startpos). */
  fen: string;
  /** The full `go ...` command. */
  go: string;
  /** Current MultiPV option value. */
  multipv: number;
}

/**
 * What the fake engine prints for a `go`:
 *  - string[]: these lines, asynchronously (must normally end with a `bestmove ...` line);
 *  - 'hang': nothing at all until `stop` arrives (then `stopReply`, unless `ignoreStop`).
 */
export type FakeGoHandler = (ctx: FakeGoContext) => string[] | 'hang';

/**
 * Scripted UCI engine for unit tests: answers the `uci` / `isready` handshake like Stockfish and delegates
 * every `go` to a handler. Output is delivered asynchronously (microtask) like a real worker.
 */
export class FakeEngine {
  /** Every command ever posted, across restarts. */
  readonly sent: string[] = [];
  created = 0;
  terminated = 0;
  /** Reply printed when `stop` arrives during a hanging search. */
  stopReply: string[] = ['bestmove a2a3'];
  /** Simulates a completely frozen worker. */
  ignoreStop = false;
  /** Simulates a worker that never completes the handshake. */
  silentHandshake = false;
  /** Lines printed in response to a `position` command (e.g. a CRITICAL ERROR). */
  onPosition: (command: string) => string[] = () => [];
  onGo: FakeGoHandler;

  private lineCb: ((line: string) => void) | null = null;
  private errorCb: ((error: Error) => void) | null = null;
  private alive = false;
  private searching = false;
  private position = 'position startpos';
  private multipv = 1;

  constructor(onGo: FakeGoHandler = () => ['bestmove e2e4']) {
    this.onGo = onGo;
  }

  readonly createTransport = (): EngineTransport => {
    this.created += 1;
    this.alive = true;
    this.searching = false;
    this.multipv = 1;
    const instance = this.created;
    return {
      post: (cmd: string) => {
        if (instance === this.created && this.alive) this.receive(cmd);
      },
      onLine: (cb) => {
        this.lineCb = cb;
      },
      onError: (cb) => {
        this.errorCb = cb;
      },
      terminate: () => {
        if (instance !== this.created) return;
        this.alive = false;
        this.terminated += 1;
      },
    };
  };

  /** Commands posted since the last restart marker (or all of them). */
  commands(filter?: (cmd: string) => boolean): string[] {
    return filter === undefined ? [...this.sent] : this.sent.filter(filter);
  }

  goCommands(): string[] {
    return this.sent.filter((cmd) => cmd.startsWith('go'));
  }

  /** Push raw lines from the "engine" (asynchronously, like a worker message). */
  emit(lines: string[]): void {
    const instance = this.created;
    queueMicrotask(() => {
      if (instance !== this.created || !this.alive) return;
      for (const line of lines) this.lineCb?.(line);
    });
  }

  /** Simulate a worker `error` event. */
  crash(message = 'worker crashed'): void {
    this.errorCb?.(new Error(message));
  }

  private receive(cmd: string): void {
    this.sent.push(cmd);
    if (cmd === 'uci') {
      if (!this.silentHandshake) this.emit(['id name Fake Stockfish', 'option name Hash type spin default 16 min 1 max 1024', 'uciok']);
    } else if (cmd === 'isready') {
      if (!this.silentHandshake) this.emit(['readyok']);
    } else if (cmd.startsWith('setoption name MultiPV value ')) {
      this.multipv = Number.parseInt(cmd.slice('setoption name MultiPV value '.length), 10);
    } else if (cmd.startsWith('position')) {
      this.position = cmd;
      this.emit(this.onPosition(cmd));
    } else if (cmd.startsWith('go')) {
      const fenMatch = /^position fen (.+?)(?: moves .*)?$/.exec(this.position);
      const reply = this.onGo({ position: this.position, fen: fenMatch?.[1] ?? '', go: cmd, multipv: this.multipv });
      if (reply === 'hang') {
        this.searching = true;
      } else {
        this.emit(reply);
      }
    } else if (cmd === 'stop') {
      if (this.searching && !this.ignoreStop) {
        this.searching = false;
        this.emit(this.stopReply);
      }
    }
  }
}

/** Convenience: an `info` line in real Stockfish 19 format. */
export function infoLine(args: {
  depth: number;
  multipv?: number;
  cp?: number;
  mate?: number;
  pv: string;
  bound?: 'lowerbound' | 'upperbound';
}): string {
  const score = args.mate !== undefined ? `mate ${args.mate}` : `cp ${args.cp ?? 0}`;
  const bound = args.bound !== undefined ? ` ${args.bound}` : '';
  return `info depth ${args.depth} seldepth ${args.depth + 2} multipv ${args.multipv ?? 1} score ${score}${bound} nodes 1234 nps 100000 hashfull 0 tbhits 0 time 12 pv ${args.pv}`;
}
