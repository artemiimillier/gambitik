import { describe, expect, it } from 'vitest';
import { lessonLine } from '../../packages/content/src/index.ts';
import type { LessonLine } from '../../packages/content/src/index.ts';
import type { DangerRecord, EvRecord, GameRecord, TurnRecord } from './config.ts';
import {
  adviceOf,
  auditBestVerdict,
  auditPraiseVerdict,
  auditQuizVerdict,
  blitzSentencesAllowed,
  boardShowsAdvice,
  buildReport,
  captureRuleBroken,
  claimsBestLead,
  crossGameRepeats,
  deicticIssues,
  gameStats,
  gatesFailed,
  hygieneIssues,
  miniSay,
  miniTopicOf,
  normText,
  observations,
  openerOf,
  parseJsonLines,
  parseRun,
  praiseTier,
  recordingEstimate,
  saySentences,
  secondDay,
  splitSentences,
  themeAnnouncementSay,
  wordCapOf,
} from './report.ts';
import type { DeepView } from './report.ts';

// ───────────────────────── hand-made records ─────────────────────────

let n = 0;
function ev(game: string, text: string, o: Partial<EvRecord> = {}): EvRecord {
  return { t: 'ev', game, n: n++, afterPly: 0, ply: 1, atMs: 0, source: 'turn', moment: 'advice', kind: 'teachTurn', priority: 1, text, bubble: text, say: [], cues: [], ...o };
}

function turn(ply: number, o: Partial<TurnRecord> = {}): TurnRecord {
  return {
    ply,
    fen: '',
    moment: 'advice',
    advice: { uci: 'e2e4', san: 'e4' },
    adviceHidden: false,
    revealAfterMs: null,
    hints: [],
    quiz: null,
    reveal: null,
    buttons: [],
    move: { uci: 'e2e4', san: 'e4', how: 'arrow', arrowShown: true, thinkMs: 3000 },
    ...o,
  };
}

function game(id: string, o: Partial<GameRecord> = {}): GameRecord {
  return {
    t: 'game',
    game: id,
    child: 1,
    stage: 1,
    gameNo: 1,
    seed: 1,
    name: 'Миша',
    address: 'm',
    childColor: 'w',
    tc: 'blitz5',
    persona: 'petya',
    strategyId: 'italian',
    strategyTitle: 'Итальянская партия',
    family: 'development',
    plies: [{ by: 'child', uci: 'e2e4', san: 'e4', thinkMs: 3000 }],
    turns: [turn(1)],
    result: '1-0',
    termination: 'checkmate',
    takeaway: 'Вывод.',
    takeawayKey: 'found.tactic',
    events: 0,
    bookBytes: 1000,
    ...o,
  };
}

// ───────────────────────── words ─────────────────────────

describe('words', () => {
  it('normalises text and splits sentences', () => {
    expect(normText('«Ёлки», — сказал Конь! Да…')).toBe('елки сказал конь да');
    expect(splitSentences('Кто защитит коня? Пешка! Вот так.')).toEqual(['Кто защитит коня?', 'Пешка!', 'Вот так.']);
    expect(splitSentences('   ')).toEqual([]);
  });

  it('openers: the first words, piece words → {фигура}', () => {
    expect(openerOf('Давай сходим конём — он встанет ближе к центру.', 3)).toBe('давай сходим {фигура}');
    expect(openerOf('Пешка знает, что делать.', 2)).toBe('{фигура} знает');
    expect(openerOf('Ого!', 3)).toBe('ого');
  });

  it('the sentence of every said part: whole and lead start a sentence, a tail goes on, spoken options are one', () => {
    const say = [
      { pool: 'v3.lead.advice', n: 1, piece: 'n' as const },
      { pool: 'v3.idea.develop', n: 1 },
      { pool: 'v3.helper', n: 1, piece: 'n' as const },
      { pool: 'v3.quiz.cat.capture', n: 1 },
      { pool: 'v3.quiz.cat.develop', n: 1 },
    ];
    expect(saySentences(say)).toEqual([0, 0, 1, 2, 2]);
  });

  it('advice with and without an idea; «лучше всего» leads', () => {
    expect(adviceOf(ev('g', 'x', { say: [{ pool: 'v3.lead.advice', n: 1 }, { pool: 'v3.idea.develop', n: 2 }] }))).toEqual({ advice: true, idea: true });
    expect(adviceOf(ev('g', 'x', { say: [{ pool: 'v3.lead.advice', n: 1 }, { pool: 'v3.idea.none', n: 2 }] }))).toEqual({ advice: true, idea: false });
    expect(adviceOf(ev('g', 'x', { say: [{ pool: 'v3.aim.develop', n: 1 }, { pool: 'v3.go.move', n: 2 }] }))).toEqual({ advice: true, idea: true });
    expect(adviceOf(ev('g', 'x', { say: [{ pool: 'v3.praise.castled', n: 1 }] }))).toEqual({ advice: false, idea: false });
    expect(claimsBestLead([{ pool: 'v3.lead.advice', n: 1 }])).toBe(false);
  });
});

// ───────────────────────── hygiene ─────────────────────────

describe('hygiene of the words', () => {
  it('finds squares, Latin, «молодец» and a feminine Гамбитик — in the text, the bubble and the quiz card', () => {
    const rules = (e: EvRecord): string[] => hygieneIssues(e).map((h) => `${h.rule}:${h.where}`);
    expect(rules(ev('g', 'Конь на эф три.'))).toEqual(['square:text', 'square:bubble']);
    expect(rules(ev('g', 'Ход Nf3.', { bubble: 'Ход.' }))).toEqual(['latin:text']);
    expect(rules(ev('g', 'Молодец!'))).toContain('banned:text');
    expect(rules(ev('g', 'Так держать!'))).toContain('banned:text');
    expect(rules(ev('g', 'Я готова играть.'))).toContain('selfFeminine:text');
    expect(rules(ev('g', 'Давай сходим конём — он встанет ближе к центру.'))).toEqual([]);
    const quiz = { id: 'q', kind: 'oppIdea' as const, ply: 3, question: 'Что задумал соперник?', options: [{ id: 'a', label: 'Нападает' }, { id: 'b', label: 'Bxf7' }, { id: 'c', label: 'Хочет съесть' }], correctId: 'a' };
    expect(rules(ev('g', 'Что задумал соперник?', { quiz }))).toEqual(['latin:quiz']);
  });

  it('pointing words need a drawable cue in their sentence', () => {
    // v3.idea.improvePiece#1: «— с нового места видно все вот эти клетки.» (cue: attacks)
    const say = [
      { pool: 'v3.lead.advice', n: 1, piece: 'n' as const },
      { pool: 'v3.idea.improvePiece', n: 1 },
    ];
    const bare = ev('g', 'Давай сходим конём — с нового места видно все вот эти клетки.', { say });
    expect(deicticIssues(bare)).toHaveLength(1);
    const drawn = { ...bare, cues: [{ kind: 'attacks' as const, sentence: 0, squares: ['d4' as const], tone: 'good' as const }] };
    expect(deicticIssues(drawn)).toEqual([]);
    const otherSentence = { ...bare, cues: [{ kind: 'attacks' as const, sentence: 1, squares: ['d4' as const], tone: 'good' as const }] };
    expect(deicticIssues(otherSentence)).toHaveLength(1);
    const empty = { ...bare, cues: [{ kind: 'attacks' as const, sentence: 0, squares: [], tone: 'good' as const }] };
    expect(deicticIssues(empty)).toHaveLength(1);
  });
});

// ───────────────────────── repetition ─────────────────────────

describe('repetition in a game', () => {
  it('counts utterances, moments, wordings, openers and adjacent repeats; the quiet sound word is not an utterance', () => {
    const g = game('c1g01', {
      turns: [turn(1), turn(3, { adviceHidden: true, move: { uci: 'g1f3', san: 'Nf3', how: 'found', arrowShown: false, thinkMs: 4000 } }), turn(5, { quiz: { id: 'q5', kind: 'oppIdea', question: '?', options: [], correctId: 'a', how: 'right', pressed: 'a', atMs: 3000 } })],
    });
    const list = [
      ev('c1g01', 'Сегодня главное — центр.', { source: 'start', moment: 'theme', say: [{ pool: 'v3.theme.family.center', n: 1 }] }),
      ev('c1g01', 'Давай сходим конём — разбудим фигуру. Центр наш.', { say: [{ pool: 'v3.lead.advice', n: 1, piece: 'n' }, { pool: 'v3.idea.develop', n: 1 }] }),
      ev('c1g01', 'Центр наш. Ура!', { source: 'reaction', moment: 'result', say: [{ pool: 'v3.lead.advice', n: 1, piece: 'n' }] }),
      ev('c1g01', 'Ага.', { source: 'bark', moment: 'quiet', kind: 'bark', bubble: '' }),
      ev('c1g01', '', { source: 'why', moment: 'why', empty: true }),
      ev('c1g01', 'Давай сходим слоном — он встанет в центр.', { say: [{ pool: 'v3.lead.advice', n: 1, piece: 'b' }, { pool: 'v3.idea.none', n: 1 }] }),
    ];
    const s = gameStats(g, list);
    expect(s.utterances).toBe(4);
    expect(s.barks).toBe(1);
    expect(s.empty).toBe(1);
    expect(s.moments).toMatchObject({ theme: 1, advice: 2, result: 1, quiet: 1 });
    expect(s.maxWording).toMatchObject({ key: 'v3.lead.advice#1', n: 3 });
    expect(s.maxOpener2).toMatchObject({ key: 'давай сходим', n: 2 });
    expect(s.maxOpener3).toMatchObject({ key: 'давай сходим {фигура}', n: 2 });
    expect(s.adjacent).toEqual([{ n: list[2]!.n, sentence: 'центр наш' }]);
    expect(s.adviceUtterances).toBe(3);
    expect(s.adviceWithIdea).toBe(1);
    expect(s.quizzes).toMatchObject({ asked: 1, right: 1 });
    expect(s.hiddenAtStart).toBe(1);
    expect(s.movedHidden).toBe(1);
    expect(s.outcome).toBe('win');
  });

  it('«второй день»: the share of game k heard word for word in game k−1 of the same child', () => {
    const g1 = game('c1g01', { gameNo: 1 });
    const g2 = game('c1g02', { gameNo: 2 });
    const g3 = game('c2g01', { child: 2, stage: 2, gameNo: 1 });
    const events = new Map([
      ['c1g01', [ev('c1g01', 'Раз.'), ev('c1g01', 'Два.')]],
      ['c1g02', [ev('c1g02', 'Раз!'), ev('c1g02', 'Три.'), ev('c1g02', 'Четыре.'), ev('c1g02', 'Пять.')]],
      ['c2g01', [ev('c2g01', 'Раз.')]],
    ]);
    const sd = secondDay([g1, g2, g3], events);
    expect(sd.map((c) => [c.child, c.repeated, c.utterances])).toEqual([
      [1, 1, 4],
      [2, 0, 0],
    ]);
    expect(sd[0]?.pct).toBe(25);
    expect([sd[0]?.sentences, sd[0]?.sentRepeated, sd[0]?.sentPct]).toEqual([4, 1, 25]);
  });

  it('theme announcements within 7 games and mini wordings within 14', () => {
    const games = [1, 5, 9].map((k) => game(`c1g0${k}`, { gameNo: k }));
    const theme = (id: string, n: number): EvRecord => ev(id, 'Тема.', { source: 'start', moment: 'theme', say: [{ pool: 'v3.theme.family.center', n }] });
    const events = new Map([
      ['c1g01', [theme('c1g01', 1), ev('c1g01', 'Мини.', { say: [{ pool: 'v3.mini.center.l1', n: 2 }] })]],
      ['c1g05', [theme('c1g05', 2)]],
      ['c1g09', [theme('c1g09', 1), ev('c1g09', 'Мини.', { say: [{ pool: 'v3.mini.center.l1', n: 2 }] })]],
    ]);
    expect(crossGameRepeats(games, events, 7, themeAnnouncementSay)).toEqual([]);
    expect(crossGameRepeats(games, events, 9, themeAnnouncementSay).map((r) => [r.key, r.games])).toEqual([['v3.theme.family.center#1', [1, 9]]]);
    expect(crossGameRepeats(games, events, 14, miniSay).map((r) => r.key)).toEqual(['v3.mini.center.l1#2']);
  });
});

// ───────────────────────── the truth audit ─────────────────────────

function deep(bestUci: string, lines: [string, number][], extra: Record<string, number> = {}): DeepView {
  const known: Record<string, number> = { ...extra };
  for (const [u, w] of lines) known[u] = w;
  return { depth: 18, best: lines[0]![1], bestUci, lines: lines.map(([uci, win]) => ({ uci, win })), known, floor: lines[lines.length - 1]![1] };
}

describe('truth audit verdicts', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  it('whichPiece: the deep best move must be of the answered piece and the decoys clearly worse', () => {
    const q = { kind: 'whichPiece', correctId: 'n', fen: START, optionIds: ['n', 'b', 'q'] };
    expect(auditQuizVerdict(q, deep('g1f3', [['g1f3', 55], ['b1c3', 54], ['e2e4', 53]])).verdict).toBe('agree');
    expect(auditQuizVerdict(q, deep('e2e4', [['e2e4', 56], ['g1f3', 55]])).verdict).toBe('disagree');
  });

  it('canCapture: «бесплатно» contradicted when the capture is ≥ 10 % worse; «потеряем» when within 5 %', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const yes = { kind: 'canCapture', correctId: 'capYes', fen, optionIds: ['capYes', 'capTrade', 'capLose'], captureUci: 'e4d5' };
    expect(auditQuizVerdict(yes, deep('e4d5', [['e4d5', 60], ['b1c3', 55]])).verdict).toBe('agree');
    expect(auditQuizVerdict(yes, deep('b1c3', [['b1c3', 60]], { e4d5: 52 })).verdict).toBe('borderline');
    expect(auditQuizVerdict(yes, deep('b1c3', [['b1c3', 60]], { e4d5: 40 })).verdict).toBe('disagree');
    const lose = { ...yes, correctId: 'capLose' };
    expect(auditQuizVerdict(lose, deep('b1c3', [['b1c3', 60]], { e4d5: 58 })).verdict).toBe('disagree');
    expect(auditQuizVerdict(lose, deep('b1c3', [['b1c3', 60]], { e4d5: 30 })).verdict).toBe('agree');
    expect(auditQuizVerdict({ ...yes, captureUci: 'a2a3' }, deep('b1c3', [['b1c3', 60]])).verdict).toBe('error');
  });

  it('checkEscape: the way of the deep best move', () => {
    // White king e1 in check from the bishop b4: Kf1 / block c3 / (no capture)
    const fen = 'rnbqk1nr/pppp1ppp/8/4p3/1b6/3P4/PPP1PPPP/RNBQKBNR w KQkq - 1 3';
    const q = { kind: 'checkEscape', correctId: 'escBlock', fen, optionIds: ['escKing', 'escBlock', 'escCapture'] };
    expect(auditQuizVerdict(q, deep('c2c3', [['c2c3', 50], ['b1d2', 49]])).verdict).toBe('agree');
    expect(auditQuizVerdict({ ...q, correctId: 'escKing' }, deep('c2c3', [['c2c3', 50], ['e1e2', 30]])).verdict).toBe('disagree');
    expect(auditQuizVerdict({ ...q, kind: 'oppIdea' }, deep('c2c3', [['c2c3', 50]])).verdict).toBe('static');
  });

  it('praise: a routine deed must be sound, a real find may be a little under the best', () => {
    expect(praiseTier('tactic.fork')).toBe('always');
    expect(praiseTier('castled')).toBe('routine');
    const d = deep('g1f3', [['g1f3', 60]]);
    expect(auditPraiseVerdict('castled', 'O-O', 59, d).verdict).toBe('agree');
    expect(auditPraiseVerdict('castled', 'O-O', 57, d).verdict).toBe('borderline');
    expect(auditPraiseVerdict('castled', 'O-O', 50, d).verdict).toBe('disagree');
    expect(auditPraiseVerdict('tactic.fork', 'Nc7+', 56, d).verdict).toBe('agree');
    expect(auditPraiseVerdict('tactic.fork', 'Nc7+', 53, d).verdict).toBe('borderline');
    expect(auditPraiseVerdict('tactic.fork', 'Nc7+', 45, d).verdict).toBe('disagree');
    expect(auditPraiseVerdict('mate', 'Qh7#', null, d).verdict).toBe('agree');
    expect(auditPraiseVerdict('mate', 'Qh7+', null, d).verdict).toBe('disagree');
  });

  it('«лучше всего»: the deep first move with a 3 % gap', () => {
    expect(auditBestVerdict('g1f3', deep('g1f3', [['g1f3', 60], ['b1c3', 50]])).verdict).toBe('agree');
    expect(auditBestVerdict('g1f3', deep('g1f3', [['g1f3', 60], ['b1c3', 59]])).verdict).toBe('borderline');
    expect(auditBestVerdict('g1f3', deep('b1c3', [['b1c3', 60]], { g1f3: 58.5 })).verdict).toBe('borderline');
    expect(auditBestVerdict('g1f3', deep('b1c3', [['b1c3', 60]], { g1f3: 40 })).verdict).toBe('disagree');
  });
});

// ───────────────────────── recording ─────────────────────────

describe('the recording estimate', () => {
  it('counts every piece / gender expansion and 0.15 credits per started 50 characters', () => {
    const lines = [
      { id: 'v3.helper', role: 'whole', subject: 'mover', cue: ['move'], stages: [1, 5], min: 1, stageMode: 'shared', purpose: '', wordings: [{ t: 'Поможет {конь}.' }] },
      { id: 'v3.quiz.right', role: 'whole', cue: [], stages: [1, 5], min: 1, stageMode: 'shared', purpose: '', wordings: [{ t: 'Верно!' }, { t: 'Ты {g:прав|права}!' }] },
    ] as unknown as LessonLine[];
    const r = recordingEstimate([{ pool: 'v3.quiz.right', n: 2, g: 'f' }], lines);
    // helper: 6 pieces (a mover may be the king), quiz.right: 1 + 2 genders
    expect(r.library.wordings).toBe(3);
    expect(r.library.units).toBe(9);
    expect(r.library.credits).toBeCloseTo(9 * 0.15, 6);
    expect(r.used.units).toBe(2);
    expect(r.heard.units).toBe(1);
    expect(r.heard.wordings).toBe(1);
  });
});

// ───────────────────────── the whole report ─────────────────────────

describe('the report and its gates', () => {
  it('passes a clean run and fails on a square, an adjacent repeat or an error', () => {
    const g = game('c1g01');
    const clean = [ev('c1g01', 'Давай сходим конём — разбудим фигуру, которая спит дома.', { say: [{ pool: 'v3.lead.advice', n: 1, piece: 'n' }, { pool: 'v3.idea.develop', n: 1 }] }), g];
    const ok = buildReport(parseRun(clean));
    expect(gatesFailed(ok).map((x) => x.id)).toEqual([]);
    expect(ok.totals.adviceIdeaPct).toBe(100);
    expect(ok.topWordings.map((w) => w.key).sort()).toEqual(['v3.idea.develop#1', 'v3.lead.advice#1']);

    const bad = buildReport(
      parseRun([
        clean[0] as EvRecord,
        ev('c1g01', 'Конь на эф три. Вперёд.', { source: 'reaction', moment: 'reaction' }),
        ev('c1g01', 'Вперёд.', { source: 'reaction', moment: 'reaction' }),
        g,
        { t: 'error', game: 'c1g02', error: 'boom' },
      ]),
    );
    expect(gatesFailed(bad).map((x) => x.id).sort()).toEqual(['adjacent', 'errors', 'squares']);
  });

  it('parses JSON lines, skipping torn ones, and orders the games', () => {
    const text = [JSON.stringify(game('c2g01', { child: 2, stage: 2 })), '{"t":"ev",', JSON.stringify(game('c1g02', { gameNo: 2 })), JSON.stringify(game('c1g01')), ''].join('\n');
    const run = parseRun(parseJsonLines(text));
    expect(run.games.map((x) => x.game)).toEqual(['c1g01', 'c1g02', 'c2g01']);
  });

  it('hidden-arrow gates are per stage ≥ 3', () => {
    const stage3 = game('c3g01', {
      child: 3,
      stage: 3,
      turns: [turn(1, { adviceHidden: true }), turn(3), turn(5), turn(7)],
    });
    const r = buildReport(parseRun([stage3]));
    const g3 = r.gates.find((x) => x.id === 'hidden3');
    expect(g3?.pass).toBe(true);
    expect(r.hidden[0]?.hiddenAtStartPct).toBe(25);
    const none = buildReport(parseRun([{ ...stage3, turns: [turn(1), turn(3)] }]));
    expect(none.gates.find((x) => x.id === 'hidden3')?.pass).toBe(false);
  });
});

describe('observations', () => {
  it('finds long turns, blitz turns over their sentences, arrows without words, a false «как я и говорил», capture quizzes against §2.4', () => {
    const cap = (correctId: string, captureUci: string, adviceUci: string | null, ply: number): TurnRecord =>
      turn(ply, {
        moment: 'quiz',
        adviceHidden: true,
        advice: adviceUci ? { uci: adviceUci, san: 'x' } : null,
        quiz: { id: `q${ply}`, kind: 'canCapture', question: '?', options: [{ id: 'capYes', label: 'Да, бесплатно' }, { id: 'capLose', label: 'Нет, потеряем' }], correctId, how: 'right', pressed: correctId, atMs: 1, captureUci },
      });
    const g = game('c1g01', {
      turns: [
        turn(1, { moment: 'danger' }),
        cap('capYes', 'e4d5', 'g1f3', 3),
        turn(5),
        turn(7, { moment: 'treasure', adviceHidden: true }),
        cap('capLose', 'e4d5', 'e4d5', 9),
        cap('capLose', 'e4d5', 'g1f3', 11),
        cap('capYes', 'e4d5', 'e4d5', 13),
        turn(15, { moment: 'danger' }),
        turn(17, { moment: 'danger' }),
        turn(19, { moment: 'quiet' }),
      ],
    });
    const g3 = game('c3g01', { child: 3, stage: 3, tc: 'rapid10', turns: [turn(1)] });
    const long = 'Раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать четырнадцать пятнадцать шестнадцать семнадцать.';
    const adv = [{ pool: 'v3.lead.advice', n: 1, piece: 'n' as const }];
    const run = parseRun([
      ev('c1g01', 'Ой-ой, твоего слона могут забрать даром!', { ply: 1, moment: 'danger', advice: 'b5d7', say: [{ pool: 'v3.danger.hanging.undefended', n: 1, piece: 'b' }] }),
      ev('c1g01', 'Как я и говорил, ходим слоном — так.', { ply: 1, source: 'repeat', moment: 'repeat', say: [{ pool: 'v3.lead.repeat', n: 1, piece: 'b' }, { pool: 'v3.idea.trade', n: 1 }] }),
      ev('c1g01', long, { ply: 5, say: adv }),
      ev('c1g01', 'Подарок! Найдёшь сам?', { ply: 7, moment: 'treasure', arrowHidden: true }),
      // blitz: «можно не спасать» + the advice — two sentences allowed; the danger + the advice — one too many
      ev('c1g01', 'Слона можно не спасать. Давай сходим конём.', { ply: 15, moment: 'danger', say: [{ pool: 'v3.danger.letGo.stronger', n: 1 }, ...adv] }),
      ev('c1g01', 'Слон под ударом! Давай сходим конём.', { ply: 17, moment: 'danger', say: [{ pool: 'v3.danger.hanging.undefended', n: 1, piece: 'b' }, ...adv] }),
      g,
      ev('c3g01', 'Так держать.', { ply: 1, source: 'takebackReply', moment: 'takeback', say: [{ pool: 'v3.takeback.yes', n: 1 }] }),
      ev('c3g01', 'Давай сходим конём.', { ply: 1, say: adv }),
      g3,
    ]);
    const o = observations(run);
    expect(o.dangerShare.find((d) => d.stage === 1)).toMatchObject({ turns: 10, danger: 3, pct: 30 });
    expect(o.overCap.count).toBe(1);
    expect(o.blitzMulti).toMatchObject({ count: 1, byMoment: { danger: 1 } });
    // ply 1: the danger without advice words; the quiet ply 19 is its own form
    expect(o.arrowWithoutWords.count).toBe(1);
    // a quiz answer that puts the arrow on the board: words about the move, or the capture that is the advice
    const answerObs = (pools: string[], t: TurnRecord, arrow = true) => {
      const u = t.advice?.uci ?? 'a1a2';
      const board = { arrows: arrow ? [{ from: u.slice(0, 2), to: u.slice(2, 4), color: 'green' }] : [], highlights: [] } as unknown as EvRecord['board'];
      return observations(parseRun([ev('c1g01', 'Ответ.', { ply: t.ply, source: 'answer', moment: 'answer', say: pools.map((pool) => ({ pool, n: 1 })), board }), game('c1g01', { tc: 'rapid10', turns: [t] })]));
    };
    const answered = (pools: string[], t: TurnRecord, arrow = true): number => answerObs(pools, t, arrow).arrowWithoutWords.count;
    const dq = turn(3, { moment: 'danger', adviceHidden: true, quiz: { id: 'q', kind: 'danger', question: '?', options: [], correctId: 'n', how: 'wrong', pressed: 'b', atMs: 1 } });
    expect(answered(['v3.quiz.wrong', 'v3.quiz.explain.danger'], dq)).toBe(1);
    expect(answered(['v3.quiz.wrong', 'v3.quiz.explain.danger', 'v3.lead.rescue'], dq)).toBe(0);
    expect(answered(['v3.quiz.right', 'v3.quiz.explain.capYes'], cap('capYes', 'e4d5', 'e4d5', 3))).toBe(0);
    expect(answered(['v3.quiz.right', 'v3.quiz.explain.capLose'], cap('capLose', 'e4d5', 'g1f3', 3))).toBe(1);
    // the advice words did not fit: no arrow (it waits for «Совет») — not an arrow without words, a target of its own
    expect(answered(['v3.quiz.wrong', 'v3.quiz.explain.danger'], dq, false)).toBe(0);
    expect(answerObs(['v3.quiz.wrong', 'v3.quiz.explain.danger'], dq, false).answerNoAdvice).toMatchObject({ count: 1, of: 1 });
    expect(answerObs(['v3.quiz.wrong', 'v3.quiz.explain.danger', 'v3.lead.rescue'], dq).answerNoAdvice).toMatchObject({ count: 0, of: 1 });
    // «Зачем мы так сходили?»: «вот зачем» + idea explains the past move — the advice needs its own words
    const wq = turn(5, { moment: 'quiz', adviceHidden: true, quiz: { id: 'w', kind: 'why', question: '?', options: [], correctId: 'attack', how: 'right', pressed: 'attack', atMs: 1 } });
    expect(answered(['v3.quiz.right', 'v3.lead.why', 'v3.idea.attack'], wq)).toBe(1);
    expect(answered(['v3.quiz.right', 'v3.lead.why', 'v3.idea.attack', 'v3.lead.subject', 'v3.idea.develop'], wq)).toBe(0);
    expect(answerObs(['v3.quiz.right'], wq, false).answerNoAdvice.byMoment).toEqual({ why: 1 });
    expect(o.repeatWithoutAdvice.count).toBe(1);
    // ply 3: «да» about another move; ply 9: «нет» about the advice itself
    expect(o.captureNotAdvice).toMatchObject({ count: 2, of: 4 });
    expect(o.takebackNoConcept).toMatchObject({ count: 1, of: 1 });
    expect(o.quizKinds).toEqual({ canCapture: 4 });
    expect(o.rhythm).toEqual(['c1g01: вопросов 4 > 3', 'c1g01: первый вопрос на 2-м ходу']);
    expect(o.momentsByStage.find((m) => m.stage === 1)).toMatchObject({ turns: 10, moments: { danger: 3, quiz: 4, advice: 1, treasure: 1, quiet: 1 } });
  });

  it('the §2.4 capture rule, the word caps and the blitz sentences', () => {
    const q = (correctId: string, captureUci: string | null) => ({ id: 'q', kind: 'canCapture', question: '?', options: [], correctId, how: 'right' as const, pressed: correctId, atMs: 1, captureUci });
    expect(captureRuleBroken({ quiz: q('capYes', 'e4d5'), advice: { uci: 'e4d5', san: 'exd5' } })).toBeNull();
    expect(captureRuleBroken({ quiz: q('capTrade', 'e4d5'), advice: { uci: 'g1f3', san: 'Nf3' } })).toContain('размен');
    expect(captureRuleBroken({ quiz: q('capLose', 'e4d5'), advice: { uci: 'g1f3', san: 'Nf3' } })).toBeNull();
    expect(captureRuleBroken({ quiz: q('capLose', 'e4d5'), advice: { uci: 'e4d5', san: 'exd5' } })).toContain('«нет»');
    expect(captureRuleBroken({ quiz: q('capYes', 'e4d5'), advice: null })).toBe('совета нет');
    expect(captureRuleBroken({ quiz: { ...q('capYes', 'e4d5'), kind: 'danger' }, advice: null })).toBeNull();

    const say = (...pools: string[]) => pools.map((pool) => ({ pool, n: 1 }));
    expect(wordCapOf(1, { source: 'turn', moment: 'advice', say: [] })).toBe(16);
    expect(wordCapOf(3, { source: 'turn', moment: 'danger', say: [] })).toBe(22);
    expect(wordCapOf(3, { source: 'turn', moment: 'danger', say: say('v3.mini.hanging.l1') })).toBe(32);
    expect(wordCapOf(3, { source: 'turn', moment: 'mini', say: [] })).toBe(40);
    // a quiz answer: the engine's own cap (the advice takes its room first)
    expect(wordCapOf(1, { source: 'answer', moment: 'answer', say: [] })).toBe(28);
    expect(wordCapOf(3, { source: 'answer', moment: 'answer', say: [] })).toBe(30);
    expect(wordCapOf(3, { source: 'turn', moment: 'quiz', say: [], quiz: { id: 'q', question: '?', options: [], correctId: 'a', kind: 'oppIdea' } as unknown as EvRecord['quiz'] })).toBeNull();
    expect(blitzSentencesAllowed({ moment: 'advice', say: [] })).toBe(1);
    expect(blitzSentencesAllowed({ moment: 'treasure', say: [] })).toBe(2);
    expect(blitzSentencesAllowed({ moment: 'mini', say: [] })).toBe(2);
    expect(blitzSentencesAllowed({ moment: 'danger', say: say('v3.lead.rescue') })).toBe(1);
    expect(blitzSentencesAllowed({ moment: 'danger', say: say('v3.danger.letGo.check', 'v3.lead.advice') })).toBe(2);
    expect(blitzSentencesAllowed({ moment: 'danger', say: say('v3.mini.hanging.l1', 'v3.lead.rescue') })).toBe(2);
  });

  it('the danger cadence of §2.2 and its per-stage gate', () => {
    const d = (o: Partial<DangerRecord>): DangerRecord => ({ kind: 'hanging', piece: 'n', square: 'f3', cls: 'other', saves: true, justTold: false, spoken: true, ...o });
    const dangerTurn = (ply: number, turnNo: number, rec: DangerRecord): TurnRecord => turn(ply, { turnNo, moment: rec.spoken ? 'danger' : 'advice', danger: rec });
    const g = game('c1g01', {
      turns: [
        dangerTurn(1, 1, d({})),
        // another piece two turns later: too soon
        dangerTurn(3, 2, d({ square: 'c3' })),
        // a check is always said, whatever the rhythm
        dangerTurn(5, 3, d({ kind: 'check', cls: 'always', piece: null, square: null })),
        // a pawn at stage 1: never
        dangerTurn(7, 4, d({ piece: 'p', cls: 'pawn' })),
        // a sure loss left unsaid
        dangerTurn(9, 5, d({ cls: 'always', spoken: false })),
        // the same piece right after the mistake words: skipped, as it should be
        dangerTurn(11, 6, d({ cls: 'always', spoken: false, justTold: true })),
        turn(13, { turnNo: 7 }),
        turn(15, { turnNo: 8 }),
      ],
    });
    const o = observations(parseRun([g]));
    expect(o.dangerCadence.byMoment).toEqual({ otherSoon: 1, pawnYoung: 1, alwaysUnsaid: 1 });
    expect(o.dangerShare[0]).toMatchObject({ turns: 8, danger: 4, found: 6, pct: 50, sameAgain: 0, byClass: { always: { found: 3, spoken: 1 }, other: { found: 2, spoken: 2 }, pawn: { found: 1, spoken: 1 } } });
    const r = buildReport(parseRun([g]));
    expect(r.gates.find((x) => x.id === 'danger1')).toMatchObject({ pass: false, hard: true });
    expect(r.gates.find((x) => x.id === 'dangerCadence')).toMatchObject({ pass: false, value: '3' });
    const calm = buildReport(parseRun([{ ...g, turns: [dangerTurn(1, 1, d({})), turn(3), turn(5), turn(7)] }]));
    expect(calm.gates.find((x) => x.id === 'danger1')).toMatchObject({ pass: true, value: '25.0 % (1/4; найдена в 1)' });
    expect(calm.gates.find((x) => x.id === 'dangerCadence')?.pass).toBe(true);
    // the queen left hanging: said again the next turn (a sure loss is always said) — counted in the danger table
    const q = d({ piece: 'q', square: 'd1', cls: 'always' });
    const again = observations(parseRun([{ ...g, turns: [dangerTurn(1, 1, q), dangerTurn(3, 2, q), dangerTurn(5, 3, { ...q, square: 'd2' })] }]));
    expect(again.dangerShare[0]).toMatchObject({ danger: 3, sameAgain: 1 });
    expect(again.dangerCadence.count).toBe(0);
    // «предупреждали и не спасли» after a danger that was never said
    const warned = (moment: string): number =>
      observations(parseRun([ev('c1g01', 'Предупреждали.', { ply: 3, source: 'reaction', moment: 'mistake', say: [{ pool: 'v3.mistake.ignoredDanger', n: 1, piece: 'n' }] }), { ...g, turns: [turn(3, { turnNo: 1, moment })] }])).dangerCadence.count;
    expect(warned('advice')).toBe(1);
    expect(warned('danger')).toBe(0);
  });

  it('praise ≤ 10 words, blitz mini-lessons (§2.2, §2.6), a repeated warning counted as «прочая»', () => {
    const words11 = 'Раз два три четыре пять шесть семь восемь девять десять одиннадцать.';
    const praise = (text: string) => ev('c3g01', text, { ply: 3, source: 'reaction', moment: 'praise', kind: 'praise', say: [{ pool: 'v3.praise.castled', n: 1 }] });
    const g3 = game('c3g01', { child: 3, stage: 3, tc: 'rapid10', turns: [turn(1), turn(3)] });
    expect(observations(parseRun([praise(words11), praise('Король в домике — надёжно.'), g3])).praiseLong.count).toBe(1);
    expect(buildReport(parseRun([praise(words11), g3])).gates.find((x) => x.id === 'praiseWords')).toMatchObject({ pass: false, hard: true });

    expect(boardShowsAdvice({ arrows: [{ from: 'e2', to: 'e4' }] }, 'e2e4')).toBe(true);
    expect(boardShowsAdvice({ arrows: [{ from: 'e7', to: 'e8' }] }, 'e7e8q')).toBe(true);
    expect(boardShowsAdvice({ arrows: [{ from: 'g1', to: 'f3' }] }, 'e2e4')).toBe(false);
    expect(boardShowsAdvice(undefined, 'e2e4')).toBe(false);
    expect(miniTopicOf('v3.mini.thinking.l2')).toBe('thinking');
    expect(miniTopicOf('v3.lead.advice')).toBeNull();
    const think = lessonLine('v3.mini.thinking.l1');
    const one = (think?.wordings.findIndex((w) => splitSentences(w.t).length === 1) ?? -1) + 1;
    const many = (think?.wordings.findIndex((w) => splitSentences(w.t).length > 1) ?? -1) + 1;
    const hang = (lessonLine('v3.mini.hanging.l1')?.wordings.findIndex((w) => splitSentences(w.t).length === 1) ?? -1) + 1;
    expect(one).toBeGreaterThan(0);
    expect(many).toBeGreaterThan(0);
    expect(hang).toBeGreaterThan(0);
    const mini = (ply: number, pool: string, k: number, o: Partial<EvRecord> = {}) => ev('c1g02', 'Урок.', { ply, moment: 'mini', say: [{ pool, n: k }], ...o });
    const bg = game('c1g02', { tc: 'blitz5', turns: [turn(1), turn(3), turn(5), turn(7)] });
    const bm = (list: EvRecord[]) => observations(parseRun([...list, bg])).blitzMini;
    // «как думать», one sentence: fine; a lesson inside a danger: fine (§2.2)
    expect(bm([mini(1, 'v3.mini.thinking.l1', one)]).count).toBe(0);
    expect(bm([mini(1, 'v3.mini.hanging.l1', hang, { moment: 'danger' })]).count).toBe(0);
    // another topic in a calm turn or after a gift's reveal; two sentences of the lesson; a second lesson
    expect(bm([mini(1, 'v3.mini.fork.l1', 1)]).byMoment).toEqual({ topic: 1 });
    expect(bm([mini(1, 'v3.mini.freeCapture.l1', 1, { source: 'reveal', moment: 'reveal' })]).byMoment).toEqual({ topic: 1 });
    expect(bm([mini(1, 'v3.mini.thinking.l1', many)]).byMoment).toEqual({ sentences: 1 });
    expect(bm([mini(1, 'v3.mini.thinking.l1', one), mini(5, 'v3.mini.hanging.l1', hang, { moment: 'danger' })]).byMoment).toEqual({ second: 1 });
    // not blitz: no such rule
    expect(observations(parseRun([mini(1, 'v3.mini.fork.l1', 1), { ...bg, tc: 'rapid10' }])).blitzMini.count).toBe(0);

    // the queen left hanging on the same square: statically «всегда», the lesson counts the repeat as «прочая»
    const q: DangerRecord = { kind: 'hanging', piece: 'q', square: 'd1', cls: 'always', saves: true, justTold: false, spoken: true };
    const rg = game('c3g02', {
      child: 3,
      stage: 3,
      tc: 'rapid10',
      turns: [
        turn(1, { turnNo: 1, moment: 'danger', danger: q }),
        turn(3, { turnNo: 2, moment: 'advice', danger: { ...q, cls: 'other', baseCls: 'always', spoken: false } }),
        turn(5, { turnNo: 3, moment: 'advice', danger: { ...q, cls: 'other', baseCls: 'always', spoken: false } }),
        turn(7, { turnNo: 4, moment: 'danger', danger: { ...q, cls: 'other', baseCls: 'always' } }),
      ],
    });
    const ro = observations(parseRun([rg]));
    expect(ro.dangerShare[0]).toMatchObject({ danger: 2, repeatWarn: { found: 3, spoken: 1 }, byClass: { always: { found: 1, spoken: 1 }, other: { found: 3, spoken: 1 } } });
    // a repeat left unsaid is not «всегда не сказана»; said again 3 turns later is within the «прочая» rhythm
    expect(ro.dangerCadence.count).toBe(0);
  });

  it('stage 5 «позже»: never right after a hidden arrow, never two calm advices in a row; hints stop when shown', () => {
    const later = (ply: number): TurnRecord => turn(ply, { adviceHidden: true, revealLater: true, revealAfterMs: 15000 });
    const g = game('c5g01', {
      child: 5,
      stage: 5,
      turns: [later(1), turn(3), later(5), later(7), turn(9, { moment: 'self', adviceHidden: true }), later(11), turn(13)],
    });
    const o = observations(parseRun([g]));
    expect(o.laterCadence.count).toBe(2);
    expect(o.later).toMatchObject({ turns: 7, later: 4 });
    // the store cancels the hints when the advice is shown; the director must say so (`stopHints`)
    const hinted = game('c1g01', {
      turns: [turn(1, { moment: 'treasure', adviceHidden: true, hints: [{ atMs: 5000, board: { arrows: [], highlights: [] } }, { atMs: 10000, board: { arrows: [], highlights: [] } }], hintsStopMs: 7000, reveal: { atMs: 7000, by: 'button' }, move: { uci: 'e2e4', san: 'e4', how: 'arrow', arrowShown: true, thinkMs: 12000 } })],
    });
    expect(observations(parseRun([hinted])).hintsAfterShown.count).toBe(0);
    expect(observations(parseRun([{ ...hinted, turns: [{ ...(hinted.turns[0] as TurnRecord), hintsStopMs: null, hintsKept: true }] }])).hintsAfterShown.count).toBe(1);
  });
});
