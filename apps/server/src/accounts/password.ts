/**
 * Accounts (GAMBIT_ACCOUNTS=1, the public site): the secrets of an account — the password and the one-time recovery
 * code — are stored only as scrypt hashes with a random salt (`scrypt$<N>$<r>$<p>$<salt>$<hash>`, base64url), checked in
 * constant time. The recovery code is shown to the family once, at registration (and again after it was used):
 * 16 characters of an alphabet without look-alikes, ≈ 80 bits. Node's own crypto only; the async `scrypt` never blocks
 * the event loop (≈ 50 ms and 32 MiB per hash with N = 2^15).
 */
import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

export const SCRYPT = { N: 32_768, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
/** a login password: 8–128 characters (a parent types it; the site has no other secret) */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/**
 * scrypt runs on Node's small shared worker pool (file reads and writes use it too): at most `HASH_CONCURRENCY` hashes at
 * once, at most `HASH_QUEUE` waiting — beyond that the caller answers 503 `busy` instead of stalling every child's
 * file work.
 */
export const HASH_CONCURRENCY = 2;
export const HASH_QUEUE = 32;

/** Too many sign-ins at once: try again in a few seconds. */
export class HashBusy extends Error {
  constructor() {
    super('too many password checks at once');
    this.name = 'HashBusy';
  }
}

let running = 0;
const waiting: (() => void)[] = [];

async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= HASH_CONCURRENCY) {
    if (waiting.length >= HASH_QUEUE) throw new HashBusy();
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function derive(secret: string, salt: Buffer, params: { N: number; r: number; p: number; keyLen: number }): Promise<Buffer> {
  return withHashSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        // maxmem: 128 · N · r · 2 bytes (≈ 64 MiB for the defaults), well above what the parameters need
        scrypt(secret.normalize('NFC'), salt, params.keyLen, { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r }, (error, key) => {
          if (error) reject(error);
          else resolve(key);
        });
      }),
  );
}

/** `scrypt$N$r$p$salt$hash` of a secret (a fresh random salt each time). */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLen);
  const key = await derive(secret, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * Does `secret` match the stored hash? False for anything malformed (never throws on bad input). Only the exact
 * parameters this code writes are accepted: a tampered row cannot make the server burn memory or time.
 */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  if (Number(parts[1]) !== SCRYPT.N || Number(parts[2]) !== SCRYPT.r || Number(parts[3]) !== SCRYPT.p) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const expected = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length !== SCRYPT.saltLen || expected.length !== SCRYPT.keyLen) return false;
  const actual = await derive(secret, salt, SCRYPT);
  return timingSafeEqual(actual, expected);
}

/** A hash to compare against when the login does not exist: the same work, so timing does not tell logins apart. */
let dummyHash: Promise<string> | null = null;
export function dummySecretHash(): Promise<string> {
  if (dummyHash === null) {
    const made = hashSecret(randomBytes(12).toString('base64url'));
    dummyHash = made;
    // a failed first try is not remembered (else unknown logins would answer 500 and known ones 401)
    made.catch(() => {
      if (dummyHash === made) dummyHash = null;
    });
  }
  return dummyHash;
}

/** The passwords guessed first (and their Russian keyboard twins): never accepted. */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'qwertyuiop', 'qwerty123', 'qwerty1234', 'qwertyui', 'asdfghjkl',
  'zxcvbnm1', '1q2w3e4r', '1q2w3e4r5t', 'qazwsxedc', 'iloveyou', 'sunshine', 'football', 'baseball', 'princess',
  'dragon12', 'monkey12', 'letmein1', 'welcome1', 'admin123', 'administrator', 'superman', 'batman12', 'trustno1',
  'chess123', 'chessmaster', 'шахматы', 'шахматы1', 'шахматы123', 'шахматист', 'пароль', 'пароль1', 'пароль123',
  'йцукенгш', 'йцукенгшщз', 'фывапролд', 'фывапролджэ', 'ячсмитьбю', 'привет123', 'люблюмаму', 'гамбитик', 'gambitik',
  'гамбитик1', 'gambitik1', 'qwertyqwerty',
]);

/** Why a new password is refused (null = fine): too short / long, or one of the first guesses. */
export function passwordProblem(password: unknown): 'type' | 'short' | 'long' | 'common' | null {
  if (typeof password !== 'string') return 'type';
  const n = [...password].length;
  if (n < PASSWORD_MIN) return 'short';
  if (n > PASSWORD_MAX) return 'long';
  const p = password.normalize('NFC').toLowerCase();
  if (COMMON_PASSWORDS.has(p)) return 'common';
  // one symbol over and over, digits only (a date, a phone) below 12, a plain run like 12345678 / abcdefgh / 87654321
  if (new Set(p).size <= 2) return 'common';
  if (/^\d+$/.test(p) && n < 12) return 'common';
  const codes = [...p].map((ch) => ch.codePointAt(0) ?? 0);
  const steps = new Set(codes.slice(1).map((c, i) => c - (codes[i] ?? 0)));
  if (steps.size === 1 && (steps.has(1) || steps.has(-1))) return 'common';
  return null;
}

/** No 0/O, 1/I/L, 5/S, 8/B, 2/Z: the family writes it on paper. */
const RECOVERY_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY3469';

/** A new recovery code `XXXX-XXXX-XXXX-XXXX` (16 of 24 symbols, ≈ 73 bits). */
export function newRecoveryCode(): string {
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  return out;
}

/** A family's invite code `XXXXX-XXXXX-XXXXX-XXXXX` (20 of the same 24 unambiguous symbols, ≈ 92 bits). */
export function newInviteCode(): string {
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 5 === 0) out += '-';
    out += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  return out;
}

/** The recovery code as typed (lower case, spaces, missing dashes) → its canonical form; null = not a code. */
export function normalizeRecoveryCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const plain = raw.toUpperCase().replace(/[\s-]/g, '');
  if (plain.length !== 16 || [...plain].some((ch) => !RECOVERY_ALPHABET.includes(ch))) return null;
  return plain.match(/.{4}/g)?.join('-') ?? null;
}

/** A random temporary password for the owner's reset command (shown once, never stored in clear). */
export function newTemporaryPassword(): string {
  const words = randomBytes(9).toString('base64url');
  return `${words.slice(0, 4)}-${words.slice(4, 8)}-${words.slice(8, 12)}`;
}
