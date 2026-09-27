import { describe, expect, it } from 'vitest';
import { REVIEW_POLL_MAX_MS, START_FEN, boardAt, buildReviewModel, cursorOfPosition, positionKey, shouldKeepPolling, takebackImproved, toMoveRows } from './reviewModel.ts';
import { FEN_MOVE3, judgementOf, sampleRecord } from './testFixtures.ts';

describe('buildReviewModel', () => {
  const model = buildReviewModel(sampleRecord());

  it('rebuilds the main line from the PGN (clock comments are ignored)', () => {
    expect(model.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
    expect(model.startFen).toBe(START_FEN);
    expect(model.moves[2]).toMatchObject({ ply: 3, moveNumber: 2, color: 'w', uci: 'd1h5', from: 'd1', to: 'h5', byChild: true });
    expect(model.moves[3]?.byChild).toBe(false);
    expect(model.moves[4]?.fenBefore).toBe(FEN_MOVE3);
  });

  it("attaches judgements to the child's moves only, by position and SAN", () => {
    expect(model.moves.filter((m) => m.judgement).map((m) => `${m.san}:${m.judgement?.classification}`)).toEqual(['e4:best', 'Qh5:inaccuracy', 'Bc4:best', 'Qxf7#:best']);
    expect(model.moves.filter((m) => !m.byChild).every((m) => m.judgement === undefined)).toBe(true);
  });

  it('keeps the taken-back attempt out of the main line but remembers it', () => {
    expect(model.takenBack.map((j) => j.san)).toEqual(['Qxe5+']);
    expect(model.moves.some((m) => m.san === 'Qxe5+')).toBe(false);
  });

  it('tells the story in the timeline, in order, pointing at the right position', () => {
    expect(model.timeline.map((item) => item.kind)).toEqual(['takenBack', 'hint', 'childSaid']);
    const [takenBack, hint, said] = model.timeline;
    expect(takenBack).toMatchObject({ kind: 'takenBack', san: 'Qxe5+', cursor: 4 });
    expect(takenBack?.kind === 'takenBack' && takenBack.judgement?.classification).toBe('blunder');
    expect(hint).toMatchObject({ kind: 'hint', level: 1, cursor: 4 });
    expect(said).toMatchObject({ kind: 'childSaid', text: 'Слон может пойти на це четыре!' });
    expect(new Set(model.timeline.map((item) => item.id)).size).toBe(model.timeline.length);
  });

  it('says «найден ход лучше» only when the move that stayed really is a different, better one', () => {
    const takenBack = model.timeline.find((item) => item.kind === 'takenBack');
    expect(takenBack?.kind === 'takenBack' && takenBack.improved).toBe(true); // Qxe5+ (−47) → Bc4 (best)

    // the child took the blunder back and then played the very same blunder again
    const record = sampleRecord();
    const blunder = judgementOf(FEN_MOVE3, 'Qxe5+', 'Bc4', 'blunder', 5);
    expect(takebackImproved(blunder, [judgementOf(FEN_MOVE3, 'Qxe5+', 'Bc4', 'blunder', 5)])).toBe(false);
    // a different move that is no better does not count either
    expect(takebackImproved(blunder, [{ ...judgementOf(FEN_MOVE3, 'Nf3', 'Bc4', 'blunder', 5), winPctLoss: 50 }])).toBe(false);
    // nothing judged at that position / no attempt known
    expect(takebackImproved(blunder, [record.judgements[0]!])).toBe(false);
    expect(takebackImproved(undefined, record.judgements)).toBe(false);
  });

  it('does not depend on the ply convention of the judgements', () => {
    const record = sampleRecord();
    const zeroBased = { ...record, judgements: record.judgements.map((j) => ({ ...j, ply: j.ply - 1 })) };
    const shifted = buildReviewModel(zeroBased);
    expect(shifted.moves.filter((m) => m.judgement).length).toBe(4);
    expect(shifted.takenBack.map((j) => j.san)).toEqual(['Qxe5+']);
  });

  it('records a declined take-back as a kept move', () => {
    const record = sampleRecord();
    const events = record.events.filter((e) => e.type !== 'takebackAccepted' && e.data.takenBack !== true);
    events.push({ t: 60000, type: 'takebackOffered', ply: 3, data: { san: 'Qh5' } }, { t: 61000, type: 'takebackDeclined', ply: 3, data: {} });
    const kept = buildReviewModel({ ...record, events }).timeline.find((item) => item.kind === 'keptMove');
    expect(kept).toMatchObject({ san: 'Qh5', cursor: 2 });
  });

  it('adds attempts that were taken back without a journal event', () => {
    const record = sampleRecord();
    const silent = buildReviewModel({ ...record, events: record.events.filter((e) => !e.type.startsWith('takeback')) });
    expect(silent.timeline.filter((item) => item.kind === 'takenBack')).toHaveLength(1);
  });

  it('falls back to the move events when the PGN is empty or broken', () => {
    for (const pgn of ['', 'это не партия 1. Zz9']) {
      const fromEvents = buildReviewModel(sampleRecord({ pgn }));
      expect(fromEvents.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
    }
  });

  it('survives an empty game and hostile event data', () => {
    const empty = buildReviewModel(sampleRecord({ pgn: '', events: [], judgements: [] }));
    expect(empty.moves).toEqual([]);
    expect(empty.startFen).toBe(START_FEN);
    expect(boardAt(empty, 0)).toEqual({ fen: START_FEN, lastMove: null, move: null });
    const weird = buildReviewModel(
      sampleRecord({
        events: [
          { t: 1, type: 'childSaid', data: { text: 42 } },
          { t: 2, type: 'hintGiven', data: { level: 'много' } },
          { t: 3, type: 'takebackAccepted', ply: Number.NaN, data: { san: { nested: true } } },
          { t: 4, type: 'childSaid', ply: 9999, data: { event: { text: 'x'.repeat(1000) } } },
        ],
      }),
    );
    const said = weird.timeline.find((item) => item.kind === 'childSaid');
    expect(said?.kind === 'childSaid' && said.text.length).toBe(280);
    expect(said?.cursor).toBe(weird.moves.length);
    expect(weird.timeline.find((item) => item.kind === 'hint')).toMatchObject({ level: null });
  });
});

describe('board helpers', () => {
  const model = buildReviewModel(sampleRecord());

  it('boardAt returns the position and the last move for a cursor', () => {
    expect(boardAt(model, 0)).toMatchObject({ fen: START_FEN, lastMove: null });
    expect(boardAt(model, 1)).toMatchObject({ lastMove: { from: 'e2', to: 'e4' } });
    expect(boardAt(model, 7).move?.san).toBe('Qxf7#');
    expect(boardAt(model, 99).move).toBeNull();
  });

  it('cursorOfPosition ignores the move counters', () => {
    expect(cursorOfPosition(model, FEN_MOVE3)).toBe(4);
    expect(cursorOfPosition(model, FEN_MOVE3.replace(/2 3$/, '0 1'))).toBe(4);
    expect(cursorOfPosition(model, START_FEN)).toBe(0);
    expect(cursorOfPosition(model, model.moves[6]?.fenAfter ?? '')).toBe(7);
    expect(cursorOfPosition(model, '8/8/8/8/8/8/8/K6k w - - 0 1')).toBe(-1);
    expect(positionKey('a b c d 5 6')).toBe('a b c d');
  });

  it('groups moves into numbered rows', () => {
    const rows = toMoveRows(model.moves);
    expect(rows.map((r) => `${r.moveNumber}:${r.white?.san ?? '-'}:${r.black?.san ?? '-'}`)).toEqual(['1:e4:e5', '2:Qh5:Nc6', '3:Bc4:Nf6', '4:Qxf7#:-']);
    const blackFirst = toMoveRows(model.moves.slice(1));
    expect(blackFirst[0]).toMatchObject({ moveNumber: 1, white: null });
    expect(blackFirst[0]?.black?.san).toBe('e5');
    expect(toMoveRows([])).toEqual([]);
  });
});

describe('shouldKeepPolling', () => {
  it('polls only while pending and only for about a minute', () => {
    expect(shouldKeepPolling('pending', 0)).toBe(true);
    expect(shouldKeepPolling('pending', 30_000)).toBe(true);
    expect(shouldKeepPolling('pending', REVIEW_POLL_MAX_MS)).toBe(false);
    expect(shouldKeepPolling('pending', REVIEW_POLL_MAX_MS - 1000)).toBe(false);
    for (const status of ['ready', 'template', 'failed'] as const) expect(shouldKeepPolling(status, 0)).toBe(false);
  });
});
