/**
 * Spaced repetition of the child's OWN puzzle mistakes (PLAN §1 / §3).
 *
 * A puzzle that was failed — or solved only with a hint — gets an FSRS card (`ts-fsrs`) and comes
 * back through `GET /puzzles/next` when it is due: the next day first, then after about 3, 8, 20…
 * days as long as it keeps being solved. A clean solve of a card whose next interval reaches
 * GRADUATE_AFTER_DAYS retires it: the idea has stuck. Nothing is ever shown as a "debt": a due
 * puzzle is simply one of the puzzles of the next batch (at most a third of it).
 *
 * Stored in the kv table as `{ cards: { <puzzleId>: <card> } }`, capped at MAX_CARDS.
 */
import { Rating, createEmptyCard, fsrs } from 'ts-fsrs';
import type { Card } from 'ts-fsrs';
import type { Repo } from '../storage/repo.ts';

export const GRADUATE_AFTER_DAYS = 21;
export const MAX_CARDS = 500;
/** share of a batch that may consist of due repetitions */
export const DUE_SHARE = 1 / 3;

interface StoredCard extends Omit<Card, 'due' | 'last_review'> {
  due: string;
  last_review?: string;
}

const scheduler = fsrs({ enable_fuzz: false, enable_short_term: false });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function revive(value: unknown): Card | null {
  if (!isRecord(value) || typeof value.due !== 'string') return null;
  const due = new Date(value.due);
  if (!Number.isFinite(due.getTime())) return null;
  const numbers = ['stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'reps', 'lapses', 'state'] as const;
  for (const key of numbers) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return null;
  }
  const lastReview = typeof value.last_review === 'string' ? new Date(value.last_review) : undefined;
  return {
    ...(value as unknown as StoredCard),
    learning_steps: typeof value.learning_steps === 'number' ? value.learning_steps : 0,
    due,
    last_review: lastReview !== undefined && Number.isFinite(lastReview.getTime()) ? lastReview : undefined,
  } as Card;
}

export class MistakeRepetition {
  private readonly repo: Repo;

  constructor(repo: Repo) {
    this.repo = repo;
  }

  private load(): Map<string, Card> {
    const raw = this.repo.loadPuzzleRepetitionRaw();
    const cards = new Map<string, Card>();
    if (!isRecord(raw) || !isRecord(raw.cards)) return cards;
    for (const [id, value] of Object.entries(raw.cards)) {
      const card = revive(value);
      if (card !== null && id.length <= 32) cards.set(id, card);
    }
    return cards;
  }

  private save(cards: Map<string, Card>): void {
    // over the cap: the cards due farthest in the future are the best-known ones — they go first
    const kept = [...cards.entries()].sort(([, a], [, b]) => a.due.getTime() - b.due.getTime()).slice(0, MAX_CARDS);
    this.repo.savePuzzleRepetition({ cards: Object.fromEntries(kept) });
  }

  /** Call for every attempt (inside the attempt transaction). */
  recordAttempt(puzzleId: string, attempt: { solved: boolean; hintsUsed: number }, now: Date): void {
    const cards = this.load();
    const existing = cards.get(puzzleId);
    const clean = attempt.solved && attempt.hintsUsed === 0;
    if (existing === undefined && clean) return; // no mistake — nothing to repeat
    const rating = !attempt.solved ? Rating.Again : attempt.hintsUsed > 0 ? Rating.Hard : Rating.Good;
    const next = scheduler.next(existing ?? createEmptyCard(now), now, rating).card;
    if (clean && next.scheduled_days >= GRADUATE_AFTER_DAYS) cards.delete(puzzleId);
    else cards.set(puzzleId, next);
    this.save(cards);
  }

  /** Ids of the puzzles due now, most overdue first. */
  due(now: Date, limit: number): string[] {
    if (limit <= 0) return [];
    return [...this.load().entries()]
      .filter(([, card]) => card.due.getTime() <= now.getTime())
      .sort(([, a], [, b]) => a.due.getTime() - b.due.getTime())
      .slice(0, limit)
      .map(([id]) => id);
  }

  count(): number {
    return this.load().size;
  }
}
