/**
 * A small proof of work before a sign-up (the open registration — no invite code, no captcha, nothing sent to
 * anyone else): the page asks `GET /api/auth/challenge`, finds a nonce such that sha256(`<challenge>:<nonce>`) starts
 * with `difficulty` zero bits (2^16 tries ≈ a second or two on a phone, done while the child fills the form) and sends
 * both with the sign-up. One family does not notice it; a script that makes thousands of accounts pays for each.
 *
 * A challenge is `<issued ms>.<random>.<hmac>` with a secret made at start (a restart just asks the page for a new
 * one), valid for CHALLENGE_TTL_MS, and good for ONE account: it is claimed before the account is made and given back
 * when the sign-up fails (a short password must not cost the child another wait).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CHALLENGE_TTL_MS = 15 * 60_000;
export const DEFAULT_POW_BITS = 16;

const NONCE_RE = /^[0-9a-zA-Z_-]{1,64}$/;

export type PowCheck = 'ok' | 'bad' | 'expired' | 'used' | 'weak';

/** Leading zero bits of a digest. */
export function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export class ProofOfWork {
  private readonly secret = randomBytes(32);
  /** claimed challenges → when they stop mattering (their expiry) */
  private readonly used = new Map<string, number>();
  private readonly now: () => number;
  readonly difficulty: number;

  constructor(o: { difficulty?: number; now?: () => number } = {}) {
    this.difficulty = o.difficulty ?? DEFAULT_POW_BITS;
    this.now = o.now ?? (() => Date.now());
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  issue(): { challenge: string; difficulty: number } {
    const body = `${this.now()}.${randomBytes(12).toString('base64url')}`;
    return { challenge: `${body}.${this.mac(body)}`, difficulty: this.difficulty };
  }

  /** Is this a solved, live, unused challenge of this server? Claims nothing. */
  check(challenge: unknown, nonce: unknown): PowCheck {
    if (typeof challenge !== 'string' || typeof nonce !== 'string' || challenge.length > 200 || !NONCE_RE.test(nonce)) return 'bad';
    const cut = challenge.lastIndexOf('.');
    if (cut <= 0) return 'bad';
    const body = challenge.slice(0, cut);
    const mac = Buffer.from(challenge.slice(cut + 1));
    const want = Buffer.from(this.mac(body));
    if (mac.length !== want.length || !timingSafeEqual(mac, want)) return 'bad';
    const issued = Number(body.slice(0, body.indexOf('.')));
    const now = this.now();
    if (!Number.isFinite(issued) || issued > now + 60_000 || now - issued > CHALLENGE_TTL_MS) return 'expired';
    if (this.used.has(challenge)) return 'used';
    const digest = createHash('sha256').update(`${challenge}:${nonce}`).digest();
    return leadingZeroBits(digest) >= this.difficulty ? 'ok' : 'weak';
  }

  /** Takes a checked challenge for one sign-up; false = taken meanwhile by a parallel one. */
  claim(challenge: string): boolean {
    this.sweep();
    if (this.used.has(challenge)) return false;
    const issued = Number(challenge.slice(0, challenge.indexOf('.')));
    this.used.set(challenge, (Number.isFinite(issued) ? issued : this.now()) + CHALLENGE_TTL_MS);
    return true;
  }

  /** Gives a claimed challenge back (the sign-up was not made). */
  release(challenge: string): void {
    this.used.delete(challenge);
  }

  private sweep(): void {
    if (this.used.size < 10_000) return;
    const now = this.now();
    for (const [c, until] of this.used) if (until < now) this.used.delete(c);
  }
}
