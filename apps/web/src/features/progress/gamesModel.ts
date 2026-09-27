/**
 * Pure logic of the games list on the progress screen: pages of every game, the «играл взрослый / архив» marks, and
 * how a long journal is cut for the safe markdown renderer (review/markdown.ts renders at most 12 000 characters).
 */
import type { GameExclusion, GameListItem } from '@gambit/shared';

/** Games per «Показать ещё». */
export const GAMES_PAGE_SIZE = 20;

/** The page asks for one row more than it shows: that row only says «there is more». */
export function splitPage(rows: readonly GameListItem[], pageSize = GAMES_PAGE_SIZE): { rows: GameListItem[]; hasMore: boolean } {
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

/** Appends a page; a game already shown (the list moved while paging) is not repeated. */
export function appendPage(shown: readonly GameListItem[], page: readonly GameListItem[]): GameListItem[] {
  const ids = new Set(shown.map((game) => game.id));
  return [...shown, ...page.filter((game) => !ids.has(game.id))];
}

/** Why a game does not count in the progress; an older server sends no field → it counts. */
export function exclusionOf(game: GameListItem): GameExclusion | null {
  return game.excluded === 'adult' || game.excluded === 'archived' ? game.excluded : null;
}

export const EXCLUSION_LABEL: Record<GameExclusion, string> = { adult: 'играл взрослый', archived: 'в архиве' };

export function withExclusion(games: readonly GameListItem[], gameId: string, excluded: GameExclusion | null): GameListItem[] {
  return games.map((game) => (game.id === gameId ? { ...game, excluded } : game));
}

/** How many of the shown games count now (for «Начать прогресс заново»: «в архив уйдут N партий»). */
export function countedGames(games: readonly GameListItem[]): number {
  return games.filter((game) => exclusionOf(game) === null).length;
}

/** The safe renderer's limit is 12 000 characters; a chunk stays well below it. */
export const JOURNAL_CHUNK_CHARS = 10_000;

/**
 * Cuts a journal into chunks the markdown renderer takes whole: only between lines and never inside a table (its
 * header would be lost). The front matter stays in the first chunk (the renderer drops it there). A single line longer
 * than a chunk is cut hard — a journal never has one, a hostile file may.
 */
export function splitJournal(markdown: string, maxChars = JOURNAL_CHUNK_CHARS): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (current.length > 0) chunks.push(current.join('\n'));
    current = [];
    size = 0;
  };
  for (const raw of lines) {
    const pieces = raw.length > maxChars ? (raw.match(new RegExp(`[^]{1,${maxChars}}`, 'g')) ?? [raw]) : [raw];
    for (const line of pieces) {
      const inTable = line.startsWith('|') && (current[current.length - 1] ?? '').startsWith('|');
      if (size + line.length + 1 > maxChars && !inTable) flush();
      else if (size + line.length + 1 > maxChars * 1.15) flush(); // a table longer than a chunk: cut it after all
      current.push(line);
      size += line.length + 1;
    }
  }
  flush();
  return chunks.filter((chunk) => chunk.trim() !== '');
}
