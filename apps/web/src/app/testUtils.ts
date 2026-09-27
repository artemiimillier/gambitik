/** Test-only helpers of the shell (never imported by production code). */
import type { GameListItem, HealthInfo, StudentProfile } from '@gambit/shared';
import type { KeyValueStorage } from './shellSettings.ts';

export interface MemoryStorage extends KeyValueStorage {
  data: Map<string, string>;
}

export function createMemoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

export function sampleProfile(overrides: Partial<StudentProfile> = {}): StudentProfile {
  return {
    nickname: 'Тигр',
    address: 'm',
    stage: 2,
    totals: { games: 3, wins: 1, losses: 2, draws: 0, puzzlesAttempted: 10, puzzlesSolved: 7, minutesPlayed: 42 },
    puzzleRating: { rating: 640, rd: 200, vol: 0.06, attempts: 10, solved: 7, lastSeen: null },
    themeSkills: {},
    recentAccuracy: [61, 70],
    weaknesses: [],
    strengths: [],
    bestWin: 'petya',
    updatedAt: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

export function sampleGame(overrides: Partial<GameListItem> = {}): GameListItem {
  return {
    id: 'g1',
    startedAt: '2026-09-21T09:30:00',
    personaId: 'sonya',
    timeControlId: 'rapid10',
    childColor: 'w',
    result: '1-0',
    accuracy: 74,
    blunders: 1,
    reviewStatus: 'ready',
    ...overrides,
  };
}

export function sampleHealth(overrides: Partial<HealthInfo> = {}): HealthInfo {
  return {
    ok: true,
    llm: { codexCli: false, codexLoggedIn: false, openaiKey: false },
    voice: { realtime: false, model: 'gpt-realtime-2.1', voice: 'marin' },
    puzzles: { count: 402 },
    ...overrides,
  };
}
