/**
 * «Дозапись голоса» configuration (docs/voice-clips/ONDEMAND.md): everything off by default, money in milli-credits with
 * clamps, the overlay only outside every checkout, DATA_DIR and the web build, and the Higgsfield CLI never looked up
 * under vitest.
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIP_GEN_BUDGET_MAX_MILLI,
  CLIP_GEN_DAILY_DEFAULT_MILLI,
  CLIP_GEN_DAILY_MIN_MILLI,
  dataDirPinned,
  defaultOverlayDir,
  findHiggsfieldBinary,
  loadConfig,
  overlayDirProblem,
  parseClipGenConfig,
} from '../config.ts';
import { tempDir } from './testkit.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const REPO = join(import.meta.dirname, '..', '..', '..', '..');

function places(dataDir: string) {
  return { repoRoot: REPO, dataDir, webDistDir: join(REPO, 'apps', 'web', 'dist') };
}

function fakeBin(dir: string): string {
  const bin = join(dir, 'higgsfield');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  return bin;
}

describe('GAMBIT_CLIP_GEN and friends', () => {
  it('is off by default: no flag, no budget, the default daily max, no pin, no CLI, no overlay under vitest', () => {
    const cfg = loadConfig({}, { codexBin: null }).clipGen;
    expect(cfg).toEqual({ enabled: false, budgetMilli: 0, dailyMaxMilli: CLIP_GEN_DAILY_DEFAULT_MILLI, dataDirPin: null, bin: null, overlayDir: null, overlayProblem: null });
  });

  it('reads credits as milli-credits and clamps them', () => {
    const data = tempDir('gambit-cfg-data-', cleanups);
    const parse = (env: NodeJS.ProcessEnv) => parseClipGenConfig(env, places(data));
    expect(parse({ GAMBIT_CLIP_GEN: '1', CLIP_GEN_BUDGET: '60', CLIP_GEN_DAILY_MAX: '15' })).toMatchObject({ enabled: true, budgetMilli: 60_000, dailyMaxMilli: 15_000 });
    expect(parse({ CLIP_GEN_BUDGET: '0,75', CLIP_GEN_DAILY_MAX: '0.05' })).toMatchObject({ budgetMilli: 750, dailyMaxMilli: 150 });
    expect(parse({ CLIP_GEN_DAILY_MAX: '99' }).dailyMaxMilli).toBe(30_000);
    expect(parse({ CLIP_GEN_BUDGET: '100000' }).budgetMilli).toBe(CLIP_GEN_BUDGET_MAX_MILLI);
    for (const bad of ['', '0', '-5', 'много', '1e3', ' 3 кредита']) expect(parse({ CLIP_GEN_BUDGET: bad }).budgetMilli, bad).toBe(0);
    for (const bad of ['', '-5', 'много', '1e3', ' 3 кредита']) expect(parse({ CLIP_GEN_DAILY_MAX: bad }).dailyMaxMilli, bad).toBe(CLIP_GEN_DAILY_DEFAULT_MILLI);
    // «0» is the owner stopping the daily spend: the floor (one job a day), never the 3-credit default
    for (const zero of ['0', '0.0', '0,00']) expect(parse({ CLIP_GEN_DAILY_MAX: zero }).dailyMaxMilli, zero).toBe(CLIP_GEN_DAILY_MIN_MILLI);
    for (const on of ['1', 'true', 'on']) expect(parse({ GAMBIT_CLIP_GEN: on }).enabled).toBe(true);
    for (const off of ['0', 'false', 'off', 'maybe']) expect(parse({ GAMBIT_CLIP_GEN: off }).enabled).toBe(false);
  });

  it('pins DATA_DIR only by an absolute path, compared through symlinks', () => {
    const data = tempDir('gambit-cfg-data-', cleanups);
    const link = join(tempDir('gambit-cfg-link-', cleanups), 'data');
    symlinkSync(data, link);
    expect(parseClipGenConfig({ CLIP_GEN_DATA_DIR: 'data' }, places(data)).dataDirPin).toBeNull();
    const pin = parseClipGenConfig({ CLIP_GEN_DATA_DIR: link }, places(data));
    expect(dataDirPinned(pin, data)).toBe(true);
    expect(dataDirPinned(pin, tempDir('gambit-cfg-other-', cleanups))).toBe(false);
    expect(dataDirPinned({ dataDirPin: null }, data)).toBe(false);
  });

  it('never looks the Higgsfield CLI up under vitest; an explicit path or `off` is honoured', () => {
    const dir = tempDir('gambit-cfg-bin-', cleanups);
    const bin = fakeBin(dir);
    // a fake `higgsfield` first on PATH and in ~/.local/bin: still not found under vitest (the real one lives there)
    mkdirSync(join(dir, '.local', 'bin'), { recursive: true });
    fakeBin(join(dir, '.local', 'bin'));
    expect(process.env.VITEST).toBeTruthy();
    expect(findHiggsfieldBinary({ PATH: dir, HOME: dir })).toBeNull();
    expect(findHiggsfieldBinary({ PATH: dir, HOME: dir, VITEST: undefined })).toBeNull();
    expect(findHiggsfieldBinary({ HIGGSFIELD_BIN: bin })).toBe(bin);
    expect(findHiggsfieldBinary({ HIGGSFIELD_BIN: 'off', PATH: dir })).toBeNull();
    expect(findHiggsfieldBinary({ HIGGSFIELD_BIN: 'higgsfield' })).toBeNull();
    expect(findHiggsfieldBinary({ HIGGSFIELD_BIN: join(dir, 'missing') })).toBeNull();
    // with the flag off the CLI is not even looked for
    const data = tempDir('gambit-cfg-data-', cleanups);
    expect(parseClipGenConfig({ HIGGSFIELD_BIN: bin }, places(data)).bin).toBeNull();
    expect(parseClipGenConfig({ GAMBIT_CLIP_GEN: '1', HIGGSFIELD_BIN: bin }, places(data)).bin).toBe(bin);
  });

  it('the overlay: the default only outside vitest, `off`, absolute paths outside checkouts, DATA_DIR and the build', () => {
    const data = tempDir('gambit-cfg-data-', cleanups);
    const outside = tempDir('gambit-cfg-overlay-', cleanups);
    expect(defaultOverlayDir({ HOME: '/Users/x' })).toBe('/Users/x/Library/Application Support/Gambitik/voice-overlay');
    expect(defaultOverlayDir({})).toBe(join(homedir(), 'Library', 'Application Support', 'Gambitik', 'voice-overlay'));
    const parse = (value: string | undefined) => parseClipGenConfig({ VOICE_OVERLAY_DIR: value }, places(data));
    expect(parse(undefined)).toMatchObject({ overlayDir: null, overlayProblem: null });
    expect(parse('off')).toMatchObject({ overlayDir: null, overlayProblem: null });
    expect(parse(join(outside, 'voice-overlay'))).toMatchObject({ overlayDir: join(outside, 'voice-overlay'), overlayProblem: null });
    expect(parse('voice-overlay')).toMatchObject({ overlayDir: null, overlayProblem: 'relative' });
    expect(parse(join(REPO, 'voice-overlay'))).toMatchObject({ overlayDir: null, overlayProblem: 'repo' });
    expect(parse(join(REPO, 'apps', 'web', 'public', 'voice'))).toMatchObject({ overlayProblem: 'repo' });
    expect(parse(join(data, 'overlay'))).toMatchObject({ overlayProblem: 'data' });
    // around a checkout or DATA_DIR is as bad as inside
    expect(overlayDirProblem('/', places(data))).toBe('repo');
    expect(overlayDirProblem(join(data, '..'), { ...places(data), repoRoot: '/nonexistent/repo' })).toBe('data');
    // any git checkout, not only this one; a symlink into it does not help
    const other = tempDir('gambit-cfg-repo-', cleanups);
    mkdirSync(join(other, '.git'));
    expect(overlayDirProblem(join(other, 'a', 'b'), places(data))).toBe('repo');
    const link = join(outside, 'sneaky');
    symlinkSync(REPO, link);
    expect(overlayDirProblem(join(link, 'voice-overlay'), places(data))).toBe('repo');
    const dist = tempDir('gambit-cfg-dist-', cleanups);
    expect(overlayDirProblem(join(dist, 'voice'), { ...places(data), webDistDir: dist })).toBe('dist');
  });

  it('the container layout of deploy/docker-ssh is accepted: /overlay next to /app (no .git in the image) and /data', () => {
    const container = { repoRoot: '/app', dataDir: '/data', webDistDir: '/app/apps/web/dist' };
    expect(overlayDirProblem('/overlay', container)).toBeNull();
    expect(parseClipGenConfig({ VOICE_OVERLAY_DIR: '/overlay', GAMBIT_CLIP_GEN: '0', HIGGSFIELD_BIN: 'off' }, container)).toMatchObject({ enabled: false, bin: null, overlayDir: '/overlay', overlayProblem: null });
    // …while an overlay inside the image's source tree or the data volume is still refused
    expect(overlayDirProblem('/app/overlay', container)).toBe('repo');
    expect(overlayDirProblem('/data/overlay', container)).toBe('data');
  });
});
