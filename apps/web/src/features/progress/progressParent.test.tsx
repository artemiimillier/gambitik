/** The parent's side of the progress screen: static markup of the games list, the gate and the journal; the routes. */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameListItem } from '@gambit/shared';
import { ApiError } from '../../api/client.ts';
import { GamesCard } from './GamesCard.tsx';
import { JournalBody } from './JournalModal.tsx';
import { ParentLock } from './ParentLock.tsx';
import { getGameJournal, listGamesPage, resetProgress, setGameExcluded } from './progressApi.ts';

const noop = (): void => undefined;

function game(id: string, overrides: Partial<GameListItem> = {}): GameListItem {
  return { id, startedAt: '2026-09-21T09:30:00', personaId: 'sonya', timeControlId: 'blitz5', childColor: 'w', result: '1-0', accuracy: 74, blunders: 1, reviewStatus: 'ready', ...overrides };
}

function card(parent: boolean, extra: Partial<Parameters<typeof GamesCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <GamesCard
      games={[game('a'), game('b', { excluded: 'adult' }), game('c', { excluded: 'archived', result: '0-1' })]}
      hasMore
      loadingMore={false}
      moreFailed={false}
      onLoadMore={noop}
      onOpenGame={noop}
      parent={parent}
      busyGameId={null}
      onToggleAdult={noop}
      onOpenJournal={noop}
      {...extra}
    />,
  );
}

describe('«Все партии»', () => {
  it('lists every game with its review, says which ones do not count, and offers the next page', () => {
    const html = card(false);
    expect(html).toContain('Все партии');
    expect(html).toContain('3 партии и ещё');
    expect(html.match(/>Разбор</g)).toHaveLength(3);
    expect(html).toContain('играл взрослый — не в успехах');
    expect(html).toContain('в архиве — не в успехах');
    expect(html).toContain('data-excluded="true"');
    expect(html).toContain('Показать ещё');
    // the child sees no parent tools
    expect(html).not.toContain('Это играл взрослый');
    expect(html).not.toContain('Журнал');
  });

  it('with the parent gate open: «Это играл взрослый» / «Вернуть в прогресс» and «Журнал» for every game', () => {
    const html = card(true);
    expect(html.match(/>Это играл взрослый</g)).toHaveLength(1);
    expect(html.match(/>Вернуть в прогресс</g)).toHaveLength(2);
    expect(html.match(/>Журнал</g)).toHaveLength(3);
    expect(card(true, { busyGameId: 'a' })).toContain('Сохраняю…');
    expect(card(false, { hasMore: false, moreFailed: true })).toContain('Не получилось — попробовать ещё');
  });

  it('the gate: hold three seconds or add two numbers', () => {
    const html = renderToStaticMarkup(<ParentLock onPass={noop} onCancel={noop} />);
    expect(html).toContain('Это для мамы и папы');
    expect(html).toContain('Нажать и держать 3 секунды');
    expect(html).toMatch(/сколько будет \d{2} \+ \d{2}\?/);
    expect(html).toContain('Отмена');
  });

  it('the journal: rendered read-only — no front matter, no HTML comments, tables and headings kept', () => {
    const markdown = ['---', 'schema: game-journal/1', 'counts_in_progress: false', '---', '', '# Партия с ботом Соня', '', '| | |', '|---|---|', '| Результат | **победа** |', '', '## Мысли после партии', '', '- Миша (голосом): «<b>не тег</b>»', '', '<!-- parent-notes:start -->', '<!-- parent-notes:end -->'].join('\n');
    const html = renderToStaticMarkup(<JournalBody journal={{ gameId: 'g1', fileName: '2026-09-21_0930_vs-sonya.md', markdown }} />);
    expect(html).toContain('2026-09-21_0930_vs-sonya.md');
    expect(html).toContain('<h2 data-level="1">Партия с ботом Соня</h2>');
    expect(html).toContain('<strong>победа</strong>');
    expect(html).toContain('Мысли после партии');
    expect(html).toContain('&lt;b&gt;не тег&lt;/b&gt;');
    expect(html).not.toContain('counts_in_progress');
    expect(html).not.toContain('parent-notes');
  });
});

describe('progressApi', () => {
  type FetchArgs = [input: string, init: RequestInit];
  function stubFetch(body: unknown, status = 200) {
    const mock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the parent routes of the contract', async () => {
    let fetchMock = stubFetch([]);
    await listGamesPage(21, 40);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/games?limit=21&offset=40');

    fetchMock = stubFetch({ id: 'a b', excluded: 'adult', profile: {} });
    await setGameExcluded('a b', 'adult');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/games/a%20b/excluded');
    expect(fetchMock.mock.calls[0]?.[1].method).toBe('PUT');
    expect(fetchMock.mock.calls[0]?.[1].body).toBe('{"excluded":"adult"}');
    expect((fetchMock.mock.calls[0]?.[1].headers as Record<string, string>)['Content-Type']).toBe('application/json');

    fetchMock = stubFetch({ archivedGames: 2, profile: {} });
    await expect(resetProgress()).resolves.toMatchObject({ archivedGames: 2 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/student/reset-progress');
    expect(fetchMock.mock.calls[0]?.[1].body).toBe('{"confirm":true}');

    fetchMock = stubFetch({ gameId: 'g1', fileName: 'x.md', markdown: '# x' });
    await expect(getGameJournal('g1')).resolves.toMatchObject({ markdown: '# x' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/games/g1/journal');
  });

  it('rejects with ApiError carrying the server code', async () => {
    stubFetch({ error: 'not-found' }, 404);
    const error = await getGameJournal('nope').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'not-found' });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    await expect(listGamesPage(21, 0)).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});
