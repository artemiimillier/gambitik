/**
 * Closing the loop game → weakness → practice, pure logic:
 *  - which puzzle theme the «Потренировать» button opens (the reviewer's suggestion when the server sends
 *    one, otherwise the most frequent motif of the game's own key moments);
 *  - which concept card explains the motif of a key moment.
 * Only themes that really exist as a drill (a Lichess tag with a Russian title) are ever offered.
 */
import { THEMES_NOT_FOR_DRILL, THEME_TITLES_RU, getConceptCardByMotif, isLichessPuzzleTheme } from '@gambit/content';
import type { ConceptCard, GameRecord, KeyMoment, MotifId } from '@gambit/shared';

export interface PracticeSuggestion {
  theme: string;
  /** kid-friendly Russian title of the theme */
  title: string;
}

/** A theme key the puzzles screen can really serve, with its Russian title — or null. */
export function drillableTheme(theme: string | null | undefined): PracticeSuggestion | null {
  if (typeof theme !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(theme)) return null;
  if (THEMES_NOT_FOR_DRILL.includes(theme) || !isLichessPuzzleTheme(theme) || !Object.hasOwn(THEME_TITLES_RU, theme)) return null;
  const title = THEME_TITLES_RU[theme];
  return title === undefined || title.trim() === '' ? null : { theme, title };
}

/** Motif → drill theme: the motif's own Lichess tag when there is one, else the first drillable tag of its concept card. */
export function themeOfMotif(motif: MotifId): PracticeSuggestion | null {
  const direct = drillableTheme(motif);
  if (direct) return direct;
  for (const theme of getConceptCardByMotif(motif)?.lichessThemes ?? []) {
    const viaCard = drillableTheme(theme);
    if (viaCard) return viaCard;
  }
  return null;
}

const PROUD: readonly KeyMoment['classification'][] = ['best', 'excellent'];

/**
 * What to practise after this game. The server's `suggestedTheme` wins when it is a real drill; otherwise
 * the motifs of the game itself decide: key moments first (the child has just looked at them), then what
 * was allowed, then what was missed — the most frequent one, ties go to the earliest.
 */
export function suggestPractice(record: Pick<GameRecord, 'summary'>, suggestedTheme?: string | null): PracticeSuggestion | null {
  const fromServer = drillableTheme(suggestedTheme);
  if (fromServer) return fromServer;

  const motifs: MotifId[] = [
    ...record.summary.keyMoments.filter((moment) => !PROUD.includes(moment.classification)).flatMap((moment) => (moment.motif ? [moment.motif] : [])),
    ...record.summary.motifsAllowed,
    ...record.summary.motifsMissed,
  ];
  const counts = new Map<string, { suggestion: PracticeSuggestion; count: number }>();
  for (const motif of motifs) {
    const suggestion = themeOfMotif(motif);
    if (!suggestion) continue;
    const entry = counts.get(suggestion.theme);
    if (entry) entry.count += 1;
    else counts.set(suggestion.theme, { suggestion, count: 1 });
  }
  let best: { suggestion: PracticeSuggestion; count: number } | null = null;
  for (const entry of counts.values()) {
    if (best === null || entry.count > best.count) best = entry;
  }
  return best?.suggestion ?? null;
}

/** The concept card that explains the idea behind a key moment (by its motif), if there is one. */
export function conceptCardForMoment(moment: Pick<KeyMoment, 'motif'>): ConceptCard | null {
  return moment.motif ? (getConceptCardByMotif(moment.motif) ?? null) : null;
}
