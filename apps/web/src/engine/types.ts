import type { EngineLine } from '@gambit/shared';

/** Default location of the classic (non-module) Stockfish worker served from `public/engine/`. */
export const DEFAULT_ENGINE_URL = '/engine/stockfish-19-lite-single.js';

/**
 * Minimal text pipe to a UCI engine. The browser implementation wraps a classic Worker,
 * tests use a scripted fake, the Node smoke script wraps the `stockfish` npm package.
 */
export interface EngineTransport {
  /** Send one UCI command (no trailing newline). */
  post(cmd: string): void;
  /** Register the single line listener. Every engine output line is delivered separately. */
  onLine(cb: (line: string) => void): void;
  /** Optional: the transport died (worker `error` event, process exit, ...). */
  onError?(cb: (error: Error) => void): void;
  /** Kill the engine. No callbacks may fire afterwards. */
  terminate(): void;
}

/** A fresh transport is created for the first use and after every fatal error. */
export type EngineTransportFactory = () => EngineTransport;

export type UciOptionValue = string | number | boolean;

export type EngineErrorCode =
  /** Stockfish 19 printed `info string CRITICAL ERROR` (illegal move / broken FEN). The result is discarded. */
  | 'critical-error'
  /** The engine answered `bestmove (none)` (no legal moves or a rejected position). */
  | 'no-move'
  /** No `bestmove` within the watchdog time. The worker is recreated. */
  | 'timeout'
  /** The search was cancelled by `stop()` (superseded). */
  | 'stopped'
  /** The engine was disposed while the request was pending. */
  | 'disposed'
  /** The worker crashed or failed to load. The worker is recreated. */
  | 'worker-error'
  /** `uci` / `isready` handshake did not complete in time. */
  | 'init-failed'
  /** Rejected before reaching the engine: the FEN is not a valid position. */
  | 'invalid-fen'
  /** Rejected before reaching the engine: checkmate / stalemate, nothing to search. */
  | 'no-legal-moves'
  /** Rejected before reaching the engine: `searchmoves` contains a move that is not legal. */
  | 'invalid-searchmoves';

export interface SearchRequest {
  fen: string;
  /** Optional UCI moves played from `fen` (lets the engine see repetitions). */
  moves?: string[];
  depth?: number;
  movetimeMs?: number;
  nodes?: number;
  /** Number of principal variations, default 1. */
  multipv?: number;
  /** Restrict the root moves (UCI). Always emitted as the LAST `go` token. */
  searchmoves?: string[];
  /** Override the computed watchdog for this search. */
  watchdogMs?: number;
  /** Called with the current best-known lines whenever a new exact PV arrives. */
  onInfo?: (lines: EngineLine[]) => void;
}

export interface SearchResult {
  fen: string;
  /** Sorted by multipv ascending, contiguous from 1, one entry per distinct root move. */
  lines: EngineLine[];
  bestmove: string;
  ponder: string | null;
  /** Depth of the best line (0 when the engine produced no PV). */
  depth: number;
  /** Wall-clock time between sending `go` and receiving `bestmove`. */
  timeMs: number;
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** Lines gathered before the search was stopped / timed out (only for 'stopped' and 'timeout'). */
  readonly partial: SearchResult | null;

  constructor(code: EngineErrorCode, message: string, partial: SearchResult | null = null) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.partial = partial;
  }
}

export function isEngineError(value: unknown): value is EngineError {
  return value instanceof EngineError;
}

/** Deterministic-friendly random source: returns a float in [0, 1). */
export type Rng = () => number;
