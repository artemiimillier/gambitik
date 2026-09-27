/**
 * Mini-lessons of «Учитель» (docs/TEACHING.md §2.6, §6.6): three levels per topic (l1 what, l2 why/how, l3 the
 * exception), one opening slot and one tactic/safety slot per game (blitz: one at all, «как думать»), the level from
 * the learner model of the phrase book (read-only here: `TeachContext.lessonHistory`), the exact triggers of §6.6.
 *
 * Pure decisions: which topic, which level, which slot. The words are picked by the lesson turn.
 */
import { Chess } from 'chess.js';
import type { Color, PieceType } from '@gambit/shared';
import { MINI_TOPICS } from '@gambit/content';
import { materialOf, opposite, parsePlacement, rankOf, squareIndex } from '../../analysis/board.ts';
import { winPct } from '../../analysis/eval.ts';
import { resolveUciMove } from '../board.ts';
import type { MoveIdea } from '../moveIdeas.ts';
import { nullMoveFen } from '../threats.ts';
import type { TeachDanger } from '../teacher.ts';
import type { LessonHistory } from './book.ts';
import type { LessonMemory, MiniSlot } from './types.ts';
import { ideaVariant } from './truth.ts';
import type { EngineProof } from './truth.ts';

export interface MiniDecision {
  topic: string;
  level: 1 | 2 | 3;
  slot: MiniSlot;
}

/** The mini-lesson of an idea (the l1 of «Почему так?», the topic of an advice idea). */
export const IDEA_MINI: Readonly<Record<string, string>> = {
  castle: 'castle',
  prepareCastle: 'castle',
  develop: 'development',
  centerPawn: 'center',
  fightCenter: 'center',
  supportCenter: 'center',
  centerControl: 'center',
  freeCapture: 'freeCapture',
  escape: 'hanging',
  defend: 'hanging',
  block: 'hanging',
  answerCheck: 'checkEscape',
  mate: 'mateInOne',
  defendMate: 'mateInOne',
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  discoveredAttack: 'discovered',
  removeDefender: 'removeDefender',
  trappedPiece: 'trapped',
  trade: 'pieceValues',
  winMaterial: 'pieceValues',
  kingActivity: 'kingActive',
  passedPawn: 'passedPawn',
  promotion: 'passedPawn',
  restrictKing: 'mateTechnique',
  rookOpenFile: 'openFile',
  connectRooks: 'connectRooks',
};

/** The topic a recalled takeaway points to (it gets priority for the mini of this game, §2.9). */
export function recallMiniTopic(key: string | null): string | null {
  if (!key) return null;
  const map: Readonly<Record<string, string>> = {
    'mistake.hanging': 'hanging',
    'mistake.ignoredDanger': 'hanging',
    'mistake.fork': 'fork',
    'mistake.pin': 'pin',
    'mistake.backRank': 'backRank',
    'mistake.mate': 'mateInOne',
    'mistake.earlyQueen': 'earlyQueen',
    'mistake.badTrade': 'pieceValues',
    'mistake.missedTreasure': 'freeCapture',
    'mistake.tactic': 'discovered',
    'theme.castle': 'castle',
    'theme.center': 'center',
    'theme.counterCenter': 'center',
    'theme.fortress': 'center',
    'theme.development': 'development',
    'theme.f7': 'development',
    'theme.openFile': 'openFile',
  };
  return map[key] ?? null;
}

/** The slot a topic takes: an endgame topic shares the tactic slot (§2.6: one opening + one tactic/safety per game). */
function slotOf(topic: string): MiniSlot | null {
  const spec = MINI_TOPICS[topic];
  return spec ? spec.slot : null;
}

function slotUsed(lm: Pick<LessonMemory, 'minis'>, slot: MiniSlot, blitz: boolean): boolean {
  if (blitz) return lm.minis.length > 0;
  const tactic = (s: MiniSlot): boolean => s === 'tactic' || s === 'endgame';
  return lm.minis.some((m) => (slot === 'opening' ? m.slot === 'opening' : tactic(m.slot)));
}

/**
 * The level to tell next (null = the topic is retired or would repeat the same level in two games in a row): l1 first;
 * the next level once the last one was heard and the child showed the concept since (`shown` counts from the level's
 * first telling, ./book.ts `miniTold`).
 */
export function miniLevel(topic: string, history: Readonly<LessonHistory> | null | undefined): 1 | 2 | 3 | null {
  const h = history?.minis[topic];
  if (!h || h.level <= 0) return 1;
  if (h.retired) return null;
  const advance = h.level < 3 && h.shown >= 1;
  const next = (advance ? h.level + 1 : h.level) as 1 | 2 | 3;
  // the same level again only after a game without it (cross-game spacing, §2.6)
  if (!advance && history && history.gameSeq - h.lastGame < 2) return null;
  return next;
}

export interface MiniChoiceArgs {
  stage: number;
  blitz: boolean;
  lm: Pick<LessonMemory, 'minis'>;
  history: Readonly<LessonHistory> | null | undefined;
  /** the recalled topic comes first when it is among the triggers */
  recallTopic?: string | null;
  /** can the phrase book say this pool at this stage? (default: yes) */
  has?: (pool: string) => boolean;
}

/**
 * The only mini-lesson of a blitz game (§2.2 after the second 50-game run): «как думать», in a one-sentence wording
 * (the caller's `has` checks the words) — no danger mini-lesson in blitz, the danger is its one sentence there.
 */
export const BLITZ_MINI_TOPICS: ReadonlySet<string> = new Set(['thinking']);

/** The first triggered topic that fits the stage, has a free slot, a level and words (blitz: `BLITZ_MINI_TOPICS`). */
export function decideMini(topics: readonly string[], a: MiniChoiceArgs): MiniDecision | null {
  const ordered = a.recallTopic && topics.includes(a.recallTopic) ? [a.recallTopic, ...topics.filter((t) => t !== a.recallTopic)] : [...topics];
  for (const topic of ordered) {
    if (a.blitz && !BLITZ_MINI_TOPICS.has(topic)) continue;
    const spec = MINI_TOPICS[topic];
    const slot = slotOf(topic);
    if (!spec || !slot) continue;
    if (a.stage < spec.stages[0] || a.stage > spec.stages[1]) continue;
    if (slotUsed(a.lm, slot, a.blitz)) continue;
    if (a.lm.minis.some((m) => m.topic === topic)) continue;
    const level = miniLevel(topic, a.history);
    if (level === null) continue;
    if (a.has && !a.has(`v3.mini.${topic}.l${level}`)) continue;
    return { topic, level, slot };
  }
  return null;
}

/** «Почему так?» tells a mini-lesson topic again only after this many games (else the theme link or the second idea). */
export const WHY_MINI_GAMES = 3;

/**
 * The mini-lesson «Почему так?» may tell about the advice's idea (§2.3): the child's own level of the topic
 * (`miniLevel`: the next one once the last was heard and shown) — not a topic told this game or in the last
 * `WHY_MINI_GAMES` games, not a retired one, only at the topic's stages and with words. null = none.
 */
export function whyMini(topic: string | undefined, a: { stage: number; lm: Pick<LessonMemory, 'minis'>; history: Readonly<LessonHistory>; has: (pool: string) => boolean }): { topic: string; level: 1 | 2 | 3 } | null {
  const spec = topic ? MINI_TOPICS[topic] : undefined;
  if (!topic || !spec || a.stage < spec.stages[0] || a.stage > spec.stages[1]) return null;
  if (a.lm.minis.some((m) => m.topic === topic)) return null;
  const h = a.history.minis[topic];
  if (h && h.level > 0 && h.lastGame >= 0 && a.history.gameSeq - h.lastGame < WHY_MINI_GAMES) return null;
  const level = miniLevel(topic, a.history);
  if (level === null || !a.has(`v3.mini.${topic}.l${level}`)) return null;
  return { topic, level };
}

// ───────────────────────── triggers (§6.6) ─────────────────────────

/** The mini told inside a danger moment the first time its reason appears this game. */
export function dangerMiniTopic(danger: Pick<TeachDanger, 'kind' | 'conceptId'> | null): string | null {
  if (!danger) return null;
  switch (danger.kind) {
    case 'hanging':
      return 'hanging';
    case 'check':
      return 'checkEscape';
    case 'mate':
      return danger.conceptId === 'scholars-mate' ? 'scholarsMate' : danger.conceptId === 'back-rank-mate' ? 'backRank' : 'mateInOne';
    case 'threat':
      return danger.conceptId === 'fork' ? 'fork' : null;
  }
}

export interface AdviceMiniArgs {
  fen: string;
  childColor: Color;
  ply: number;
  /** child turn number this game (1-based) */
  turnNo: number;
  advice: { uci: string; san: string; allIdeas: readonly MoveIdea[]; mate?: number | null } | null;
  /** the opponent's last move and whether it was an early queen */
  opponent: { earlyQueen: boolean } | null;
  proof: EngineProof | null;
}

function castleLegalAfter(fen: string, uci: string): boolean {
  const mv = resolveUciMove(fen, uci);
  if (!mv) return false;
  const nf = nullMoveFen(mv.fenAfter);
  if (!nf) return false;
  try {
    return new Chess(nf).moves().some((m) => m.startsWith('O-O'));
  } catch {
    return false;
  }
}

function capturesOfDifferentValue(fen: string): boolean {
  try {
    const values = new Set(
      new Chess(fen)
        .moves({ verbose: true })
        .filter((m) => m.captured)
        .map((m) => m.captured as PieceType)
        .map((p) => (p === 'n' || p === 'b' ? 3 : p === 'p' ? 1 : p === 'r' ? 5 : 9)),
    );
    return values.size >= 2;
  } catch {
    return false;
  }
}

function loneKingCramped(fen: string, childColor: Color): boolean {
  try {
    const b = parsePlacement(fen);
    const them = opposite(childColor);
    if (b.some((p) => p && p.color === them && p.type !== 'k')) return false;
    if (materialOf(b, childColor) - materialOf(b, them) < 5) return false;
    const nf = nullMoveFen(fen);
    if (!nf) return false;
    return new Chess(nf).moves().length <= 2;
  } catch {
    return false;
  }
}

function hasEnemyQueen(fen: string, childColor: Color): boolean {
  try {
    return parsePlacement(fen).some((p) => p && p.color !== childColor && p.type === 'q');
  } catch {
    return true;
  }
}

/**
 * The topics the ADVICE of this turn triggers (§6.6), most specific first. A treasure's own minis (mate in one, free
 * capture, the gift fork) wait until the gift is resolved — they are not here.
 */
export function adviceMiniTopics(a: AdviceMiniArgs): string[] {
  const out: string[] = [];
  const adv = a.advice;
  const has = (id: string): MoveIdea | undefined => adv?.allIdeas.find((i) => i.id === id);
  const mv = adv ? resolveUciMove(a.fen, adv.uci) : undefined;
  if (adv && mv) {
    // castling «now» (the advice is the castle) or «next move» (the advice clears the way, then it is legal; ply ≥ 8)
    if (mv.isCastle) out.push('castle');
    else if (has('prepareCastle') && a.ply >= 8 && castleLegalAfter(a.fen, adv.uci)) out.push('castle');
    // tactics of the advice itself
    for (const [idea, topic] of [
      ['fork', 'fork'],
      ['pin', 'pin'],
      ['skewer', 'skewer'],
      ['discoveredAttack', 'discovered'],
      ['removeDefender', 'removeDefender'],
      ['trappedPiece', 'trapped'],
    ] as const) {
      if (has(idea)) out.push(topic);
    }
    if (has('kingActivity') && !hasEnemyQueen(a.fen, a.childColor)) out.push('kingActive');
    const trade = has('trade');
    if (trade) {
      try {
        const b = parsePlacement(a.fen);
        const diff = materialOf(b, a.childColor) - materialOf(b, opposite(a.childColor));
        if (diff >= 3 && a.proof && a.proof.best >= winPct({ cp: 250, mate: null })) out.push('tradeWhenAhead');
      } catch {
        // no trade lesson on a broken FEN
      }
    }
    const rook = has('rookOpenFile');
    if (rook && ideaVariant(rook, a.fen, adv.uci) === 'open') out.push('openFile');
    if (a.opponent?.earlyQueen) {
      const attack = has('attack');
      const b1 = mv ? parsePlacement(mv.fenAfter) : null;
      const onQueen = !!attack && (attack.covers?.includes('develop') || attack.squares.some((sq) => b1?.[squareIndex(sq)]?.type === 'q'));
      if (onQueen) out.push('earlyQueen');
    }
    if (trade || capturesOfDifferentValue(a.fen)) out.push('pieceValues');
    const passed = has('passedPawn');
    if (passed && mv.piece === 'p') {
      const rel = a.childColor === 'w' ? rankOf(squareIndex(mv.to)) : 7 - rankOf(squareIndex(mv.to));
      if (rel >= 4) out.push('passedPawn');
    }
    if (has('restrictKing')) out.push('mateTechnique');
    if (has('connectRooks')) out.push('connectRooks');
    // (the opening words wait for turn 4: turn 3 belongs to «как думать»)
    if (a.turnNo >= 4 && (has('centerPawn') || has('fightCenter'))) out.push('center');
    if (a.turnNo >= 4 && has('develop')) out.push('development');
  } else if (capturesOfDifferentValue(a.fen)) {
    out.push('pieceValues');
  }
  if (loneKingCramped(a.fen, a.childColor)) out.push('stalemate');
  // «как думать»: the child's third move of every teacher game (first, when it is due)
  if (a.turnNo === 3) out.unshift('thinking');
  return [...new Set(out)];
}
