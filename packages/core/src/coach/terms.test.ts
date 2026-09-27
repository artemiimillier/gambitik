/**
 * One word for one idea (TEACHER-MODE §2.8.6): the coach's motif terms are the titles of the concept cards the child
 * reads («вилка», «связка», «сквозной удар», «мат на последней линии» …) — never a second name («линейный удар»).
 * The cards live in @gambit/content; this test reads them through a test-only relative import (no runtime dependency).
 */
import { describe, expect, it } from 'vitest';
import type { MotifId } from '@gambit/shared';
import { CONCEPT_CARDS } from '../../../content/src/conceptCards.ts';
import { allowedFactRu, motifAccRu, motifWithGlossRu } from './brief.ts';
import { buildExplainBest, buildPraise, buildTakebackOffer, buildThreatWarning } from './events.ts';
import { motifExplanationRu, motifPracticeLineRu, motifTitleRu } from './motifs.ts';
import { RNG_SWEEP, bestMoveJudgement, constRng, facts, forkBlunder, profile, queenBlunder, FORK_FEN } from './test-fixtures.ts';

/** The tactical / mating motifs a child meets both on a card and in the coach's words. */
const CARD_TERMS: readonly MotifId[] = ['fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'removeDefender', 'trappedPiece', 'backRankMate', 'mateIn1', 'mateIn2', 'mateIn3', 'promotion'];

describe('motif terms = concept card titles', () => {
  it.each(CARD_TERMS)('%s', (m) => {
    const card = CONCEPT_CARDS.find((c) => c.motif === m);
    expect(card, m).toBeDefined();
    expect(motifTitleRu(m)).toBe(card?.title);
  });

  it('«сквозной удар» everywhere, «линейный удар» nowhere', () => {
    const p = profile();
    const texts: string[] = [
      motifTitleRu('skewer'),
      motifAccRu('skewer'),
      motifWithGlossRu('skewer'),
      allowedFactRu('skewer'),
      motifExplanationRu('skewer', 'allowed'),
      motifExplanationRu('skewer', 'missed'),
      motifPracticeLineRu('skewer'),
    ];
    for (const r of RNG_SWEEP) {
      const rng = constRng(r);
      for (const e of [
        buildPraise(bestMoveJudgement('skewer'), p, rng),
        buildExplainBest(forkBlunder({ missedMotif: 'skewer', allowedMotif: 'skewer' }), p, rng),
        buildTakebackOffer(queenBlunder({ allowedMotif: 'skewer' }), p, rng),
        buildThreatWarning({ fen: FORK_FEN, facts: facts(FORK_FEN), profile: p, threat: { uci: 'd4c2', san: 'Nxc2+', motif: 'skewer', targetSquares: ['e1', 'a1'], gainCp: 500 } }, rng),
      ]) {
        if (e) texts.push(e.text, e.bubbleText, e.brief ?? '');
      }
    }
    const all = texts.join('\n');
    expect(all).toMatch(/сквозн/i);
    expect(all).not.toMatch(/линейн/i);
  });

  it('the back-rank mate is «на последней линии», as on the card and in the review prompt', () => {
    expect(motifTitleRu('backRankMate')).toBe('Мат на последней линии');
    expect(motifAccRu('backRankMate')).toBe('мат на последней линии');
    expect(allowedFactRu('backRankMate')).not.toMatch(/горизонтал/);
  });
});
