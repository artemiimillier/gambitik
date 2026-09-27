/**
 * Constants of the «Записи» clip library tools (docs/voice-clips/SPEC.md §4, §5.3, §10). Node-only, no side effects.
 *
 * Every number here is a measured or specified value — change it only together with the SPEC:
 *  - voice: Higgsfield text2speech_v2 / minimax / preset «Giselle» → voiceKey `giselle-mm1`;
 *  - pricing: 0.15 credits per started 50 characters (Unicode code points, tags included), per job;
 *  - processing: −18 LUFS / −1.5 dBTP, trim at −55 dBFS keeping 30 / 60 ms, tag silences ≥ 550 ms, tempo 4.0 ± 0.6 syl/s.
 */
import os from 'node:os';
import path from 'node:path';
import { repoPath } from '../lib/cli.ts';

export const VOICE_KEY = 'giselle-mm1';

/** What the manifest records about the voice and exactly what `generate create` sends. */
export const VOICE = {
  provider: 'higgsfield',
  model: 'text2speech_v2',
  variant: 'minimax',
  voiceType: 'preset',
  voiceId: '9d3128b8-dd25-5158-9bdb-2e69ac8998b9',
  name: 'Giselle',
} as const;

// ── Pricing and prompt limits (SPEC §10, §10.1) ──────────────────────────────────────────────────────────

/** Credits are counted in integer milli-credits so sums never drift (0.15 = 150). */
export const MILLI_PER_BUCKET = 150;
export const CHARS_PER_BUCKET = 50;
/** A prompt longer than this is refused before any call (SPEC §10: «reject empty or > 480-char prompts»). */
export const MAX_PROMPT_CHARS = 480;

// ── Generation protocol (SPEC §10 «Spend protocol») ──────────────────────────────────────────────────────────────

export const RATE_LIMIT_MARKER = 'rate_limit_reached';
export const BACKOFF_FIRST_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
/** Total create attempts for one job while the account is rate-limited. */
export const MAX_CREATE_TRIES = 8;
/** A job key whose jobs failed (not charged) this many times is not re-created again automatically. */
export const MAX_FAILED_PER_KEY = 2;
/** How many recent audio jobs the duplicate check reads (`generate list --audio --json --size N`). */
export const LIST_PAGE_SIZE = 50;
export const WAIT_TIMEOUT = '10m';
/** `generate wait --interval`: the job is done in ≈ 5 s, polling every second saves the child ≈ 2 s. */
export const WAIT_INTERVAL = '1s';
/** The machine-wide generator lock file (inside the overlay folder): one generator per Higgsfield account at a time. */
export const GLOBAL_LOCK = 'higgsfield.lock';
/** How long `voice:generate` waits for the server to finish its phrase before it gives up (the server holds ≈ 5 s). */
export const GLOBAL_LOCK_WAIT_MS = 60_000;
/**
 * The overlay's publish lock file (inside the overlay folder): one writer of its unit store and manifest at a time —
 * the server's finish or the operator's `voice:process` / `voice:verify --overlay`.
 */
export const PUBLISH_LOCK = 'publish.lock';
/** How long an overlay `process` / `verify` waits for the server's finish (process 60 s + verify 90 s at most). */
export const PUBLISH_LOCK_WAIT_MS = 180_000;
/** How often a waiting generator looks at a held lock again. */
export const LOCK_POLL_MS = 500;

// ── Audio processing (SPEC §5.3, §10, §10.1) ─────────────────────────────────────────────────

export const SAMPLE_RATE = 32_000;
export const TARGET_LUFS = -18;
export const TARGET_TRUE_PEAK = -1.5;
/** Anything quieter is silence: the floor is −66 dBFS, word-final «ф»/«ть» sit at −36…−50 (never trim at −45). */
export const SILENCE_DB = -55;
/** The tag `<#0.6#>` gives ≈ 730–790 ms of silence; natural pauses inside a line stay below this. */
export const TAG_SILENCE_MS = 550;
export const KEEP_BEFORE_MS = 30;
export const KEEP_AFTER_MS = 60;
export const FADE_MS = 5;
/** Inner pauses of slot units («эф | шесть» got 110–230 ms in isolation) longer than this are clamped … */
export const SLOT_PAUSE_MAX_MS = 120;
/** … to this length. */
export const SLOT_PAUSE_CLAMP_MS = 60;
/** Articulation-rate gate: 4.0 ± 0.6 syllables per second of speech. */
export const TEMPO_TARGET = 4.0;
export const TEMPO_TOLERANCE = 0.6;
/** Out-of-band takes are pulled to just inside the band (least `atempo` change), never further. */
export const TEMPO_PULL_MARGIN = 0.1;
export const ATEMPO_MIN = 0.8;
export const ATEMPO_MAX = 1.3;
/** Units with fewer syllables (barks, «Хм…») skip the tempo gate. */
export const TEMPO_MIN_SYLLABLES = 3;
/** Pauses at least this long do not count as articulation time. */
export const TEMPO_PAUSE_MS = 100;
/** A unit that ends in a fall (slot units, lines ending in «.») must end at or below this F0. */
export const EDGE_F0_MAX_HZ = 190;
/** After this many recordings of the same unit, an out-of-band take is kept (flagged for a listener's ear). */
export const MAX_TEMPO_RENDERS = 3;
/** Per-unit loudness correction is skipped when the unit is already this close to the target. */
export const LOUDNESS_SLACK_DB = 0.3;

// ── Output format (SPEC §4.1) ────────────────────────────────────────────────────────────────────────────────────

export const CODEC = { c: 'mp3', kbps: 48, hz: SAMPLE_RATE, ch: 1 } as const;
export const LOUDNESS = { lufs: TARGET_LUFS, truePeak: TARGET_TRUE_PEAK } as const;
/** tools warn when the shipped library grows past this (SPEC §4.1). */
export const LIBRARY_WARN_BYTES = 60 * 1024 * 1024;

// ── Runtime gap table (SPEC §5.3), used by the offline review renders ───────────────────────────────────────────────

export const GAP_MS = { '.': 450, '!': 450, '?': 500, '—': 280, ':': 240, ';': 260, split: 250, bark: 200 } as const;
export type GapKind = keyof typeof GAP_MS;
export const GAP_JITTER_MS = 30;

// ── Verify gates (SPEC §10 `verify`) ────────────────────────────────────────────────────────────────────────────────

export const MS_PER_CHAR_MIN = 55;
export const MS_PER_CHAR_MAX = 140;
/** The duration-per-character gate needs enough characters to mean anything («Ого!» is naturally long per char). */
export const MS_PER_CHAR_MIN_CHARS = 8;
export const PEAK_MAX_DBFS = -1.0;
export const F0_MEDIAN_MIN_HZ = 140;
export const F0_MEDIAN_MAX_HZ = 480;
export const LUFS_TOLERANCE = 1.0;

// ── The overlay's QA rule («Дозапись голоса», design-audio §3): hard gates keep a take out, soft flags only put it
//    first on the review page. The static library keeps the strict rule above (`isPublishable`). ─────────────────

/** Hard band of the speaking rate after `atempo` (syl/s); outside the strict 3.4–4.6 but inside this = a soft flag. */
export const OVERLAY_TEMPO_MIN = 3.2;
export const OVERLAY_TEMPO_MAX = 5.4;
/** A lead whose end F0 is above this is published `ctx: 'cont'` (played only right before its tail). */
export const CONT_F0_HZ = 210;
/** A unit this far from −18 LUFS is re-gained when encoded (not flagged); further off is a hard gate. */
export const REGAIN_MAX_LU = 2.5;
/** A pack whose tag split found the wrong count is re-cut for free at its longest pauses ≥ this (ASR checks each piece). */
export const RECUT_MIN_SILENCE_MS = 250;
/** Units of at most this many words pass ASR at a lower similarity (the piece word is still required). */
export const SHORT_UNIT_WORDS = 2;
export const ASR_SHORT_MIN_SCORE = 0.75;

// ── Paths ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const TOOL_DIR = repoPath('tools', 'voice-clips');
export const DEFAULT_LEDGER = path.join(TOOL_DIR, `ledger.${VOICE_KEY}.jsonl`);
export const DEFAULT_UNITS = path.join(TOOL_DIR, `units.${VOICE_KEY}.json`);
export const DEFAULT_REVIEW = path.join(TOOL_DIR, `review.${VOICE_KEY}.json`);
export const DEFAULT_REPORT = path.join(TOOL_DIR, `process-report.${VOICE_KEY}.json`);
export const DEFAULT_MASTERS = path.join(TOOL_DIR, '.masters');
export const DEFAULT_WORK = path.join(os.tmpdir(), 'gambit-voice-clips');
/** Library root served by Vite / Hono (`apps/web/public/voice`), never `dist/` and never `data/`. */
export const DEFAULT_LIBRARY = repoPath('apps', 'web', 'public', 'voice');
/**
 * «Дозапись голоса»: the one overlay folder of this Mac (outside every checkout, so a `git clean` never deletes paid
 * audio and every checkout shares one ledger, one budget and one lock). `VOICE_OVERLAY_DIR` overrides it (`off` = none).
 */
export const DEFAULT_OVERLAY_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Gambitik', 'voice-overlay');
export const DEFAULT_REVIEW_PAGE_DIR = repoPath('test-results', 'voice-review');

// ── Speech recognition (whisper.cpp; the model lives outside the repository) ────────────────────────────────────────

export const WHISPER_BIN = 'whisper-cli';
/** Multilingual «small» (466 MiB) from huggingface.co/ggerganov/whisper.cpp; checksums as published there. */
export const WHISPER_MODEL = {
  file: 'ggml-small.bin',
  bytes: 487_601_967,
  sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  sha1: '55356645c2b361a969dfd0ef2c5a50d530afd8d5',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
} as const;
export const DEFAULT_WHISPER_MODEL = path.join(os.homedir(), '.cache', 'gambitik', 'whisper', WHISPER_MODEL.file);
