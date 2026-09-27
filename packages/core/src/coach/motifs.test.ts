import { describe, expect, it } from 'vitest';
import {
  isMateMotif,
  motifExplanationRu,
  motifPracticeLineRu,
  motifTitleInlineRu,
  motifTitleRu,
  motifToPuzzleTheme,
  pickPracticeMotif,
} from './motifs.ts';
import { ALL_MOTIFS } from './test-fixtures.ts';

describe('motif wording', () => {
  it('has the expected kid-friendly titles', () => {
    expect(motifTitleRu('fork')).toBe('Вилка');
    expect(motifTitleRu('pin')).toBe('Связка');
    expect(motifTitleRu('hangingPiece')).toBe('Фигура без защиты');
    expect(motifTitleRu('mateIn1')).toBe('Мат в один ход');
    expect(motifTitleInlineRu('backRankMate')).toBe('мат на последней линии');
  });

  it('covers every motif with Russian-only, non-shaming text', () => {
    for (const m of ALL_MOTIFS) {
      for (const s of [motifTitleRu(m), motifExplanationRu(m, 'allowed'), motifExplanationRu(m, 'missed'), motifPracticeLineRu(m)]) {
        expect(s.length, m).toBeGreaterThan(3);
        expect(s, m).not.toMatch(/[A-Za-z]/);
        expect(s, m).not.toMatch(/плох|глуп|зевнул|ошиб/i);
        expect(s, m).toMatch(/^[А-ЯЁ]/);
      }
      expect(motifExplanationRu(m, 'allowed')).toMatch(/[.!]$/);
      expect(motifPracticeLineRu(m)).toMatch(/[.?»]$/);
    }
  });

  it('uses the motif words the child is taught', () => {
    expect(motifExplanationRu('fork', 'allowed')).toContain('вилк');
    expect(motifExplanationRu('pin', 'allowed')).toContain('связка');
    expect(motifExplanationRu('hangingPiece', 'allowed')).toContain('Фигура осталась без защиты');
    expect(motifExplanationRu('mateIn2', 'allowed')).toContain('угроза мата');
  });

  it('maps motifs to real lichess puzzle themes', () => {
    expect(motifToPuzzleTheme('removeDefender')).toBe('capturingDefender');
    expect(motifToPuzzleTheme('freeCapture')).toBe('hangingPiece');
    expect(motifToPuzzleTheme('kingSafety')).toBe('exposedKing');
    expect(motifToPuzzleTheme('development')).toBeUndefined();
    for (const m of ALL_MOTIFS) {
      const theme = motifToPuzzleTheme(m);
      if (theme !== undefined) expect(theme).toMatch(/^[a-z][A-Za-z0-9]+$/);
    }
  });

  it('isMateMotif', () => {
    expect(ALL_MOTIFS.filter(isMateMotif)).toEqual(['backRankMate', 'mateIn1', 'mateIn2', 'mateIn3']);
    expect(isMateMotif(undefined)).toBe(false);
  });

  it('pickPracticeMotif: most frequent allowed first, then missed, ties → first seen', () => {
    expect(pickPracticeMotif({ motifsAllowed: ['pin', 'fork', 'fork'], motifsMissed: ['mateIn1'] })).toBe('fork');
    expect(pickPracticeMotif({ motifsAllowed: ['pin', 'fork'], motifsMissed: [] })).toBe('pin');
    expect(pickPracticeMotif({ motifsAllowed: [], motifsMissed: ['skewer', 'mateIn1', 'mateIn1'] })).toBe('mateIn1');
    expect(pickPracticeMotif({ motifsAllowed: [], motifsMissed: [] })).toBeUndefined();
  });
});
