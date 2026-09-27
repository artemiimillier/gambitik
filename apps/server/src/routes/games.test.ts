/**
 * The parent's side of the history: every game paginated, «играл взрослый / проверка», «Начать прогресс заново», the
 * journal of one game, and the child's thoughts appended after the game was saved.
 */
import { existsSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameExclusionResponse, GameJournalResponse, GameListItem, GameThought, GameThoughtsResponse, ProgressResetResponse, ProgressSnapshot, StudentProfile } from '@gambit/shared';
import { MAX_THOUGHTS_PER_GAME, THOUGHT_GAMES_WINDOW } from '../services/games.ts';
import { createTestServer, sampleGameRecord } from '../testing/fixtures.ts';
import type { TestServer } from '../testing/fixtures.ts';

const servers: TestServer[] = [];

async function start(): Promise<TestServer> {
  const server = await createTestServer({ autoReview: false });
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.cleanup();
});

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/** Game `n` starts n hours after the sample game: a higher n is a newer game. */
function gameAt(n: number, overrides: Parameters<typeof sampleGameRecord>[0] = {}) {
  const startedAt = new Date(Date.parse('2026-09-21T08:00:00.000Z') + n * 3_600_000).toISOString();
  const endedAt = new Date(Date.parse(startedAt) + 300_000).toISOString();
  return sampleGameRecord({ id: `g${n}`, startedAt, endedAt, ...overrides });
}

/** The game with a teacher's phrase that explained the concept card `conceptId` (TEACHER-MODE §7.5). */
function withConcept(record: ReturnType<typeof gameAt>, conceptId: string): ReturnType<typeof gameAt> {
  const teach = { moment: 'turn', style: 'concept', ply: 3, advice: [], conceptId };
  return { ...record, events: [...record.events, { t: 13_000, type: 'coachSaid', ply: 3, data: { kind: 'teachTurn', text: 'Новая тема!', teach } }] };
}

async function saveGames(server: TestServer, ...records: ReturnType<typeof gameAt>[]): Promise<void> {
  for (const record of records) expect((await server.request('/api/games', { method: 'POST', json: record })).status).toBe(201);
  await server.ctx.idle();
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

function journalOf(server: TestServer, gameId: string): string {
  const base = server.ctx.repo.getGameFileBase(gameId);
  return readFileSync(join(server.dataDir, `${base ?? ''}.md`), 'utf8');
}

describe('GET /api/games — every game, page by page', () => {
  it('pages with limit + offset, newest first, and says whether each game counts', async () => {
    const server = await start();
    await saveGames(server, gameAt(1), gameAt(2), gameAt(3));
    const first = await json<GameListItem[]>(server.request('/api/games?limit=2'));
    expect(first.map((g) => [g.id, g.excluded])).toEqual([
      ['g3', null],
      ['g2', null],
    ]);
    expect((await json<GameListItem[]>(server.request('/api/games?limit=2&offset=2'))).map((g) => g.id)).toEqual(['g1']);
    expect(await json<GameListItem[]>(server.request('/api/games?limit=2&offset=9'))).toEqual([]);
    expect((await server.request('/api/games?offset=-1')).status).toBe(400);
  });
});

describe('PUT /api/games/:id/excluded — «играл взрослый / проверка»', () => {
  it('takes the game out of the totals, charts, profile.md and the coach notes, keeps its files, and can undo it', async () => {
    const server = await start();
    await server.request('/api/student', { method: 'PUT', json: { nickname: 'Миша' } });
    const adult = gameAt(1, { personaId: 'dima' });
    const child = gameAt(2, { result: '0-1' });
    await saveGames(server, adult, child);
    expect((await json<StudentProfile>(server.request('/api/student'))).bestWin).toBe('dima');

    const marked = await json<GameExclusionResponse>(server.request('/api/games/g1/excluded', { method: 'PUT', json: { excluded: 'adult' } }));
    expect(marked.excluded).toBe('adult');
    expect(marked.profile.totals).toMatchObject({ games: 1, wins: 0, losses: 1 });
    expect(marked.profile.bestWin).toBeNull();
    expect(await json<StudentProfile>(server.request('/api/student'))).toEqual(marked.profile);

    // still listed (the parent can undo it), but no longer in the charts
    const list = await json<GameListItem[]>(server.request('/api/games'));
    expect(list.map((g) => [g.id, g.excluded])).toEqual([
      ['g2', null],
      ['g1', 'adult'],
    ]);
    const progress = await json<ProgressSnapshot>(server.request('/api/progress'));
    expect(progress.games.map((g) => g.gameId)).toEqual(['g2']);
    expect(progress.profile.totals.games).toBe(1);

    // the files say so too
    await server.ctx.idle();
    expect(journalOf(server, 'g1')).toContain('\ncounts_in_progress: false\nexcluded: adult\n');
    expect(journalOf(server, 'g1')).toContain('| В прогрессе ребёнка | **не считается** — играл взрослый (проверка) |');
    expect(journalOf(server, 'g2')).toContain('\ncounts_in_progress: true\n');
    const profileMd = readFileSync(join(server.dataDir, 'student', 'profile.md'), 'utf8');
    expect(profileMd).toContain('- Не считаются в прогрессе: 1 партия');
    expect(profileMd).not.toContain('| Дима |');
    const progressJson = JSON.parse(readFileSync(join(server.dataDir, 'student', 'progress.json'), 'utf8')) as { games: { total: number; gamesByOpponent: Record<string, number> } };
    expect(progressJson.games.total).toBe(1);
    expect(progressJson.games.gamesByOpponent).toEqual({ petya: 1 });
    expect(walk(join(server.dataDir, 'games')).filter((f) => f.endsWith('.pgn'))).toHaveLength(2);

    // a new game of the child: weaknesses and totals still ignore the adult game
    await saveGames(server, gameAt(3));
    expect((await json<StudentProfile>(server.request('/api/student'))).totals.games).toBe(2);

    const undone = await json<GameExclusionResponse>(server.request('/api/games/g1/excluded', { method: 'PUT', json: { excluded: null } }));
    expect(undone.excluded).toBeNull();
    expect(undone.profile.totals.games).toBe(3);
    expect(undone.profile.bestWin).toBe('dima');
    await server.ctx.idle();
    expect(journalOf(server, 'g1')).toContain('\ncounts_in_progress: true\n');
  });

  it('gives the concept cards of an adult game back to the child: the cards come from the games that count', async () => {
    const server = await start();
    await saveGames(server, withConcept(gameAt(1), 'opening-center'), withConcept(gameAt(2), 'fork'), withConcept(gameAt(3), 'opening-center'));
    const profile = async (): Promise<StudentProfile> => json<StudentProfile>(server.request('/api/student'));
    expect((await profile()).conceptsIntroduced).toEqual(['opening-center', 'fork']);

    // a parent's own 5-minute game with «Учитель»: marked, its card is new for the child again
    const marked = await json<GameExclusionResponse>(server.request('/api/games/g2/excluded', { method: 'PUT', json: { excluded: 'adult' } }));
    expect(marked.profile.conceptsIntroduced).toEqual(['opening-center']);
    // a card another counting game explained stays explained
    await server.request('/api/games/g1/excluded', { method: 'PUT', json: { excluded: 'adult' } });
    expect((await profile()).conceptsIntroduced).toEqual(['opening-center']);
    await server.request('/api/games/g2/excluded', { method: 'PUT', json: { excluded: null } });
    expect((await profile()).conceptsIntroduced).toEqual(['fork', 'opening-center']);
    // «Начать прогресс заново»: every card is new again
    const reset = await json<ProgressResetResponse>(server.request('/api/student/reset-progress', { method: 'POST', json: { confirm: true } }));
    expect(reset.profile.conceptsIntroduced).toEqual([]);
  });

  it('a profile from before the concept list gets the cards of every game that counts with the next saved game', async () => {
    const server = await start();
    await saveGames(server, withConcept(gameAt(1), 'opening-center'), withConcept(gameAt(2), 'fork'));
    const { conceptsIntroduced: _dropped, ...legacy } = server.ctx.student.getProfile();
    server.ctx.repo.saveProfile(legacy);
    expect((await json<StudentProfile>(server.request('/api/student'))).conceptsIntroduced).toBeUndefined();
    await saveGames(server, withConcept(gameAt(3), 'pin'));
    expect((await json<StudentProfile>(server.request('/api/student'))).conceptsIntroduced).toEqual(['opening-center', 'fork', 'pin']);
  });

  it('marking and unmarking games keeps «games on this stage» right: only the games played on it count', async () => {
    const server = await start();
    const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
    await saveGames(server, gameAt(1), gameAt(2), gameAt(3), gameAt(4));
    await pause();
    await server.request('/api/student', { method: 'PUT', json: { stage: 2 } });
    await pause();
    await saveGames(server, gameAt(5), gameAt(6));
    const onStage = (): number => server.ctx.student.getProfile().totals.games - server.ctx.repo.loadStageMeta().gamesAtStageStart;
    expect(server.ctx.repo.loadStageMeta().gamesAtStageStart).toBe(4);
    expect(onStage()).toBe(2);

    // three games before the stage are an adult's: still two games on the stage — and after the undo too
    for (const id of ['g1', 'g2', 'g3']) await server.request(`/api/games/${id}/excluded`, { method: 'PUT', json: { excluded: 'adult' } });
    expect(server.ctx.repo.loadStageMeta().gamesAtStageStart).toBe(1);
    expect(onStage()).toBe(2);
    for (const id of ['g1', 'g2', 'g3']) await server.request(`/api/games/${id}/excluded`, { method: 'PUT', json: { excluded: null } });
    expect(server.ctx.repo.loadStageMeta().gamesAtStageStart).toBe(4);
    expect(onStage()).toBe(2);
    // a game played ON the stage is an adult's: one game less on it
    await server.request('/api/games/g5/excluded', { method: 'PUT', json: { excluded: 'adult' } });
    expect(onStage()).toBe(1);
    await server.request('/api/games/g5/excluded', { method: 'PUT', json: { excluded: null } });
    await saveGames(server, gameAt(7));
    expect(onStage()).toBe(3);

    // a stage meta from before the timestamp: the moment is taken from the games that count, before the change
    server.ctx.repo.saveStageMeta({ gamesAtStageStart: 4 });
    await server.request('/api/games/g2/excluded', { method: 'PUT', json: { excluded: 'adult' } });
    expect(server.ctx.repo.loadStageMeta().gamesAtStageStart).toBe(3);
    expect(onStage()).toBe(3);
    await server.request('/api/games/g2/excluded', { method: 'PUT', json: { excluded: null } });
    expect(onStage()).toBe(3);
  });

  it('validates the id and the body', async () => {
    const server = await start();
    await saveGames(server, gameAt(1));
    expect((await server.request('/api/games/nope/excluded', { method: 'PUT', json: { excluded: 'adult' } })).status).toBe(404);
    expect((await server.request('/api/games/..%2Fx/excluded', { method: 'PUT', json: { excluded: 'adult' } })).status).toBe(404);
    for (const body of [{}, { excluded: 'archived' }, { excluded: true }, { excluded: 'adult', extra: 1 }]) {
      const res = await server.request('/api/games/g1/excluded', { method: 'PUT', json: body });
      expect(res.status, JSON.stringify(body)).toBe(body.excluded === 'adult' ? 200 : 400);
    }
  });
});

describe('POST /api/student/reset-progress — «Начать прогресс заново»', () => {
  it('archives the games that count (never deletes them), keeps puzzles and the stage, and counts the games after it', async () => {
    const server = await start();
    await server.request('/api/student', { method: 'PUT', json: { nickname: 'Миша', stage: 2 } });
    await saveGames(server, gameAt(1), gameAt(2), gameAt(3));
    await server.request('/api/games/g1/excluded', { method: 'PUT', json: { excluded: 'adult' } });
    await server.request('/api/puzzles/attempt', { method: 'POST', json: { puzzleId: 'p1', solved: true, msSpent: 5000, hintsUsed: 0, themes: ['fork'], puzzleRating: 700 } });

    expect((await server.request('/api/student/reset-progress', { method: 'POST', json: {} })).status).toBe(400);
    expect((await server.request('/api/student/reset-progress', { method: 'POST', json: { confirm: false } })).status).toBe(400);
    const reset = await json<ProgressResetResponse>(server.request('/api/student/reset-progress', { method: 'POST', json: { confirm: true } }));
    expect(reset.archivedGames).toBe(2);
    expect(reset.profile.totals).toMatchObject({ games: 0, wins: 0, puzzlesAttempted: 1 });
    expect(reset.profile).toMatchObject({ nickname: 'Миша', stage: 2, recentAccuracy: [], bestWin: null });

    const list = await json<GameListItem[]>(server.request('/api/games'));
    expect(list.map((g) => [g.id, g.excluded])).toEqual([
      ['g3', 'archived'],
      ['g2', 'archived'],
      ['g1', 'adult'],
    ]);
    expect((await json<ProgressSnapshot>(server.request('/api/progress'))).games).toEqual([]);
    await server.ctx.idle();
    expect(journalOf(server, 'g2')).toContain('\nexcluded: archived\n');
    expect(walk(join(server.dataDir, 'games')).filter((f) => f.endsWith('.md'))).toHaveLength(3);

    await saveGames(server, gameAt(4));
    expect((await json<StudentProfile>(server.request('/api/student'))).totals.games).toBe(1);
    // a second reset has nothing left but the new game
    expect((await json<ProgressResetResponse>(server.request('/api/student/reset-progress', { method: 'POST', json: { confirm: true } }))).archivedGames).toBe(1);
  });
});

describe('GET /api/games/:id/journal', () => {
  it('serves the markdown journal of that one game', async () => {
    const server = await start();
    await saveGames(server, gameAt(1));
    const journal = await json<GameJournalResponse>(server.request('/api/games/g1/journal'));
    expect(journal.gameId).toBe('g1');
    expect(journal.fileName).toMatch(/^2026-09-21_\d{4}_vs-petya\.md$/);
    expect(journal.markdown).toContain('schema: game-journal/1');
    expect(journal.markdown).toBe(journalOf(server, 'g1'));
  });

  it('never leaves the data folder: unknown ids, a tampered file base, a symlink, a missing file → 404', async () => {
    const server = await start();
    await saveGames(server, gameAt(1), gameAt(2));
    expect((await server.request('/api/games/nope/journal')).status).toBe(404);
    expect((await server.request('/api/games/..%2F..%2Fetc/journal')).status).toBe(404);

    const secret = join(server.dataDir, 'student', 'profile.md');
    server.ctx.db.run(`UPDATE game SET file_base = '../student/profile' WHERE id = 'g1'`);
    expect((await server.request('/api/games/g1/journal')).status).toBe(404);
    server.ctx.db.run(`UPDATE game SET file_base = 'games/../../outside' WHERE id = 'g1'`);
    expect((await server.request('/api/games/g1/journal')).status).toBe(404);

    const g2 = join(server.dataDir, `${server.ctx.repo.getGameFileBase('g2') ?? ''}.md`);
    unlinkSync(g2);
    expect((await server.request('/api/games/g2/journal')).status).toBe(404);
    symlinkSync(secret, g2);
    expect((await server.request('/api/games/g2/journal')).status).toBe(404);
  });
});

describe('POST /api/games/:id/thoughts — the child\'s thoughts after the game', () => {
  const thought = (id: string, text: string, extra: Partial<GameThought> = {}): GameThought => ({ id, source: 'voice', text, at: '2026-09-21T11:10:00.000Z', ...extra });

  it('appends them to the journal («Мысли после партии»), idempotent per id', async () => {
    const server = await start();
    await server.request('/api/student', { method: 'PUT', json: { nickname: 'Миша' } });
    await saveGames(server, gameAt(1));
    const body = {
      thoughts: [
        thought('t1', 'Я увидел,   что\nкороль заперт', { question: 'Как тебе удалось найти мат?' }),
        thought('t2', 'Не зевнуть ферзя', { source: 'typed', question: 'Что было самым трудным в этой партии?', at: '2026-09-21T11:11:00.000Z' }),
        thought('t1', 'дубликат в том же запросе'),
      ],
    };
    const first = await json<GameThoughtsResponse>(server.request('/api/games/g1/thoughts', { method: 'POST', json: body }));
    expect(first).toEqual({ gameId: 'g1', added: 2, total: 2 });
    const again = await json<GameThoughtsResponse>(server.request('/api/games/g1/thoughts', { method: 'POST', json: body }));
    expect(again).toEqual({ gameId: 'g1', added: 0, total: 2 });

    await server.ctx.idle();
    const md = journalOf(server, 'g1');
    expect(md).toContain('## Мысли после партии');
    expect(md).toContain('На вопрос «Как тебе удалось найти мат?» Миша (голосом): «Я увидел, что король заперт»');
    expect(md).toContain('На вопрос «Что было самым трудным в этой партии?» Миша (написал): «Не зевнуть ферзя»');
    expect(md).not.toContain('дубликат');
    expect(server.ctx.repo.listThoughts('g1').map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('only for the latest few games, only for games that exist, and within the size limits', async () => {
    const server = await start();
    await saveGames(server, ...Array.from({ length: THOUGHT_GAMES_WINDOW + 1 }, (_, i) => gameAt(i + 1)));
    const one = { thoughts: [thought('t1', 'мысль')] };
    expect((await server.request('/api/games/g1/thoughts', { method: 'POST', json: one })).status).toBe(409);
    expect(await json<{ error: string }>(server.request('/api/games/g1/thoughts', { method: 'POST', json: one }))).toEqual({ error: 'too-old' });
    expect((await server.request(`/api/games/g${THOUGHT_GAMES_WINDOW + 1}/thoughts`, { method: 'POST', json: one })).status).toBe(200);
    expect((await server.request('/api/games/g2/thoughts', { method: 'POST', json: one })).status).toBe(200);
    expect((await server.request('/api/games/nope/thoughts', { method: 'POST', json: one })).status).toBe(404);

    const g = `/api/games/g${THOUGHT_GAMES_WINDOW + 1}/thoughts`;
    for (const bad of [
      { thoughts: [] },
      { thoughts: [thought('t', 'x'.repeat(601))] },
      { thoughts: [thought('t', '   ')] },
      { thoughts: [thought('../x', 'x')] },
      { thoughts: [thought('t', 'x', { at: 'вчера' })] },
      { thoughts: [thought('t', 'x', { question: 'x'.repeat(301) })] },
      { thoughts: Array.from({ length: 21 }, (_, i) => thought(`t${i}`, 'x')) },
    ]) {
      expect((await server.request(g, { method: 'POST', json: bad })).status).toBe(400);
    }

    // a game takes at most MAX_THOUGHTS_PER_GAME thoughts; resending is still fine
    for (let batch = 0; batch * 20 < MAX_THOUGHTS_PER_GAME + 10; batch += 1) {
      await server.request(g, { method: 'POST', json: { thoughts: Array.from({ length: 20 }, (_, i) => thought(`b${batch}-${i}`, `мысль ${i}`)) } });
    }
    expect(server.ctx.repo.countThoughts(`g${THOUGHT_GAMES_WINDOW + 1}`)).toBe(MAX_THOUGHTS_PER_GAME);
    expect(await json<GameThoughtsResponse>(server.request(g, { method: 'POST', json: { thoughts: [thought('late', 'ещё')] } }))).toMatchObject({ added: 0, total: MAX_THOUGHTS_PER_GAME });
  });

  it('refuses a text body (the route is JSON only, like every state change)', async () => {
    const server = await start();
    await saveGames(server, gameAt(1));
    const res = await server.request('/api/games/g1/thoughts', { method: 'POST', body: '{"thoughts":[]}', headers: { 'content-type': 'text/plain' } });
    expect(res.status).toBe(415);
  });
});
