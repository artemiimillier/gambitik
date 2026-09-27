/** Test-only fixtures (not imported by production code): a short real game with a taken-back attempt. */
import { Chess } from 'chess.js';
import type { GameRecord, MoveClass, MoveJudgement } from '@gambit/shared';

export function judgementOf(fenBefore: string, san: string, bestSan: string, classification: MoveClass, ply: number): MoveJudgement {
  const played = new Chess(fenBefore).move(san);
  const best = new Chess(fenBefore).move(bestSan);
  const loss = classification === 'blunder' ? 47 : classification === 'inaccuracy' ? 7 : 0;
  return {
    ply,
    color: played.color,
    san: played.san,
    uci: `${played.from}${played.to}${played.promotion ?? ''}`,
    fenBefore,
    fenAfter: played.after,
    evalBefore: { cp: 30, mate: null },
    evalAfter: { cp: 30 - loss * 10, mate: null },
    winPctBefore: 52,
    winPctAfter: 52 - loss,
    winPctLoss: loss,
    classification,
    accuracy: 100 - loss,
    bestUci: `${best.from}${best.to}${best.promotion ?? ''}`,
    bestSan: best.san,
    bestPvSan: [best.san],
    refutationPvSan: classification === 'blunder' ? ['Nxe5'] : [],
    refutationPvUci: classification === 'blunder' ? ['c6e5'] : [],
    ...(classification === 'blunder' ? { allowedMotif: 'hangingPiece' as const } : {}),
    materialLossPawns: classification === 'blunder' ? 8 : 0,
    confidence: 'confirmed',
  };
}

const FEN_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_MOVE2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
export const FEN_MOVE3 = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3';
const FEN_MOVE4 = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

export function sampleRecord(overrides: Partial<GameRecord> = {}): GameRecord {
  const judgements: MoveJudgement[] = [
    judgementOf(FEN_START, 'e4', 'e4', 'best', 1),
    judgementOf(FEN_MOVE2, 'Qh5', 'Nf3', 'inaccuracy', 3),
    judgementOf(FEN_MOVE3, 'Qxe5+', 'Bc4', 'blunder', 5),
    judgementOf(FEN_MOVE3, 'Bc4', 'Bc4', 'best', 5),
    judgementOf(FEN_MOVE4, 'Qxf7#', 'Qxf7#', 'best', 7),
  ];
  return {
    id: 'game-1',
    startedAt: '2026-09-21T10:00:00.000Z',
    endedAt: '2026-09-21T10:04:00.000Z',
    personaId: 'petya',
    timeControlId: 'rapid10',
    childColor: 'w',
    result: '1-0',
    termination: 'checkmate',
    pgn: '1. e4 {[%clk 0:09:56]} e5 2. Qh5 {[%clk 0:09:48]} Nc6 3. Bc4 {[%clk 0:09:17]} Nf6 4. Qxf7# {[%clk 0:09:08]} 1-0',
    events: [
      { t: 0, type: 'gameStart', data: { personaId: 'petya' } },
      { t: 4000, type: 'move', ply: 1, data: { san: 'e4', uci: 'e2e4', by: 'child' } },
      { t: 6000, type: 'move', ply: 2, data: { san: 'e5', uci: 'e7e5', by: 'bot' } },
      { t: 12000, type: 'move', ply: 3, data: { san: 'Qh5', uci: 'd1h5', by: 'child' } },
      { t: 14000, type: 'move', ply: 4, data: { san: 'Nc6', uci: 'b8c6', by: 'bot' } },
      { t: 21000, type: 'move', ply: 5, data: { san: 'Qxe5+', uci: 'h5e5', by: 'child', takenBack: true } },
      { t: 21400, type: 'takebackOffered', ply: 5, data: { san: 'Qxe5+', winPctLoss: 47, motif: 'hangingPiece' } },
      { t: 27000, type: 'takebackAccepted', ply: 5, data: { san: 'Qxe5+' } },
      { t: 30000, type: 'hintRequested', ply: 5, data: {} },
      { t: 30300, type: 'hintGiven', ply: 5, data: { level: 1, text: 'Какая фигура ещё не вышла?' } },
      { t: 41000, type: 'childSaid', ply: 5, data: { text: 'Слон может пойти на це четыре!' } },
      { t: 44000, type: 'move', ply: 5, data: { san: 'Bc4', uci: 'f1c4', by: 'child' } },
      { t: 47000, type: 'move', ply: 6, data: { san: 'Nf6', uci: 'g8f6', by: 'bot' } },
      { t: 52000, type: 'move', ply: 7, data: { san: 'Qxf7#', uci: 'h5f7', by: 'child' } },
      { t: 52500, type: 'gameEnd', data: { result: '1-0' } },
    ],
    judgements,
    summary: {
      accuracy: 81.4,
      acpl: 38,
      counts: { best: 3, excellent: 0, good: 0, inaccuracy: 1, mistake: 0, blunder: 1, missedWin: 0 },
      takebacksOffered: 1,
      takebacksAccepted: 1,
      hintsUsed: 1,
      motifsMissed: [],
      motifsAllowed: ['hangingPiece'],
      keyMoments: [
        {
          ply: 5,
          fenBefore: FEN_MOVE3,
          playedSan: 'Qxe5+',
          bestSan: 'Bc4',
          classification: 'blunder',
          motif: 'hangingPiece',
          explanation: 'Пешку защищает конь, поэтому ферзь пропал бы. Хорошо, что ход был возвращён.',
        },
      ],
    },
    examMode: false,
    ...overrides,
  };
}
