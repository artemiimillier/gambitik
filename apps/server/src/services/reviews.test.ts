import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameReview } from '@gambit/shared';
import { LlmProviderError } from '../llm/types.ts';
import type { LlmProvider, LlmRequest } from '../llm/types.ts';
import { createTemplateProvider } from '../llm/providers/template.ts';
import type { GameReviewWithAdvice } from '../routes/games.ts';
import { createTestServer, sampleGameRecord } from '../testing/fixtures.ts';
import type { TestServer } from '../testing/fixtures.ts';

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.cleanup();
});

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
}

const LLM_REVIEW = {
  markdown: '# Разбор\n\n## Что получилось\nТы вернул ход и нашёл Сc4 — отличная привычка.\n\n## Главный урок партии\nПеред взятием проверь, кто защищает фигуру.',
  keyTakeaways: ['Перед взятием проверь защиту.', 'Возвращать ход — это сила, а не слабость.'],
  suggestedTheme: 'hangingPiece',
};

function template(): LlmProvider {
  return createTemplateProvider({ templateReview: null, motifTitleRu: (m) => m, themeTitleRu: (t) => t, defaultTheme: () => 'hangingPiece' });
}

describe('background reviews', () => {
  it("stores an LLM review as 'ready' and embeds it into the journal", async () => {
    const requests: LlmRequest[] = [];
    const fakeLlm: LlmProvider = {
      id: 'codex',
      isConfigured: () => true,
      generate: (request) => {
        requests.push(request);
        return Promise.resolve(LLM_REVIEW);
      },
    };
    const server = await createTestServer({ runtimeAi: true }, { providers: [fakeLlm, template()] });
    servers.push(server);
    const record = sampleGameRecord();

    const pending = await server.request('/api/games', { method: 'POST', json: record });
    expect(pending.status).toBe(201);
    await server.ctx.idle();

    const review = (await (await server.request(`/api/games/${record.id}/review`)).json()) as GameReviewWithAdvice;
    // the contract's GameReview + the additive advice fields
    expect(review).toEqual({
      gameId: record.id,
      status: 'ready',
      provider: 'codex',
      markdown: LLM_REVIEW.markdown,
      keyTakeaways: LLM_REVIEW.keyTakeaways,
      suggestedTheme: 'hangingPiece',
      suggestedThemeTitle: server.ctx.content.themeTitlesRu.hangingPiece,
    });

    // the prompt carries engine facts only — and no way to re-judge moves
    const prompt = requests[0]?.prompt ?? '';
    expect(prompt).toContain('"engineVerdict": "зевок"');
    expect(prompt).toContain('allowedThemes');
    // what the child SAID never leaves the machine by default — only a count does
    expect(prompt).not.toContain('Слон может пойти на це четыре!');
    expect(prompt).not.toContain('studentSaid');
    expect(prompt).toContain('"studentSpokeTimes": 1');
    // Russian text only: the fixture's English opening name is not handed to the model (it would copy it)
    expect(prompt).not.toContain("King's Pawn Game");
    expect(prompt).toContain('"opening": null');
    expect(requests[0]?.jsonSchema).toMatchObject({ additionalProperties: false, required: ['markdown', 'keyTakeaways', 'suggestedTheme'] });

    const journal = readFileSync(walk(join(server.dataDir, 'games')).find((f) => f.endsWith('.md')) ?? '', 'utf8');
    expect(journal).toContain('review: ready');
    expect(journal).toContain('### Разбор'); // headings are demoted below the journal's own sections
    expect(journal).toContain('#### Что получилось');
    expect(journal).toContain('- Перед взятием проверь защиту.');
    expect(journal).toContain('Источник разбора: ИИ-тренер (Codex)');
    const profileMd = readFileSync(join(server.dataDir, 'student', 'profile.md'), 'utf8');
    expect(profileMd).toContain('- Возвращать ход — это сила, а не слабость.');
  });

  it('REVIEW_INCLUDE_CHILD_SPEECH=1 sends redacted speech to the API providers — and never to codex', async () => {
    const prompts: Record<string, string> = {};
    const recording = (id: 'codex' | 'openrouter', fail: boolean): LlmProvider => ({
      id,
      isConfigured: () => true,
      generate: (request) => {
        prompts[id] = request.prompt;
        return fail ? Promise.reject(new LlmProviderError(id, 'timeout', 'slow')) : Promise.resolve(LLM_REVIEW);
      },
    });
    const server = await createTestServer({ runtimeAi: true, reviewIncludeChildSpeech: true }, { providers: [recording('codex', true), recording('openrouter', false), template()] });
    servers.push(server);
    const base = sampleGameRecord();
    const record = sampleGameRecord({
      events: [...base.events, { t: 44_000, type: 'childSaid', ply: 6, data: { text: 'Меня зовут Петя, мой телефон 8-900-123-45-67, пиши на petya@example.com' } }],
    });
    await server.request('/api/games', { method: 'POST', json: record });
    await server.ctx.idle();

    expect(server.ctx.repo.getReview(record.id)).toMatchObject({ status: 'ready', provider: 'openrouter' });
    expect(prompts.codex).not.toContain('Слон может пойти');
    expect(prompts.codex).not.toContain('studentSaid');
    expect(prompts.openrouter).toContain('Слон может пойти на це четыре!');
    expect(prompts.openrouter).not.toContain('900');
    expect(prompts.openrouter).not.toContain('45-67');
    expect(prompts.openrouter).not.toContain('example.com');
    // the local journal keeps the words as they were said
    const journal = readFileSync(walk(join(server.dataDir, 'games')).find((f) => f.endsWith('.md')) ?? '', 'utf8');
    expect(journal).toContain('8-900-123-45-67');
  });

  it('a game saved by an automated test run (X-Gambit-Automation) never reaches a paid LLM', async () => {
    let llmCalls = 0;
    const fakeLlm: LlmProvider = {
      id: 'openai-api',
      isConfigured: () => true,
      generate: () => {
        llmCalls += 1;
        return Promise.resolve(LLM_REVIEW);
      },
    };
    const server = await createTestServer({ runtimeAi: true }, { providers: [fakeLlm, template()] });
    servers.push(server);
    const record = sampleGameRecord();

    const saved = await server.request('/api/games', { method: 'POST', json: record, headers: { 'x-gambit-automation': '1' } });
    expect(saved.status).toBe(201);
    await server.ctx.idle();

    expect(llmCalls).toBe(0);
    const review = (await (await server.request(`/api/games/${record.id}/review`, { headers: { 'x-gambit-automation': '1' } })).json()) as GameReview;
    expect(review.status).toBe('template');
    expect(review.provider).toBe('template');
    expect(review.markdown.length).toBeGreaterThan(50);

    // any other header value is ordinary traffic: the LLM is used as usual
    const second = sampleGameRecord({ id: 'g-20260921-101500-second' });
    await server.request('/api/games', { method: 'POST', json: second, headers: { 'x-gambit-automation': 'yes' } });
    await server.ctx.idle();
    expect(llmCalls).toBe(1);
  });

  it('replaces an unknown suggested theme by the engine-derived one', async () => {
    const fakeLlm: LlmProvider = { id: 'openai-api', isConfigured: () => true, generate: () => Promise.resolve({ ...LLM_REVIEW, suggestedTheme: 'quantumChess' }) };
    const server = await createTestServer({ runtimeAi: true }, { providers: [fakeLlm, template()] });
    servers.push(server);
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord() });
    await server.ctx.idle();
    expect(server.ctx.repo.getReview('game-0001')).toMatchObject({ status: 'ready', provider: 'openai-api', suggestedTheme: 'hangingPiece' });
  });

  it("falls back to the template when the LLM hits its usage limit ('template'), and keeps the breaker open", async () => {
    let calls = 0;
    const limited: LlmProvider = {
      id: 'codex',
      isConfigured: () => true,
      generate: () => {
        calls += 1;
        return Promise.reject(new LlmProviderError('codex', 'usage_limit', "You've hit your usage limit."));
      },
    };
    const server = await createTestServer({ runtimeAi: true }, { providers: [limited, template()] });
    servers.push(server);
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord({ id: 'g1' }) });
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord({ id: 'g2' }) });
    await server.ctx.idle();
    expect(calls).toBe(1);
    for (const id of ['g1', 'g2']) {
      const review = (await (await server.request(`/api/games/${id}/review`)).json()) as GameReview;
      expect(review.status).toBe('template');
      expect(review.markdown).toContain('Что получилось');
    }
  });

  it("marks the review 'failed' only when even the template cannot be produced", async () => {
    const broken: LlmProvider = { id: 'template', isConfigured: () => true, generate: () => Promise.reject(new LlmProviderError('template', 'failed', 'boom')) };
    const server = await createTestServer({}, { providers: [broken] });
    servers.push(server);
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord() });
    await server.ctx.idle();
    const review = (await (await server.request('/api/games/game-0001/review')).json()) as GameReview;
    expect(review).toMatchObject({ status: 'failed', provider: 'template', markdown: '' });
  });

  it('picks up reviews that were pending when the server stopped', async () => {
    const server = await createTestServer({ autoReview: false });
    servers.push(server);
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord() });
    expect(server.ctx.repo.pendingReviewGameIds()).toEqual(['game-0001']);
    server.ctx.reviews.resumePending();
    await server.ctx.idle();
    expect(server.ctx.repo.pendingReviewGameIds()).toEqual([]);
    expect(server.ctx.repo.getReview('game-0001')?.status).toBe('template');
  });

  it('runs end to end through a FAKE codex executable (never the real binary)', async () => {
    const server0 = await createTestServer();
    servers.push(server0);
    const bin = join(server0.dataDir, 'fake-codex');
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(LLM_REVIEW) } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
    ];
    writeFileSync(`${bin}.out`, `${lines.join('\n')}\n`);
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "features" ]; then echo "apps stable true"; exit 0; fi\nif [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi\ncat > /dev/null\ncat "${bin}.out"\n`);
    chmodSync(bin, 0o755);

    const server = await createTestServer({ runtimeAi: true, codexBin: bin, llmProvider: 'codex' });
    servers.push(server);
    await server.request('/api/games', { method: 'POST', json: sampleGameRecord() });
    await server.ctx.idle();
    const review = (await (await server.request('/api/games/game-0001/review')).json()) as GameReview;
    expect(review).toMatchObject({ status: 'ready', provider: 'codex' });
    const health = (await (await server.request('/api/health')).json()) as { llm: unknown };
    expect(health.llm).toEqual({ codexCli: true, codexLoggedIn: true, openaiKey: false, openrouterKey: false });
  });
});
