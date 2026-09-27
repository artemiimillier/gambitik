/**
 * Multi-frame zstd stream decompression for Node.
 *
 * WHY THIS EXISTS: `zlib.createZstdDecompress()` (Node 26.7) decodes exactly ONE frame. It ends
 * silently after the first frame of a concatenated stream and fails with
 * `ZSTD_error_prefix_unknown` on a leading skippable frame. `lichess_db_puzzle.csv.zst` is written
 * pzstd-style: [skippable frame (12 bytes)] [zstd frame ≈ 9 MB] [skippable] [frame] … — so the
 * naive pipe yields either an error or only the first few percent of the data.
 *
 * `ZstdFrameScanner` walks the container format (RFC 8878 §3.1: frame header → block headers →
 * optional checksum; skippable frames) to find exact frame boundaries without decompressing, and
 * `createMultiFrameZstdDecompress()` feeds every frame to its own native decompressor.
 */
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC_BASE = 0x184d2a50;
const EMPTY = Buffer.alloc(0);

export class ZstdFormatError extends Error {}

/** True when the first four bytes look like a zstd frame or a zstd skippable frame. */
export function looksLikeZstd(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const magic = Buffer.from(head.buffer, head.byteOffset, 4).readUInt32LE(0);
  return magic === ZSTD_MAGIC || (magic & SKIPPABLE_MAGIC_MASK) >>> 0 === SKIPPABLE_MAGIC_BASE;
}

export interface FrameSegment {
  /** bytes belonging to the current data frame (may be empty when only `end` is signalled) */
  data: Buffer;
  /** true when this segment completes the frame */
  end: boolean;
}

type ScannerState = 'magic' | 'skipSize' | 'skipData' | 'descriptor' | 'headerRest' | 'blockHeader' | 'blockData' | 'checksum';

const HEADER_STATE_SIZE: Partial<Record<ScannerState, number>> = { magic: 4, skipSize: 4, descriptor: 1, blockHeader: 3 };

/**
 * Incremental frame-boundary scanner. Feed arbitrary chunks to `scan()`; it returns the byte
 * ranges that belong to data frames (skippable frames are dropped) and marks where each frame
 * ends. Call `finish()` at end of input — it throws when the input stops inside a frame.
 */
export class ZstdFrameScanner {
  frames = 0;
  skippableFrames = 0;

  private state: ScannerState = 'magic';
  private readonly small = Buffer.alloc(4);
  private smallLength = 0;
  private remaining = 0;
  private hasChecksum = false;
  private lastBlock = false;

  private get inFrame(): boolean {
    return this.state !== 'magic' && this.state !== 'skipSize' && this.state !== 'skipData';
  }

  scan(chunk: Buffer): FrameSegment[] {
    const out: FrameSegment[] = [];
    let pos = 0;
    let rangeStart = this.inFrame ? 0 : -1;

    const endFrame = (): void => {
      out.push({ data: rangeStart >= 0 ? chunk.subarray(rangeStart, pos) : EMPTY, end: true });
      rangeStart = -1;
      this.state = 'magic';
    };
    const afterBlock = (): void => {
      if (!this.lastBlock) this.state = 'blockHeader';
      else if (this.hasChecksum) {
        this.state = 'checksum';
        this.remaining = 4;
      } else endFrame();
    };

    while (pos < chunk.length) {
      const headerSize = HEADER_STATE_SIZE[this.state];
      if (headerSize !== undefined) {
        const take = Math.min(headerSize - this.smallLength, chunk.length - pos);
        chunk.copy(this.small, this.smallLength, pos, pos + take);
        this.smallLength += take;
        pos += take;
        if (this.smallLength < headerSize) break; // chunk exhausted mid-header
        this.smallLength = 0;

        switch (this.state) {
          case 'magic': {
            const magic = this.small.readUInt32LE(0);
            if (magic === ZSTD_MAGIC) {
              // The magic was buffered (it may straddle chunks) — forward a copy, then raw ranges.
              out.push({ data: Buffer.from(this.small), end: false });
              rangeStart = pos;
              this.frames++;
              this.state = 'descriptor';
            } else if ((magic & SKIPPABLE_MAGIC_MASK) >>> 0 === SKIPPABLE_MAGIC_BASE) {
              this.skippableFrames++;
              this.state = 'skipSize';
            } else {
              throw new ZstdFormatError(`not a zstd stream: unexpected frame magic 0x${magic.toString(16).padStart(8, '0')}`);
            }
            break;
          }
          case 'skipSize': {
            this.remaining = this.small.readUInt32LE(0);
            this.state = this.remaining > 0 ? 'skipData' : 'magic';
            break;
          }
          case 'descriptor': {
            const fhd = this.small[0] ?? 0;
            const fcsFlag = fhd >> 6;
            const singleSegment = (fhd & 0x20) !== 0;
            this.hasChecksum = (fhd & 0x04) !== 0;
            const dictIdSize = [0, 1, 2, 4][fhd & 0x03] ?? 0;
            const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
            this.remaining = (singleSegment ? 0 : 1) + dictIdSize + fcsSize;
            this.state = this.remaining > 0 ? 'headerRest' : 'blockHeader';
            break;
          }
          case 'blockHeader': {
            const header = (this.small[0] ?? 0) | ((this.small[1] ?? 0) << 8) | ((this.small[2] ?? 0) << 16);
            this.lastBlock = (header & 1) === 1;
            const blockType = (header >> 1) & 3;
            if (blockType === 3) throw new ZstdFormatError('corrupt zstd stream: reserved block type');
            this.remaining = blockType === 1 ? 1 : header >>> 3; // RLE blocks carry a single byte
            if (this.remaining > 0) this.state = 'blockData';
            else afterBlock();
            break;
          }
          default:
            break;
        }
        continue;
      }

      const take = Math.min(this.remaining, chunk.length - pos);
      pos += take;
      this.remaining -= take;
      if (this.remaining > 0) break; // chunk exhausted mid-payload
      switch (this.state) {
        case 'skipData':
          this.state = 'magic';
          break;
        case 'headerRest':
          this.state = 'blockHeader';
          break;
        case 'blockData':
          afterBlock();
          break;
        case 'checksum':
          endFrame();
          break;
        default:
          break;
      }
    }

    if (rangeStart >= 0 && rangeStart < chunk.length) out.push({ data: chunk.subarray(rangeStart), end: false });
    return out;
  }

  /** Throws when the input ended in the middle of a frame (truncated download). */
  finish(): void {
    if (this.state !== 'magic' || this.smallLength !== 0) {
      throw new ZstdFormatError('truncated zstd stream: input ended in the middle of a frame');
    }
    if (this.frames === 0) throw new ZstdFormatError('empty zstd stream: no data frame found');
  }
}

/**
 * Transform: compressed bytes in (any number of zstd frames, skippable frames allowed) →
 * decompressed bytes out. Errors (corrupt data, truncation) surface as stream errors.
 */
export function createMultiFrameZstdDecompress(): Transform {
  const scanner = new ZstdFrameScanner();
  let inner: Transform | null = null;

  const transform = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
      let segments: FrameSegment[];
      try {
        segments = scanner.scan(chunk);
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      feed(segments).then(
        () => done(),
        (err: unknown) => done(err instanceof Error ? err : new Error(String(err))),
      );
    },
    flush(done: TransformCallback): void {
      try {
        scanner.finish();
        done();
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    },
    destroy(err: Error | null, done: (error: Error | null) => void): void {
      inner?.destroy();
      inner = null;
      done(err);
    },
  });

  async function feed(segments: FrameSegment[]): Promise<void> {
    for (const segment of segments) {
      if (!inner) {
        inner = createZstdDecompress();
        inner.on('data', (out: Buffer) => transform.push(out));
        // Persistent listener: a decoder error between two writes must fail the stream, not crash the process.
        inner.on('error', (err: Error) => transform.destroy(err));
      }
      const frame = inner;
      if (segment.data.length > 0) {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error): void => reject(err);
          frame.once('error', onError);
          frame.write(segment.data, (err) => {
            frame.off('error', onError);
            if (err) reject(err);
            else resolve();
          });
        });
      }
      if (segment.end) {
        await new Promise<void>((resolve, reject) => {
          frame.once('error', reject);
          frame.once('end', resolve);
          frame.end();
        });
        inner = null;
      }
    }
  }

  return transform;
}
