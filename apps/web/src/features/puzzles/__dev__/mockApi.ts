/**
 * DEV ONLY — an in-browser stand-in for the local server, so the secondary screens can be looked at
 * without starting @gambit/server (and without touching the real data/ directory).
 * Installed by screens.main.tsx; never imported by production code.
 */
import { CURRICULUM, PERSONAS } from '@gambit/content';
import { buildTemplateReview } from '@gambit/core';
import type { GameListItem, GameReview, HealthInfo, ProgressSnapshot, Puzzle, PuzzleAttempt, StudentProfile } from '@gambit/shared';
import { sampleRecord } from '../../review/testFixtures.ts';

const PUZZLES: Puzzle[] = [
  { id: '0URgB', fen: '3r3k/pq4pp/4r3/3R4/2p1p3/8/P1P2PPP/3R2K1 w - - 0 31', lastMoveUci: 'f6e6', solutionUci: ['d5d8', 'e6e8', 'd8e8'], rating: 438, themes: ['backRankMate', 'endgame', 'mate', 'mateIn2', 'short'] },
  { id: 'mRP8m', fen: '6k1/5p1p/8/p1Pn2p1/2B5/P5P1/7P/5K2 b - - 2 35', lastMoveUci: 'd3c4', solutionUci: ['d5e3', 'f1e2', 'e3c4'], rating: 486, themes: ['crushing', 'endgame', 'fork', 'short'] },
  { id: 'jNjSQ', fen: '8/8/7P/5p2/K3p3/5k2/8/8 w - - 1 44', lastMoveUci: 'e3f3', solutionUci: ['h6h7', 'e4e3', 'h7h8q'], rating: 453, themes: ['advancedPawn', 'crushing', 'endgame', 'pawnEndgame', 'promotion', 'short'] },
  { id: 'two-mates', fen: '6k1/5ppp/8/8/8/8/5PPP/R3R1K1 w - - 0 1', lastMoveUci: 'h8g8', solutionUci: ['a1a8'], rating: 400, themes: ['mateIn1', 'backRankMate', 'oneMove'] },
  { id: 'S8pw0', fen: '8/8/pp1b4/8/2PN1p1k/1P2pP2/P3K3/8 w - - 18 56', lastMoveUci: 'g5h4', solutionUci: ['d4f5', 'h4g5', 'f5d6'], rating: 442, themes: ['crushing', 'endgame', 'fork', 'short'] },
  { id: 'OXRlH', fen: '8/1kbQ4/1N4p1/2r4p/8/7P/5PP1/6K1 b - - 0 47', lastMoveUci: 'd5b6', solutionUci: ['c5c1', 'd7d1', 'c1d1'], rating: 424, themes: ['endgame', 'mate', 'mateIn2', 'short'] },
];

let profile: StudentProfile = {
  nickname: 'Тёма',
  address: 'm',
  stage: 2,
  totals: { games: 12, wins: 7, losses: 4, draws: 1, puzzlesAttempted: 64, puzzlesSolved: 41, minutesPlayed: 135 },
  puzzleRating: { rating: 742, rd: 95, vol: 0.06, attempts: 64, solved: 41, lastSeen: '2026-09-20T17:00:00.000Z' },
  themeSkills: {
    mateIn1: { rating: 880, rd: 90, vol: 0.06, attempts: 30, solved: 24, lastSeen: null },
    hangingPiece: { rating: 640, rd: 110, vol: 0.06, attempts: 14, solved: 6, lastSeen: null },
    fork: { rating: 760, rd: 120, vol: 0.06, attempts: 12, solved: 8, lastSeen: null },
    backRankMate: { rating: 700, rd: 200, vol: 0.06, attempts: 3, solved: 2, lastSeen: null },
  },
  recentAccuracy: [61, 58, 66, 70, 64, 72, 69, 75],
  weaknesses: ['Фигура без защиты', 'Задачи: Незащищённая фигура'],
  strengths: ['Задачи: Мат в 1 ход', 'Вилка (находит сам)'],
  bestWin: 'grisha',
  updatedAt: '2026-09-21T09:00:00.000Z',
};

const record = sampleRecord();
let reviewPolls = 0;

function progress(): ProgressSnapshot {
  const accuracy = [48, 55, 52, 61, 58, 66, 70, 64, 72, 69, 75, 81];
  const blunders = [5, 4, 4, 3, 4, 2, 2, 3, 1, 2, 1, 1];
  return {
    profile,
    games: accuracy.map((a, i) => ({
      date: new Date(Date.UTC(2026, 8, 5 + i, 15)).toISOString(),
      gameId: i === accuracy.length - 1 ? record.id : `demo-${i}`,
      accuracy: a,
      blunders: blunders[i] ?? 0,
      personaId: i < 5 ? 'petya' : i < 9 ? 'sonya' : 'grisha',
      result: i % 3 === 1 ? '0-1' : '1-0',
    })),
    puzzleRatingHistory: Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 1 + Math.floor(i / 2), 12 + (i % 2))).toISOString(), rating: 600 + i * 4 + Math.round(Math.sin(i / 2) * 25) })),
    themeTable: Object.entries(profile.themeSkills).map(([theme, skill]) => ({
      theme,
      title: { mateIn1: 'Мат в 1 ход', hangingPiece: 'Незащищённая фигура', fork: 'Вилка', backRankMate: 'Мат на последней линии' }[theme] ?? theme,
      rating: skill.rating,
      attempts: skill.attempts,
      solved: skill.solved,
    })),
    stage: CURRICULUM[1] ?? (CURRICULUM[0] as ProgressSnapshot['stage']),
    nextStage: CURRICULUM[2] ?? null,
  };
}

function games(): GameListItem[] {
  return progress()
    .games.map(
      (g, i): GameListItem => ({
        id: g.gameId,
        startedAt: g.date,
        personaId: g.personaId,
        timeControlId: i % 2 === 0 ? 'rapid10' : 'blitz5',
        childColor: 'w',
        result: g.result,
        accuracy: g.accuracy,
        blunders: g.blunders,
        reviewStatus: i % 4 === 0 ? 'pending' : 'template',
      }),
    )
    .reverse();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function handle(method: string, path: string, body: unknown): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (path === '/api/health') {
    const health: HealthInfo = { ok: true, llm: { codexCli: false, codexLoggedIn: false, openaiKey: false }, voice: { realtime: false, model: '', voice: '' }, puzzles: { count: PUZZLES.length } };
    return json(health);
  }
  if (path === '/api/student') return json(profile);
  if (path.startsWith('/api/puzzles/next')) {
    const theme = new URL(path, 'http://x').searchParams.get('theme');
    const pool = theme ? PUZZLES.filter((p) => p.themes.includes(theme)) : PUZZLES;
    return json(pool);
  }
  if (path === '/api/puzzles/attempt' && method === 'POST') {
    const attempt = body as PuzzleAttempt;
    const delta = attempt.solved ? (attempt.hintsUsed > 0 ? 3 : 11) : -8;
    profile = { ...profile, puzzleRating: { ...profile.puzzleRating, rating: profile.puzzleRating.rating + delta, attempts: profile.puzzleRating.attempts + 1 } };
    return json({ puzzleRating: profile.puzzleRating });
  }
  if (path.startsWith('/api/games?')) return json(games());
  if (/^\/api\/games\/[^/]+\/review$/.test(path)) {
    reviewPolls++;
    const pending = reviewPolls < 3;
    const review: GameReview = { gameId: record.id, status: pending ? 'pending' : 'template', provider: 'template', markdown: pending ? '' : buildTemplateReview(record, PERSONAS.petya, profile) };
    return json(review);
  }
  if (/^\/api\/games\/[^/]+$/.test(path)) return path.endsWith('/missing') ? json({ error: 'not-found' }, 404) : json(record);
  if (path === '/api/progress') return json(progress());
  if (path === '/api/curriculum') return json({ stages: CURRICULUM, current: profile.stage });
  return json({ error: 'not-found' }, 404);
}

export function installMockApi(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    if (!path.startsWith('/api/')) return realFetch(input, init);
    let body: unknown;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    return handle((init?.method ?? 'GET').toUpperCase(), path, body);
  };
}
