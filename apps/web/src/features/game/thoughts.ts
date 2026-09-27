/**
 * The child's thoughts about a finished game that come AFTER its record went out (what the child
 * thinks belongs in the journal): the talk with Гамбитик after the game (the child's voice transcripts) and a late answer
 * to the diary question — each with the question it answers. They go to `POST /games/:id/thoughts` (the server adds them
 * to the game's journal, «Мысли после партии»). Words said BEFORE the record left are in the record itself and are never
 * sent again (they would stand twice in the journal).
 *
 * Offline-safe the way finished games are (./unsavedGames.ts): what cannot be sent now is parked in localStorage under
 * `gambit.unsentThoughts` and goes out after the parked games when the next game starts. Every thought has a stable id,
 * and the server skips ids it already has, so a repeated send is harmless. A 4xx answer (404 — the game is not on the
 * server, 409 — «too-old», not one of the newest games any more) means «never»: those thoughts are dropped.
 */
import type { GameThought } from '@gambit/shared';
import type { KeyValueStorage } from './gameTypes.ts';
import { isClientError } from './unsavedGames.ts';

export const UNSENT_THOUGHTS_KEY = 'gambit.unsentThoughts';
/** The server's limits (apps/server/src/schemas.ts): per request, per text, per question, per game. */
export const THOUGHTS_PER_REQUEST = 20;
export const THOUGHT_MAX_CHARS = 600;
export const THOUGHT_QUESTION_MAX_CHARS = 300;
export const THOUGHTS_PER_GAME = 60;
/** Parked thoughts of at most this many games (the server takes them only for its newest few games anyway). */
export const MAX_PARKED_THOUGHT_GAMES = 5;
/** A thought waits this long for the ones that follow it: a sentence of the talk comes in pieces. */
export const THOUGHTS_SEND_DELAY_MS = 3_000;

/** `POST /games/:id/thoughts` (`appendGameThoughts` of the api client). */
export type SendThoughts = (gameId: string, thoughts: GameThought[]) => Promise<unknown>;

interface ParkedThoughts {
  gameId: string;
  thoughts: GameThought[];
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** One thought in the server's shape: the text tidied and cut to the limits, an empty question left out. null = nothing to say. */
export function makeThought(a: { id: string; source: GameThought['source']; text: string; question?: string | null; at: Date }): GameThought | null {
  const text = a.text.replace(/\s+/g, ' ').trim().slice(0, THOUGHT_MAX_CHARS).trim();
  if (text === '' || !ID_RE.test(a.id)) return null;
  const question = (a.question ?? '').replace(/\s+/g, ' ').trim().slice(0, THOUGHT_QUESTION_MAX_CHARS).trim();
  return { id: a.id, source: a.source, ...(question !== '' ? { question } : {}), text, at: a.at.toISOString() };
}

function isThought(value: unknown): value is GameThought {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Partial<GameThought>;
  return typeof t.id === 'string' && ID_RE.test(t.id) && (t.source === 'voice' || t.source === 'typed') && typeof t.text === 'string' && t.text.trim() !== '' && typeof t.at === 'string' && (t.question === undefined || typeof t.question === 'string');
}

export function readParkedThoughts(storage: KeyValueStorage | null | undefined): ParkedThoughts[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(UNSENT_THOUGHTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((g): g is ParkedThoughts => typeof g === 'object' && g !== null && typeof (g as ParkedThoughts).gameId === 'string' && ID_RE.test((g as ParkedThoughts).gameId) && Array.isArray((g as ParkedThoughts).thoughts))
      .map((g) => ({ gameId: g.gameId, thoughts: g.thoughts.filter(isThought) }))
      .filter((g) => g.thoughts.length > 0);
  } catch {
    return [];
  }
}

function writeParked(storage: KeyValueStorage, games: ParkedThoughts[]): boolean {
  try {
    if (games.length === 0) storage.removeItem(UNSENT_THOUGHTS_KEY);
    else storage.setItem(UNSENT_THOUGHTS_KEY, JSON.stringify(games));
    return true;
  } catch {
    return false;
  }
}

/** Parks thoughts of a game (merged by id, ≤ 60 a game, the newest 5 games). false = they could not be stored. */
export function parkThoughts(storage: KeyValueStorage | null | undefined, gameId: string, thoughts: readonly GameThought[]): boolean {
  if (!storage || thoughts.length === 0) return false;
  const games = readParkedThoughts(storage);
  const mine = games.find((g) => g.gameId === gameId) ?? { gameId, thoughts: [] };
  const known = new Set(mine.thoughts.map((t) => t.id));
  const merged = [...mine.thoughts, ...thoughts.filter((t) => !known.has(t.id))].slice(0, THOUGHTS_PER_GAME);
  const rest = games.filter((g) => g.gameId !== gameId);
  return writeParked(storage, [...rest, { gameId, thoughts: merged }].slice(-MAX_PARKED_THOUGHT_GAMES));
}

/** Drops parked thoughts of a game: the given ids, or all of them. */
export function removeParkedThoughts(storage: KeyValueStorage | null | undefined, gameId: string, ids?: readonly string[]): void {
  if (!storage) return;
  const games = readParkedThoughts(storage);
  const next = games
    .map((g) => (g.gameId !== gameId ? g : { gameId, thoughts: ids ? g.thoughts.filter((t) => !ids.includes(t.id)) : [] }))
    .filter((g) => g.thoughts.length > 0);
  if (next.length !== games.length || next.some((g, i) => g.thoughts.length !== games[i]?.thoughts.length)) writeParked(storage, next);
}

/**
 * Sends every parked thought (after the parked games went out — the game must be on the server first). A network or
 * server failure stops the pass (tried again next time); a 4xx drops that game's thoughts for good. Returns how many
 * were delivered.
 */
export async function flushParkedThoughts(storage: KeyValueStorage | null | undefined, send: SendThoughts): Promise<number> {
  let sent = 0;
  for (const game of readParkedThoughts(storage)) {
    for (let i = 0; i < game.thoughts.length; i += THOUGHTS_PER_REQUEST) {
      const batch = game.thoughts.slice(i, i + THOUGHTS_PER_REQUEST);
      try {
        await send(game.gameId, batch);
      } catch (error) {
        if (isClientError(error)) {
          removeParkedThoughts(storage, game.gameId);
          break;
        }
        return sent;
      }
      removeParkedThoughts(storage, game.gameId, batch.map((t) => t.id));
      sent += batch.length;
    }
  }
  return sent;
}

/** The thoughts of ONE finished game, from the moment its record went out. */
export interface ThoughtsOutbox {
  /** a thought: sent a few seconds later with the ones that follow it (a sentence of the talk comes in pieces) */
  add(thought: GameThought): void;
  /** the record's fate: 'saved' — the game is on the server, send; 'local' — it is parked: park the thoughts with it */
  recordDelivered(outcome: 'saved' | 'local'): void;
  /** leaving the game: whatever is not sent yet is parked (it goes out when the next game starts) */
  close(): void;
  /** sends what is waiting now (tests; the timer does it otherwise) */
  flush(): Promise<void>;
}

export interface ThoughtsOutboxOptions {
  gameId: string;
  send: SendThoughts;
  storage?: KeyValueStorage | null;
  delayMs?: number;
  log?(message: string, error?: unknown): void;
}

export function createThoughtsOutbox(o: ThoughtsOutboxOptions): ThoughtsOutbox {
  let state: 'waiting' | 'server' | 'parked' | 'closed' | 'refused' = 'waiting';
  let pending: GameThought[] = [];
  let taken = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending: Promise<void> | null = null;
  const delayMs = o.delayMs ?? THOUGHTS_SEND_DELAY_MS;

  const park = (): void => {
    if (pending.length === 0) return;
    if (!parkThoughts(o.storage, o.gameId, pending)) o.log?.(`${pending.length} thought(s) of the game could not be parked`);
    pending = [];
  };
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (): void => {
    if (timer !== null || state !== 'server') return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };

  async function sendNow(): Promise<void> {
    while (state === 'server' && pending.length > 0) {
      const batch = pending.slice(0, THOUGHTS_PER_REQUEST);
      try {
        await o.send(o.gameId, batch);
        pending = pending.filter((t) => !batch.includes(t));
      } catch (error) {
        if (isClientError(error)) {
          // 404 / 409 «too-old»: the server will never take them
          o.log?.('the server refused the thoughts of the game', error);
          state = 'refused';
          pending = [];
          return;
        }
        // offline or a server error: they wait in localStorage for the next game start (the ids make it idempotent)
        o.log?.('sending the thoughts failed — parked', error);
        park();
        return;
      }
    }
  }

  function flush(): Promise<void> {
    clearTimer();
    if (sending) return sending.then(() => (pending.length > 0 && state === 'server' ? flush() : undefined));
    sending = sendNow().finally(() => {
      sending = null;
    });
    return sending;
  }

  return {
    add(thought) {
      if (state === 'refused' || taken >= THOUGHTS_PER_GAME) return;
      taken += 1;
      pending.push(thought);
      if (state === 'parked' || state === 'closed') park();
      else if (state === 'server') schedule();
    },
    recordDelivered(outcome) {
      if (state !== 'waiting') return;
      state = outcome === 'saved' ? 'server' : 'parked';
      if (state === 'parked') park();
      else if (pending.length > 0) schedule();
    },
    close() {
      clearTimer();
      if (state === 'refused') return;
      state = 'closed';
      park();
    },
    flush,
  };
}
