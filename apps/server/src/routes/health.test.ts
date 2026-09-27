import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthInfo } from '@gambit/shared';
import { createTestServer } from '../testing/fixtures.ts';
import type { TestServer } from '../testing/fixtures.ts';
import { isTempDir, readGitSha } from './health.ts';

const servers: TestServer[] = [];
const dirs: string[] = [];

async function start(...args: Parameters<typeof createTestServer>): Promise<TestServer> {
  const server = await createTestServer(...args);
  servers.push(server);
  return server;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function health(server: TestServer): Promise<HealthInfo> {
  return (await (await server.request('/api/health')).json()) as HealthInfo;
}

afterEach(async () => {
  vi.useRealTimers();
  while (servers.length > 0) await servers.pop()?.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('readGitSha — the commit the server runs, read from .git without a git process', () => {
  it('reads a branch ref: loose first, then packed-refs', () => {
    const repo = tempDir('gambit-git-');
    mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(repo, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${'f'.repeat(40)} refs/heads/main\n`);
    expect(readGitSha(repo)).toBe('fffffff');
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${SHA}\n`);
    expect(readGitSha(repo)).toBe('0123456');
  });

  it('reads a detached HEAD and a worktree (.git file → gitdir, refs in the common dir)', () => {
    const repo = tempDir('gambit-git-');
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), `${SHA}\n`);
    expect(readGitSha(repo)).toBe('0123456');

    const main = tempDir('gambit-git-main-');
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(join(main, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(main, '.git', 'refs', 'heads', 'feature'), `${'a'.repeat(40)}\n`);
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature\n');
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const worktree = tempDir('gambit-git-wt-');
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    expect(readGitSha(worktree)).toBe('aaaaaaa');
  });

  it('is null outside a checkout and on anything odd (never follows a ref out of .git)', () => {
    expect(readGitSha(tempDir('gambit-nogit-'))).toBeNull();
    const repo = tempDir('gambit-git-');
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/../../secret\n');
    expect(readGitSha(repo)).toBeNull();
    writeFileSync(join(repo, '.git', 'HEAD'), 'garbage\n');
    expect(readGitSha(repo)).toBeNull();
  });
});

describe('isTempDir — only a throw-away DATA_DIR lets the smoke scripts write a profile / games', () => {
  it('a folder under the OS temp dir (also through a symlink into it) is temp; the repository data/ is not', () => {
    const temp = tempDir('gambit-data-');
    expect(isTempDir(temp)).toBe(true);
    expect(isTempDir(join(temp, 'not-created-yet'))).toBe(true);
    expect(isTempDir('/private/tmp/some-session/some-data')).toBe(true);
    expect(isTempDir('/Users/someone/Chess/data')).toBe(false);
    // a prefix is not a parent: /tmpfoo is not inside /tmp
    expect(isTempDir('/tmpfoo/data', ['/tmp'])).toBe(false);
    expect(isTempDir('/tmp', ['/tmp'])).toBe(false);
  });

  it('resolves symlinks: a link in a temp folder that points at a real folder is NOT temp', () => {
    const temp = tempDir('gambit-link-');
    const elsewhere = tempDir('gambit-real-');
    symlinkSync(elsewhere, join(temp, 'data'));
    // (the roots are given: only `temp` counts as throw-away here, `elsewhere` stands for the child's real folder)
    expect(isTempDir(join(temp, 'data'), [temp])).toBe(false);
    expect(isTempDir(join(temp, 'fresh'), [temp])).toBe(true);
  });
});

describe('GET /api/health — build, temp DATA_DIR, activity', () => {
  it('tells which code runs: the commit at start, the start time, the build time of the served bundle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    const server = await start();
    const before = await health(server);
    expect(before.build?.startedAt).toBe('2026-09-23T10:00:00.000Z');
    expect(before.build?.distBuiltAt).toBeNull();
    expect(before.build?.gitSha === null || /^[0-9a-f]{7}$/.test(before.build?.gitSha ?? '')).toBe(true);
    // a bundle appears (the launcher rebuilt it): its time is read on every request
    mkdirSync(server.ctx.config.webDistDir, { recursive: true });
    const index = join(server.ctx.config.webDistDir, 'index.html');
    writeFileSync(index, '<!doctype html>');
    utimesSync(index, new Date('2026-09-22T17:43:05.000Z'), new Date('2026-09-22T17:43:05.000Z'));
    expect((await health(server)).build?.distBuiltAt).toBe('2026-09-22T17:43:05.000Z');
  });

  it('a container has no .git: the commit its image was built from (GAMBIT_BUILD_SHA) — a checkout still wins', async () => {
    const image = await start({ repoRoot: tempDir('gambit-image-'), buildSha: 'b4d0abe' });
    expect((await health(image)).build?.gitSha).toBe('b4d0abe');
    const none = await start({ repoRoot: tempDir('gambit-image-'), buildSha: null });
    expect((await health(none)).build?.gitSha).toBeNull();
    const repo = tempDir('gambit-git-');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), `${SHA}\n`);
    expect((await health(await start({ repoRoot: repo, buildSha: 'b4d0abe' }))).build?.gitSha).toBe(SHA.slice(0, 7));
  });

  it('reports a temp DATA_DIR (tests run on one) and never a path', async () => {
    const server = await start();
    const text = await (await server.request('/api/health')).text();
    expect((JSON.parse(text) as HealthInfo).dataDirIsTemp).toBe(true);
    expect(text).not.toContain(server.dataDir);
    expect(text).not.toContain(tmpdir());
  });

  it('activity: idle since the last API request that is not a health check; null before the first one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
    const server = await start();
    expect((await health(server)).activity).toEqual({ idleSeconds: null });
    await server.request('/api/student');
    vi.setSystemTime(new Date('2026-09-23T10:04:10.900Z'));
    expect((await health(server)).activity).toEqual({ idleSeconds: 250 });
    // health checks (the launcher, the settings screen) never count as activity
    vi.setSystemTime(new Date('2026-09-23T10:11:40.000Z'));
    expect((await health(server)).activity).toEqual({ idleSeconds: 700 });
    // a voice black-box batch, a strategy request… — somebody is playing
    await server.request('/api/voice/diag', { method: 'POST', json: { page: 'a1b2c3d4-e5f6', events: [{ t: 1, e: 'sess.connected' }] } });
    expect((await health(server)).activity).toEqual({ idleSeconds: 0 });
  });

  it('a request refused by the security middleware (foreign Host) is not activity', async () => {
    const server = await start();
    expect((await server.request('/api/student', { headers: { host: 'evil.example:8787' } })).status).toBe(403);
    expect((await health(server)).activity).toEqual({ idleSeconds: null });
  });
});
