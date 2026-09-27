/// <reference types="node" />
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { solvePow } from './pow.ts';

describe('the sign-up proof of work', () => {
  it('finds a nonce whose sha256 starts with the asked zero bits (as the server checks it)', async () => {
    const challenge = '1790000000000.abc.def';
    const nonce = await solvePow(challenge, 10);
    const digest = createHash('sha256').update(`${challenge}:${nonce}`).digest();
    expect(digest[0]).toBe(0);
    expect((digest[1] ?? 255) >> 6).toBe(0);
  });
});
