/**
 * Tiny shared helpers for the data tools (argument parsing, number formatting, repo paths).
 * Node-only; no dependencies.
 */
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root (tools/lib/cli.ts → ../..). Independent of process.cwd(). */
export const REPO_ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function repoPath(...segments: string[]): string {
  return path.join(REPO_ROOT, ...segments);
}

/** Path for log output: relative to cwd when inside it, absolute otherwise. */
export function displayPath(file: string): string {
  const rel = path.relative(process.cwd(), file);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
}

export class UsageError extends Error {}

export type OptionSpec = NonNullable<ParseArgsConfig['options']>;

/** `parseArgs` wrapper that turns unknown flags into a UsageError instead of a stack trace. */
export function parseCli<T extends OptionSpec>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false, strict: true }).values;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

export function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} expects a positive integer, got "${value}"`);
  return n;
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

export function fmt(n: number): string {
  return NUMBER_FORMAT.format(n);
}

export function fmtBytes(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }
  return String(err);
}
