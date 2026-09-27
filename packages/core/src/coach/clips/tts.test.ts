/**
 * «Дозапись голоса»: the TTS text of a lesson unit and the «pack» recipe (one paid job for a request's missing parts,
 * split at `<#0.6#>` silences). Pure strings — nothing is generated or played.
 */
import { describe, expect, it } from 'vitest';
import { PACK_MAX_CHARS, PACK_MAX_PARTS, PACK_SPLIT, PACK_TAG, packProblem, packPrompt, ttsPartText } from './tts.ts';

describe('ttsPartText', () => {
  it('drops «» and " quotes, keeps ё, dashes, colons and capitals', () => {
    expect(ttsPartText('Сегодня играем «Итальянскую партию» — быстро выводим фигуры.', 'whole')).toBe('Сегодня играем Итальянскую партию — быстро выводим фигуры.');
    expect(ttsPartText('Разыграем "Защиту Каро-Канн": ещё один план!', 'whole')).toBe('Разыграем Защиту Каро-Канн: ещё один план!');
  });

  it('a lead before its tail gets no end mark, a lead said alone gets the «.» its bubble shows', () => {
    expect(ttsPartText('Давай сходим конём', 'lead')).toBe('Давай сходим конём');
    expect(ttsPartText('Давай сходим конём', 'leadAlone')).toBe('Давай сходим конём.');
    expect(ttsPartText('Хм…', 'leadAlone')).toBe('Хм…');
  });

  it('keeps a tail and the options sentence as written', () => {
    expect(ttsPartText('— и это мат!', 'tail')).toBe('— и это мат!');
    expect(ttsPartText('Коня, слона или ладью?', 'frag')).toBe('Коня, слона или ладью?');
  });

  it('collapses spaces the way the bubble joins them', () => {
    expect(ttsPartText('  Смотри ,  тут   подарок !', 'whole')).toBe('Смотри, тут подарок!');
  });
});

describe('the pack recipe', () => {
  it('is measured: tags of 0.6 s, a 700 ms split, ≤ 4 parts, ≤ 240 characters', () => {
    expect(PACK_TAG).toBe('<#0.6#>');
    expect(PACK_SPLIT).toEqual({ mode: 'tags', minSilenceMs: 700 });
    expect(PACK_MAX_PARTS).toBe(4);
    expect(PACK_MAX_CHARS).toBe(240);
  });

  it('joins the parts in spoken order with the tag', () => {
    expect(packPrompt(['Давай сходим конём', '— и это мат!', 'Отличный ход.'])).toBe('Давай сходим конём<#0.6#>— и это мат!<#0.6#>Отличный ход.');
    expect(packPrompt(['Что задумал соперник?'])).toBe('Что задумал соперник?');
  });

  it('refuses a pack that breaks a rule (the caller splits the request)', () => {
    expect(packProblem([])).toBe('empty');
    expect(packProblem(['Раз.', ' '])).toBe('blank-part');
    expect(packProblem(['Раз.<#0.3#>Два.'])).toBe('tag-inside');
    expect(packProblem(['Раз.', 'Два.', 'Три.', 'Четыре.', 'Пять.'])).toBe('too-many');
    expect(packProblem(['Что задумал соперник?', 'Отличный ход.'])).toBe('question-not-last');
    expect(packProblem(['Видишь?', 'Куда пойдёт конь?'])).toBe('question-not-last');
    expect(packProblem(['Отличный ход.', 'Что задумал соперник?'])).toBeNull();
    expect(packPrompt(['Что задумал соперник?', 'Отличный ход.'])).toBeNull();
  });

  it('counts characters as the price does: code points, tags included', () => {
    const a = 'а'.repeat(113);
    // 113 + 7 + 113 = 233 ≤ 240; one more tag and part is over
    expect(packProblem([a, a])).toBeNull();
    expect(packProblem([a, a, 'Да.'])).toBe('too-long');
    expect(packProblem(['ё'.repeat(PACK_MAX_CHARS)])).toBeNull();
    expect(packProblem(['ё'.repeat(PACK_MAX_CHARS + 1)])).toBe('too-long');
  });
});
