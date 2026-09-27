import { describe, expect, it } from 'vitest';
import type { KeyMoment } from '@gambit/shared';
import {
  ACCEPT_TRY_LOSS_PCT,
  MAX_MOMENT_TRIES,
  SHOW_ANSWER_DELAY_MS,
  answersUnlocked,
  buildReviewMomentEvent,
  canShowAnswer,
  hintAnnotations,
  isCorrectVerdict,
  judgeTry,
  momentCaptionRu,
  refineVerdict,
  resolveMoment,
  revealAnnotations,
  tryFeedbackRu,
  untouchedTaskCount,
} from './reviewMoment.ts';
import { FEN_MOVE3, judgementOf, sampleRecord } from './testFixtures.ts';

const record = sampleRecord();
const moment = record.summary.keyMoments[0] as KeyMoment;

describe('resolveMoment', () => {
  it('finds the best and the played move through the matching judgement', () => {
    const resolved = resolveMoment(moment, record.judgements);
    expect(resolved.best?.uci).toBe('f1c4');
    expect(resolved.played?.uci).toBe('h5e5');
    expect(resolved.judgement?.san).toBe('Qxe5+');
    expect(resolved.color).toBe('w');
    expect(resolved.moveLabel).toBe('3.');
    expect(resolved.isProud).toBe(false);
  });

  it('falls back to the SAN of the key moment when no judgement matches', () => {
    const resolved = resolveMoment({ ...moment, playedSan: 'Qxe5+??', bestSan: 'Bc4!' }, []);
    expect(resolved.best?.uci).toBe('f1c4');
    expect(resolved.played?.uci).toBe('h5e5');
    expect(resolved.judgement).toBeUndefined();
  });

  it('survives a moment whose moves do not fit the position', () => {
    const resolved = resolveMoment({ ...moment, bestSan: 'Zz9', playedSan: '' }, []);
    expect(resolved.best).toBeNull();
    expect(resolved.played).toBeNull();
    expect(judgeTry(resolved, 'f1c4')).toBe('other');
    expect(revealAnnotations(resolved).arrows).toEqual([]);
  });

  it('recognises a proud moment (the played move was the best)', () => {
    const proud: KeyMoment = { ply: 7, fenBefore: record.judgements[4]?.fenBefore ?? '', playedSan: 'Qxf7#', bestSan: 'Qxf7#', classification: 'best', explanation: 'Мат! Ферзь и слон сработали вместе.' };
    const resolved = resolveMoment(proud, record.judgements);
    expect(resolved.isProud).toBe(true);
    expect(revealAnnotations(resolved).arrows).toEqual([{ from: 'h5', to: 'f7', color: 'green' }]);
    const event = buildReviewMomentEvent(resolved, 'revealed', () => 0);
    expect(event.pose).toBe('cheer');
    expect(event.text).toContain('Мат!');
  });
});

describe('judgeTry', () => {
  const resolved = resolveMoment(moment, record.judgements);

  it('compares the try with the recorded best move', () => {
    expect(judgeTry(resolved, 'f1c4')).toBe('best');
    expect(judgeTry(resolved, 'h5e5')).toBe('samePlayed');
    expect(judgeTry(resolved, 'g1f3')).toBe('other');
    expect(judgeTry(resolved, 'a1a5')).toBe('illegal');
    expect(judgeTry(resolved, 'junk')).toBe('illegal');
  });

  it('accepts a checkmate that is not the recorded best move', () => {
    const fen = '6k1/5ppp/8/8/8/8/5PPP/R3R1K1 w - - 0 1';
    const mating = resolveMoment({ ply: 1, fenBefore: fen, playedSan: 'h3', bestSan: 'Ra8#', classification: 'missedWin', explanation: 'Тут был мат.' }, [judgementOf(fen, 'h3', 'Ra8#', 'mistake', 1)]);
    expect(judgeTry(mating, 'a1a8')).toBe('best');
    expect(judgeTry(mating, 'e1e8')).toBe('mate');
  });

  it('gives kind feedback that never blames', () => {
    for (const verdict of ['best', 'mate', 'good', 'better', 'samePlayed', 'other', 'illegal'] as const) {
      for (const left of [0, 1, MAX_MOMENT_TRIES]) {
        const text = tryFeedbackRu(verdict, left);
        expect(text.length).toBeGreaterThan(5);
        expect(text).not.toMatch(/(неправильно|плохо|ошиб|глуп)/i);
      }
    }
  });
});

describe('engine-checked tries (any good move counts, not only the first choice of the engine)', () => {
  const resolved = resolveMoment(moment, record.judgements); // the played blunder lost 47 win%
  const evaluation = (winPctLoss: number) => ({ winPctLoss, winPctAfter: 52 - winPctLoss, classification: 'good' as const });

  it('accepts a move within a small win% loss of the best one', () => {
    expect(refineVerdict('other', evaluation(0), resolved.judgement)).toBe('good');
    expect(refineVerdict('other', evaluation(ACCEPT_TRY_LOSS_PCT - 0.1), resolved.judgement)).toBe('good');
    expect(isCorrectVerdict('good')).toBe(true);
    expect(tryFeedbackRu('good', 2)).toBe('Это тоже хороший ход!');
  });

  it('says «лучше, чем в партии» only when the numbers prove it, and still asks for a stronger move', () => {
    expect(refineVerdict('other', evaluation(12), resolved.judgement)).toBe('better'); // 47 → 12
    expect(refineVerdict('other', evaluation(45), resolved.judgement)).toBe('other'); // hardly better than the blunder
    expect(refineVerdict('other', evaluation(12), undefined)).toBe('other'); // nothing to compare with → no claim
    expect(isCorrectVerdict('better')).toBe(false);
    expect(tryFeedbackRu('better', 1)).toContain('лучше, чем в партии');
  });

  it('claims nothing when the engine could not answer, and never touches a final verdict', () => {
    expect(refineVerdict('other', null, resolved.judgement)).toBe('other');
    expect(refineVerdict('other', { ...evaluation(0), winPctLoss: Number.NaN }, resolved.judgement)).toBe('other');
    expect(refineVerdict('samePlayed', evaluation(0), resolved.judgement)).toBe('samePlayed');
    expect(refineVerdict('best', evaluation(30), resolved.judgement)).toBe('best');
    expect(tryFeedbackRu('other', 2)).not.toMatch(/лучше, чем в партии|тоже хороший/);
  });

  it('praises the child\'s own good move and still names the engine\'s favourite', () => {
    const event = buildReviewMomentEvent(resolved, 'found', () => 0, { san: 'Nf3', from: 'g1', to: 'f3' });
    expect(event.pose).toBe('cheer');
    expect(event.text).toContain('тоже хороший ход');
    expect(event.text).toContain('конь на эф три');
    expect(event.text).toContain('слон на цэ четыре');
    expect(event.text).not.toMatch(/[A-Za-z]/);
    expect(event.text).not.toMatch(/наш[ёе]л|нашла/); // gender-neutral
    expect(event.bubbleText).toContain('Кf3');
    expect(event.board?.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'blue' });
  });
});

describe('true solve-first', () => {
  it('offers «Показать ответ» only after a real try — or after 20 s', () => {
    expect(canShowAnswer(0, 0)).toBe(false);
    expect(canShowAnswer(0, SHOW_ANSWER_DELAY_MS - 1)).toBe(false);
    expect(canShowAnswer(0, SHOW_ANSWER_DELAY_MS)).toBe(true);
    expect(canShowAnswer(1, 0)).toBe(true);
  });

  it('keeps the answers closed while a task moment is untouched; proud moments are not tasks', () => {
    const task = { isProud: false };
    const proud = { isProud: true };
    expect(untouchedTaskCount([task, proud, task], {})).toBe(2);
    expect(untouchedTaskCount([task, proud, task], { 0: 'tried' })).toBe(1);
    expect(untouchedTaskCount([task, proud, task], { 0: 'found', 2: 'revealed' })).toBe(0);
    expect(untouchedTaskCount([proud], {})).toBe(0);
    expect(answersUnlocked(2, false)).toBe(false);
    expect(answersUnlocked(0, false)).toBe(true);
    expect(answersUnlocked(2, true)).toBe(true);
  });

  it('the hint shows WHICH piece to look at, never where it goes', () => {
    const resolved = resolveMoment(moment, record.judgements);
    expect(hintAnnotations(resolved)).toEqual({ arrows: [], highlights: [{ square: 'f1', color: 'yellow' }] });
    expect(hintAnnotations({ best: null })).toBeNull();
  });
});

describe('buildReviewMomentEvent', () => {
  const resolved = resolveMoment(moment, record.judgements);

  it('is a reviewMoment event with a Latin-free spoken text and Russian notation in the bubble', () => {
    for (const outcome of ['found', 'revealed'] as const) {
      for (const r of [0, 0.4, 0.99]) {
        const event = buildReviewMomentEvent(resolved, outcome, () => r);
        expect(event.kind).toBe('reviewMoment');
        expect(event.priority).toBe(1);
        expect(event.pauseClock).toBe(false);
        expect(event.text).not.toMatch(/[A-Za-z]/);
        expect(event.text).toContain('слон на цэ четыре');
        expect(event.text).toContain('Пешку защищает конь');
        expect(event.bubbleText).toContain('3. Сc4');
      }
    }
    expect(buildReviewMomentEvent(resolved, 'found', () => 0).pose).toBe('cheer');
    expect(buildReviewMomentEvent(resolved, 'revealed', () => 0).pose).toBe('talk');
  });

  it('does not say «Сильнее было» after the child found the best move itself (it would contradict the praise)', () => {
    for (const r of [0, 0.4, 0.99]) {
      const found = buildReviewMomentEvent(resolved, 'found', () => r);
      expect(found.text).not.toContain('Сильнее было');
      expect(found.bubbleText).not.toContain('Сильнее было');
      expect(found.bubbleText).toContain('Лучший ход — 3. Сc4');
      expect(buildReviewMomentEvent(resolved, 'revealed', () => r).bubbleText).toContain('Сильнее было 3. Сc4');
    }
  });

  it('draws the best move green and the played move red', () => {
    expect(buildReviewMomentEvent(resolved, 'revealed').board).toEqual({
      arrows: [
        { from: 'h5', to: 'e5', color: 'red' },
        { from: 'f1', to: 'c4', color: 'green' },
      ],
      highlights: [],
    });
  });

  it('strips Latin notation that an LLM explanation might contain from the spoken text only', () => {
    const noisy = resolveMoment({ ...moment, explanation: 'После Qxe5+ конь бьёт ферзя (Nxe5).' }, record.judgements);
    const event = buildReviewMomentEvent(noisy, 'revealed', () => 0);
    expect(event.text).not.toMatch(/[A-Za-z]/);
    expect(event.bubbleText).toContain('Nxe5');
  });

  it('captions the moment card', () => {
    // never the head-on label of the child's move («Зевок», «Ошибка»)
    expect(momentCaptionRu(resolved)).toBe('Фигура под боем на 3-м ходу');
    expect(momentCaptionRu({ ...resolved, moment: { ...moment, motif: 'fork' } })).toBe('Трудный момент на 3-м ходу');
    expect(momentCaptionRu({ ...resolved, moment: { ...moment, classification: 'missedWin' } })).toBe('Упущенный шанс на 3-м ходу');
    expect(momentCaptionRu({ ...resolved, isProud: true })).toBe('Сильный ход на 3-м ходу');
    expect(momentCaptionRu({ ...resolved, moveLabel: '?' })).toBe('Фигура под боем');
    for (const classification of ['inaccuracy', 'mistake', 'blunder', 'missedWin'] as const) {
      expect(momentCaptionRu({ ...resolved, moment: { ...moment, classification } })).not.toMatch(/зевок|ошибк/i);
    }
    expect(FEN_MOVE3).toContain(' w ');
  });
});
