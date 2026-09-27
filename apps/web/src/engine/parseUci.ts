import type { EngineLine } from '@gambit/shared';

/** One parsed `info ... score ... pv ...` line. Scores are from the side-to-move point of view (raw UCI). */
export interface ParsedInfo extends EngineLine {
  seldepth: number | null;
  /** 'lower' / 'upper' for aspiration-window bound reports; such scores are inexact. */
  bound: 'lower' | 'upper' | null;
  nodes: number | null;
  nps: number | null;
  timeMs: number | null;
}

export interface ParsedBestmove {
  /** UCI move, or null for `bestmove (none)`. */
  bestmove: string | null;
  ponder: string | null;
}

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export function isUciMove(token: string): boolean {
  return UCI_MOVE.test(token);
}

function toInt(token: string | undefined): number | null {
  if (token === undefined || !/^-?\d+$/.test(token)) return null;
  return Number.parseInt(token, 10);
}

/**
 * Parses a UCI `info` line that carries a score and a PV.
 * Returns null for everything else (`info string ...`, `info depth 0 score mate 0`, currmove reports, ...).
 * A missing `multipv` token means MultiPV 1.
 */
export function parseInfoLine(line: string): ParsedInfo | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'info' || tokens[1] === 'string') return null;

  let depth: number | null = null;
  let seldepth: number | null = null;
  let multipv = 1;
  let cp: number | null = null;
  let mate: number | null = null;
  let bound: ParsedInfo['bound'] = null;
  let nodes: number | null = null;
  let nps: number | null = null;
  let timeMs: number | null = null;
  let pvUci: string[] = [];

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    switch (token) {
      case 'depth':
        depth = toInt(tokens[i + 1]);
        i += 2;
        break;
      case 'seldepth':
        seldepth = toInt(tokens[i + 1]);
        i += 2;
        break;
      case 'multipv':
        multipv = toInt(tokens[i + 1]) ?? 1;
        i += 2;
        break;
      case 'score': {
        const kind = tokens[i + 1];
        const value = toInt(tokens[i + 2]);
        if (value === null) return null;
        if (kind === 'cp') cp = value;
        else if (kind === 'mate') mate = value;
        else return null;
        i += 3;
        if (tokens[i] === 'lowerbound') {
          bound = 'lower';
          i += 1;
        } else if (tokens[i] === 'upperbound') {
          bound = 'upper';
          i += 1;
        }
        break;
      }
      case 'wdl':
        i += 4;
        break;
      case 'nodes':
        nodes = toInt(tokens[i + 1]);
        i += 2;
        break;
      case 'nps':
        nps = toInt(tokens[i + 1]);
        i += 2;
        break;
      case 'time':
        timeMs = toInt(tokens[i + 1]);
        i += 2;
        break;
      case 'pv':
        // The PV always runs to the end of the line.
        pvUci = tokens.slice(i + 1).filter(isUciMove);
        i = tokens.length;
        break;
      case 'string':
        // Free text until the end of the line.
        i = tokens.length;
        break;
      default:
        // Unknown or uninteresting token (hashfull, tbhits, currmove, ...): skip it; its value is skipped as a token too.
        i += 1;
        break;
    }
  }

  if (depth === null || (cp === null && mate === null) || pvUci.length === 0 || multipv < 1) return null;
  return { multipv, depth, cp, mate, pvUci, seldepth, bound, nodes, nps, timeMs };
}

/** Parses `bestmove e2e4 ponder e7e5` / `bestmove (none)`. Returns null when the line is not a bestmove line. */
export function parseBestmoveLine(line: string): ParsedBestmove | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'bestmove') return null;
  const move = tokens[1];
  const bestmove = move !== undefined && isUciMove(move) ? move : null;
  const ponderToken = tokens[2] === 'ponder' ? tokens[3] : undefined;
  const ponder = ponderToken !== undefined && isUciMove(ponderToken) ? ponderToken : null;
  return { bestmove, ponder };
}

export function isCriticalErrorLine(line: string): boolean {
  return line.includes('CRITICAL ERROR');
}

/** Strips the parser-only fields so the value matches the shared `EngineLine` contract exactly. */
export function toEngineLine(info: EngineLine): EngineLine {
  return { multipv: info.multipv, depth: info.depth, cp: info.cp, mate: info.mate, pvUci: [...info.pvUci] };
}

/**
 * Collects the best-known line per multipv index during one search.
 * Rules: inexact (bound) scores are ignored; a line replaces the stored one only when it is at least as deep.
 */
export class LineCollector {
  private readonly byMultipv = new Map<number, EngineLine>();

  /** Returns true when the line was accepted. */
  add(info: ParsedInfo): boolean {
    if (info.bound !== null) return false;
    const existing = this.byMultipv.get(info.multipv);
    if (existing !== undefined && existing.depth > info.depth) return false;
    this.byMultipv.set(info.multipv, toEngineLine(info));
    return true;
  }

  /**
   * Lines sorted by multipv. If an interrupted iteration left the same root move under two multipv
   * indices, only the deeper (then better-ranked) entry survives and the ranks are renumbered 1..n.
   */
  snapshot(): EngineLine[] {
    const sorted = [...this.byMultipv.values()].sort((a, b) => a.multipv - b.multipv);
    const byRootMove = new Map<string, EngineLine>();
    for (const line of sorted) {
      const root = line.pvUci[0];
      if (root === undefined) continue;
      const existing = byRootMove.get(root);
      if (existing === undefined || line.depth > existing.depth) byRootMove.set(root, line);
    }
    return sorted
      .filter((line) => byRootMove.get(line.pvUci[0] ?? '') === line)
      .map((line, index) => ({ ...line, multipv: index + 1 }));
  }
}
