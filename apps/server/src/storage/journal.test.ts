import { describe, expect, it } from 'vitest';
import type { GameEvent, GameRecord, Persona } from '@gambit/shared';
import { fallbackCurriculum, loadContent } from '../content.ts';
import { sampleGameRecord, sampleTeacherGameRecord } from '../testing/fixtures.ts';
import { PARENT_NOTES_END, PARENT_NOTES_START } from './files.ts';
import {
  REVIEW_END,
  REVIEW_START,
  adviceFollowed,
  adviceItems,
  adviceStats,
  aiSummary,
  collectThoughts,
  demoteHeadings,
  extractMainLine,
  lastQuestion,
  matchJudgements,
  mergeSplitUtterances,
  planTimeline,
  quizStats,
  renderGameJournal,
  renderPgnFile,
  renderThoughts,
  renderTimeline,
  renderTimelineLine,
} from './journal.ts';
import { pluralRu, qualityMark, sanToRu } from './notation.ts';
import { renderProfileMd } from './profileMd.ts';
import { defaultProfile } from '../services/profile.ts';

const content = await loadContent({ loadContentModule: () => Promise.resolve({}), loadCoreModule: () => Promise.resolve({}) });
const petya: Persona = content.personas.petya;

function journal(record: GameRecord, extra: Partial<Parameters<typeof renderGameJournal>[0]> = {}): string {
  return renderGameJournal({ record, persona: petya, nickname: 'Миша', review: null, pgnFileName: 'game.pgn', motifTitleRu: content.motifTitleRu, parentNotes: null, ...extra });
}

describe('notation', () => {
  it('translates piece letters only', () => {
    expect(sanToRu('Nf3')).toBe('Кf3');
    expect(sanToRu('Kxe2')).toBe('Крxe2');
    expect(sanToRu('exd8=Q+')).toBe('exd8=Ф+');
    expect(sanToRu('Rad1')).toBe('Лad1');
    expect(sanToRu('Bb5+')).toBe('Сb5+');
    // one implementation for bubbles, reviews and journals (@gambit/core): Russian castling notation
    expect(sanToRu('O-O-O')).toBe('0-0-0');
    expect(sanToRu('O-O+')).toBe('0-0+');
    expect(sanToRu('e4')).toBe('e4');
    // a "SAN" that is not one (hostile local client) is rendered as inert text
    expect(sanToRu('<!-- x -->')).not.toContain('<');
    expect(sanToRu('`|\n')).toBe('\\|');
  });

  it('maps judgements to annotation marks', () => {
    expect(qualityMark({ classification: 'blunder' })).toBe('??');
    expect(qualityMark({ classification: 'mistake' })).toBe('?');
    expect(qualityMark({ classification: 'missedWin' })).toBe('?');
    expect(qualityMark({ classification: 'inaccuracy' })).toBe('?!');
    expect(qualityMark({ classification: 'good' })).toBe('');
    expect(qualityMark({ classification: 'best' })).toBe('');
    expect(qualityMark({ classification: 'best' }, true)).toBe('!');
    expect(qualityMark({ classification: 'excellent', missedMotif: 'fork' })).toBe('!');
    expect(qualityMark({ classification: 'best', missedMotif: 'fork' })).toBe('!');
    expect(qualityMark({ classification: 'best', missedMotif: 'mateIn2' })).toBe('!!');
  });

  it('declines Russian plurals', () => {
    expect([1, 2, 5, 11, 21, 24, 112].map((n) => pluralRu(n, 'ход', 'хода', 'ходов'))).toEqual(['1 ход', '2 хода', '5 ходов', '11 ходов', '21 ход', '24 хода', '112 ходов']);
  });
});

describe('main line and judgements', () => {
  it('reads the main line from the PGN and separates taken-back attempts', () => {
    const record = sampleGameRecord();
    const mainLine = extractMainLine(record);
    expect(mainLine.map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
    const judged = matchJudgements(mainLine, record.judgements);
    expect([...judged.byPly.keys()]).toEqual([1, 3, 5, 7]);
    expect(judged.byPly.get(5)?.san).toBe('Bc4');
    expect(judged.takenBack.map((j) => j.san)).toEqual(['Qxe5+']);
  });

  it('treats an identical earlier attempt as taken back', () => {
    const record = sampleGameRecord();
    const bc4 = record.judgements.find((j) => j.san === 'Bc4');
    if (bc4 === undefined) throw new Error('fixture');
    const judged = matchJudgements(extractMainLine(record), [...record.judgements.slice(0, 2), { ...bc4, accuracy: 1 }, ...record.judgements.slice(2)]);
    expect(judged.takenBack.map((j) => j.san)).toEqual(['Bc4', 'Qxe5+']);
    expect(judged.byPly.get(5)?.accuracy).not.toBe(1);
  });

  it('falls back to the move events when the PGN is unusable', () => {
    const mainLine = extractMainLine(sampleGameRecord({ pgn: 'this is not a pgn' }));
    expect(mainLine.map((m) => `${m.ply}:${m.san}`)).toEqual(['1:e4', '2:e5', '3:Qh5', '4:Nc6', '5:Bc4', '6:Nf6', '7:Qxf7#']);
    expect(journal(sampleGameRecord({ pgn: '', events: [] }))).toContain('_Ходы не записаны._');
  });
});

describe('timeline', () => {
  it('renders every interaction type defensively', () => {
    expect(renderTimelineLine({ t: 61_000, type: 'hintGiven', ply: 9, data: { hintLevel: 4, event: { bubbleText: 'Сыграй Кf3' } } }, 'Миша')).toBe('- `01:01` · ход 5 — **Подсказка уровня 4 (показан ход)**: «Сыграй Кf3»');
    expect(renderTimelineLine({ t: 0, type: 'takebackDeclined', ply: 4, data: { san: 'Qd2' } }, 'Миша')).toContain('«Оставлю свой ход»** — ход Фd2 остался на доске.');
    expect(renderTimelineLine({ t: 0, type: 'coachSaid', data: {} }, 'Миша')).toBeNull();
    // a live conversation, the model's own words never came: the line says so and keeps what was meant
    expect(renderTimelineLine({ t: 0, type: 'coachSaid', data: { template: 'Стоп-стоп!', spokenBy: 'model', kind: 'takebackOffer' } }, 'Миша')).toBe(
      '- `00:00` — Тренер (предложение вернуть ход): расшифровки нет — могло не прозвучать. Смысл: «Стоп-стоп!»',
    );
    expect(renderTimelineLine({ t: 0, type: 'coachSaid', data: { spokenBy: 'model', kind: 'praise' } }, 'Миша')).toBe('- `00:00` — Тренер (похвала): расшифровки нет — могло не прозвучать.');
    expect(renderTimelineLine({ t: 5_000, type: 'takebackOffered', ply: 5, data: { san: 'Qxf7+', winPctLoss: 44.6, template: 'Стоп-стоп!', spokenBy: 'model' } }, 'Миша')).toBe(
      '- `00:05` · ход 3 — **Тренер предложил вернуть ход** Фxf7+ (шансы упали на 45%). Расшифровки нет — могло не прозвучать. Смысл: «Стоп-стоп!»',
    );
    expect(renderTimelineLine({ t: 0, type: 'hintGiven', data: { level: 1, template: 'Что хочет соперник?', spokenBy: 'model' } }, 'Миша')).toBe(
      '- `00:00` — **Подсказка уровня 1 (вопрос-подсказка)**. Расшифровки нет — могло не прозвучать. Смысл: «Что хочет соперник?»',
    );
    // …and when they came, they are IN the line, marked «голосом»
    expect(renderTimelineLine({ t: 5_000, type: 'takebackOffered', ply: 5, data: { san: 'Qxf7+', template: 'Стоп-стоп!', spokenBy: 'model' } }, 'Миша', {}, { modelWords: 'Ой, стой! Ферзь пропадёт.' })).toBe(
      '- `00:05` · ход 3 — **Тренер предложил вернуть ход** Фxf7+. Сказал голосом: «Ой, стой! Ферзь пропадёт.»',
    );
    expect(renderTimelineLine({ t: 0, type: 'hintGiven', data: { level: 2, template: 'Смотри на центр', spokenBy: 'model' } }, 'Миша', {}, { modelWords: 'Глянь в центр доски.' })).toBe(
      '- `00:00` — **Подсказка уровня 2 (зона доски или тема)** голосом: «Глянь в центр доски.»',
    );
    // a transcript of the voice model's own speech is marked; a prepared phrase is not; the client may report «heard»
    expect(renderTimelineLine({ t: 6_000, type: 'coachSaid', data: { text: 'Ой, подожди! Давай вернём ход?', source: 'voice' } }, 'Миша')).toBe('- `00:06` — Тренер (голосом): «Ой, подожди! Давай вернём ход?»');
    expect(renderTimelineLine({ t: 6_000, type: 'coachSaid', data: { kind: 'praise', text: 'Молодец!', heard: false } }, 'Миша')).toBe('- `00:06` — Тренер (похвала): «Молодец!» (не прозвучало)');
    expect(renderTimelineLine({ t: 6_000, type: 'coachSaid', data: { kind: 'praise', text: 'Молодец!', heard: true } }, 'Миша')).toBe('- `00:06` — Тренер (похвала): «Молодец!» (прозвучало)');
    // the child: by voice, typed into the diary (with its question), a chosen answer
    expect(renderTimelineLine({ t: 7_000, type: 'childSaid', data: { text: 'Я хочу напасть', source: 'voice' } }, 'Миша')).toBe('- `00:07` — Миша (голосом): «Я хочу напасть»');
    expect(renderTimelineLine({ t: 7_000, type: 'childSaid', data: { text: 'Не зевнуть ферзя', source: 'typed', about: 'hardestMoment' } }, 'Миша')).toBe(
      '- `00:07` — На вопрос «Что было самым трудным в этой партии?» Миша (написал): «Не зевнуть ферзя»',
    );
    expect(renderTimelineLine({ t: 7_000, type: 'childSaid', data: { text: 'Хотел напасть', source: 'choice', about: 'takebackDeclined' } }, 'Миша')).toBe('- `00:07` — Миша (выбрал ответ): «Хотел напасть»');
    expect(renderTimelineLine({ t: 0, type: 'move', ply: 1, data: { san: 'e4' } }, 'Миша')).toBeNull();
    expect(renderTimelineLine({ t: 0, type: 'childSaid', data: { text: 'таблица | ломается\nперенос' } }, 'Миша')).toBe('- `00:00` — Миша: «таблица \\| ломается перенос»');
  });
});

describe('renderGameJournal', () => {
  it('shows a pending review first and the finished one later, keeping parent notes', () => {
    const record = sampleGameRecord();
    const pending = journal(record);
    expect(pending).toContain('review: pending');
    expect(pending).toContain('Разбор готовится');
    expect(pending.indexOf(REVIEW_START)).toBeLessThan(pending.indexOf(REVIEW_END));
    expect(pending.indexOf(REVIEW_END)).toBeLessThan(pending.indexOf(PARENT_NOTES_START));

    const done = journal(record, {
      review: { status: 'ready', provider: 'openai-api', markdown: '# Разбор\n## Итог\nХорошо.', keyTakeaways: ['Проверяй защиту'], suggestedThemeTitle: 'Вилка' },
      parentNotes: '\nмои заметки\n',
    });
    expect(done).toContain('review: ready');
    expect(done).toContain('### Разбор\n#### Итог');
    expect(done).toContain('**Что потренировать:** Вилка');
    expect(done).toContain('ИИ-тренер (OpenAI API)');
    expect(done).toContain(`${PARENT_NOTES_START}\nмои заметки\n${PARENT_NOTES_END}`);
    expect(journal(record, { review: { status: 'failed', provider: 'template', markdown: '', keyTakeaways: [], suggestedThemeTitle: null } })).toContain('Разбор не получилось подготовить');
  });

  it('describes a lost game with Black correctly', () => {
    const text = journal(sampleGameRecord({ childColor: 'b', result: '1-0', examMode: true, timeControlId: 'bullet1' }));
    expect(text).toContain('| Цвет ученика | чёрные |');
    expect(text).toContain('**поражение** (1-0)');
    expect(text).toContain('1 минута · экзамен без подсказок');
    expect(text).toContain('| № | Белые (Петя) | Чёрные (Миша) |');
  });

  it('demotes review headings relative to their own top level', () => {
    expect(demoteHeadings('# A\n## B\ntext # not a heading')).toBe('### A\n#### B\ntext # not a heading');
    expect(demoteHeadings('### A\n#### B')).toBe('### A\n#### B');
    expect(demoteHeadings('##### deep\n###### deeper', 6)).toBe('###### deep\n###### deeper');
    expect(demoteHeadings('no headings')).toBe('no headings');
  });
});

describe('renderPgnFile', () => {
  it('adds a header when the client sent bare movetext and keeps a complete PGN as is', () => {
    const bare = renderPgnFile(sampleGameRecord({ pgn: '1. e4 e5' }), petya, 'Ми"ша');
    expect(bare).toContain('[White "Ми\\"ша"]');
    expect(bare).toContain('[TimeControl "600+0"]');
    expect(bare.trimEnd().endsWith('1. e4 e5 1-0')).toBe(true);
    const full = '[Event "X"]\n[Result "1-0"]\n\n1. e4 1-0';
    expect(renderPgnFile(sampleGameRecord({ pgn: full }), petya, 'Миша')).toBe(`${full}\n`);
    expect(renderPgnFile(sampleGameRecord({ pgn: '', timeControlId: 'training' }), petya, 'Миша')).toContain('[TimeControl "-"]');
  });
});

describe('renderProfileMd', () => {
  it('renders every section and preserves the parent block', () => {
    const curriculum = fallbackCurriculum();
    const stage = curriculum[0];
    if (stage === undefined) throw new Error('curriculum');
    const profile = { ...defaultProfile(new Date('2026-09-21T10:00:00Z')), nickname: 'Миша', weaknesses: ['Вилка'], strengths: ['Мат в 1 ход'], themeSkills: { fork: { rating: 812.4, rd: 120, vol: 0.06, attempts: 12, solved: 7, lastSeen: '2026-09-20T10:00:00Z' } } };
    const md = renderProfileMd({
      profile,
      stage,
      nextStage: curriculum[1] ?? null,
      personas: content.personas,
      themeTitleRu: (theme) => content.themeTitlesRu[theme] ?? theme,
      lastGames: [{ id: 'g', startedAt: '2026-09-21T14:42:10.000Z', personaId: 'sonya', timeControlId: 'blitz5', childColor: 'b', result: '0-1', accuracy: 77.7, blunders: 0, reviewStatus: 'ready', journalPath: 'games/2026/09/x.md' }],
      coachNotes: [{ startedAt: '2026-09-21T14:42:10.000Z', personaId: 'sonya', takeaways: ['Считай шахи'], suggestedThemeTitle: 'Вилка' }],
      parentNotes: '\nНе больше 40 минут.\n',
    });
    for (const heading of ['## Сейчас', '## Рейтинги по темам', '## Сильные стороны', '## Над чем работаем', '## Последние 10 партий', '## Заметки тренера']) expect(md).toContain(heading);
    expect(md).toContain('| Вилка `fork` | 812 | 120 | 12 | 7 (58%) | 20.09.2026 |');
    expect(md).toContain('| Соня | 5 минут | чёрные | победа (0-1) | 78% | 0 | [журнал](../games/2026/09/x.md) |');
    expect(md).toContain('- Потренировать: Вилка');
    expect(md).toContain(`${PARENT_NOTES_START}\nНе больше 40 минут.\n${PARENT_NOTES_END}`);
  });
});

describe('the smart strategist in the journal', () => {
  it('shows the strategy of the game and every re-plan: what, by which model, how fast', () => {
    expect(
      renderTimelineLine({ t: 1_000, type: 'coachSaid', ply: 0, data: { kind: 'strategy', strategyId: 'italian', titleRu: 'Итальянская партия', ideaRu: 'быстро выводим фигуры и целимся в слабую точку', provider: 'codex', latencyMs: 2140, late: false } }, 'Миша'),
    ).toBe('- `00:01` · ход 1 — **Стратегия партии: Итальянская партия** — быстро выводим фигуры и целимся в слабую точку (Codex, 2,1 с).');
    expect(renderTimelineLine({ t: 0, type: 'coachSaid', data: { kind: 'strategy', titleRu: 'Лондонская система', provider: 'template', latencyMs: 12, late: true } }, 'Миша')).toBe(
      '- `00:00` — **Стратегия партии: Лондонская система** (пришла с опозданием, без модели, 0,0 с).',
    );
    expect(renderTimelineLine({ t: 0, type: 'coachSaid', data: { kind: 'strategy', failed: true, latencyMs: 9000 } }, 'Миша')).toBe('- `00:00` — Стратегия партии не пришла вовремя — учитель вёл по правилам (9,0 с).');
    expect(
      renderTimelineLine(
        { t: 65_000, type: 'coachSaid', ply: 6, data: { kind: 'replan', ply: 7, trigger: 'leftLine', provider: 'openrouter', latencyMs: 2400, planRu: 'Прячем короля и бьём по центру.', whyRu: 'Король уходит в домик.', preferredUci: 'e1g1' } },
        'Миша',
      ),
    ).toBe('- `01:05` · ход 3 — Новый план (соперник ушёл от плана, OpenRouter, 2,4 с): «Прячем короля и бьём по центру.» Почему этот ход: «Король уходит в домик.»');
    expect(renderTimelineLine({ t: 0, type: 'coachSaid', data: { kind: 'replan', dropped: 'stale', provider: 'evil<script>', trigger: 'phase', latencyMs: 300 } }, 'Миша')).toBe(
      '- `00:00` — Новый план не использован: устарел (новая стадия партии, 0,3 с).',
    );
    expect(renderTimelineLine({ t: 0, type: 'coachSaid', data: { kind: 'replan' } }, 'Миша')).toBeNull();
    expect(renderTimelineLine({ t: 0, type: 'coachSaid', data: { kind: 'strategy', titleRu: 'Таблица | ломается' } }, 'Миша')).toContain('Таблица \\| ломается');
  });
});

describe('teacher mode in the journal (docs/TEACHER-MODE.md §7.5)', () => {
  it('a child\'s move with advice: «Совет: Кf3 (зел.), Кc3 (син.) → сыграно Кf3 ✓» — followed, alternative, own, taken back', () => {
    const line = (data: Record<string, unknown>, ply = 3): string | null => renderTimelineLine({ t: 12_000, type: 'move', ply, data: { by: 'child', ...data } }, 'Миша');
    expect(line({ san: 'Nf3', advice: ['Nf3', 'Nc3'], followed: 'primary' })).toBe('- `00:12` · ход 2 — Совет: Кf3 (зел.), Кc3 (син.) → сыграно Кf3 ✓ (по совету)');
    expect(line({ san: 'Nc3', advice: ['Nf3', 'Nc3'], followed: 'alternative' })).toBe('- `00:12` · ход 2 — Совет: Кf3 (зел.), Кc3 (син.) → сыграно Кc3 ✓ (по запасному совету)');
    expect(line({ san: 'Qh5', advice: ['Nf3', 'Nc3'], followed: 'own' })).toBe('- `00:12` · ход 2 — Совет: Кf3 (зел.), Кc3 (син.) → сыграно Фh5 — свой ход');
    // no `followed` (or null): derived from the SANs
    expect(line({ san: 'Nc3', advice: ['Nf3', 'Nc3'], followed: null })).toContain('→ сыграно Кc3 ✓ (по запасному совету)');
    expect(line({ san: 'Ng5', advice: ['Bc4', 'd4'], takenBack: true })).toBe('- `00:12` · ход 2 — Совет: Сc4 (зел.), d4 (син.) → сыграно Кg5 — свой ход (ход возвращён)');
    // plain moves (no advice, a bot move, garbage) stay out of the timeline
    expect(line({ san: 'e4' })).toBeNull();
    expect(line({ san: 'e4', advice: [] })).toBeNull();
    expect(line({ san: 'e4', advice: 'e4' })).toBeNull();
    // a hostile «SAN» is inert text
    expect(line({ san: 'e4', advice: ['<!-- x -->'] })).not.toContain('<');
  });

  it('a teacher\'s phrase shows what was advised (with arrows), the moment and a new topic; spoken by the model → «своими словами»', () => {
    const turn = (data: Record<string, unknown>): string | null => renderTimelineLine({ t: 5_000, type: 'coachSaid', ply: 2, data }, 'Миша', { conceptTitleRu: (id) => (id === 'scholars-mate' ? 'Детский мат' : null) });
    const teach = { moment: 'turn', style: 'full', ply: 3, advice: [{ uci: 'g1f3', san: 'Nf3', source: 'repertoire', arrow: 'green' }, { uci: 'b1c3', san: 'Nc3', source: 'engine', arrow: 'blue' }] };
    expect(turn({ kind: 'teachTurn', text: 'Выведем коня?', teach })).toBe('- `00:05` · ход 1 — Тренер (совет учителя): советует Кf3 (зел.), Кc3 (син.) — «Выведем коня?»');
    expect(turn({ kind: 'teachTurn', template: 'Выведем коня?', spokenBy: 'model', teach })).toBe(
      '- `00:05` · ход 1 — Тренер (совет учителя): советует Кf3 (зел.), Кc3 (син.). Расшифровки нет — могло не прозвучать. Смысл: «Выведем коня?»',
    );
    expect(
      renderTimelineLine({ t: 5_000, type: 'coachSaid', ply: 2, data: { kind: 'teachTurn', template: 'Выведем коня?', spokenBy: 'model', teach } }, 'Миша', {}, { modelWords: 'Давай разбудим коня!' }),
    ).toBe('- `00:05` · ход 1 — Тренер (совет учителя, голосом): советует Кf3 (зел.), Кc3 (син.) — «Давай разбудим коня!»');
    expect(turn({ kind: 'teachTurn', text: 'Осторожно, детский мат!', teach: { ...teach, moment: 'turn', style: 'concept', conceptId: 'scholars-mate' } })).toContain(
      'Тренер (совет учителя, новая тема «Детский мат»): советует Кf3 (зел.), Кc3 (син.) — «Осторожно, детский мат!»',
    );
    expect(turn({ kind: 'teachTurn', text: 'План!', teach: { ...teach, moment: 'openingPlan', conceptId: 'unknown-card' } })).toContain('(совет учителя, план дебюта, новая тема)');
    expect(turn({ kind: 'teachTurn', text: 'Тут подарок — найдёшь?', teach: { moment: 'turn', style: 'full', ply: 5, advice: [], reveal: 'later' } })).toBe(
      '- `00:05` · ход 1 — Тренер (совет учителя, подарок: ученик ищет ход сам): «Тут подарок — найдёшь?»',
    );
    expect(turn({ kind: 'teachReaction', text: 'Теперь соперник заберёт пешку.', teach: { moment: 'reaction', style: 'short', ply: 3, advice: [] } })).toBe(
      '- `00:05` · ход 1 — Тренер (учитель о ходе ученика): «Теперь соперник заберёт пешку.»',
    );
    // nothing to show: no words, no advice
    expect(turn({ kind: 'teachReaction', teach: { moment: 'reaction', style: 'short', ply: 3, advice: [] } })).toBeNull();
  });

  it('a teacher\'s take-back offer reminds what was advised before', () => {
    const line = renderTimelineLine(
      {
        t: 21_400,
        type: 'takebackOffered',
        ply: 5,
        data: { san: 'Ng5', winPctLoss: 61, spokenBy: 'model', teach: { moment: 'turn', style: 'full', ply: 5, advice: [{ uci: 'f1c4', san: 'Bc4', source: 'repertoire', arrow: 'green' }, { uci: 'd2d4', san: 'd4', source: 'mainLine', arrow: 'blue' }] } },
      },
      'Миша',
    );
    expect(line).toBe('- `00:21` · ход 3 — **Тренер предложил вернуть ход** Кg5 (шансы упали на 61%). Раньше советовал: Сc4 (зел.), d4 (син.). Расшифровки нет — могло не прозвучать.');
  });

  it('the header names the coach style and a parent sees how often the advice was followed', () => {
    const record = sampleTeacherGameRecord();
    const text = journal(record, { conceptTitleRu: (id) => (id === 'opening-center' ? 'Центр' : null) });
    expect(text).toContain('\ncoach_style: teacher\n');
    expect(text).toContain('| Как помогал тренер | «Учитель» — сам показывал хорошие ходы стрелками и объяснял, выбирал ученик |');
    // e4 ✓, Qh5 own (an inaccuracy), Bc4 ✓, Qxf7# ✓ — the taken-back Qxe5+ does not count
    expect(text).toContain('| Советы учителя | по совету: 3 из 4 ходов (зелёная стрелка — 3, синяя — 0) · свои ходы: 1, из них хороших: 0 |');
    expect(text).toContain('Тренер (совет учителя, план дебюта, новая тема «Центр»): советует e4 (зел.), d4 (син.) — «Начинаем с центра! Пешка на е четыре — или на дэ четыре.»');
    expect(text).toContain('— Совет: e4 (зел.), d4 (син.) → сыграно e4 ✓ (по совету)');
    expect(text).toContain('— Совет: Кf3 (зел.), Кc3 (син.) → сыграно Фh5 — свой ход');
    expect(text).toContain('→ сыграно Фxe5+ — свой ход (ход возвращён)');

    // older games (no coachStyle) keep their header exactly; other styles are named too
    const old = journal(sampleGameRecord());
    expect(old).not.toContain('coach_style');
    expect(old).not.toContain('Как помогал тренер');
    expect(old).not.toContain('Советы учителя');
    expect(journal(sampleGameRecord({ coachStyle: 'helper' }))).toContain('| Как помогал тренер | «Подсказчик» — помогал, когда просили |');
    expect(journal(sampleGameRecord({ coachStyle: 'exam', examMode: true }))).toContain('coach_style: exam');
  });

  it('adviceStats / adviceItems / adviceFollowed are defensive', () => {
    const record = sampleTeacherGameRecord();
    expect(adviceStats(record, matchJudgements(extractMainLine(record), record.judgements))).toEqual({ advised: 4, primary: 3, alternative: 0, own: 1, ownGood: 0 });
    expect(adviceStats(sampleGameRecord(), matchJudgements(extractMainLine(sampleGameRecord()), []))).toBeNull();
    expect(adviceItems([' e4 ', 42, { san: 'd4', arrow: 'blue' }, { san: 'Nf3', arrow: 'pink' }])).toEqual([
      { san: 'e4', arrow: 'green' },
      { san: 'd4', arrow: 'blue' },
      { san: 'Nf3', arrow: 'blue' },
    ]);
    expect(adviceItems(null)).toEqual([]);
    const advice = adviceItems(['Nf3', 'Nc3']);
    expect(adviceFollowed({ followed: 'weird' }, 'Nf3', advice)).toBe('primary');
    expect(adviceFollowed({}, 'Nc3', advice)).toBe('alternative');
    expect(adviceFollowed({}, 'h4', advice)).toBe('own');
    expect(adviceFollowed({}, null, advice)).toBeNull();
  });
});

describe('the lesson model in the journal (docs/TEACHING.md §4.6)', () => {
  const QUIZ = {
    id: 'q1',
    kind: 'oppIdea',
    ply: 7,
    question: 'Как думаешь, что задумал соперник?',
    options: [
      { id: 'attack', label: 'Нападает', icon: '⚔' },
      { id: 'capture', label: 'Хочет съесть' },
      { id: 'develop', label: 'Выводит фигуру' },
    ],
    correctId: 'attack',
  };
  const teach = (moment: string) => ({ moment, style: 'short', ply: 7, advice: [] });
  const say = (data: Record<string, unknown>): string | null => renderTimelineLine({ t: 5_000, type: 'coachSaid', ply: 6, data }, 'Миша');

  it('names the new moments: theme, quiz (with its buttons, the proven one marked), answer, mini-lesson, takeaway', () => {
    expect(say({ kind: 'gameStart', text: 'Сегодня главное — быстро разбудить все фигуры.', teach: { ...teach('theme'), ply: 1 } })).toBe(
      '- `00:05` · ход 3 — Тренер (начало партии, тема партии): «Сегодня главное — быстро разбудить все фигуры.»',
    );
    expect(say({ kind: 'teachTurn', text: 'Соперник пошёл конём. Как думаешь, что задумал соперник?', teach: teach('quiz'), quiz: QUIZ })).toBe(
      '- `00:05` · ход 3 — Тренер (совет учителя, вопрос с кнопками): «Соперник пошёл конём. Как думаешь, что задумал соперник?» Варианты: «Нападает» (верный), «Хочет съесть», «Выводит фигуру».',
    );
    expect(say({ kind: 'teachTurn', text: 'Да! Конь нападает на пешку.', teach: teach('answer') })).toBe('- `00:05` · ход 3 — Тренер (совет учителя, после ответа на вопрос): «Да! Конь нападает на пешку.»');
    expect(say({ kind: 'teachTurn', text: 'Рокировка прячет короля.', teach: { ...teach('mini'), style: 'concept' } })).toBe('- `00:05` · ход 3 — Тренер (совет учителя, мини-урок): «Рокировка прячет короля.»');
    expect(say({ kind: 'gameEnd', text: 'Мат! Главное сегодня: фигуры без защиты — подарок.', teach: teach('takeaway') })).toBe(
      '- `00:05` · ход 3 — Тренер (конец партии, главный вывод партии): «Мат! Главное сегодня: фигуры без защиты — подарок.»',
    );
    // a malformed quiz shows no buttons, never throws
    for (const quiz of [null, 'x', { options: 'x' }, { options: [42, { label: '' }, { id: 'a' }] }]) {
      expect(say({ kind: 'teachTurn', text: 'Что задумал соперник?', teach: teach('quiz'), quiz })).toBe('- `00:05` · ход 3 — Тренер (совет учителя, вопрос с кнопками): «Что задумал соперник?»');
    }
  });

  it('the child\'s button: the question it answered and whether it was right («верно» / «не угадал»)', () => {
    const answer = (data: Record<string, unknown>): string | null => renderTimelineLine({ t: 9_000, type: 'childSaid', ply: 7, data: { source: 'choice', about: 'quiz', quizId: 'q1', ...data } }, 'Миша');
    expect(answer({ optionId: 'attack', correct: true, question: QUIZ.question, text: 'Нападает' })).toBe('- `00:09` · ход 4 — На вопрос «Как думаешь, что задумал соперник?» Миша (выбрал ответ): «Нападает» — верно');
    expect(answer({ optionId: 'capture', correct: false, question: QUIZ.question, text: 'Хочет съесть' })).toBe(
      '- `00:09` · ход 4 — На вопрос «Как думаешь, что задумал соперник?» Миша (выбрал ответ): «Хочет съесть» — не угадал',
    );
    // no question kept, no verdict: still the answer
    expect(answer({ optionId: 'capture', text: 'Хочет съесть' })).toBe('- `00:09` · ход 4 — Миша (выбрал ответ): «Хочет съесть»');
    // «верно» only for a quiz: another chosen answer with `correct` says nothing about it
    expect(renderTimelineLine({ t: 9_000, type: 'childSaid', data: { source: 'choice', about: 'takebackDeclined', correct: true, text: 'Хотел напасть' } }, 'Миша')).toBe(
      '- `00:09` — Миша (выбрал ответ): «Хотел напасть»',
    );
    // a question the event carries wins after the game too («Мысли после партии»)
    const record: GameRecord = {
      ...sampleGameRecord(),
      events: [
        { t: 0, type: 'gameStart', data: {} },
        { t: 50_000, type: 'gameEnd', data: { result: '1-0' } },
        { t: 60_000, type: 'childSaid', data: { text: 'Слоном', source: 'typed', question: 'Какой фигурой был мат?' } },
      ],
    };
    expect(collectThoughts(record)).toEqual([{ source: 'typed', text: 'Слоном', at: new Date(Date.parse(record.startedAt) + 60_000).toISOString(), question: 'Какой фигурой был мат?' }]);
  });

  it('the header counts the questions: «верно: 1 из 2 · без ответа: 1»', () => {
    const base = sampleTeacherGameRecord();
    const asked = (t: number): GameEvent => ({ t, type: 'coachSaid', ply: 6, data: { kind: 'teachTurn', text: 'Что задумал соперник?', teach: teach('quiz'), quiz: QUIZ } });
    const answered = (t: number, correct: boolean): GameEvent => ({ t, type: 'childSaid', ply: 7, data: { source: 'choice', about: 'quiz', quizId: 'q1', correct, question: QUIZ.question, text: 'Нападает' } });
    const record: GameRecord = { ...base, events: [...base.events, asked(1), answered(2, true), asked(3), answered(4, false), asked(5)] };
    expect(quizStats(record)).toEqual({ asked: 3, answered: 2, right: 1 });
    expect(journal(record)).toContain('| Вопросы с кнопками | верно: 1 из 2 · без ответа: 1 |');
    expect(journal({ ...base, events: [...base.events, asked(1)] })).toContain('| Вопросы с кнопками | без ответа: 1 |');
    // no question in the game: no row
    expect(quizStats(base)).toBeNull();
    expect(journal(base)).not.toContain('Вопросы с кнопками');
  });
});

describe('who said what, and was it heard', () => {
  const said = (t: number, who: 'childSaid' | 'coachSaid', text: string): GameEvent => ({ t, type: who, data: { text, source: 'voice' } });

  it('glues the pieces of one live utterance back together — never two different sentences or two speakers', () => {
    const merged = mergeSplitUtterances([said(1_000, 'childSaid', 'Слон пойдёт на це четыре'), said(2_500, 'childSaid', '. потом ферзь'), said(3_000, 'childSaid', 'а потом мат')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.data.text).toBe('Слон пойдёт на це четыре. потом ферзь а потом мат');
    // a new sentence (capital letter), too late, another speaker, a typed answer: kept apart
    expect(mergeSplitUtterances([said(1_000, 'childSaid', 'Привет'), said(2_000, 'childSaid', 'Как дела?')])).toHaveLength(2);
    expect(mergeSplitUtterances([said(1_000, 'childSaid', 'Слон'), said(20_000, 'childSaid', '. потом')])).toHaveLength(2);
    expect(mergeSplitUtterances([said(1_000, 'coachSaid', 'Смотри'), said(1_500, 'childSaid', '. да')])).toHaveLength(2);
    expect(mergeSplitUtterances([said(1_000, 'childSaid', 'Смотри'), { t: 1_500, type: 'childSaid', data: { text: '. да', source: 'typed' } }])).toHaveLength(2);
    // the coach's own speech is glued the same way (cut-off phrases)
    expect(mergeSplitUtterances([said(1_000, 'coachSaid', 'Конь прыгает'), said(1_800, 'coachSaid', 'буквой Г!')])[0]?.data.text).toBe('Конь прыгает буквой Г!');
  });

  it('pairs «the model says it in its own words» with the transcript that followed, in order and within 30 s', () => {
    const events: GameEvent[] = [
      { t: 10_000, type: 'coachSaid', ply: 3, data: { kind: 'praise', template: 'Молодец!', spokenBy: 'model' } },
      { t: 11_000, type: 'hintGiven', ply: 3, data: { level: 1, template: 'Что хочет соперник?', spokenBy: 'model' } },
      said(13_000, 'coachSaid', 'Вот это ход!'),
      said(16_000, 'coachSaid', 'А что задумал Петя?'),
      said(17_000, 'coachSaid', 'Кстати, ты молодец.'),
      { t: 20_000, type: 'coachSaid', data: { kind: 'encourage', template: 'Не сдавайся!', spokenBy: 'model' } },
      said(60_000, 'coachSaid', 'Совсем другое.'),
    ];
    const plan = planTimeline(events);
    expect([...plan.modelWords.entries()]).toEqual([
      [0, 'Вот это ход!'],
      [1, 'А что задумал Петя?'],
    ]);
    expect([...plan.folded]).toEqual([2, 3]);
    const lines = renderTimeline(events, 'Миша');
    expect(lines[0]).toContain('«Голосом» — слова, которые на самом деле прозвучали');
    expect(lines).toContain('- `00:10` · ход 2 — Тренер (похвала, голосом): «Вот это ход!»');
    expect(lines).toContain('- `00:11` · ход 2 — **Подсказка уровня 1 (вопрос-подсказка)** голосом: «А что задумал Петя?»');
    expect(lines).toContain('- `00:17` — Тренер (голосом): «Кстати, ты молодец.»');
    // 40 s later the words belong to something else: the encouragement says honestly that nothing was transcribed
    expect(lines).toContain('- `00:20` — Тренер (поддержка): расшифровки нет — могло не прозвучать. Смысл: «Не сдавайся!»');
    expect(lines).toContain('- `01:00` — Тренер (голосом): «Совсем другое.»');
    expect(lines.join('\n')).not.toContain('(ниже)');
    // a game without any live voice has no legend
    expect(renderTimeline(sampleGameRecord().events, 'Миша')[0]).not.toContain('Голосом');
  });

  it('keeps the child\'s words after the end of the game out of the timeline: they are «Мысли после партии»', () => {
    const record = sampleGameRecord();
    const events: GameEvent[] = [
      ...record.events,
      said(60_000, 'coachSaid', 'Здорово сыграл! Как тебе удалось найти мат?'),
      said(64_000, 'childSaid', 'Я увидел, что король заперт'),
      said(65_000, 'childSaid', '. и ферзь бьёт эф семь'),
      { t: 70_000, type: 'childSaid', data: { text: 'Не зевнуть ферзя', source: 'typed', about: 'hardestMoment' } },
      said(300_000, 'childSaid', 'А можно ещё?'),
    ];
    const withTalk = { ...record, events };
    const timeline = renderTimeline(events, 'Миша').join('\n');
    expect(timeline).toContain('Тренер (голосом): «Здорово сыграл! Как тебе удалось найти мат?»');
    expect(timeline).not.toContain('король заперт');
    expect(timeline).toContain('Миша: «Слон может пойти на це четыре!»');

    const thoughts = collectThoughts(withTalk, [{ source: 'voice', text: 'Потом я ещё думал про слона', question: 'Что запомнилось?', at: '2026-09-21T15:10:00.000Z' }]);
    expect(thoughts.map((t) => [t.source, t.question ?? null, t.text])).toEqual([
      ['voice', 'Как тебе удалось найти мат?', 'Я увидел, что король заперт. и ферзь бьёт эф семь'],
      ['typed', 'Что было самым трудным в этой партии?', 'Не зевнуть ферзя'],
      // four minutes later it is not an answer to that question any more
      ['voice', null, 'А можно ещё?'],
      ['voice', 'Что запомнилось?', 'Потом я ещё думал про слона'],
    ]);
    expect(thoughts[0]?.at).toBe(new Date(Date.parse(record.startedAt) + 64_000).toISOString());
    const section = renderThoughts(thoughts, 'Миша');
    expect(section[0]).toBe('## Мысли после партии');
    expect(section).toContain(`- \`${new Date(Date.parse(record.startedAt) + 64_000).toTimeString().slice(0, 5)}\` — На вопрос «Как тебе удалось найти мат?» Миша (голосом): «Я увидел, что король заперт. и ферзь бьёт эф семь»`);
    expect(section.join('\n')).toContain('Миша (написал): «Не зевнуть ферзя»');
    expect(renderThoughts([], 'Миша').join('\n')).toContain('пока ничего не сказал и не написал');
    // hostile text stays inert
    expect(renderThoughts([{ source: 'typed', text: 'a | b <!-- x -->', at: 'garbage' }], 'Миша')[2]).toBe('- Миша (написал): «a \\| b &lt;!-- x --&gt;»');
    expect(lastQuestion('Отличная партия! Как ты нашёл мат? Молодец.')).toBe('Как ты нашёл мат?');
    expect(lastQuestion('Молодец.')).toBeNull();
  });
});

describe('the parent\'s view of one game', () => {
  it('a game played by an adult / archived says so in the front matter and the header; a normal game counts', () => {
    const normal = journal(sampleGameRecord());
    expect(normal).toContain('\ncounts_in_progress: true\n');
    expect(normal).not.toContain('excluded:');
    expect(normal).not.toContain('В прогрессе ребёнка');
    const adult = journal(sampleGameRecord(), { excluded: 'adult' });
    expect(adult).toContain('\ncounts_in_progress: false\nexcluded: adult\n');
    expect(adult).toContain('| В прогрессе ребёнка | **не считается** — играл взрослый (проверка) |');
    expect(journal(sampleGameRecord(), { excluded: 'archived' })).toContain('в архиве после «Начать прогресс заново»');
  });

  it('shows the appended thoughts and groups which AI worked on the game in the header', () => {
    const base = sampleGameRecord();
    const record: GameRecord = {
      ...base,
      events: [
        ...base.events.slice(0, 2),
        { t: 900, type: 'coachSaid', ply: 0, data: { kind: 'strategy', strategyId: 'italian', titleRu: 'Итальянская партия', provider: 'codex', model: 'gpt-5.6-sol', billing: 'subscription', latencyMs: 2140 } },
        { t: 30_000, type: 'coachSaid', ply: 4, data: { kind: 'replan', provider: 'openrouter', planRu: 'Прячем короля.', latencyMs: 900 } },
        { t: 40_000, type: 'coachSaid', ply: 6, data: { kind: 'replan', provider: 'codex', planRu: 'Бьём по центру.', latencyMs: 900 } },
        { t: 45_000, type: 'coachSaid', ply: 6, data: { kind: 'replan', provider: 'codex', dropped: 'stale', latencyMs: 900 } },
        ...base.events.slice(2),
      ],
    };
    const review = { status: 'ready' as const, provider: 'openrouter' as const, markdown: 'Хорошо.', keyTakeaways: [], suggestedThemeTitle: null };
    expect(aiSummary(record, review)).toEqual({ strategy: { provider: 'codex', model: 'gpt-5.6-sol', billing: 'subscription', latencyMs: 2140 }, replans: { openrouter: 1, codex: 1 }, review: 'openrouter' });
    const text = journal(record, { review, thoughts: [{ source: 'typed', text: 'Было трудно в конце', question: 'Что было самым трудным в этой партии?', at: '2026-09-21T15:00:00.000Z' }] });
    expect(text).toContain('\nai: { strategy: "codex", strategy_model: "gpt-5.6-sol", strategy_billing: "subscription", replans: 2, review: "openrouter" }\n');
    expect(text).toContain('| ИИ в этой партии | стратегия — Codex (gpt-5.6-sol, через подписку, 2,1 с) · новые планы: 2 (OpenRouter ×1, Codex ×1) · разбор — ИИ-тренер (OpenRouter) |');
    expect(text).toContain('## Мысли после партии');
    expect(text).toContain('На вопрос «Что было самым трудным в этой партии?» Миша (написал): «Было трудно в конце»');
    expect(text.indexOf('## Общение с тренером')).toBeLessThan(text.indexOf('## Мысли после партии'));
    expect(text.indexOf('## Мысли после партии')).toBeLessThan(text.indexOf('## Ключевые моменты'));
    // nothing known → no row; an unknown provider / a hostile model id is not shown
    expect(journal(sampleGameRecord())).not.toContain('ИИ в этой партии');
    expect(aiSummary({ ...base, events: [{ t: 0, type: 'coachSaid', data: { kind: 'strategy', provider: 'codex', model: '<b>x</b>', billing: 'gift' } }] }, null).strategy).toEqual({ provider: 'codex', model: null, billing: null, latencyMs: null });
    expect(aiSummary({ ...base, events: [{ t: 0, type: 'coachSaid', data: { kind: 'strategy', failed: true } }] }, null).strategy).toBe('failed');
    expect(aiSummary({ ...base, events: [{ t: 0, type: 'coachSaid', data: { kind: 'strategy', provider: 'evil' } }] }, null).strategy).toBeNull();
  });
});
