/**
 * The jobs file: WHAT `generate` records. It is written by the catalogue/script step (`voice:script` / `voice:plan`)
 * and read here; this module only defines and validates the contract, so the paid path never depends on the
 * catalogue code.
 *
 * ```json
 * { "v": 1, "voiceKey": "giselle-mm1", "campaign": "pilot",
 *   "jobs": [ { "prompt": "Ого!<#0.6#>Смотри, тут подарок!", "take": 1, "recipe": "whole",
 *               "pieces": [ { "key": "line:bark.wow#1", "text": "Ого!", "pool": "bark.wow", "kind": "bark" },
 *                           { "key": "line:treasure.look#1", "text": "Смотри, тут подарок!", "pool": "treasure.look" } ] } ] }
 * ```
 *
 * One job = one paid Higgsfield call. `pieces` lists, in spoken order, what the audio splits into: units to keep and
 * carrier parts to throw away (`{ "discard": true }`, e.g. the dummy slot of a head recipe). The split is at tag
 * silences (`split.mode: "tags"`, every gap ≥ 550 ms, count must match) or at the longest pauses (`"longest"`, for a
 * head cut at its natural dash pause).
 */
import { readFileSync } from 'node:fs';
import { VOICE_KEY } from './config.ts';
import { promptProblem } from './cost.ts';
import { jobKey } from './ids.ts';

export type Recipe = 'whole' | 'head' | 'tail' | 'slot-batch' | 'slot-carrier' | 'single' | 'bark' | 'pack';
export type UnitKind = 'line' | 'slot' | 'frag' | 'bark';
/** `fall`: the unit must end low (slot units, lines ending in «.»); `any`: no edge check. */
export type UnitEnd = 'fall' | 'any';

export interface UnitPiece {
  /** Manifest key, e.g. `line:teach.head.advice#1`, `slot:ins:n:f6`, `frag:f:смотри, тут подарок|!`. */
  key: string;
  /** The words of this piece exactly as spoken (no pause tags); the ASR check compares against it. */
  text: string;
  /** Catalogue pool (line id) this take belongs to, e.g. `teach.head.advice`. */
  pool?: string;
  /**
   * Every pool the take serves, when more than its own (`CatalogUnit.pools`): a plain wording of a `byPiece` line joins
   * every piece pool («— и сразу в атаку!» is also `reason.attack@n`), a wording without `{g:…}` both gender pools.
   */
  pools?: string[];
  mood?: string;
  tier?: string;
  kind?: UnitKind;
  end?: UnitEnd;
  /** false: skip the tempo gate (interjections, deliberately slow lines). */
  tempo?: boolean;
  /**
   * «Дозапись голоса» (the lesson model, core `TtsPartRole`): how the part is said in its sentence. A `lead` / `leadAlone`
   * take whose end does not fall (F0 > 210 Hz) is published `ctx: 'cont'` (only before its tail) under the overlay rule.
   */
  role?: PartRole;
  /** words a placeholder produced ({конём}, {g:сам|сама}, …): the overlay's ASR check must hear each of them, in order */
  critical?: string[];
}

/** How a lesson-v3 part is said (the same names as core `TtsPartRole`). */
export type PartRole = 'whole' | 'lead' | 'leadAlone' | 'tail' | 'frag';
export const PART_ROLES: readonly PartRole[] = ['whole', 'lead', 'leadAlone', 'tail', 'frag'];

export interface DiscardPiece {
  discard: true;
  text?: string;
}

export type Piece = UnitPiece | DiscardPiece;

export interface SplitRule {
  mode: 'tags' | 'longest';
  minSilenceMs: number;
}

export interface GenJob {
  /** Exactly what is sent to Higgsfield (pause tags included). */
  prompt: string;
  /** 1-based; a re-render of the same prompt is a new take. */
  take: number;
  recipe: Recipe;
  pieces: Piece[];
  split?: SplitRule;
  tier?: string;
  priority?: number;
  batch?: string;
}

export interface JobsFile {
  v: 1;
  voiceKey: string;
  campaign: string;
  jobs: GenJob[];
}

export class JobsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobsFileError';
  }
}

export function isDiscard(piece: Piece): piece is DiscardPiece {
  return (piece as DiscardPiece).discard === true;
}

export function keyOfJob(job: Pick<GenJob, 'prompt' | 'take'>, voiceKey: string = VOICE_KEY): string {
  return jobKey(voiceKey, job.prompt, job.take);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RECIPES: readonly Recipe[] = ['whole', 'head', 'tail', 'slot-batch', 'slot-carrier', 'single', 'bark', 'pack'];
const CAMPAIGN_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Validates one job; returns the list of problems (empty when fine). */
export function jobProblems(job: unknown): string[] {
  if (!isRecord(job)) return ['job is not an object'];
  const problems: string[] = [];
  const prompt = promptProblem(job.prompt);
  if (prompt !== null) problems.push(prompt);
  if (!Number.isInteger(job.take) || (job.take as number) < 1) problems.push('take must be an integer ≥ 1');
  if (!RECIPES.includes(job.recipe as Recipe)) problems.push(`unknown recipe ${String(job.recipe)}`);
  if (!Array.isArray(job.pieces) || job.pieces.length === 0) problems.push('pieces must be a non-empty array');
  else {
    let units = 0;
    for (const piece of job.pieces as unknown[]) {
      if (!isRecord(piece)) problems.push('piece is not an object');
      else if (piece.discard === true) continue;
      else if (typeof piece.key !== 'string' || piece.key === '') problems.push('piece without key');
      else if (typeof piece.text !== 'string' || piece.text.trim() === '') problems.push(`piece ${piece.key} without text`);
      else if (piece.pools !== undefined && (!Array.isArray(piece.pools) || piece.pools.some((x) => typeof x !== 'string' || x === ''))) problems.push(`piece ${piece.key}: pools must be a list of pool names`);
      else if (piece.role !== undefined && !PART_ROLES.includes(piece.role as PartRole)) problems.push(`piece ${piece.key}: unknown role ${String(piece.role)}`);
      else if (piece.critical !== undefined && (!Array.isArray(piece.critical) || piece.critical.some((x) => typeof x !== 'string' || x.trim() === ''))) problems.push(`piece ${piece.key}: critical must be a list of words`);
      else units++;
    }
    if (units === 0) problems.push('job keeps no unit');
  }
  if (job.split !== undefined) {
    const split = job.split;
    if (!isRecord(split) || (split.mode !== 'tags' && split.mode !== 'longest') || typeof split.minSilenceMs !== 'number' || split.minSilenceMs < 40) {
      problems.push('split must be { mode: "tags" | "longest", minSilenceMs ≥ 40 }');
    }
  }
  return problems;
}

export function parseJobsFile(raw: unknown): JobsFile {
  if (!isRecord(raw)) throw new JobsFileError('jobs file is not a JSON object');
  if (raw.v !== 1) throw new JobsFileError(`unsupported jobs file version ${String(raw.v)}`);
  if (raw.voiceKey !== VOICE_KEY) throw new JobsFileError(`jobs file is for voice ${String(raw.voiceKey)}, this tool records ${VOICE_KEY}`);
  if (typeof raw.campaign !== 'string' || !CAMPAIGN_RE.test(raw.campaign)) throw new JobsFileError('campaign must be a short lowercase name such as "pilot"');
  if (!Array.isArray(raw.jobs)) throw new JobsFileError('jobs must be an array');
  const seen = new Set<string>();
  raw.jobs.forEach((job: unknown, index: number) => {
    const problems = jobProblems(job);
    if (problems.length > 0) throw new JobsFileError(`job #${index + 1}: ${problems.join('; ')}`);
    const key = keyOfJob(job as GenJob);
    if (seen.has(key)) throw new JobsFileError(`job #${index + 1}: the same prompt and take appear twice (bump "take" for a second take)`);
    seen.add(key);
  });
  return raw as unknown as JobsFile;
}

export function readJobsFile(file: string): JobsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new JobsFileError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseJobsFile(raw);
}
