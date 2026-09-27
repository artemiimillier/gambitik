/**
 * Human- and LLM-readable files under DATA_DIR. SQLite is the operational truth; these files are
 * derived from it and rewritten as a whole, always atomically (tmp file + rename in the same
 * directory) because a parent or an LLM may be reading them at any moment.
 *
 *   data/games/YYYY/MM/YYYY-MM-DD_HHMM_vs-<persona>.pgn | .md | .json (the machine twin, see gameData.ts)
 *   data/student/profile.md
 *   data/student/progress.json
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { PersonaId } from '@gambit/shared';

/** Journals and the profile carry a child's words: owner-only files in owner-only directories. */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await open(tmp, 'w', PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-time parts: the files are named the way the family remembers the game. */
export function localDateParts(iso: string): { yyyy: string; mm: string; dd: string; hh: string; min: string } {
  const parsed = new Date(iso);
  const d = Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
  return {
    yyyy: String(d.getFullYear()),
    mm: pad2(d.getMonth() + 1),
    dd: pad2(d.getDate()),
    hh: pad2(d.getHours()),
    min: pad2(d.getMinutes()),
  };
}

export interface DataPaths {
  dataDir: string;
  appDb: string;
  gamesDir: string;
  studentDir: string;
  profileMd: string;
  progressJson: string;
}

export function dataPaths(dataDir: string): DataPaths {
  const studentDir = join(dataDir, 'student');
  return {
    dataDir,
    appDb: join(dataDir, 'app.sqlite'),
    gamesDir: join(dataDir, 'games'),
    studentDir,
    profileMd: join(studentDir, 'profile.md'),
    progressJson: join(studentDir, 'progress.json'),
  };
}

/**
 * Picks a free `games/YYYY/MM/YYYY-MM-DD_HHMM_vs-<persona>` base (relative to DATA_DIR, POSIX
 * separators). Two games in the same minute get the suffixes `_2`, `_3`, …
 */
export function allocateGameFileBase(dataDir: string, startedAt: string, personaId: PersonaId, taken: (base: string) => boolean = () => false): string {
  const p = localDateParts(startedAt);
  const stem = `games/${p.yyyy}/${p.mm}/${p.yyyy}-${p.mm}-${p.dd}_${p.hh}${p.min}_vs-${personaId}`;
  for (let n = 1; n < 1000; n += 1) {
    const base = n === 1 ? stem : `${stem}_${n}`;
    const abs = resolveDataFile(dataDir, base);
    if (!taken(base) && !existsSync(`${abs}.pgn`) && !existsSync(`${abs}.md`) && !existsSync(`${abs}.json`)) return base;
  }
  return `${stem}_${randomBytes(3).toString('hex')}`;
}

/** Absolute path of a DATA_DIR-relative POSIX path; refuses to leave DATA_DIR. */
export function resolveDataFile(dataDir: string, relativePosixPath: string): string {
  const abs = join(dataDir, ...relativePosixPath.split('/'));
  const rel = relative(dataDir, abs);
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`path escapes the data directory: ${relativePosixPath}`);
  }
  return abs;
}

// ───────────────────────── protected parent block ─────────────────────────

export const PARENT_NOTES_START = '<!-- parent-notes:start -->';
export const PARENT_NOTES_END = '<!-- parent-notes:end -->';

export const DEFAULT_PARENT_NOTES = `
## Заметки родителя

_Пишите здесь что угодно: наблюдения, договорённости, планы. Программа никогда не изменяет текст между этими двумя отметками._
`;

/**
 * Returns the text between the markers (exclusive), or null when the block is missing or broken.
 *
 * The real block is always the LAST thing in a generated file, so the LAST start marker paired with
 * the LAST end marker is taken: a marker that slipped into the body (a child's words,
 * an LLM review) can then never make the "parent notes" swallow the rest of the old file. Generated
 * text is additionally neutralised by `neutraliseMarkers` / `mdInline`.
 */
export function extractParentNotes(markdown: string | null): string | null {
  if (markdown === null) return null;
  const end = markdown.lastIndexOf(PARENT_NOTES_END);
  if (end < 0) return null;
  const start = markdown.lastIndexOf(PARENT_NOTES_START, end);
  if (start < 0) return null;
  return markdown.slice(start + PARENT_NOTES_START.length, end);
}

/**
 * Makes generated text unable to carry an HTML comment — and therefore any of our block markers
 * (`<!-- parent-notes:start -->`, `<!-- review:start -->`, …). `<!--` becomes `&lt;!--`, which a
 * markdown viewer shows as the literal characters.
 */
export function neutraliseMarkers(text: string): string {
  return text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

export function parentNotesBlock(existing: string | null): string {
  // the parent's own text is kept verbatim — except that it cannot contain the markers themselves
  const inner = (existing ?? DEFAULT_PARENT_NOTES).replaceAll(PARENT_NOTES_START, '').replaceAll(PARENT_NOTES_END, '');
  return `${PARENT_NOTES_START}${inner}${PARENT_NOTES_END}`;
}

/**
 * Serialises file writes: read-modify-write of files with a protected block must not interleave
 * (a finished review and a newly saved game may both want to rewrite profile.md).
 */
export class WriteChain {
  private tail: Promise<void> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
