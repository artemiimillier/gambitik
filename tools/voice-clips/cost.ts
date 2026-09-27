/**
 * The price of a Higgsfield text2speech_v2 job and prompt validation (docs/voice-clips/SPEC.md §10.1, measured with 13 free
 * `generate cost` probes): credits = 0.15 × ⌈chars / 50⌉ per job, chars = Unicode code points (spaces, ё and pause
 * tags such as `<#0.6#>` included). Money is kept in integer milli-credits everywhere.
 */
import { CHARS_PER_BUCKET, MAX_PROMPT_CHARS, MILLI_PER_BUCKET } from './config.ts';

/** Unicode code points (what Higgsfield counts), not UTF-16 units and not bytes. */
export function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function jobMilli(prompt: string): number {
  const chars = codePoints(prompt);
  return chars === 0 ? 0 : MILLI_PER_BUCKET * Math.ceil(chars / CHARS_PER_BUCKET);
}

export function milliToCredits(milli: number): number {
  return Math.round(milli) / 1000;
}

export function creditsToMilli(credits: number): number {
  return Math.round(credits * 1000);
}

/** «0.15», «13.5», «0» — for logs and reports. */
export function fmtCredits(milli: number): string {
  return String(milliToCredits(milli));
}

/**
 * Why a prompt must not be sent, or null when it is fine. Refused: empty or whitespace-only text (an empty prompt
 * creates a failed job), anything over 480 characters, control characters, and unbalanced pause tags.
 */
export function promptProblem(prompt: unknown): string | null {
  if (typeof prompt !== 'string') return 'prompt is not a string';
  if (prompt.trim() === '') return 'empty prompt';
  const chars = codePoints(prompt);
  if (chars > MAX_PROMPT_CHARS) return `prompt has ${chars} characters (max ${MAX_PROMPT_CHARS})`;
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(prompt)) return 'prompt contains control characters';
  const withoutTags = prompt.replace(/<#\d+(?:\.\d+)?#>/g, '');
  if (/<#|#>/.test(withoutTags)) return 'malformed pause tag (expected <#0.6#>)';
  if (withoutTags.replace(/[\s.,!?…:;—–-]/g, '') === '') return 'prompt has no words';
  return null;
}
