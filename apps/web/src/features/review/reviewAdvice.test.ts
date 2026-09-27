import { describe, expect, it } from 'vitest';
import { conceptCardForMoment, drillableTheme, suggestPractice, themeOfMotif } from './reviewAdvice.ts';
import { sampleRecord } from './testFixtures.ts';

describe('review advice (game → weakness → practice)', () => {
  it('offers only real drill themes with a Russian title', () => {
    expect(drillableTheme('fork')).toEqual({ theme: 'fork', title: expect.stringMatching(/[А-Яа-я]/) });
    for (const bad of [null, undefined, '', 'mix', 'oneMove', 'opening', 'noSuchTheme', 'fork; drop table', '../etc']) expect(drillableTheme(bad), String(bad)).toBeNull();
  });

  it('prefers the reviewer\'s suggestion when the server sends a valid one', () => {
    const record = sampleRecord();
    expect(suggestPractice(record, 'pin')?.theme).toBe('pin');
    // junk from an LLM never becomes a button
    expect(suggestPractice(record, 'javascript:alert(1)')?.theme).toBe('hangingPiece');
  });

  it('falls back to the most frequent motif of the game itself', () => {
    const record = sampleRecord();
    expect(suggestPractice(record)?.theme).toBe('hangingPiece');
    const forks = sampleRecord({ summary: { ...record.summary, keyMoments: [], motifsAllowed: ['fork', 'pin', 'fork'], motifsMissed: ['pin'] } });
    expect(suggestPractice(forks)?.theme).toBe('fork'); // 2 × fork, 2 × pin → the earliest wins the tie
    const nothing = sampleRecord({ summary: { ...record.summary, keyMoments: [], motifsAllowed: [], motifsMissed: [] } });
    expect(suggestPractice(nothing)).toBeNull();
  });

  it('proud moments do not send the child to practise what already works', () => {
    const record = sampleRecord();
    const proudOnly = sampleRecord({
      summary: { ...record.summary, motifsAllowed: [], motifsMissed: [], keyMoments: [{ ...record.summary.keyMoments[0]!, classification: 'best', motif: 'fork' }] },
    });
    expect(suggestPractice(proudOnly)).toBeNull();
  });

  it('maps motifs without an own Lichess tag through their concept card, or to nothing', () => {
    expect(themeOfMotif('fork')?.theme).toBe('fork');
    const viaCard = themeOfMotif('freeCapture');
    expect(viaCard === null || typeof viaCard.title === 'string').toBe(true);
    expect(themeOfMotif('development')?.theme).not.toBe('opening');
  });

  it('links a key moment to the concept card of its motif', () => {
    expect(conceptCardForMoment({ motif: 'fork' })?.motif).toBe('fork');
    expect(conceptCardForMoment({})).toBeNull();
  });
});
