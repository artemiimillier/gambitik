import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { computePositionFacts } from '../analysis/facts.ts';
import { buildMoveCheckAnswerRu, buildPositionAnswerRu, moveTextProblemRu, parseMoveText } from './answers.ts';
import { sanToSpokenRu } from './spoken.ts';
import { analysisOf, bestMoveJudgement, profile, queenBlunder } from './test-fixtures.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const LATIN = /[A-Za-z]/;

function after(...sans: string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

describe('parseMoveText — what a voice model may pass', () => {
  it.each([
    ['Nf3', 'g1f3'],
    ['g1f3', 'g1f3'],
    ['g1-f3', 'g1f3'],
    ['Кf3', 'g1f3'],
    ['конь на эф три', 'g1f3'],
    ['Конём на f3!', 'g1f3'],
    ['е4', 'e2e4'], // Cyrillic е
    ['пешка е четыре', 'e2e4'],
    ['e4', 'e2e4'],
    ['пешка с е два на е четыре', 'e2e4'],
  ])('%s → %s', (text, uci) => {
    const r = parseMoveText(START, text);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      expect(r.uci).toBe(uci);
      expect(r.spoken).not.toMatch(LATIN);
    }
  });

  it('Russian piece letters, the Cyrillic capture sign and castling in words', () => {
    const italian = after('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5');
    for (const text of ['O-O', '0-0', 'короткая рокировка', 'рокировка', 'Крg1']) {
      const r = parseMoveText(italian, text);
      expect(r.ok, text).toBe(true);
      if (r.ok) expect(r.san, text).toBe('O-O');
    }
    const scholar = after('e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6');
    for (const text of ['Фxf7', 'Фхf7#', 'Qxf7#', 'ферзь бьёт на эф семь']) {
      const r = parseMoveText(scholar, text);
      expect(r.ok, text).toBe(true);
      if (r.ok) expect(r.san, text).toBe('Qxf7#');
    }
    const bishop = parseMoveText(after('e4', 'e5'), 'Сc4');
    expect(bishop.ok && bishop.san).toBe('Bc4');
    const rook = parseMoveText('4k3/8/8/8/8/8/8/R3K3 w Q - 0 1', 'Лd1');
    expect(rook.ok && rook.san).toBe('Rd1');
  });

  it('explains in words why a move is impossible', () => {
    const why = (fen: string, text: string): string => {
      const r = parseMoveText(fen, text);
      expect(r.ok, text).toBe(false);
      return r.ok ? '' : moveTextProblemRu(r);
    };
    expect(why(START, 'Nf4')).toMatch(/конь так не ходит/);
    expect(why(START, 'Qh5')).toMatch(/путь загорожен/);
    expect(why(START, 'e5')).toMatch(/пешка так не ходит/);
    expect(why(START, 'Ke2')).toMatch(/на е два уже стоит своя фигура/);
    expect(why(START, 'O-O')).toMatch(/между королём и ладьёй ещё стоят фигуры/);
    expect(why('4k3/8/8/8/8/8/8/4K2R w - - 0 1', 'O-O')).toMatch(/король или ладья уже ходили/);
    // pinned knight: the bishop on b4 pins it to the king
    expect(why('4k3/8/8/8/1b6/8/3N4/4K3 w - - 0 1', 'Nf3')).toMatch(/связана/);
    // in check: only a move that answers the check is allowed
    expect(why('4k3/8/8/8/8/8/4r3/R3K3 w Q - 0 1', 'Ra8')).toMatch(/сейчас шах/);
    expect(why('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'Qd1')).toMatch(/на доске уже нет/);
    for (const text of ['Nf4', 'Qh5', 'O-O']) expect(why(START, text)).not.toMatch(LATIN);
  });

  it('two knights to one square is ambiguous; nonsense is unparsable', () => {
    const r = parseMoveText('4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1', 'конь на дэ два');
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    if (!r.ok) expect(moveTextProblemRu(r)).toMatch(/уточни/);
    expect(parseMoveText(START, 'привет')).toEqual({ ok: false, reason: 'unparsable' });
    expect(parseMoveText(START, '')).toEqual({ ok: false, reason: 'unparsable' });
    expect(parseMoveText('broken', 'e4')).toEqual({ ok: false, reason: 'unparsable' });
    expect(moveTextProblemRu({ ok: false, reason: 'unparsable' })).toMatch(/конь на эф три/);
  });
});

describe('buildMoveCheckAnswerRu — «а если я пойду…?»', () => {
  it('a dangerous move: the opponent\'s answer and the loss, never the better move', () => {
    const j = queenBlunder();
    const text = buildMoveCheckAnswerRu({ judgement: j, move: { uci: j.uci, san: j.san, fenBefore: j.fenBefore }, profile: profile() });
    expect(text).toMatch(/^Ученик спрашивает про ход: ферзь бьёт на е пять, шах/);
    expect(text).toMatch(/Опасно: после него у соперника сильный ответ — конь бьёт на е пять/);
    expect(text).toContain('ферзя');
    expect(text).toMatch(/станет хуже/);
    expect(text).toMatch(/Не говори, какой ход лучший/);
    expect(text).not.toContain(sanToSpokenRu(j.bestSan, j.fenBefore));
    expect(text).not.toMatch(LATIN);
  });

  it('a good move is only called safe — never «the best»', () => {
    const j = bestMoveJudgement('fork');
    const text = buildMoveCheckAnswerRu({ judgement: j, move: { uci: j.uci, san: j.san, fenBefore: j.fenBefore }, profile: profile({ address: 'f' }) });
    expect(text).toMatch(/Ход безопасный и хороший/);
    expect(text).not.toMatch(/самый сильный|лучший ход(?! ли)/);
    expect(text).not.toMatch(LATIN);
  });

  it('mate is celebrated; without an engine answer only the simple static check is given', () => {
    const fen = after('e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6');
    expect(buildMoveCheckAnswerRu({ judgement: null, move: { uci: 'h5f7', san: 'Qxf7#', fenBefore: fen } })).toMatch(/Это мат/);
    const hangs = buildMoveCheckAnswerRu({ judgement: null, move: { uci: 'h5h6', san: 'Qxh6', fenBefore: after('e4', 'h6', 'Qh5', 'g6') } });
    expect(hangs).toMatch(/Точная проверка сейчас недоступна/);
    const safe = buildMoveCheckAnswerRu({ judgement: null, move: { uci: 'g1f3', san: 'Nf3', fenBefore: START } });
    expect(safe).toMatch(/не стоит под боем без защиты/);
    expect(safe).not.toMatch(LATIN);
  });

  it('teacher mode: compares with the advice and allows naming only the advised moves (TEACHER-MODE §6.4)', () => {
    const j = queenBlunder();
    const advice = [
      { uci: 'f1c4', san: 'Bc4', source: 'repertoire' as const, arrow: 'green' as const, scoreCp: 40 },
      { uci: 'g1f3', san: 'Nf3', source: 'mainLine' as const, arrow: 'blue' as const, scoreCp: 30 },
    ];
    const text = buildMoveCheckAnswerRu({ judgement: j, move: { uci: j.uci, san: j.san, fenBefore: j.fenBefore }, profile: profile(), advice });
    expect(text).toMatch(/Сравнение с советом учителя \(слон на цэ четыре или конь на эф три\): этот ход намного слабее совета/);
    expect(text).toMatch(/из других ходов можно назвать только ходы совета: слон на цэ четыре или конь на эф три/);
    expect(text).not.toMatch(/не предлагай другой ход/);
    expect(text).not.toMatch(LATIN);
    // the advised move itself
    const nf3 = bestMoveJudgement(undefined);
    const own = buildMoveCheckAnswerRu({
      judgement: nf3,
      move: { uci: nf3.uci, san: nf3.san, fenBefore: nf3.fenBefore },
      advice: [{ uci: nf3.uci, san: nf3.san, source: 'engine', arrow: 'blue', scoreCp: 80 }],
    });
    expect(own).toMatch(/Это ход из совета учителя \(синяя стрелка\)/);
    expect(own).not.toMatch(/Сравнение с советом/);
  });

  it('teacher mode: the gap to the advice in words (≤ 30 cp — just as good)', () => {
    const j = bestMoveJudgement(undefined, { evalAfter: { cp: 70, mate: null } });
    const text = buildMoveCheckAnswerRu({ judgement: j, move: { uci: j.uci, san: j.san, fenBefore: j.fenBefore }, advice: [{ uci: 'a2a3', san: 'a3', source: 'engine', arrow: 'green', scoreCp: 95 }] });
    expect(text).toMatch(/примерно так же хорошо, как совет/);
  });

  it('remembers that this very move was just taken back', () => {
    const j = queenBlunder();
    const text = buildMoveCheckAnswerRu({ judgement: j, move: { uci: j.uci, san: j.san, fenBefore: j.fenBefore }, takenBackBefore: true });
    expect(text).toContain('Это тот самый ход, который недавно вернули.');
  });
});

describe('buildPositionAnswerRu — «что сейчас на доске?»', () => {
  const fen = after('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4');
  const base = {
    fen,
    facts: computePositionFacts(fen),
    childColor: 'w' as const,
    moveNumber: 4,
    lastMoves: [
      { san: 'Bc4', fenBefore: after('e4', 'e5', 'Nf3', 'Nc6'), by: 'child' as const },
      { san: 'Nd4', fenBefore: after('e4', 'e5', 'Nf3', 'Nc6', 'Bc4'), by: 'bot' as const },
    ],
  };

  it('whose move, the last moves, material, threats — in words, without the best move; never the clock readings', () => {
    const analysis = analysisOf(fen, 'Nxd4');
    const threat = { uci: 'd4f3', san: 'Nxf3+', motif: 'removeDefender' as const, targetSquares: ['f3'], gainCp: 300 };
    const text = buildPositionAnswerRu({ ...base, analysis, threat, clock: { child: 440_000, opponent: 481_000 }, opening: { name: 'Итальянская партия', title: 'Тихая итальянка', idea: 'Развиваем фигуры.' } });
    // the obvious (colour, move number, whose move) is no fact to retell — only a reference for a direct question
    expect(text).toMatch(/^Сейчас дебют\. /);
    expect(text).not.toMatch(/^[^.]*(белыми|ход ученика)/);
    expect(text).toMatch(/Только если ученик сам спросит об этом: ученик играет белыми, идёт 4-й ход, сейчас ход ученика\. Сам этого не говори — это видно на экране\.$/);
    expect(text).toContain('Ход ученика: слон на цэ четыре.');
    expect(text).toContain('Последний ход соперника: конь на дэ четыре');
    expect(text).toContain('Материал равный.');
    // «у тебя осталось четыре минуты…» must never be read out — the child sees the clock
    expect(text).not.toMatch(/Часы|минут|секунд|время/i);
    expect(text).toContain('соперник сыграет конь бьёт на эф три, шах');
    expect(text).toContain('Дебют: Итальянская партия.');
    expect(text).toContain('Лучший ход не называй');
    expect(text).not.toContain(sanToSpokenRu('Nxd4', fen));
    expect(text).not.toMatch(LATIN);
    expect(text).not.toMatch(/движ|ребён/);
  });

  it('«Учитель»: no «Лучший ход не называй» next to the teacher\'s advice — the advised moves may be named', () => {
    const helper = buildPositionAnswerRu({ ...base, threat: null });
    expect(helper).toContain('Лучший ход не называй: для этого есть подсказки по ступенькам.');
    const teacher = buildPositionAnswerRu({ ...base, threat: null, teacher: true });
    expect(teacher).not.toMatch(/Лучший ход не называй|подсказки по ступенькам/);
    expect(teacher).toContain('Ходы ученика называй только из совета учителя, если он есть в этом ответе; слово «лучший» не говори.');
    const girl = buildPositionAnswerRu({ ...base, threat: null, teacher: true, profile: { address: 'f' } });
    expect(girl).toContain('Ходы ученицы называй только из совета учителя');
    expect(girl).toMatch(/Только если ученица сама спросит об этом: ученица играет белыми/);
    // exam: the reference line too, nothing else changes
    const exam = buildPositionAnswerRu({ ...base, examMode: true, threat: null });
    expect(exam).toMatch(/Только если ученик сам спросит об этом/);
    // Black to move, the bot thinking, a finished game
    const blackFen = after('e4');
    const black = buildPositionAnswerRu({ fen: blackFen, facts: computePositionFacts(blackFen), childColor: 'w', moveNumber: 1 });
    expect(black).toMatch(/ученик играет белыми, идёт 1-й ход, сейчас ходит соперник\./);
    const over = buildPositionAnswerRu({ ...base, gameOver: true, threat: null });
    expect(over).toMatch(/^Сейчас дебют\. Партия уже закончилась\./);
    expect(over).not.toMatch(/сейчас ход ученика/);
  });

  it('knows when there is no threat, and finds a mate threat on its own', () => {
    const untimed = buildPositionAnswerRu({ ...base, threat: null, clock: null });
    expect(untimed).toMatch(/Сильных угроз у соперника сейчас нет\./);
    expect(untimed).not.toMatch(/часов|Часы/);
    const mateFen = '4r1k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 30';
    const text = buildPositionAnswerRu({ fen: mateFen, facts: computePositionFacts(mateFen), childColor: 'w' });
    expect(text).toMatch(/ладья на е один, мат/);
    expect(text).toMatch(/сначала защита короля/);
  });

  it('exam: neutral facts only — no threats, no weak spots', () => {
    const text = buildPositionAnswerRu({ ...base, examMode: true, threat: { uci: 'd4f3', san: 'Nxf3+', motif: 'fork', targetSquares: ['f3'], gainCp: 300 } });
    expect(text).toMatch(/Это экзамен/);
    expect(text).not.toMatch(/Под боем|угроз(?!ы, опасные)|соперник сыграет|без надёжной защиты/);
  });

  it('the opponent\'s loose piece is mentioned without its square', () => {
    const loose = after('d4', 'e5');
    const text = buildPositionAnswerRu({ fen: loose, facts: computePositionFacts(loose), childColor: 'w' });
    expect(text).toMatch(/У соперника есть фигура без надёжной защиты — не называй какую/);
    expect(text).not.toContain('е пять');
  });
});
