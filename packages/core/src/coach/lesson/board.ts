/**
 * Every lesson cue is projected onto the board primitives —
 * arrows and square highlights in four colours (docs/TEACHING.md §3) — so «вот эти клетки» is never said over an
 * empty board. `flank` is not drawn here (a whole side of the board would hide the pieces).
 */
import type { AnnotationColor, BoardAnnotations, CueKind, LessonCue, Square } from '@gambit/shared';

/** Cue kinds the board can show (a pointing wording is allowed only for these, with ≥ 1 square). */
export const DRAWABLE_CUES: ReadonlySet<CueKind> = new Set<CueKind>(['move', 'lastMove', 'attacks', 'line', 'center', 'capture', 'threat', 'hanging', 'piece', 'defend', 'king', 'weak', 'path']);

const COLOR: Readonly<Record<CueKind, AnnotationColor | null>> = {
  move: 'green',
  lastMove: 'blue',
  attacks: 'yellow',
  line: 'yellow',
  center: 'yellow',
  path: 'yellow',
  capture: 'red',
  threat: 'red',
  hanging: 'red',
  piece: 'blue',
  defend: 'blue',
  king: 'blue',
  weak: 'blue',
  flank: null,
};

/** The server keeps ≤ 32 arrows / ≤ 64 highlights per event (apps/server/src/schemas.ts). */
const MAX_ARROWS = 32;
const MAX_HIGHLIGHTS = 64;

/**
 * Projects cues onto arrows + highlights. A square gets the colour of its first cue (the more important cue first:
 * pass danger before info). `sentence` limits it to one sentence's cues (undefined = all).
 */
export function cuesToBoard(cues: readonly LessonCue[], opts: { sentence?: number; base?: BoardAnnotations | null } = {}): BoardAnnotations {
  const arrows: BoardAnnotations['arrows'] = [...(opts.base?.arrows ?? [])];
  const highlights: BoardAnnotations['highlights'] = [...(opts.base?.highlights ?? [])];
  const lit = new Set<Square>(highlights.map((h) => h.square));
  const arrowKey = new Set(arrows.map((a) => `${a.from}${a.to}`));
  for (const c of cues) {
    if (opts.sentence !== undefined && c.sentence !== opts.sentence) continue;
    const color = COLOR[c.kind];
    if (!color) continue;
    for (const a of c.arrows ?? []) {
      const k = `${a.from}${a.to}`;
      if (arrowKey.has(k) || arrows.length >= MAX_ARROWS) continue;
      arrowKey.add(k);
      arrows.push({ from: a.from, to: a.to, color });
    }
    if (c.kind === 'move' || c.kind === 'lastMove') continue; // an arrow is enough
    for (const sq of c.squares) {
      if (lit.has(sq) || highlights.length >= MAX_HIGHLIGHTS) continue;
      lit.add(sq);
      highlights.push({ square: sq, color });
    }
  }
  return { arrows, highlights };
}

/** Can the board show this cue now (drawable kind and resolved squares/arrows)? */
export function cueDrawable(c: Pick<LessonCue, 'kind' | 'squares' | 'arrows'>): boolean {
  return DRAWABLE_CUES.has(c.kind) && (c.squares.length > 0 || (c.arrows?.length ?? 0) > 0);
}
