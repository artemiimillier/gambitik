/**
 * The sign-up's proof of work (server: apps/server/src/accounts/pow.ts): a task from `GET /api/auth/challenge` is solved
 * in the background while the child fills the form — sha256(`<challenge>:<nonce>`) with `difficulty` leading zero
 * bits, about 65 000 tries (a second or two on a phone). No task (the family server, GAMBIT_POW_BITS=0) = nothing to do.
 */
import { API_BASE } from '@gambit/shared';

export interface PowAnswer {
  challenge: string;
  nonce: string;
}

/** tries hashed at once (WebCrypto is asynchronous: a batch keeps it busy) */
const BATCH = 256;

function zeroBits(digest: ArrayBuffer): number {
  const bytes = new Uint8Array(digest);
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export async function solvePow(challenge: string, difficulty: number, signal?: AbortSignal): Promise<string> {
  const encoder = new TextEncoder();
  for (let base = 0; ; base += BATCH) {
    if (signal?.aborted) throw new Error('aborted');
    const nonces = Array.from({ length: BATCH }, (_, i) => (base + i).toString(36));
    const digests = await Promise.all(nonces.map((n) => crypto.subtle.digest('SHA-256', encoder.encode(`${challenge}:${n}`))));
    const hit = digests.findIndex((d) => zeroBits(d) >= difficulty);
    if (hit !== -1) return nonces[hit] as string;
  }
}

/** A task from the server, solved; null = no task needed (or the server did not give one: it will say so itself). */
export async function earnPow(signal?: AbortSignal): Promise<PowAnswer | null> {
  let task: { challenge: string; difficulty: number } | null = null;
  try {
    const res = await fetch(`${API_BASE}/auth/challenge`, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { pow?: { challenge?: unknown; difficulty?: unknown } | null };
    const p = body.pow;
    if (p && typeof p.challenge === 'string' && typeof p.difficulty === 'number') task = { challenge: p.challenge, difficulty: p.difficulty };
  } catch {
    return null;
  }
  if (task === null) return null;
  return { challenge: task.challenge, nonce: await solvePow(task.challenge, task.difficulty, signal) };
}
