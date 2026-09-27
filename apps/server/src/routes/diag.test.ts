import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer } from '../testing/fixtures.ts';
import type { TestServer } from '../testing/fixtures.ts';
import { createVoiceDiagLog, VOICE_DIAG_FILE } from './diag.ts';

const servers: TestServer[] = [];
const dirs: string[] = [];

async function start(): Promise<TestServer> {
  const server = await createTestServer();
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

type DiagFields = Record<string, string | number | boolean | null>;
const batch = (events: DiagFields[] = [{ t: 12, e: 'out.play', ok: false, err: 'NotAllowedError', kind: 'openai-live' }]) => ({ page: 'a1b2c3d4-e5f6', events });
/** bodies that must be refused (shapes the type would not allow on purpose) */
const rawBatch = (events: unknown[]) => ({ page: 'a1b2c3d4-e5f6', events });

function logLines(dataDir: string): Record<string, unknown>[] {
  const path = join(dataDir, VOICE_DIAG_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('POST /api/voice/diag — the voice black box', () => {
  it('appends every event as one JSON line in <DATA_DIR>/voice-diag.log (private file), with the server time and the page id', async () => {
    const server = await start();
    const res = await server.request('/api/voice/diag', {
      method: 'POST',
      json: batch([
        { t: 0, e: 'page.open', browser: 'chrome 141', os: 'mac', visible: true, activated: null },
        { t: 1500, e: 'utt', ms: 2400, peak: 0, play: 0, paused: true, why: 'notPlaying' },
      ]),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const lines = logLines(server.dataDir);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ page: 'a1b2c3d4-e5f6', t: 0, e: 'page.open', browser: 'chrome 141' });
    expect(lines[1]).toMatchObject({ e: 'utt', why: 'notPlaying', paused: true });
    expect(typeof lines[0]?.at).toBe('string');
    expect(statSync(join(server.dataDir, VOICE_DIAG_FILE)).mode & 0o777).toBe(0o600);
  });

  it('refuses anything that could carry words, secrets or long text — the whole batch, nothing is written', async () => {
    const server = await start();
    const refused = [
      // the child's / the coach's words (Cyrillic) can never pass
      batch([{ t: 1, e: 'transcript', text: 'Привет, Гамбитик' }]),
      // long text
      batch([{ t: 1, e: 'err', reason: 'x'.repeat(65) }]),
      // odd characters (SDP / JSON / keys)
      batch([{ t: 1, e: 'sdp', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1' }]),
      batch([{ t: 1, e: 'key', value: 'sk-proj-abc"}' }]),
      // nested objects, bad names, missing t / e, too many events or fields, extra top-level keys
      rawBatch([{ t: 1, e: 'nested', data: { a: 1 } }]),
      batch([{ t: 1, e: 'Bad Name' }]),
      batch([{ e: 'no.time' }]),
      batch([{ t: 1 }]),
      batch(Array.from({ length: 201 }, (_, i) => ({ t: i, e: 'many' }))),
      batch([{ t: 1, e: 'wide', ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])) }]),
      { ...batch(), extra: 'x' },
      { page: 'BAD PAGE', events: [{ t: 1, e: 'x' }] },
      { page: 'a1b2c3d4', events: [] },
    ];
    for (const body of refused) {
      const res = await server.request('/api/voice/diag', { method: 'POST', json: body });
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const notJson = await server.request('/api/voice/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    expect(notJson.status).toBe(400);
    expect(logLines(server.dataDir)).toEqual([]);
  });

  it('takes the beacon of a closing page (text/plain) — only with a same-origin proof', async () => {
    const server = await start();
    const beacon = (headers: Record<string, string>) =>
      server.app.request('/api/voice/diag', { method: 'POST', headers: { host: '127.0.0.1:8787', 'content-type': 'text/plain;charset=UTF-8', ...headers }, body: JSON.stringify(batch()) });
    expect((await beacon({ origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await beacon({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    // no proof / foreign origin: refused before the handler
    expect((await beacon({})).status).toBe(415);
    expect((await beacon({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await beacon({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(logLines(server.dataDir)).toHaveLength(2);
    // the usage beacon keeps working next to it
    const usage = await server.app.request('/api/voice/usage', {
      method: 'POST',
      headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ provider: 'openai-live', seconds: 5 }),
    });
    expect(usage.status).toBe(200);
  });

  it('automated runs are accepted and dropped: the owner\'s log only has real sessions', async () => {
    const server = await start();
    const res = await server.request('/api/voice/diag', { method: 'POST', json: batch(), headers: { 'x-gambit-automation': '1' } });
    expect(res.status).toBe(200);
    expect(logLines(server.dataDir)).toEqual([]);
  });

  it('is never readable over HTTP', async () => {
    const server = await start();
    await server.request('/api/voice/diag', { method: 'POST', json: batch() });
    expect((await server.request('/api/voice/diag')).status).toBe(404);
  });
});

describe('createVoiceDiagLog — size cap', () => {
  it('rotates at the cap: the current file starts over, one older file is kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gambit-diag-'));
    dirs.push(dir);
    const log = createVoiceDiagLog(dir, { maxBytes: 400, now: () => new Date('2026-09-22T15:00:00Z') });
    for (let i = 0; i < 6; i++) await log.append(batch([{ t: i, e: 'utt', why: 'ok', ms: 1000 + i }]));
    const current = readFileSync(join(dir, VOICE_DIAG_FILE), 'utf8');
    const older = readFileSync(join(dir, `${VOICE_DIAG_FILE}.1`), 'utf8');
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(400);
    expect(Buffer.byteLength(older)).toBeLessThanOrEqual(400);
    expect(current.trim().split('\n').at(-1)).toContain('"t":5');
    // an old file written with another mode is made private too
    writeFileSync(join(dir, VOICE_DIAG_FILE), '');
    chmodSync(join(dir, VOICE_DIAG_FILE), 0o644);
    await log.append(batch());
    expect(statSync(join(dir, VOICE_DIAG_FILE)).mode & 0o777).toBe(0o600);
  });
});
