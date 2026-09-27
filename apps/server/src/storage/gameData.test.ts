import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, sampleGameRecord } from '../testing/fixtures.ts';
import type { TestServer } from '../testing/fixtures.ts';
import { DataFileWriter } from './writer.ts';
import { GAME_DATA_SCHEMA, REBUILT_FROM_JOURNAL, isRebuiltFromJournal, parseGameDataFile, renderGameDataFile } from './gameData.ts';

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.cleanup();
});

async function start(): Promise<TestServer> {
  const server = await createTestServer();
  servers.push(server);
  return server;
}

function baseOf(server: TestServer, id: string): string {
  return join(server.dataDir, server.ctx.repo.getGameFileBase(id) ?? '');
}

describe('the machine twin of a game (<base>.json)', () => {
  it('round-trips the record, the flag, the review and the thoughts — and refuses anything else', () => {
    const record = sampleGameRecord();
    const review = { gameId: record.id, status: 'ready' as const, provider: 'codex' as const, markdown: 'Разбор', keyTakeaways: ['a'], suggestedTheme: 'fork', updatedAt: '2026-09-21T15:00:00.000Z' };
    const thoughts = [{ id: 't1', source: 'typed' as const, text: 'Трудно', question: 'Что было самым трудным?', at: '2026-09-21T15:01:00.000Z' }];
    const text = renderGameDataFile({ record, excluded: 'adult', review, thoughts });
    const parsed = parseGameDataFile(text);
    expect(parsed).toEqual({ schema: GAME_DATA_SCHEMA, gameId: record.id, excluded: 'adult', record, review: { ...review, gameId: undefined }, thoughts });
    expect(parsed?.review).not.toHaveProperty('gameId');
    expect(parseGameDataFile(renderGameDataFile({ record, excluded: null, review: null, thoughts: [] }))).toMatchObject({ excluded: null, review: null, thoughts: [] });

    expect(parseGameDataFile('{broken')).toBeNull();
    expect(parseGameDataFile(JSON.stringify({ ...JSON.parse(text), schema: 'game-data/2' }))).toBeNull();
    expect(parseGameDataFile(JSON.stringify({ ...JSON.parse(text), gameId: 'other' }))).toBeNull();
    expect(parseGameDataFile(JSON.stringify({ ...JSON.parse(text), record: { ...record, personaId: 'kasparov' } }))).toBeNull();
  });

  it('is written next to the journal, follows the flag and the thoughts, and is backfilled for older games', async () => {
    const server = await start();
    const record = sampleGameRecord({ id: 'g1' });
    await server.request('/api/games', { method: 'POST', json: record });
    await server.ctx.idle();
    const twin = () => parseGameDataFile(readFileSync(`${baseOf(server, 'g1')}.json`, 'utf8'));
    expect(twin()).toMatchObject({ gameId: 'g1', excluded: null, record, review: { status: 'template', provider: 'template' }, thoughts: [] });

    await server.request('/api/games/g1/excluded', { method: 'PUT', json: { excluded: 'adult' } });
    await server.request('/api/games/g1/thoughts', { method: 'POST', json: { thoughts: [{ id: 't1', source: 'voice', text: 'Ура', at: '2026-09-21T15:00:00.000Z' }] } });
    await server.ctx.idle();
    expect(twin()).toMatchObject({ excluded: 'adult', thoughts: [{ id: 't1', text: 'Ура' }] });

    // a game saved by an older version has no twin: the first student-files write of a server run adds it
    rmSync(`${baseOf(server, 'g1')}.json`);
    const writer = new DataFileWriter({ paths: server.ctx.paths, repo: server.ctx.repo, content: server.ctx.content, getProfile: () => server.ctx.student.getProfile(), log: () => undefined });
    await writer.writeStudentFiles();
    expect(twin()).toMatchObject({ gameId: 'g1', excluded: 'adult' });
  });

  it('never overwrites the richer journal of a game that was rebuilt from it', async () => {
    const server = await start();
    const rebuilt = sampleGameRecord({ id: 'old', events: [{ t: 0, type: 'gameStart', data: { [REBUILT_FROM_JOURNAL]: true } }], judgements: [] });
    expect(isRebuiltFromJournal(rebuilt)).toBe(true);
    expect(isRebuiltFromJournal(sampleGameRecord())).toBe(false);
    await server.request('/api/games', { method: 'POST', json: rebuilt });
    await server.ctx.idle();
    const md = `${baseOf(server, 'old')}.md`;
    writeFileSync(md, '# Настоящий журнал со всеми ходами\n');
    await server.request('/api/games/old/excluded', { method: 'PUT', json: { excluded: 'adult' } });
    await server.ctx.idle();
    expect(readFileSync(md, 'utf8')).toBe('# Настоящий журнал со всеми ходами\n');
    // …while its twin still follows the database
    expect(parseGameDataFile(readFileSync(`${baseOf(server, 'old')}.json`, 'utf8'))?.excluded).toBe('adult');
    expect(existsSync(`${baseOf(server, 'old')}.pgn`)).toBe(true);
  });
});
