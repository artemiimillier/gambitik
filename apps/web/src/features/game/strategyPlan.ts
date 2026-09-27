/**
 * «Учитель» + the smart strategist: WHEN the game asks the smart model to re-plan, and WHAT it may choose from.
 * Pure functions (chess.js + @gambit/core), no timers, no network — the game controller (gameStore.ts) runs them at the
 * moment the bot's move is DECIDED (before its human-like pause), always on the real move, never on a guess.
 *
 *  - `strategyLineStatus`: is the game still on the strategy's line? With the card's whole main line (both sides) any
 *    deviation leaves it at once; with only the child's planned moves, the next plan move must stay legal. Either way
 *    the plan move must be among the engine's candidates within the teacher's tolerance; without a card the teacher's
 *    repertoire memory says whether the opponent played the model reply.
 *  - `replanTrigger`: the opponent left the line (once per departure), the phase changed (opening → middlegame →
 *    endgame), or every `everyPlies` plies in the middlegame / endgame.
 *  - `replanCandidates`: the engine's top lines of the child's position within tolerance, with the code's ideas in kid
 *    words — the smart model may only pick one of these (the server and `acceptReplan` check it).
 */
import { Chess } from 'chess.js';
import { TEACH_TOLERANCE_CP, explainMove, pickIdeas, teachScoreCp } from '@gambit/core';
import type { Color, EngineLine, PositionFacts, ReplanRequest } from '@gambit/shared';

export type GamePhase = PositionFacts['phase'];
export type LineStatus = 'on' | 'off' | 'done' | 'unknown';
export type ReplanTrigger = 'leftLine' | 'phase' | 'cadence';

/** A re-plan at most this often in the middlegame / endgame when nothing else happens (every ~6 plies). */
export const REPLAN_EVERY_PLIES = 6;
/** Engine candidates offered to the smart model (the teacher's MultiPV is 3). */
export const REPLAN_MAX_CANDIDATES = 3;

function uciOfSan(fen: string, san: string): string | null {
  try {
    const move = new Chess(fen).move(san);
    return `${move.from}${move.to}${move.promotion ?? ''}`;
  } catch {
    return null;
  }
}

function sanOfUci(fen: string, uci: string): string | null {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined }).san;
  } catch {
    return null;
  }
}

export interface LineStatusArgs {
  /** the child's position right after the bot's (decided) move */
  fen: string;
  childColor: Color;
  /** SAN of the whole game up to `fen`, the bot's move included */
  historySan: readonly string[];
  /** the curated card's line of the child's planned moves (SAN); null = no card known */
  lineSan: readonly string[] | null;
  /** the card's whole main line from the initial position, both sides (SAN) — the opponent's deviation is seen at once */
  mainLineSan?: readonly string[] | null;
  /** engine lines of `fen` (side to move = the child); empty = not analysed (legality only) */
  lines?: readonly EngineLine[];
  /** the teacher's repertoire memory: the opponent's model reply (null = none / not in book) */
  repertoireOppNext?: string | null;
  repertoireInBook?: boolean;
  toleranceCp?: number;
}

function sameSan(x: string | undefined, y: string | undefined): boolean {
  return x !== undefined && y !== undefined && x.replace(/[+#!?]+$/u, '') === y.replace(/[+#!?]+$/u, '');
}

/** The plan move `next` in `fen`: illegal → off; with engine lines it must be among them within the tolerance. */
function planMoveStatus(fen: string, next: string, lines: readonly EngineLine[], toleranceCp: number): LineStatus {
  const uci = uciOfSan(fen, next);
  if (uci === null) return 'off';
  if (lines.length === 0) return 'on';
  const best = lines[0];
  const own = lines.find((line) => line.pvUci[0] === uci);
  if (!best || !own) return 'off';
  return teachScoreCp(best) - teachScoreCp(own) <= toleranceCp ? 'on' : 'off';
}

/**
 * On the line = the game followed the card's main line (both sides; without one: the child played the card's moves) so
 * far, and the next planned move is legal here and — when there is an analysis — within the tolerance of the best line
 * (a plan move the engine does not even list counts as «off»: the plan has to be thought over). The card's line played
 * to its end = 'done'. Without a card: the teacher's repertoire memory.
 */
export function strategyLineStatus(a: LineStatusArgs): { status: LineStatus; nextSan: string | null } {
  const bot = a.historySan[a.historySan.length - 1];
  const tolerance = a.toleranceCp ?? TEACH_TOLERANCE_CP;
  const main = a.mainLineSan ?? null;
  if (main && main.length > 0 && a.historySan.length < main.length) {
    // the whole main line (both sides) is known: any deviation — the bot's or the child's — leaves it
    for (let i = 0; i < a.historySan.length; i++) if (!sameSan(a.historySan[i], main[i])) return { status: 'off', nextSan: null };
    const next = main[a.historySan.length] as string;
    return { status: planMoveStatus(a.fen, next, a.lines ?? [], tolerance), nextSan: next };
  }
  if (a.lineSan && a.lineSan.length > 0) {
    // the child's own moves so far: White plays plies 1, 3, … ; Black plays 2, 4, …
    const first = a.childColor === 'w' ? 0 : 1;
    const played = a.historySan.filter((_, index) => index % 2 === first);
    for (let i = 0; i < played.length; i++) {
      if (i >= a.lineSan.length) return { status: 'done', nextSan: null };
      if (!sameSan(played[i], a.lineSan[i])) return { status: 'off', nextSan: null };
    }
    const next = a.lineSan[played.length];
    if (next === undefined) return { status: 'done', nextSan: null };
    return { status: planMoveStatus(a.fen, next, a.lines ?? [], tolerance), nextSan: next };
  }
  if (a.repertoireInBook === true && typeof a.repertoireOppNext === 'string' && bot !== undefined) {
    return { status: bot === a.repertoireOppNext ? 'on' : 'off', nextSan: null };
  }
  return { status: 'unknown', nextSan: null };
}

export interface ReplanTriggerArgs {
  /** the ply the child is about to play (after the bot's move) */
  ply: number;
  phase: GamePhase;
  /** the phase the current plan was made for (the strategy starts in the opening) */
  planPhase: GamePhase;
  /** line status before the bot's move (what the plan assumed) and after it */
  lineBefore: LineStatus;
  lineAfter: LineStatus;
  /** ply of the last re-plan request; null = none yet this game */
  lastReplanPly: number | null;
  everyPlies?: number;
}

/**
 * Why to re-plan now, or null. «Left the line» fires once, on the move that leaves it (not on every later move); a new
 * phase always; in the middlegame / endgame every `everyPlies` plies after the last re-plan.
 */
export function replanTrigger(a: ReplanTriggerArgs): ReplanTrigger | null {
  if (a.lineAfter === 'off' && a.lineBefore !== 'off') return 'leftLine';
  if (a.phase !== a.planPhase) return 'phase';
  if (a.phase !== 'opening' && a.lastReplanPly !== null && a.ply - a.lastReplanPly >= (a.everyPlies ?? REPLAN_EVERY_PLIES)) return 'cadence';
  return null;
}

export type ReplanCandidate = ReplanRequest['candidates'][number];

/**
 * The engine's candidate moves for the child: the lines of `fen` within the tolerance of the best one (the best always),
 * at most `max`, each with the code's ideas («выводит коня», «нападает на пешку на е пять»). Latin-free ideas only.
 */
export function replanCandidates(
  fen: string,
  lines: readonly EngineLine[],
  opts: { stage: number; phase?: GamePhase; toleranceCp?: number; max?: number } = { stage: 1 },
): ReplanCandidate[] {
  const sorted = [...lines].filter((line) => line.pvUci.length > 0).sort((x, y) => x.multipv - y.multipv);
  const best = sorted[0];
  if (!best) return [];
  const bestCp = teachScoreCp(best);
  const tolerance = opts.toleranceCp ?? TEACH_TOLERANCE_CP;
  const out: ReplanCandidate[] = [];
  const seen = new Set<string>();
  for (const line of sorted) {
    const uci = line.pvUci[0] as string;
    if (seen.has(uci) || out.length >= (opts.max ?? REPLAN_MAX_CANDIDATES)) continue;
    const cp = teachScoreCp(line);
    if (line !== best && bestCp - cp > tolerance) continue;
    const san = sanOfUci(fen, uci);
    if (san === null) continue;
    seen.add(uci);
    let ideasRu: string[] = [];
    try {
      const ideas = explainMove({ fen, uci, pvUci: line.pvUci, lineScore: { cp: line.cp, mate: line.mate }, ...(opts.phase ? { phase: opts.phase } : {}) });
      // on «ты» («выводишь коня в игру»): the teacher says the strategist's «why» to the child as it is
      ideasRu = pickIdeas(ideas, { stage: opts.stage, max: 2 })
        .map((idea) => idea.phraseYouRu)
        .filter((phrase) => phrase !== '' && !/[A-Za-z]/.test(phrase));
    } catch {
      ideasRu = [];
    }
    out.push({ uci, san, cp: Math.max(-100_000, Math.min(100_000, Math.round(cp))), ideasRu });
  }
  return out;
}

/** The position after `uci` from `fen`, or null (illegal / the game ends with it). */
export function positionAfter(fen: string, uci: string): { fen: string; san: string; over: boolean } | null {
  try {
    const chess = new Chess(fen);
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    return { fen: chess.fen(), san: move.san, over: chess.isGameOver() };
  } catch {
    return null;
  }
}
