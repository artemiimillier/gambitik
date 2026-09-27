/**
 * The reaction half of the lesson director (docs/TEACHING.md §2.5, §2.8, §2.9): specific praise, the outcome of a
 * followed arrow, a mistake by a concept, the take-back offer and replies, the end of the game with ONE takeaway.
 * Installed by ./engine.ts together with the turn half.
 *
 * Every event is a lesson event (`lessonEvent`): pre-written wordings only (`say`), no clip, no brief; the only
 * randomness is the phrase book's own seeded PRNG. The lesson memory is never mutated in place: every function returns
 * the next `TeachMemory` for the caller to commit. Chess truth comes from ./mistake.ts, ./praise.ts, ./end.ts and
 * ./goals.ts; this file decides what is said and when.
 */
import type { CoachEvent, MascotPose, PieceType, StudentProfile, TeachAdvice, TeachSummary, TimeControlId } from '@gambit/shared';
import { lessonPoolSpec } from '@gambit/content';
import type { TeachMemory } from '../teacher.ts';
import { cueDrawable } from './board.ts';
import type { LessonBook, PickArgs } from './book.ts';
import { resolveCues } from './cues.ts';
import type { CueFacts } from './cues.ts';
import type { LessonDirectorImpl, LessonEndArgs, LessonEndResult, LessonReactionArgs, LessonReactionResult, LessonTakebackArgs } from './director.ts';
import { gameOutcome, takeawayCandidates, takeawayRotationOk, takeawayVariant } from './end.ts';
import type { GameOutcome } from './end.ts';
import { lessonEvent, lessonGender, lessonStage } from './event.ts';
import { goalDoneBy, goalsOfCard } from './goals.ts';
import { restoreLessonMemory } from './memory.ts';
import { BIG_LOSS_PAWNS, MISTAKE_EVERY_PLIES, isMistakeMove, materialTrack, mistakeConcepts, pendingCueFacts, readTakebackMark, realizedLoss, takebackConcepts, takebackPending } from './mistake.ts';
import type { MistakeFacts } from './mistake.ts';
import { PRAISE_MAX_WORDS, RESULT_EVERY_TURNS, foundBy, habitsDone, miniShownBy, praiseCap, praiseChoices, resultChoice } from './praise.ts';
import type { PraiseChoice, PraiseInput } from './praise.ts';
import { joinSentence, renderUtterance } from './render.ts';
import type { SentenceSpec } from './render.ts';
import type { LessonMemory, PendingTakeback } from './types.ts';

// ───────────────────────── words ─────────────────────────

interface Ask {
  pool: string;
  piece?: PieceType | null;
  variant?: string | null;
  facts?: CueFacts | null;
  /** only wordings of at most this many words (the book fits the cap before the bag decides: no fallback repeats) */
  maxWords?: number;
}

interface Voice {
  book: LessonBook;
  stage: number;
  g: 'm' | 'f';
}

function voiceOf(profile: StudentProfile, book: LessonBook): Voice {
  return { book, stage: lessonStage(profile), g: lessonGender(profile) };
}

/** «вот эти клетки / сюда» only when every cue of the pool can be drawn with squares (docs/TEACHING.md §3). */
function deixisOk(pool: string, facts: CueFacts | null | undefined): boolean {
  const spec = lessonPoolSpec(pool);
  if (!spec || spec.cue.length === 0 || !facts) return false;
  try {
    return resolveCues(spec.cue, facts, 0).every(cueDrawable);
  } catch {
    return false;
  }
}

function argsOf(v: Voice, a: Ask): PickArgs {
  return {
    stage: v.stage,
    g: v.g,
    piece: a.piece ?? null,
    ...(a.variant ? { variant: a.variant } : {}),
    deixis: deixisOk(a.pool, a.facts),
    ...(a.maxWords !== undefined ? { maxWords: a.maxWords } : {}),
  };
}

/** Does the pool have a wording for this stage / piece / variant (does not pick)? */
function can(v: Voice, a: Ask): boolean {
  return v.book.has(a.pool, argsOf(v, a));
}

/** One sentence of one wording, or null when the pool has nothing that fits. */
function sentence(v: Voice, a: Ask): SentenceSpec | null {
  const picked = v.book.pick(a.pool, argsOf(v, a));
  if (!picked) return null;
  return { parts: [picked], facts: a.facts ?? null };
}

function withLesson(memory: TeachMemory, lesson: LessonMemory): TeachMemory {
  return { ...memory, lesson };
}

function teachOf(moment: TeachSummary['moment'], ply: number, advice: readonly TeachAdvice[] = []): TeachSummary {
  return { moment, style: moment === 'takeaway' ? 'full' : 'short', ply, advice: advice.map((a) => ({ uci: a.uci, san: a.san, source: a.source, arrow: a.arrow })) };
}

function isBlitz(tc: TimeControlId): boolean {
  return tc === 'blitz5' || tc === 'bullet1';
}

/** The child turn counter of the lesson (the turn half counts teacher turns; without it — the child's move number). */
function turnOf(lm: LessonMemory, ply: number): number {
  return lm.turn > 0 ? lm.turn : Math.floor((ply + 1) / 2);
}

// ───────────────────────── mistake ─────────────────────────

/** The first concept whose pool has words at this stage (the §2.8 order; a later one stands in for an empty pool). */
function speakableConcept(v: Voice, concepts: readonly MistakeFacts[]): MistakeFacts | null {
  return concepts.find((m) => can(v, { pool: m.pool, piece: m.piece, facts: m.facts })) ?? null;
}

/** The rule after the concept: the first time a game as a rule, the second time as a question (stages 3–5). */
function ruleSentence(v: Voice, m: MistakeFacts, lm: LessonMemory): { spec: SentenceSpec; said: string } | null {
  if (!m.rule) return null;
  if (!lm.rulesSaid.includes(m.rule)) {
    const spec = sentence(v, { pool: `v3.rule.${m.rule}` });
    return spec ? { spec, said: m.rule } : null;
  }
  const ask = `ask.${m.rule}`;
  if (v.stage >= 3 && !lm.rulesSaid.includes(ask)) {
    const spec = sentence(v, { pool: `v3.rule.ask.${m.rule}` });
    return spec ? { spec, said: ask } : null;
  }
  return null;
}

function mistakeReaction(args: LessonReactionArgs, lm: LessonMemory, v: Voice): CoachEvent | null {
  const j = args.judgement;
  let concepts: MistakeFacts[];
  try {
    concepts = mistakeConcepts({
      judgement: j,
      advice: args.advice,
      stage: v.stage,
      lastDanger: lm.lastDanger,
      treasureHidden: args.treasureHidden === true,
      prev: args.prev ?? null,
    });
  } catch {
    return null;
  }
  // «был ход сильнее»: stages 3–5 only, once a game
  concepts = concepts.filter((m) => m.concept !== 'slower' || (v.stage >= 3 && !lm.slowerSaid));
  const m = speakableConcept(v, concepts);
  if (!m) return null;
  // at most one mistake reaction in 3 child moves — unless ≥ 3 pawns go or it is mate
  const last = lm.mistakes[lm.mistakes.length - 1];
  const big = j.materialLossPawns >= BIG_LOSS_PAWNS || m.mated;
  if (last && j.ply - last.ply < MISTAKE_EVERY_PLIES && !big) return null;
  const what = sentence(v, { pool: m.pool, piece: m.piece, facts: m.facts });
  if (!what) return null;
  const rule = isBlitz(args.tc) ? null : ruleSentence(v, m, lm);
  const rendered = renderUtterance([what, rule?.spec]);
  if (rendered.text === '') return null;
  lm.mistakes = [...lm.mistakes, { turn: turnOf(lm, j.ply), ply: j.ply, concept: m.concept, uci: j.uci, lossPawns: j.materialLossPawns, mated: m.mated, victim: m.victim }];
  if (rule) lm.rulesSaid = [...lm.rulesSaid, rule.said];
  if (m.concept === 'slower') lm.slowerSaid = true;
  return lessonEvent({ kind: 'teachReaction', rendered, pose: 'think', priority: m.mated ? 2 : 1, pauseClock: true, teach: teachOf('reaction', j.ply, args.advice) });
}

// ───────────────────────── praise / outcome ─────────────────────────

/** The words of a praise choice (praise itself keeps to `PRAISE_MAX_WORDS`; an outcome line is a `whole` sentence). */
function praiseAsk(c: PraiseChoice, maxWords?: number): Ask {
  return { pool: c.pool, piece: c.piece, variant: c.variant, facts: c.facts, ...(maxWords !== undefined ? { maxWords } : {}) };
}

function praiseEvent(v: Voice, c: PraiseChoice, ply: number, priority: 0 | 1, kind: 'praise' | 'teachReaction', pose: MascotPose, maxWords?: number): CoachEvent | null {
  const spec = sentence(v, praiseAsk(c, maxWords));
  if (!spec) return null;
  const rendered = renderUtterance([spec]);
  if (rendered.text === '') return null;
  return lessonEvent({ kind, rendered, pose, priority, pauseClock: false, teach: teachOf('reaction', ply) });
}

function praiseAllowed(c: PraiseChoice, lm: LessonMemory, stage: number): boolean {
  const cap = praiseCap(stage);
  if (c.reason === 'mate') return true; // the last word of the game
  // routine praise leaves the last slot of the cap to a real find
  return c.tier === 'always' ? lm.praises.length < cap : lm.praises.length < cap - 1;
}

function lessonReaction(args: LessonReactionArgs, memory: TeachMemory, book: LessonBook): LessonReactionResult {
  const j = args.judgement;
  const v = voiceOf(args.profile, book);
  const lm = restoreLessonMemory(memory.lesson);
  // a take-back offer of an earlier ply that never got its reply is over
  if (lm.pendingTakeback && lm.pendingTakeback.ply < j.ply) lm.pendingTakeback = null;
  const turn = turnOf(lm, j.ply);
  const inAdvice = args.advice.findIndex((a) => a.uci === j.uci);
  // a move after a quiz, without a shown arrow, or not the advised one is the child's own
  const own = !args.adviceShown || args.quizAnswered === true || inAdvice < 0;
  const followed = !own;
  lm.followStreak = followed ? lm.followStreak + 1 : 0;
  if (args.adviceShown && !lm.adviceShown.includes(j.ply)) lm.adviceShown = [...lm.adviceShown, j.ply].slice(-40);

  // the take-back offer is the caller's path (lessonTakebackOffer)
  if (args.decision?.action === 'offerTakeback') return { now: null, memory: withLesson(memory, lm) };

  const input: PraiseInput = {
    judgement: j,
    advice: args.advice,
    stage: v.stage,
    own,
    adviceHidden: !args.adviceShown,
    treasureHidden: args.treasureHidden === true,
    prev: args.prev ?? null,
    card: args.strategyCard ?? null,
    historySan: args.historySan,
    threatAfter: args.threatAfter ?? null,
    lesson: lm,
    history: book.history(),
  };

  // what the child found himself, and the goals of the card his move achieved — facts for the takeaway
  const found = safe(() => foundBy(input), null);
  if (found && !lm.found.some((f) => f.ply === j.ply)) lm.found = [...lm.found, { turn, ply: j.ply, kind: found.kind, ...(found.motif ? { motif: found.motif } : {}) }];
  const goalsBefore = lm.goalsDone;
  const goodForGoal = found !== null || j.winPctLoss < 2 || (followed && j.winPctLoss < 5);
  if (goodForGoal && args.strategyCard) {
    const goal = safe(() => {
      const goals = goalsOfCard(args.strategyCard ?? null, j.color);
      const before = args.historySan.slice(0, Math.max(0, args.historySan.length - 1));
      return goalDoneBy(goals, j.fenBefore, j.fenAfter, j.color, before, args.historySan);
    }, null);
    if (goal && !lm.goalsDone.includes(goal.key)) lm.goalsDone = [...lm.goalsDone, goal.key];
  }
  // the concepts the child showed (the next mini-lesson level), then the habits of this game
  for (const topic of safe(() => miniShownBy(input, found), [] as string[])) book.learner.miniShown(topic);
  for (const reason of safe(() => habitsDone(input), [] as string[])) book.learner.habitDone(reason);

  // a weaker move: a mistake by a concept (or silence)
  if (isMistakeMove(j)) {
    const now = mistakeReaction(args, lm, v);
    return { now, memory: withLesson(memory, lm) };
  }

  // praise for a deed (the goal praise looks at the goals done before this move)
  const praiseInput: PraiseInput = { ...input, lesson: { ...lm, goalsDone: goalsBefore } };
  for (const c of safe(() => praiseChoices(praiseInput), [] as PraiseChoice[])) {
    if (!praiseAllowed(c, lm, v.stage)) continue;
    // ≤ 10 words, fitted by the book before the bag decides (never «the one short wording every time»)
    if (!can(v, praiseAsk(c, PRAISE_MAX_WORDS))) continue;
    const event = praiseEvent(v, c, j.ply, 1, 'praise', 'cheer', PRAISE_MAX_WORDS);
    if (!event) continue;
    lm.praises = [...lm.praises, { turn, reason: c.reason }];
    if (c.tier === 'habit') book.learner.habitPraised(c.reason.replace(/^habit\./, ''));
    return { now: event, memory: withLesson(memory, lm) };
  }

  // a followed arrow: at most the outcome, without «ты», not more often than every 3 turns
  if (followed) {
    const lastResult = lm.resultTurns[lm.resultTurns.length - 1];
    if (lastResult === undefined || turn - lastResult >= RESULT_EVERY_TURNS) {
      const c = safe(() => resultChoice({ judgement: j, lesson: lm, stage: v.stage, prev: args.prev ?? null }), null);
      if (c && can(v, praiseAsk(c))) {
        const event = praiseEvent(v, c, j.ply, 0, 'teachReaction', 'talk');
        if (event) {
          lm.resultTurns = [...lm.resultTurns, turn];
          return { now: event, memory: withLesson(memory, lm) };
        }
      }
    }
  }
  return { now: null, memory: withLesson(memory, lm) };
}

function safe<T>(f: () => T, dflt: T): T {
  try {
    return f();
  } catch {
    return dflt;
  }
}

// ───────────────────────── take-back ─────────────────────────

function lessonTakebackOffer(args: LessonTakebackArgs, memory: TeachMemory, book: LessonBook): { event: CoachEvent; memory: TeachMemory } {
  const j = args.judgement;
  const v = voiceOf(args.profile, book);
  const lm = restoreLessonMemory(memory.lesson);
  const concepts = safe(() => takebackConcepts({ judgement: j, advice: args.advice, stage: v.stage, lastDanger: lm.lastDanger }), [] as MistakeFacts[]);
  // the concept must have words where it is said: in the offer at stages 1–2, in the reply (its own board facts) at 3–5
  const speakable = (m: MistakeFacts): boolean => (v.stage <= 2 ? can(v, { pool: m.pool, piece: m.piece, facts: m.facts }) : can(v, { pool: m.pool, piece: m.piece, facts: pendingCueFacts(takebackPending(j, m)) }));
  const m = concepts.find(speakable) ?? null;
  let specs: (SentenceSpec | null)[];
  if (v.stage <= 2) {
    // «Стоп-стоп! {что случилось}. Вернём ход?»
    const what = m ? sentence(v, { pool: m.pool, piece: m.piece, facts: m.facts }) : null;
    specs = [sentence(v, { pool: args.again ? 'v3.takeback.again' : 'v3.takeback.stop' }), what, sentence(v, { pool: 'v3.takeback.ask' })];
  } else {
    // «Стоп! Что теперь может съесть соперник?» — the answer (and its red highlight) comes after the reply
    specs = args.again ? [sentence(v, { pool: 'v3.takeback.again' }), sentence(v, { pool: 'v3.takeback.askThink' })] : [sentence(v, { pool: 'v3.takeback.askThink' })];
  }
  const rendered = renderUtterance(specs);
  if (m) lm.mistakes = [...lm.mistakes, { turn: turnOf(lm, j.ply), ply: j.ply, concept: m.concept, uci: j.uci, lossPawns: j.materialLossPawns, mated: m.mated, victim: m.victim }];
  // the concept waits for the reply in its own field (`lastDanger` keeps the warning for the retry's «ignoredDanger»)
  lm.pendingTakeback = takebackPending(j, m);
  lm.followStreak = 0;
  const event = lessonEvent({
    kind: 'takebackOffer',
    rendered,
    pose: 'oops',
    priority: 2,
    pauseClock: true,
    teach: teachOf('reaction', j.ply, args.advice),
    ...(v.stage >= 3 ? { noCueBoard: true } : {}),
  });
  return { event, memory: withLesson(memory, lm) };
}

/** The pending take-back: the own field, else the mark of a game saved before it (in `lastDanger`). */
function pendingOf(lm: LessonMemory): PendingTakeback | null {
  if (lm.pendingTakeback) return lm.pendingTakeback;
  const mark = readTakebackMark(lm.lastDanger);
  if (!mark) return null;
  return {
    ply: mark.ply,
    uci: '',
    childColor: 'w',
    concept: mark.concept,
    piece: mark.piece,
    square: mark.victim,
    cue: { fen: '', victim: mark.victim, target: null, piece: null, kingOf: null, move: null, line: null, threat: null },
  };
}

function lessonTakebackReply(kind: 'yes' | 'no', profile: StudentProfile, memory: TeachMemory, book: LessonBook): { event: CoachEvent; memory: TeachMemory } {
  const v = voiceOf(profile, book);
  const lm = restoreLessonMemory(memory.lesson);
  const pending = pendingOf(lm);
  const specs: (SentenceSpec | null)[] = [sentence(v, { pool: `v3.takeback.${kind}` })];
  // stages 3–5: what could be taken, with its red highlight — only now, after the child's own look
  if (v.stage >= 3 && pending?.concept) {
    const pool = `v3.mistake.${pending.concept}`;
    const facts = pendingCueFacts(pending);
    specs.push(sentence(v, { pool, piece: pending.piece, facts }) ?? sentence(v, { pool, piece: pending.piece }));
  }
  const rendered = renderUtterance(specs);
  lm.pendingTakeback = null;
  if (readTakebackMark(lm.lastDanger)) lm.lastDanger = null;
  const event = lessonEvent({ kind: 'teachReaction', rendered, pose: 'talk', priority: 1, pauseClock: true, teach: teachOf('reaction', pending?.ply ?? 0) });
  return { event, memory: withLesson(memory, lm) };
}

// ───────────────────────── the end of the game ─────────────────────────

const END_POSE: Readonly<Record<GameOutcome, MascotPose>> = { win: 'cheer', loss: 'talk', draw: 'talk', unfinished: 'idle' };

/**
 * The takeaway key: the first true one that the rotation allows and that has words; else the first with words.
 * `variants` — the sub-case of a key (the motif of the found tactic, ./end.ts `takeawayVariant`).
 */
export function chooseTakeaway(keys: readonly string[], v: Pick<Voice, 'book' | 'stage' | 'g'>, variants: Readonly<Record<string, string | null>> = {}): string | null {
  const voice: Voice = { book: v.book, stage: v.stage, g: v.g };
  const history = v.book.history();
  const speakable = keys.filter((k) => can(voice, { pool: `v3.takeaway.${k}`, variant: variants[k] ?? null }));
  return speakable.find((k) => takeawayRotationOk(k, history)) ?? speakable[0] ?? null;
}

function lessonEnd(args: LessonEndArgs, memory: TeachMemory, book: LessonBook): LessonEndResult {
  const v = voiceOf(args.profile, book);
  const lm = restoreLessonMemory(memory.lesson);
  const outcome = gameOutcome(args.result, args.childColor, args.termination);
  const keys = safe(
    () =>
      takeawayCandidates({
        outcome,
        stage: v.stage,
        childColor: args.childColor,
        lesson: lm,
        judgements: args.judgements,
        historySan: args.historySan,
        card: args.strategyCard,
      }),
    [`stage.${v.stage}`],
  );
  const variants = Object.fromEntries(keys.map((k) => [k, safe(() => takeawayVariant(k, lm), null)]));
  const key = chooseTakeaway(keys, v, variants);
  const opener = sentence(v, { pool: `v3.end.${outcome}` });
  const takeaway = key ? sentence(v, { pool: `v3.takeaway.${key}`, variant: variants[key] ?? null }) : null;
  const rendered = renderUtterance([opener, takeaway]);
  const takeawayText = takeaway ? joinSentence(takeaway.parts.map((p) => p.text)) : '';
  if (key && takeaway) book.learner.takeaway(key);

  // the realized loss of the mistakes said during the game
  safe(() => {
    const track = materialTrack(args.historySan, args.childColor);
    lm.mistakes = lm.mistakes.map((m) => {
      const r = realizedLoss(track, m.ply, args.childColor);
      const played = args.historySan[m.ply - 1] !== undefined && args.judgements.some((j) => j.ply === m.ply && j.uci === m.uci && args.historySan[m.ply - 1]?.replace(/[+#]/g, '') === j.san.replace(/[+#]/g, ''));
      return played ? { ...m, lossPawns: r.pawns, mated: r.mated || m.mated } : m;
    });
    return true;
  }, false);

  const event = lessonEvent({
    kind: 'gameEnd',
    rendered,
    pose: END_POSE[outcome],
    priority: 2,
    pauseClock: false,
    teach: teachOf('takeaway', args.historySan.length),
  });
  return { event, takeaway: takeawayText, takeawayKey: key && takeaway ? key : '', memory: withLesson(memory, lm) };
}

export const REACTION_IMPL: Pick<LessonDirectorImpl, 'lessonReaction' | 'lessonTakebackOffer' | 'lessonTakebackReply' | 'lessonEnd'> = {
  lessonReaction,
  lessonTakebackOffer,
  lessonTakebackReply,
  lessonEnd,
};
