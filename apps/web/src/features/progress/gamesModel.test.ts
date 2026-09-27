import { describe, expect, it } from 'vitest';
import type { GameListItem } from '@gambit/shared';
import { MAX_MARKDOWN_CHARS, parseMarkdown } from '../review/markdown.ts';
import { GAMES_PAGE_SIZE, JOURNAL_CHUNK_CHARS, appendPage, countedGames, exclusionOf, splitJournal, splitPage, withExclusion } from './gamesModel.ts';

function game(id: string, overrides: Partial<GameListItem> = {}): GameListItem {
  return { id, startedAt: '2026-09-21T09:30:00', personaId: 'sonya', timeControlId: 'blitz5', childColor: 'w', result: '1-0', accuracy: 74, blunders: 1, reviewStatus: 'ready', ...overrides };
}

describe('every game, page by page', () => {
  it('shows a page and knows from the extra row whether there is more', () => {
    const rows = Array.from({ length: GAMES_PAGE_SIZE + 1 }, (_, i) => game(`g${i}`));
    expect(splitPage(rows)).toEqual({ rows: rows.slice(0, GAMES_PAGE_SIZE), hasMore: true });
    expect(splitPage(rows.slice(0, 5))).toEqual({ rows: rows.slice(0, 5), hasMore: false });
    expect(splitPage([])).toEqual({ rows: [], hasMore: false });
  });

  it('never shows a game twice when the list moved between two pages', () => {
    expect(appendPage([game('a'), game('b')], [game('b'), game('c')]).map((g) => g.id)).toEqual(['a', 'b', 'c']);
  });

  it('reads the «играл взрослый / архив» mark tolerantly and updates one game', () => {
    expect(exclusionOf(game('a'))).toBeNull();
    expect(exclusionOf(game('a', { excluded: null }))).toBeNull();
    expect(exclusionOf(game('a', { excluded: 'adult' }))).toBe('adult');
    expect(exclusionOf({ ...game('a'), excluded: 'weird' } as unknown as GameListItem)).toBeNull();
    const list = [game('a'), game('b', { excluded: 'archived' }), game('c')];
    expect(withExclusion(list, 'a', 'adult').map(exclusionOf)).toEqual(['adult', 'archived', null]);
    expect(countedGames(list)).toBe(2);
  });
});

describe('splitJournal', () => {
  const journal = [
    '---',
    'schema: game-journal/1',
    'game_id: "g1"',
    '---',
    '',
    '# Партия с ботом Соня',
    '',
    '| № | Белые | Чёрные | Заметка |',
    '|---:|---|---|---|',
    ...Array.from({ length: 200 }, (_, i) => `| ${i + 1} | e4 | e5 | ход номер ${i + 1}, спокойный и хороший |`),
    '',
    '## Общение с тренером',
    '',
    ...Array.from({ length: 300 }, (_, i) => `- \`00:${String(i % 60).padStart(2, '0')}\` — Тренер (голосом): «Реплика ${i}: смотри в центр доски.»`),
    '',
    '<!-- parent-notes:start -->',
    '## Заметки родителя',
    '<!-- parent-notes:end -->',
  ].join('\n');

  it('cuts a long journal into chunks the safe renderer takes whole, losing nothing', () => {
    const chunks = splitJournal(journal);
    expect(journal.length).toBeGreaterThan(MAX_MARKDOWN_CHARS * 2);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThan(MAX_MARKDOWN_CHARS);
    expect(chunks.join('\n')).toBe(journal);
    expect(chunks[0]?.startsWith('---\nschema: game-journal/1')).toBe(true);
    // the move table stays whole: one chunk has its header and every row
    const withTable = chunks.find((chunk) => chunk.includes('| № | Белые |')) ?? '';
    expect(withTable).toContain('| 200 | e4 | e5 |');
    const table = parseMarkdown(withTable).find((block) => block.type === 'table');
    expect(table?.type === 'table' ? table.rows.length : 0).toBe(200);
  });

  it('keeps a short journal in one piece and cuts a hostile endless line hard', () => {
    expect(splitJournal('# Партия\n\nкоротко')).toEqual(['# Партия\n\nкоротко']);
    const hostile = splitJournal('x'.repeat(JOURNAL_CHUNK_CHARS * 3 + 5));
    expect(hostile.length).toBe(4);
    for (const chunk of hostile) expect(chunk.length).toBeLessThanOrEqual(JOURNAL_CHUNK_CHARS);
    expect(splitJournal('')).toEqual([]);
  });
});
