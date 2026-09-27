import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_PORT, WEB_DEV_PORT } from '@gambit/shared';
import { DEFAULT_OUT_DIR, OWNER_PORTS, SmokeGuardError, argValue, assertSafeHealth, fetchSafeHealth, outDir, parseBaseUrl, safeLocalPath, scratchDir, workDir } from './guard.ts';

const argv = (...words: string[]) => ['node', 'tools/voice-smoke/teacher.mjs', ...words];

const HEALTH = {
  ok: true,
  llm: { codexCli: false, codexLoggedIn: false, openaiKey: false, openrouterKey: false },
  voice: { realtime: false, model: 'gpt-realtime-2.1', voice: 'marin', live: false, liveModel: 'gpt-live-1', preferred: 'live' },
  puzzles: { count: 402 },
  dataDirIsTemp: true,
  build: { gitSha: 'abc1234', startedAt: '2026-09-23T10:00:00.000Z', distBuiltAt: null },
  activity: { idleSeconds: null },
};

describe('--base-url: no default server, never the real stack’s ports', () => {
  it('the real stack’s ports are the contract’s server and Vite dev ports', () => {
    expect(OWNER_PORTS).toEqual([SERVER_PORT, WEB_DEV_PORT]);
    expect(OWNER_PORTS).toEqual([8787, 5173]);
  });

  it('refuses to run without --base-url (there is no default server)', () => {
    expect(() => parseBaseUrl(argv('--n', '1'))).toThrow(SmokeGuardError);
    expect(() => parseBaseUrl(argv('--n', '1'))).toThrow(/--base-url is required/);
    expect(() => parseBaseUrl(argv('--base-url'))).toThrow(/--base-url is required/);
    expect(() => parseBaseUrl(argv('--base-url', '--dry'))).toThrow(/--base-url is required/);
    // a bare `--base` is not silently ignored
    expect(() => parseBaseUrl(argv('--base', 'http://127.0.0.1:8788'))).toThrow(/renamed/);
  });

  it('refuses 8787 and 5173 outright, whatever the spelling', () => {
    for (const url of ['http://127.0.0.1:8787', 'http://localhost:8787/', 'http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:8787']) {
      expect(() => parseBaseUrl(argv('--base-url', url)), url).toThrow(/owner's own/);
    }
  });

  it('only plain http on this computer with an explicit port, origin only', () => {
    expect(() => parseBaseUrl(argv('--base-url', 'https://127.0.0.1:8788'))).toThrow(/http:\/\//);
    expect(() => parseBaseUrl(argv('--base-url', 'http://192.168.1.5:8788'))).toThrow(/this computer/);
    expect(() => parseBaseUrl(argv('--base-url', 'http://example.com:8788'))).toThrow(/this computer/);
    expect(() => parseBaseUrl(argv('--base-url', 'http://127.0.0.1'))).toThrow(/explicit port/);
    expect(() => parseBaseUrl(argv('--base-url', 'http://127.0.0.1:80'))).toThrow(/explicit port/);
    expect(() => parseBaseUrl(argv('--base-url', 'http://127.0.0.1:8788/api'))).toThrow(/origin only/);
    expect(() => parseBaseUrl(argv('--base-url', 'not a url'))).toThrow(/not a URL/);
  });

  it('accepts a throw-away server on another port', () => {
    expect(parseBaseUrl(argv('--base-url', 'http://127.0.0.1:8788'))).toBe('http://127.0.0.1:8788');
    expect(parseBaseUrl(argv('--dry', '--base-url', 'http://localhost:8795/', '--n', '2'))).toBe('http://localhost:8795');
    expect(parseBaseUrl(argv('--base-url', 'http://[::1]:8790'))).toBe('http://[::1]:8790');
  });

  it('argValue reads the word after a flag', () => {
    expect(argValue(argv('--n', '3'), 'n')).toBe('3');
    expect(argValue(argv('--n'), 'n')).toBeUndefined();
    expect(argValue(argv(), 'n')).toBeUndefined();
  });
});

describe('the server must report a throw-away DATA_DIR before a profile / games are written', () => {
  it('accepts a Гамбитик server on a temp DATA_DIR', () => {
    expect(assertSafeHealth(HEALTH, 'http://127.0.0.1:8788').voice.liveModel).toBe('gpt-live-1');
  });

  it('refuses the real data dir, an older server without the flag, and anything that is not Гамбитик', () => {
    expect(() => assertSafeHealth({ ...HEALTH, dataDirIsTemp: false }, 'http://127.0.0.1:8788')).toThrow(/not a temp folder/);
    const { dataDirIsTemp: _flag, ...older } = HEALTH;
    expect(() => assertSafeHealth(older, 'http://127.0.0.1:8788')).toThrow(/does not report dataDirIsTemp/);
    expect(() => assertSafeHealth({ status: 'ok' }, 'http://127.0.0.1:8788')).toThrow(/not a Гамбитик server/);
    expect(() => assertSafeHealth(null, 'http://127.0.0.1:8788')).toThrow(/not a Гамбитик server/);
    expect(() => assertSafeHealth({ ...HEALTH, dataDirIsTemp: 'yes' }, 'http://127.0.0.1:8788')).toThrow(SmokeGuardError);
  });

  it('fetchSafeHealth: no server, a foreign service, a non-JSON answer and the real data are all refused', async () => {
    const answer = (body: unknown, status = 200): typeof fetch => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    const seen: string[] = [];
    const recording: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify(HEALTH));
    };
    expect((await fetchSafeHealth('http://127.0.0.1:8788', recording)).dataDirIsTemp).toBe(true);
    expect(seen).toEqual(['http://127.0.0.1:8788/api/health']);
    await expect(fetchSafeHealth('http://127.0.0.1:8788', async () => Promise.reject(new Error('ECONNREFUSED')))).rejects.toThrow(/no server/);
    await expect(fetchSafeHealth('http://127.0.0.1:8788', answer('Not Found', 404))).rejects.toThrow(/404/);
    await expect(fetchSafeHealth('http://127.0.0.1:8788', answer('<html>'))).rejects.toThrow(/did not answer JSON/);
    await expect(fetchSafeHealth('http://127.0.0.1:8788', answer({ ...HEALTH, dataDirIsTemp: false }))).rejects.toThrow(/not a temp folder/);
  });
});

describe('where the scripts write', () => {
  const root = '/repo';

  it('output goes to the git-ignored test-results/voice-samples by default; --out overrides', () => {
    expect(DEFAULT_OUT_DIR).toBe(join('test-results', 'voice-samples'));
    expect(outDir(root, undefined)).toBe('/repo/test-results/voice-samples');
    expect(outDir(root, 'docs/voice-samples')).toBe('/repo/docs/voice-samples');
    expect(outDir(root, '/tmp/elsewhere')).toBe('/tmp/elsewhere');
  });

  it('never inside the child’s data/', () => {
    expect(() => outDir(root, 'data')).toThrow(/inside data\//);
    expect(() => outDir(root, 'data/voice')).toThrow(/inside data\//);
    expect(() => safeLocalPath(root, '/repo/data/games', '--data-dir')).toThrow(/--data-dir/);
    expect(safeLocalPath(root, 'database', '--out')).toBe('/repo/database');
    expect(safeLocalPath(root, '../data', '--out')).toBe('/data');
    // a folder named «..x» inside data/ is still inside
    expect(() => safeLocalPath(root, 'data/..x', '--out')).toThrow(/inside data\//);
  });

  it('scratch files live in the OS temp dir', () => {
    expect(scratchDir('teacher-voice')).toMatch(/gambit-voice-smoke[/\\]teacher-voice$/);
  });

  it('--work (scratch wav / aiff / webm) and --reanalyse (a report read AND written back) are refused inside data/ too', () => {
    expect(workDir(root, undefined, 'voice')).toBe(scratchDir('voice'));
    expect(workDir(root, 'test-results/work', 'voice')).toBe('/repo/test-results/work');
    expect(() => workDir(root, 'data/games', 'voice')).toThrow(/--work data\/games is inside data\//);
    expect(() => workDir(root, '/repo/data', 'conv-voice')).toThrow(SmokeGuardError);
    expect(safeLocalPath(root, 'test-results/voice-samples/teacher.json', '--reanalyse')).toBe('/repo/test-results/voice-samples/teacher.json');
    expect(() => safeLocalPath(root, 'data/games/2026-09-23.json', '--reanalyse')).toThrow(/--reanalyse data\/games\/2026-09-23\.json is inside data\//);
  });
});
