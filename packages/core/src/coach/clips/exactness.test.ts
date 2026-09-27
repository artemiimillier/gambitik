/**
 * «Дозапись голоса» records the words the bubble shows. For the builders' events with a clip twin that is only possible when
 * the builder's text (the child's name stripped) IS a combination of catalogue wordings — then the web knows which
 * wording to play first and which to ask for. The gate: ≥ 95 % of the greeting (row 1 of the plan), the board's hello
 * (8), the resumed game (10), the take-back family (12) and praise (13) resolve to wordings exactly. The game's start and
 * end are said in part (the opponent's name and the practice idea stay in the bubble): what their twin says, and what
 * it asks to have recorded, is always words of the bubble — never a wording it does not show.
 *
 * Also: the shell lines the web says stay equal to their content source (a test-only read of @gambit/content). That
 * the starter set's takes (tier `pilot`) keep naming their words — wordings are appended, never inserted — is checked
 * where the library files are read: tools/voice-clips/manifest.catalog.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { TIME_CONTROLS } from '@gambit/shared';
import type { CoachEvent, GameListItem, GameResult, StudentProfile, Termination } from '@gambit/shared';
import { MASCOT } from '../../../../content/src/mascot.ts';
import {
  buildDeclineReasonReply,
  buildGameEnd,
  buildGameHello,
  buildGameStart,
  buildGameResumed,
  buildGreeting,
  buildPraise,
  buildTakebackAccepted,
  buildTakebackDeclined,
  buildTakebackOffer,
  buildTakebackQuestion,
  buildVoluntaryTakeback,
} from '../events.ts';
import { ALL_MOTIFS, PERSONA, backRankBlunder, bestMoveJudgement, forkBlunder, profile, queenBlunder, seededRng, summary } from '../test-fixtures.ts';
import { clipCatalogLine } from './catalog.ru.ts';
import { clipInputOf, stripName } from './compile.ts';
import { catalogIndex } from './fixtures.ts';
import { mergeClipIndexes } from './keys.ts';
import { lineWordingOf, lineWordingText, twinWordingsOf } from './lines.ts';
import { planClips } from './plan.ts';

/** Does the bubble resolve to wordings, whole: every sentence a wording, joined exactly the name-stripped text? */
function resolves(event: CoachEvent, name: string): boolean {
  const sentences = event.clip?.sentences ?? [];
  if (sentences.length === 0) return false;
  const wordings = twinWordingsOf(event, { name });
  const texts = sentences.map((s, i) => {
    const it = s.items[0];
    const n = wordings[i];
    const l = s.items.length === 1 && it && 'line' in it && typeof n === 'number' ? lineWordingOf(it, n) : null;
    return l ? lineWordingText(l) : null;
  });
  const norm = (t: string): string => t.replace(/\s+/g, ' ').trim();
  return texts.every((t) => t !== null) && norm(texts.join(' ')) === norm(stripName(event.text, name));
}

const NAMES = ['Миша', '', 'Маша'] as const;
const OUTCOMES: (GameListItem | undefined)[] = [
  undefined,
  { result: '1-0', childColor: 'w' } as GameListItem,
  { result: '0-1', childColor: 'w' } as GameListItem,
  { result: '1/2-1/2', childColor: 'w' } as GameListItem,
  { result: '*', childColor: 'w' } as GameListItem,
];

function child(i: number): { p: StudentProfile; name: string } {
  const name = NAMES[i % NAMES.length] as string;
  const first = i % 7 === 0;
  return { p: profile({ nickname: name, address: i % 2 ? 'm' : 'f', totals: { ...profile().totals, games: first ? 0 : 3 } }), name };
}

const SAMPLES = 400;

describe('the bubble is a combination of catalogue wordings (≥ 95 %)', () => {
  const rate = (make: (i: number, rng: () => number) => { event: CoachEvent; name: string }): number => {
    const rng = seededRng(2509);
    let ok = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const { event, name } = make(i, rng);
      if (resolves(event, name)) ok++;
    }
    return ok / SAMPLES;
  };

  it('the greeting on app open (every day part, first time, after a win / loss / draw / unfinished game)', () => {
    expect(
      rate((i, rng) => {
        const { p, name } = child(i);
        const lastGame = p.totals.games === 0 ? undefined : OUTCOMES[i % OUTCOMES.length];
        return { event: buildGreeting({ profile: p, hour: [8, 14, 20, 23][i % 4] as number, ...(lastGame ? { lastGame } : {}) }, rng), name };
      }),
    ).toBeGreaterThanOrEqual(0.95);
  });

  it("the board's «Привет!» and the resumed game", () => {
    expect(rate((i, rng) => ({ event: buildGameHello(child(i).p, rng), name: child(i).name }))).toBeGreaterThanOrEqual(0.95);
    expect(rate((i, rng) => ({ event: buildGameResumed({ childToMove: i % 2 === 0, profile: child(i).p }, rng), name: child(i).name }))).toBeGreaterThanOrEqual(0.95);
  });

  it('the take-back family: the offer, the second try, the question, the replies', () => {
    const blunders = [forkBlunder(), queenBlunder(), backRankBlunder()];
    const reasons = ['planned', 'dontSee', 'risk'] as const;
    expect(
      rate((i, rng) => {
        const { p, name } = child(i);
        const j = blunders[i % blunders.length] as ReturnType<typeof forkBlunder>;
        const events = [
          () => buildTakebackOffer(j, p, rng),
          () => buildTakebackOffer(j, p, rng, { again: true }),
          () => buildTakebackQuestion(j, p, rng),
          () => buildTakebackDeclined(p, rng),
          () => buildTakebackAccepted(p, rng),
          () => buildVoluntaryTakeback(p, rng),
          () => buildDeclineReasonReply(reasons[i % reasons.length] as (typeof reasons)[number], p, rng),
        ];
        return { event: (events[i % events.length] as () => CoachEvent)(), name };
      }),
    ).toBeGreaterThanOrEqual(0.95);
  });

  it('praise: what was found, then the process', () => {
    const motifs = [undefined, ...ALL_MOTIFS];
    expect(
      rate((i, rng) => {
        const { p, name } = child(i);
        const motif = motifs[i % motifs.length];
        return { event: buildPraise(bestMoveJudgement(motif, i % 4 === 0 ? { san: 'Nf3' } : {}), p, rng, motif), name };
      }),
    ).toBeGreaterThanOrEqual(0.95);
  });
});

describe('the game\'s start and end: said in part, but only words of the bubble — and only those are recorded', () => {
  const norm = (t: string): string => t.normalize('NFC').replace(/\.\.\./g, '…').replace(/\s+/g, ' ').trim();
  const FULL = catalogIndex();
  const EMPTY = mergeClipIndexes(null, null);

  /**
   * every sentence the twin says with the whole catalogue recorded, and every one it asks for with nothing recorded,
   * that the bubble does not show. `asked` only: an exam's tail — its builder words are longer than a wording may be,
   * the twin keeps the catalogue's exam line as its stand-in (an exam never records anything)
   */
  function strays(event: CoachEvent, name: string, rng: () => number, o: { askedOnly?: boolean } = {}): string[] {
    const bubble = norm(stripName(event.text, name));
    const input = clipInputOf(event, { name });
    const wordings = twinWordingsOf(event, { name });
    const said = o.askedOnly === true ? [] : planClips(input, FULL, { rng, jitter: false, prevBark: true, wordings }).sentences.map((x) => x.text);
    const asked = (planClips(input, EMPTY, { rng, jitter: false, wordings }).lineMissing ?? []).map((l) => lineWordingText(l) ?? '?');
    return [...said, ...asked].filter((t) => !bubble.includes(norm(t)));
  }

  it('the game end: every result, every way it ended', () => {
    const rng = seededRng(2510);
    const ends: [GameResult, Termination][] = [
      ['1-0', 'checkmate'],
      ['1-0', 'resign'],
      ['1-0', 'timeout'],
      ['0-1', 'checkmate'],
      ['0-1', 'timeout'],
      ['1/2-1/2', 'stalemate'],
      ['1/2-1/2', 'draw'],
      ['*', 'abandoned'],
    ];
    const wrong: string[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const { p, name } = child(i);
      const [result, termination] = ends[i % ends.length] as [GameResult, Termination];
      const persona = i % 3 === 0 ? { ...PERSONA, name: '' } : PERSONA;
      const event = buildGameEnd({ result, childColor: 'w', termination, summary: summary(), persona, profile: p }, rng);
      for (const t of strays(event, name, rng)) wrong.push(`${result} ${termination}: «${t}» in «${event.text}»`);
    }
    expect(wrong).toEqual([]);
  });

  it('the game start: every mode, with and without the hello, a named and a nameless opponent', () => {
    const rng = seededRng(2511);
    const wrong: string[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const { p, name } = child(i);
      const timeControl = [TIME_CONTROLS.rapid10, TIME_CONTROLS.blitz5, TIME_CONTROLS.training, TIME_CONTROLS.bullet1][i % 4] ?? TIME_CONTROLS.rapid10;
      const persona = i % 3 === 0 ? { ...PERSONA, name: '' } : PERSONA;
      const coachStyle = (['helper', 'exam'] as const)[i % 2];
      const event = buildGameStart({ persona, timeControl, childColor: 'w', profile: p, coachStyle, greet: i % 5 < 2 }, rng);
      for (const t of strays(event, name, rng, { askedOnly: coachStyle === 'exam' })) wrong.push(`«${t}» in «${event.text}»`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('the shell lines', () => {
  it("the break lines are the mascot's own (the web says MASCOT.phrases.break)", () => {
    expect(clipCatalogLine('shell.break')?.wordings.map((w) => w.t)).toEqual([...MASCOT.phrases.break]);
  });
});
