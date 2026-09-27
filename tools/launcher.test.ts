/**
 * Шахматы.command (zsh, macOS) — its decisions, run through zsh with fixtures: the version it compares with the
 * running server (the same short commit the server reports in /api/health → build.gitSha), «is this Гамбитик on
 * the port», «is the running server older than the code», «how long has nobody played».
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readGitSha } from '../apps/server/src/routes/health.ts';

const ROOT = resolve(import.meta.dirname, '..');
const LAUNCHER = join(ROOT, 'Шахматы.command');
const hasZsh = spawnSync('zsh', ['-c', 'true']).status === 0;

/** the launcher's shell functions (`name() { … }` blocks), without its top-level code */
function launcherFunctions(): string {
  const text = readFileSync(LAUNCHER, 'utf8');
  return [...text.matchAll(/^[a-z_]+\(\) \{\n[\s\S]*?\n\}$/gm)].map((m) => m[0]).join('\n\n');
}

function zsh(cwd: string, script: string): { status: number | null; out: string } {
  const result = spawnSync('zsh', ['-c', `${launcherFunctions()}\n\n${script}`], { cwd, encoding: 'utf8', timeout: 10_000 });
  return { status: result.status, out: `${result.stdout}`.trim() };
}

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const health = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    llm: { codexCli: false, codexLoggedIn: false, openaiKey: true },
    voice: { realtime: true, model: 'gpt-realtime-2.1', voice: 'marin' },
    puzzles: { count: 402 },
    ...extra,
  });
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe.skipIf(!hasZsh)('Шахматы.command', () => {
  it('is valid zsh', () => {
    expect(spawnSync('zsh', ['-n', LAUNCHER]).status).toBe(0);
    expect(launcherFunctions()).toContain('server_outdated()');
  });

  it('computes the same version (short commit) as the server, from loose refs, packed refs and a detached HEAD', () => {
    expect(zsh(ROOT, 'git_sha').out).toBe(readGitSha(ROOT) ?? '');
    const repo = tempDir('gambit-launcher-git-');
    mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(repo, '.git', 'packed-refs'), `# pack-refs with: peeled\n${SHA} refs/heads/main\n`);
    expect(zsh(repo, 'git_sha').out).toBe('abcdef0');
    expect(readGitSha(repo)).toBe('abcdef0');
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`);
    expect(zsh(repo, 'git_sha').out).toBe('1111111');
    expect(readGitSha(repo)).toBe('1111111');
    writeFileSync(join(repo, '.git', 'HEAD'), `${SHA}\n`);
    expect(zsh(repo, 'git_sha').out).toBe(readGitSha(repo));
    // no checkout: no version, like the server's null
    expect(zsh(tempDir('gambit-launcher-nogit-'), 'git_sha || echo none').out).toBe('none');
  });

  it('tells Гамбитик from another program on the port', () => {
    expect(zsh(ROOT, `is_gambit ${q(health())} && echo yes || echo no`).out).toBe('yes');
    expect(zsh(ROOT, `is_gambit ${q('{"status":"ok","service":"gateway"}')} && echo yes || echo no`).out).toBe('no');
    expect(zsh(ROOT, `is_gambit ${q('<html>Not found</html>')} && echo yes || echo no`).out).toBe('no');
  });

  it('reads how long nobody played: seconds, «never», or nothing from an older server', () => {
    expect(zsh(ROOT, `idle_seconds ${q(health({ activity: { idleSeconds: 700 } }))}`).out).toBe('700');
    expect(zsh(ROOT, `idle_seconds ${q(health({ activity: { idleSeconds: null } }))}`).out).toBe('never');
    expect(zsh(ROOT, `idle_seconds ${q(health())} || echo unknown`).out).toBe('unknown');
  });

  it('restarts only a server older than the code here: another commit, or a server file changed after its start', () => {
    const repo = tempDir('gambit-launcher-code-');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), `${SHA}\n`);
    mkdirSync(join(repo, 'apps', 'server', 'src'), { recursive: true });
    const file = join(repo, 'apps', 'server', 'src', 'index.ts');
    writeFileSync(file, '// code');
    const old = new Date('2026-09-23T10:00:00.000Z');
    utimesSync(file, old, old);
    const running = (sha: string | null, startedAt: string) => health({ build: { gitSha: sha, startedAt, distBuiltAt: null }, activity: { idleSeconds: null } });
    const outdated = (json: string) => zsh(repo, `server_outdated ${q(json)} && echo outdated || echo current`).out;

    expect(outdated(running('abcdef0', '2026-09-23T11:00:00.000Z'))).toBe('current');
    // a commit happened since the server started
    expect(outdated(running('1234567', '2026-09-23T11:00:00.000Z'))).toBe('outdated');
    // the code changed after the start (not committed yet)
    expect(outdated(running('abcdef0', '2026-09-23T09:59:00.000Z'))).toBe('outdated');
    // a server from before the build info
    expect(outdated(health())).toBe('outdated');
  });

  it('rebuilds the web bundle when it is missing or older than its sources', () => {
    const repo = tempDir('gambit-launcher-web-');
    mkdirSync(join(repo, 'apps', 'web', 'src'), { recursive: true });
    const source = join(repo, 'apps', 'web', 'src', 'main.tsx');
    writeFileSync(source, '// app');
    const web = () => zsh(repo, 'web_outdated && echo rebuild || echo current').out;
    expect(web()).toBe('rebuild');
    mkdirSync(join(repo, 'apps', 'web', 'dist'), { recursive: true });
    const index = join(repo, 'apps', 'web', 'dist', 'index.html');
    writeFileSync(index, '<!doctype html>');
    utimesSync(source, new Date('2026-09-23T10:00:00.000Z'), new Date('2026-09-23T10:00:00.000Z'));
    utimesSync(index, new Date('2026-09-23T11:00:00.000Z'), new Date('2026-09-23T11:00:00.000Z'));
    expect(web()).toBe('current');
    utimesSync(source, new Date('2026-09-23T12:00:00.000Z'), new Date('2026-09-23T12:00:00.000Z'));
    expect(web()).toBe('rebuild');
  });
});
