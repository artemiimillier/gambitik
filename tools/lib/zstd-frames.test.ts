import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import { createMultiFrameZstdDecompress, looksLikeZstd, ZstdFrameScanner } from './zstd-frames.ts';

/** pzstd-style skippable frame: magic 0x184D2A50, size 4, payload = size of the next frame. */
function skippable(payload: Buffer, nibble = 0): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0x184d2a50 + nibble, 0);
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function pzstdLike(parts: string[]): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    const frame = zstdCompressSync(Buffer.from(part));
    const size = Buffer.alloc(4);
    size.writeUInt32LE(frame.length, 0);
    out.push(skippable(size), frame);
  }
  return Buffer.concat(out);
}

function chunked(buf: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) chunks.push(buf.subarray(i, i + size));
  return chunks;
}

async function decompress(chunks: Buffer[]): Promise<string> {
  const out: Buffer[] = [];
  await pipeline(
    Readable.from(chunks, { objectMode: false }),
    createMultiFrameZstdDecompress(),
    new Writable({
      write(chunk: Buffer, _enc, done) {
        out.push(chunk);
        done();
      },
    }),
  );
  return Buffer.concat(out).toString('utf8');
}

// Compressible but non-trivial text, big enough for several zstd blocks (> 128 kB each part).
function sampleText(seed: number, lines: number): string {
  let s = '';
  let x = seed;
  for (let i = 0; i < lines; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += `${i.toString(36)},${x.toString(36)},r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7,${x % 3000}\n`;
  }
  return s;
}

describe('looksLikeZstd', () => {
  it('recognises data frames and skippable frames', () => {
    expect(looksLikeZstd(zstdCompressSync(Buffer.from('x')))).toBe(true);
    expect(looksLikeZstd(skippable(Buffer.from([1, 2, 3, 4])))).toBe(true);
    expect(looksLikeZstd(skippable(Buffer.alloc(0), 0xf))).toBe(true);
    expect(looksLikeZstd(Buffer.from('PuzzleId,FEN'))).toBe(false);
    expect(looksLikeZstd(Buffer.from([0x28]))).toBe(false);
  });
});

describe('ZstdFrameScanner', () => {
  it('finds frame boundaries regardless of chunking and drops skippable frames', () => {
    const a = zstdCompressSync(Buffer.from(sampleText(1, 4000)));
    const b = zstdCompressSync(Buffer.from('tiny'));
    const input = Buffer.concat([skippable(Buffer.from('meta')), a, skippable(Buffer.alloc(0), 3), b]);

    for (const size of [1, 2, 3, 5, 7, 64, 4096, input.length]) {
      const scanner = new ZstdFrameScanner();
      const frames: Buffer[] = [];
      let current: Buffer[] = [];
      for (const chunk of chunked(input, size)) {
        for (const seg of scanner.scan(chunk)) {
          current.push(seg.data);
          if (seg.end) {
            frames.push(Buffer.concat(current));
            current = [];
          }
        }
      }
      scanner.finish();
      expect(current, `chunk size ${size}`).toEqual([]);
      expect(frames.length).toBe(2);
      expect(frames[0]?.equals(a), `frame A, chunk size ${size}`).toBe(true);
      expect(frames[1]?.equals(b), `frame B, chunk size ${size}`).toBe(true);
      expect(scanner.frames).toBe(2);
      expect(scanner.skippableFrames).toBe(2);
    }
  });

  it('rejects garbage and detects truncation', () => {
    expect(() => new ZstdFrameScanner().scan(Buffer.from('PuzzleId,FEN,Moves'))).toThrow(/not a zstd stream/);

    const frame = zstdCompressSync(Buffer.from(sampleText(2, 500)));
    const truncated = new ZstdFrameScanner();
    truncated.scan(frame.subarray(0, frame.length - 3));
    expect(() => truncated.finish()).toThrow(/truncated/);

    const midMagic = new ZstdFrameScanner();
    midMagic.scan(Buffer.concat([frame, frame.subarray(0, 2)]));
    expect(() => midMagic.finish()).toThrow(/truncated/);

    expect(() => new ZstdFrameScanner().finish()).toThrow(/empty/);
  });
});

describe('createMultiFrameZstdDecompress', () => {
  it('decodes a single ordinary frame', async () => {
    const text = sampleText(3, 3000);
    expect(await decompress(chunked(zstdCompressSync(Buffer.from(text)), 1000))).toBe(text);
  });

  it('decodes every frame of a pzstd-style stream (native createZstdDecompress stops after the first)', async () => {
    const parts = [sampleText(4, 5000), sampleText(5, 10), sampleText(6, 5000)];
    const input = pzstdLike(parts);
    expect(await decompress(chunked(input, 16 * 1024))).toBe(parts.join(''));
    expect(await decompress(chunked(input, 777))).toBe(parts.join(''));
    expect(await decompress([input])).toBe(parts.join(''));
  });

  it('fails on a truncated stream after delivering the complete frames', async () => {
    const input = pzstdLike([sampleText(7, 2000), sampleText(8, 2000)]);
    await expect(decompress(chunked(input.subarray(0, input.length - 10), 4096))).rejects.toThrow(/truncated|unexpected end/i);
  });

  it('fails on corrupt frame content', async () => {
    const frame = Buffer.from(zstdCompressSync(Buffer.from(sampleText(9, 3000))));
    for (let i = 40; i < 60; i++) frame[i] = (frame[i] ?? 0) ^ 0xff;
    await expect(decompress([frame])).rejects.toThrow();
  });

  it('fails on non-zstd input', async () => {
    await expect(decompress([Buffer.from('PuzzleId,FEN,Moves\n')])).rejects.toThrow(/not a zstd stream/);
  });
});
