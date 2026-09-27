/**
 * The real words of @gambit/content against the recorded voice «Дозапись голоса» (docs/TEACHING.md §4.5): every
 * expansion of every wording (per subject piece × per child's gender — the whole library, 7916 today) is rebuilt
 * exactly from its ids (the server renders a request from ids and never accepts text), keeps its words when joined into
 * the bubble's sentence (so a recorded part is literally a piece of the bubble), and gives a TTS prompt with no quotes,
 * no Latin, no digits, no placeholder and no pause tag that fits one pack alone. Every tail starts with «—» (the seam
 * the planner's dash gap and the pack recipe assume) and no wording can carry the child's name.
 */
import { describe, expect, it } from 'vitest';
import type { PieceType } from '@gambit/shared';
import { LESSON_LINES } from '@gambit/content';
import { expandWording } from '../clips/catalog.ts';
import { expectedPartText } from '../clips/lessonPlan.ts';
import { PACK_MAX_CHARS, packProblem, ttsPartText } from '../clips/tts.ts';
import type { TtsPartRole } from '../clips/tts.ts';
import { capitalize } from '../phrase.ts';
import { expandLessonWording } from './lint.ts';
import { isOptionPool, pieceLabel, quizOptionLabel, quizOptionsText } from './quizWords.ts';
import { joinSentence } from './render.ts';

/** The server's refusal limit for one prompt (tools/voice-clips `promptProblem`). */
const PROMPT_MAX = 480;
const BAD_PROMPT_RE = /[«»„“”"A-Za-z0-9{}<>#]/u;
const LEAD = 'Давай сходим конём';
const TAIL = '— и это мат!';

interface Expansion {
  pool: string;
  role: 'whole' | 'lead' | 'tail';
  n: number;
  piece?: PieceType;
  g?: 'm' | 'f';
  text: string | null;
}

const ALL: Expansion[] = LESSON_LINES.flatMap((line) =>
  line.wordings.flatMap((w, i) => expandLessonWording(line, w).map((e) => ({ pool: line.id, role: line.role, n: i + 1, ...e }))),
);
const name = (e: Expansion): string => `${e.pool}#${e.n}${e.piece ? `@${e.piece}` : ''}${e.g ? `/${e.g}` : ''}: ${e.text ?? '(null)'}`;

/** The TTS prompts of one expansion, by the roles it can be said in (a quiz button only inside the options sentence). */
function promptsOf(e: Expansion & { text: string }): { role: TtsPartRole; prompt: string }[] {
  if (isOptionPool(e.pool)) return [{ role: 'frag', prompt: ttsPartText(quizOptionsText([quizOptionLabel(e.text), pieceLabel('n', 'whichPiece'), pieceLabel('b', 'whichPiece')]), 'frag') }];
  const roles: TtsPartRole[] = e.role === 'lead' ? ['lead', 'leadAlone'] : e.role === 'tail' ? ['tail'] : ['whole'];
  return roles.map((role) => ({ role, prompt: ttsPartText(e.text, role) }));
}

describe('lesson words for the recorded voice', () => {
  it('covers the whole library (every wording × subject piece × gender)', () => {
    expect(ALL.length).toBeGreaterThan(7000);
  });

  it('every tail starts with «—»', () => {
    const tails = LESSON_LINES.filter((l) => l.role === 'tail').flatMap((l) => l.wordings.map((w, i) => `${l.id}#${i + 1}: ${w.t}`));
    expect(tails.length).toBeGreaterThan(0);
    expect(tails.filter((t) => !/^[^:]+: —\s/u.test(t))).toEqual([]);
  });

  it('no wording can carry the child`s name: every placeholder is a piece or a gender form', () => {
    const odd: string[] = [];
    for (const line of LESSON_LINES) {
      line.wordings.forEach((w, i) => {
        for (const m of w.t.matchAll(/\{([^{}]*)\}/gu)) {
          const token = m[0];
          const piece = expandWording(token, { piece: 'n' });
          const gender = expandWording(token, { g: 'f' });
          if ((piece === null && gender === null) || /name|имя|ник/iu.test(token)) odd.push(`${line.id}#${i + 1}: ${token}`);
        }
      });
    }
    expect(odd).toEqual([]);
  });

  it('every expansion is rebuilt exactly from its ids (pool, n, piece, gender)', () => {
    const bad = ALL.filter((e) => e.text === null || expectedPartText({ pool: e.pool, n: e.n, ...(e.piece ? { piece: e.piece } : {}), ...(e.g ? { g: e.g } : {}) }) !== e.text);
    expect(bad.map(name).slice(0, 20)).toEqual([]);
  });

  it('keeps its words when joined into a sentence: a whole is already the bubble`s sentence, a lead / tail joins by a space', () => {
    const bad: string[] = [];
    for (const e of ALL) {
      const t = e.text as string;
      if (isOptionPool(e.pool)) continue;
      if (e.role === 'whole' && joinSentence([t]) !== t) bad.push(`${name(e)} → ${joinSentence([t])}`);
      if (e.role === 'lead') {
        if (joinSentence([t]) !== `${capitalize(t)}.`) bad.push(`alone ${name(e)}`);
        if (joinSentence([t, TAIL]) !== `${capitalize(t)} ${TAIL}`) bad.push(`+tail ${name(e)}`);
      }
      if (e.role === 'tail' && joinSentence([LEAD, t]) !== `${LEAD} ${t}`) bad.push(name(e));
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });

  it('gives a clean TTS prompt: the bubble`s words minus quotes, no Latin / digits / placeholder / tag, one pack alone', () => {
    const bad: string[] = [];
    let longest = 0;
    for (const e of ALL) {
      for (const { role, prompt } of promptsOf(e as Expansion & { text: string })) {
        const chars = [...prompt].length;
        longest = Math.max(longest, chars);
        if (prompt === '' || BAD_PROMPT_RE.test(prompt) || chars > PROMPT_MAX || packProblem([prompt]) !== null) bad.push(`${role} ${name(e)} → ${prompt}`);
        // the prompt says the bubble's words: the same text with the quotes dropped
        const bubble = role === 'whole' ? (e.text as string) : role === 'leadAlone' ? joinSentence([e.text as string]) : null;
        if (bubble !== null && prompt !== bubble.replace(/[«»„“”"]/gu, '').replace(/\s+/g, ' ').replace(/\s+([,.!?…:;])/g, '$1').trim()) bad.push(`bubble ${name(e)} → ${prompt}`);
      }
    }
    expect(bad.slice(0, 20)).toEqual([]);
    expect(longest).toBeLessThanOrEqual(PACK_MAX_CHARS);
  });
});
