/**
 * `AppType` must stay usable by typed clients: `hc<AppType>()` sees every route, its body and
 * its response type. (The compile-time part of this test is checked by `pnpm typecheck`.)
 */
import { hc } from 'hono/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppType } from './index.ts';
import { createTestServer, sampleGameRecord } from './testing/fixtures.ts';
import type { TestServer } from './testing/fixtures.ts';

let server: TestServer;
beforeAll(async () => {
  server = await createTestServer({ autoReview: false });
});
afterAll(() => server.cleanup());

describe('typed RPC client', () => {
  it('talks to every kind of route through hc<AppType>', async () => {
    const viaApp: typeof fetch = (input, init) => Promise.resolve(server.app.request(input instanceof URL ? input.href : input, init));
    const client = hc<AppType>('http://127.0.0.1:8787', { fetch: viaApp });

    const health = await (await client.api.health.$get()).json();
    expect(health.ok).toBe(true);
    expect(health.puzzles.count).toBeGreaterThan(0);

    const updated = await client.api.student.$put({ json: { nickname: 'Лев', address: 'm' } });
    expect(updated.status).toBe(200);

    const saved = await client.api.games.$post({ json: sampleGameRecord() });
    expect(saved.status).toBe(201);
    const listed = await client.api.games.$get({ query: { limit: '5' } });
    if (listed.status !== 200) throw new Error(`unexpected status ${listed.status}`);
    const list = await listed.json();
    expect(list[0]?.id).toBe('game-0001');

    const review = await client.api.games[':id'].review.$get({ param: { id: 'game-0001' } });
    expect(review.status).toBe(200);

    const next = await client.api.puzzles.next.$get({ query: { theme: 'mateIn1', count: '2' } });
    if (next.status !== 200) throw new Error(`unexpected status ${next.status}`);
    const puzzles = await next.json();
    expect(puzzles.map((p) => p.themes.includes('mateIn1'))).toEqual([true, true]);

    // state-changing requests must be JSON, even the body-less ones (security.ts)
    const voice = await client.api.voice.session.$post(undefined, { headers: { 'content-type': 'application/json' } });
    expect(voice.status).toBe(503);

    const live = await client.api.voice.live.$post({ json: { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
    expect(live.status).toBe(503);

    const reported = await client.api.voice.usage.$post({ json: { provider: 'openai-live', seconds: 12 } });
    expect(reported.status).toBe(200);
    const usage = await (await client.api.voice.usage.$get()).json();
    expect(usage.todaySeconds).toBe(12);
    expect(usage.byProvider['openai-live']?.monthSeconds).toBe(12);
  });
});
