/**
 * What the catalogue adds to the published manifest (web-layer.md §4): a take serves every pool its wording fits
 * (`pools`), the catalogue's L3 siblings (`fallbacks`), barks marked as interjections (`interj`); and the jobs file
 * carries `pools` through validation. Pure: no audio, no files.
 */
import { describe, expect, it } from 'vitest';
import { CLIP_CATALOG, catalogFallbacks, lineKeyText } from '../../packages/core/src/coach/clips/index.ts';
import { repoPath } from '../lib/cli.ts';
import { VOICE_KEY } from './config.ts';
import { jobProblems } from './jobs.ts';
import { buildManifest, readCurrentManifest } from './manifest.ts';
import type { UnitStore } from './manifest.ts';

const unit = (id: string, key: string, extra: Partial<UnitStore['units'][string]> = {}): UnitStore['units'][string] => ({
  id, key, text: '— и сразу в атаку!', take: 1, ms: 900, on: 30, off: 840, file: `${id.slice(1, 3)}/${id}.mp3`, qa: 'asr', jobId: 'j', jobKey: 'k', cut: 0, bytes: 4000, flags: [], processedAt: 't', ...extra,
});

describe('manifest from catalogue units', () => {
  it('lists a plain wording of a byPiece line in every piece pool it serves', () => {
    const store: UnitStore = {
      v: 1,
      voiceKey: VOICE_KEY,
      units: {
        c00000000000a1: unit('c00000000000a1', 'line:reason.attack#5', { pool: 'reason.attack', pools: ['reason.attack', 'reason.attack@n', 'reason.attack@q'] }),
        c00000000000a2: unit('c00000000000a2', 'line:reason.attack@n#1', { pool: 'reason.attack@n', text: '— нападаешь на коня!' }),
      },
    };
    const m = buildManifest(store, {}, 1);
    expect(m.pools['reason.attack']).toEqual(['c00000000000a1']);
    expect(m.pools['reason.attack@n']).toEqual(['c00000000000a1', 'c00000000000a2']);
    expect(m.pools['reason.attack@q']).toEqual(['c00000000000a1']);
    // (the tools-only fields stay out of the published units)
    expect(Object.keys(m.units.c00000000000a1 as object)).not.toContain('pools');
  });

  it('carries the catalogue fallbacks and marks barks as interjections', () => {
    const store: UnitStore = { v: 1, voiceKey: VOICE_KEY, units: { c00000000000b1: unit('c00000000000b1', 'line:bark.cheer#1', { text: 'Ого!', pool: 'bark.cheer', kind: 'bark' }) } };
    const m = buildManifest(store, {}, 1);
    expect(m.fallbacks).toEqual(catalogFallbacks(CLIP_CATALOG));
    expect(m.fallbacks['teach.head.good']).toBe('teach.head.arrow');
    expect(m.units.c00000000000b1?.interj).toBe(true);
  });
});

describe('jobs file: pools', () => {
  const job = (pools: unknown) => ({ prompt: '— и сразу в атаку!', take: 1, recipe: 'whole', pieces: [{ key: 'line:reason.attack#5', text: '— и сразу в атаку!', pools }] });

  it('accepts a list of pool names and refuses anything else', () => {
    expect(jobProblems(job(['reason.attack', 'reason.attack@n']))).toEqual([]);
    expect(jobProblems(job(undefined))).toEqual([]);
    expect(jobProblems(job('reason.attack')).join()).toMatch(/pools/);
    expect(jobProblems(job(['']))).not.toEqual([]);
  });
});

describe('the committed `pilot` library against today\'s catalogue', () => {
  it('every `line:` take still names its words: wordings are appended, never inserted (a number is its recording\'s key)', () => {
    const manifest = readCurrentManifest(repoPath('apps/web/public/voice'));
    expect(manifest).not.toBeNull();
    let lines = 0;
    for (const [key, ids] of Object.entries(manifest?.keys ?? {})) {
      if (!key.startsWith('line:')) continue;
      for (const id of ids) expect(lineKeyText(key), key).toBe(manifest?.units[id]?.text);
      lines++;
    }
    expect(lines).toBeGreaterThan(50);
  });
});
