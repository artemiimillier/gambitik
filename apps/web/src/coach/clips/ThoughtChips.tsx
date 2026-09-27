/**
 * «Как тебе партия?» — the child's thoughts after a game, with big buttons instead of a microphone
 * (docs/voice-clips/SPEC.md §8.3): 5 chips gendered by `address`, up to two taps; each one is journaled (or follows the
 * record through the existing thoughts route) and Гамбитик answers it with a recorded line (the game does both,
 * `tapThought`). Shown on the result card after the diary sentence, as one row of small tiles (icon + short words; the
 * full words are the button's name) so the way forward stays clear of his bubble.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { THOUGHT_QUESTION_RU, THOUGHT_TAPS_MAX, thoughtChips } from './clipAsk.ts';
import type { ThoughtChipId } from './clipAsk.ts';
import styles from './ThoughtChips.module.css';

export interface ThoughtChipsProps {
  address: 'm' | 'f';
  /** the game takes the tap (journal + his reply); false = not taken */
  onTap(chip: ThoughtChipId): boolean;
  /** tests: chips already tapped */
  initialTapped?: readonly ThoughtChipId[];
}

export function ThoughtChips({ address, onTap, initialTapped = [] }: ThoughtChipsProps): ReactElement {
  const [tapped, setTapped] = useState<readonly ThoughtChipId[]>(initialTapped);
  const full = tapped.length >= THOUGHT_TAPS_MAX;
  return (
    <section className={styles.thoughts} aria-label={THOUGHT_QUESTION_RU}>
      <p className={styles.question}>{THOUGHT_QUESTION_RU}</p>
      <div className={styles.chips}>
        {thoughtChips(address).map((chip) => {
          const chosen = tapped.includes(chip.id);
          return (
            <button
              key={chip.id}
              type="button"
              className={styles.chip}
              data-chip={chip.id}
              aria-label={chip.label}
              title={chip.label}
              aria-pressed={chosen}
              disabled={chosen || full}
              onClick={() => {
                if (onTap(chip.id)) setTapped((list) => [...list, chip.id]);
              }}
            >
              <span className={styles.icon} aria-hidden="true">
                {chip.icon}
              </span>
              <span className={styles.label}>{chip.short}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
