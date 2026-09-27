/**
 * ffmpeg / ffprobe helpers (execFile, never a shell; nothing is ever played). Raw audio moves between ffmpeg and the
 * JS analysis as mono 32 kHz float32 little-endian.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CODEC, SAMPLE_RATE, TARGET_LUFS, TARGET_TRUE_PEAK } from './config.ts';

export class AudioToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioToolError';
  }
}

interface ExecOut {
  stdout: Buffer;
  stderr: string;
}

function exec(bin: string, args: readonly string[]): Promise<ExecOut> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr);
      if (err) reject(new AudioToolError(`${bin} ${args.slice(0, 6).join(' ')} …: ${errText.trim().split('\n').slice(-3).join(' | ') || err.message}`));
      else resolve({ stdout: stdout as Buffer, stderr: errText });
    });
  });
}

let ffmpegChecked: Promise<boolean> | null = null;

/** ffmpeg with libmp3lame, loudnorm and atempo (cached). */
export function ffmpegAvailable(): Promise<boolean> {
  ffmpegChecked ??= (async () => {
    try {
      const encoders = (await exec('ffmpeg', ['-hide_banner', '-encoders'])).stdout.toString('utf8');
      const filters = (await exec('ffmpeg', ['-hide_banner', '-filters'])).stdout.toString('utf8');
      return encoders.includes('libmp3lame') && filters.includes('loudnorm') && filters.includes('atempo');
    } catch {
      return false;
    }
  })();
  return ffmpegChecked;
}

function toFloat32(buf: Buffer): Float32Array {
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function toBuffer(pcm: Float32Array): Buffer {
  const buf = Buffer.alloc(pcm.length * 4);
  for (let i = 0; i < pcm.length; i++) buf.writeFloatLE(pcm[i]!, i * 4);
  return buf;
}

const RAW_IN = ['-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '1'];

/** Decodes any audio file to mono float32 at `rate` (ffmpeg honours the MP3 LAME tag, so priming is removed). */
export async function decodeToPcm(file: string, rate = SAMPLE_RATE): Promise<Float32Array> {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(rate), '-']);
  return toFloat32(stdout);
}

/** Writes raw float32 PCM (the input format of the helpers below). */
export function writeRaw(file: string, pcm: Float32Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, toBuffer(pcm));
}

export interface Loudness {
  /** integrated loudness, LUFS (−Infinity when too short / silent to gate) */
  lufs: number;
  /** true peak, dBTP */
  truePeak: number;
}

function num(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/** EBU R128 integrated loudness and true peak (ffmpeg `loudnorm` measuring pass). */
export async function measureLoudness(input: string | { pcm: Float32Array; work: string }): Promise<Loudness> {
  let file: string;
  let args: string[];
  let tmp: string | null = null;
  if (typeof input === 'string') {
    file = input;
    args = ['-i', file];
  } else {
    tmp = path.join(input.work, `ln-${process.pid}-${Math.random().toString(36).slice(2)}.f32`);
    writeRaw(tmp, input.pcm);
    file = tmp;
    args = [...RAW_IN, '-i', file];
  }
  try {
    const { stderr } = await exec('ffmpeg', ['-hide_banner', '-nostats', '-nostdin', ...args, '-af', `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:LRA=11:print_format=json`, '-f', 'null', '-']);
    const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1);
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(json) as Record<string, unknown>;
    } catch {
      throw new AudioToolError(`loudnorm printed no JSON for ${file}`);
    }
    return { lufs: num(data.input_i), truePeak: num(data.input_tp) };
  } finally {
    if (tmp !== null) rmSync(tmp, { force: true });
  }
}

/** Gain (dB) that brings `measured` to −18 LUFS without letting the true peak pass −1.5 dBTP; 0 when unmeasurable. */
export function normalisingGain(measured: Loudness): number {
  if (!Number.isFinite(measured.lufs) || measured.lufs < -70) return 0;
  const toTarget = TARGET_LUFS - measured.lufs;
  const headroom = Number.isFinite(measured.truePeak) ? TARGET_TRUE_PEAK - measured.truePeak : toTarget;
  return Math.min(toTarget, headroom);
}

export interface EncodeOptions {
  /** ffmpeg atempo factor (0.8–1.3); 1 or undefined = untouched */
  atempo?: number;
  gainDb?: number;
  work: string;
}

/** Encodes PCM to the library format — MP3 CBR 48 kbps, mono, 32 kHz, no ID3 — via a temp file and an atomic rename. */
export async function encodeMp3(pcm: Float32Array, out: string, opts: EncodeOptions): Promise<void> {
  const raw = path.join(opts.work, `enc-${process.pid}-${Math.random().toString(36).slice(2)}.f32`);
  writeRaw(raw, pcm);
  mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp.mp3`;
  const filters: string[] = [];
  if (opts.atempo !== undefined && Math.abs(opts.atempo - 1) > 1e-3) filters.push(`atempo=${opts.atempo.toFixed(4)}`);
  if (opts.gainDb !== undefined && Math.abs(opts.gainDb) > 1e-3) filters.push(`volume=${opts.gainDb.toFixed(2)}dB`);
  try {
    await exec('ffmpeg', [
      '-v', 'error', '-nostdin', '-y',
      ...RAW_IN, '-i', raw,
      ...(filters.length > 0 ? ['-af', filters.join(',')] : []),
      '-c:a', 'libmp3lame', '-b:a', `${CODEC.kbps}k`, '-ar', String(CODEC.hz), '-ac', String(CODEC.ch),
      '-map_metadata', '-1', '-id3v2_version', '0', '-write_xing', '1',
      '-f', 'mp3', tmp,
    ]);
    renameSync(tmp, out);
  } finally {
    rmSync(raw, { force: true });
    rmSync(tmp, { force: true });
  }
}

/** Time-stretches PCM with ffmpeg `atempo` (WSOLA: pitch unchanged); factor > 1 is faster. */
export async function atempoPcm(pcm: Float32Array, factor: number, work: string): Promise<Float32Array> {
  if (Math.abs(factor - 1) <= 1e-3) return pcm;
  const raw = path.join(work, `tempo-${process.pid}-${Math.random().toString(36).slice(2)}.f32`);
  writeRaw(raw, pcm);
  try {
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-nostdin', ...RAW_IN, '-i', raw, '-af', `atempo=${factor.toFixed(4)}`, '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), '-']);
    return toFloat32(stdout);
  } finally {
    rmSync(raw, { force: true });
  }
}

/** 16 kHz mono 16-bit WAV (whisper.cpp input). */
export async function toWav16k(file: string, out: string): Promise<void> {
  mkdirSync(path.dirname(out), { recursive: true });
  await exec('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', file, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
}

/** Writes PCM as an MP3 at an arbitrary bitrate (review renders and test fixtures). */
export async function writeMp3(pcm: Float32Array, out: string, kbps: number, work: string): Promise<void> {
  const raw = path.join(work, `mp3-${process.pid}-${Math.random().toString(36).slice(2)}.f32`);
  writeRaw(raw, pcm);
  try {
    mkdirSync(path.dirname(out), { recursive: true });
    await exec('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...RAW_IN, '-i', raw, '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-ar', String(SAMPLE_RATE), '-ac', '1', out]);
  } finally {
    rmSync(raw, { force: true });
  }
}

export interface ProbeInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  bitRate: number;
  durationMs: number;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate:format=duration', '-of', 'json', file]);
  const data = JSON.parse(stdout.toString('utf8')) as { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  const s = data.streams?.[0] ?? {};
  return {
    codec: String(s.codec_name ?? ''),
    sampleRate: Number(s.sample_rate ?? 0),
    channels: Number(s.channels ?? 0),
    bitRate: Number(s.bit_rate ?? 0),
    durationMs: Math.round(Number(data.format?.duration ?? 0) * 1000),
  };
}
