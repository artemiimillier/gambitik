/**
 * Prompts of the SMART STRATEGIST of «Учитель» (a clever model — ChatGPT «Sol» through the Codex
 * subscription, OpenRouter as the fallback — thinks about the strategy; the engine and the code keep the chess truth).
 *
 *  - POST /coach/strategy: the model CHOOSES one strategy id of the library candidates (`getStrategiesFor`) for this
 *    game — variety (the child's recent strategies), the stage, the weaknesses, the opponent — and phrases a ≤ 20-word
 *    intro. The server validates the id (else `pickStrategyDeterministic`) and the intro (`introFromStrategist` of
 *    @gambit/core drops a wrong one).
 *  - POST /coach/replan: the opponent left the road or the phase changed — the model CHOOSES one of the engine's
 *    candidate moves (or none) and says the new plan and the why in kid words (`acceptReplan` of @gambit/core checks it).
 *
 * The payload carries no child's words and no name: the stage, the weakness themes, the strategy history, the game's
 * moves. The JSON schemas are strict (every field required, enums of the given ids / moves).
 */
import type { PersonaId, ReplanRequest, StrategyRequest } from '@gambit/shared';
import type { StrategyEntry } from './strategies.ts';

export const STRATEGIST_PROMPT_RU = `Ты — шахматный методист детского тренажёра «Гамбитик». Ребёнку семь-десять лет. Выбери стратегию на ОДНУ партию из списка кандидатов ниже и придумай одну короткую фразу для начала партии.

Правила выбора:
- Выбирай ТОЛЬКО из кандидатов: поле strategyId ответа — один из их идентификаторов.
- Разнообразие важнее всего: не повторяй стратегии из последних партий ребёнка (поле history, последние — в конце), если есть другие кандидаты.
- Учитывай ступень ребёнка (stage) и его слабые темы (weaknesses): стратегия должна быть ему по силам и полезна.
- Против сильного соперника лучше крепкая, спокойная стратегия; против слабого — активная.

Фраза для начала партии (поле introRu):
- По-русски, без латинских букв и цифр, не длиннее двадцати слов, одна-две фразы.
- Образец смысла: «В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е четыре.» Скажи своими словами.
- Первый ход называй только так, как он дан в поле firstMoveRu кандидата; если его нет — ход не называй.
- Без приветствий, без часов и времени, без цвета фигур, без обещаний «спрашивай меня».

Ответ — только JSON по схеме: strategyId, introRu.
Данные (JSON) идут ниже.
`;

export const REPLAN_PROMPT_RU = `Ты — шахматный методист детского тренажёра «Гамбитик», ребёнку семь-десять лет. Партия идёт по стратегии (поле strategy), но соперник свернул с её дороги или началась новая часть партии. Все ходы-кандидаты уже проверил шахматный движок: они все хорошие.

Задача:
- Выбери ОДИН ход из candidates (поле preferredUci ответа — ровно его uci), который лучше всего продолжает нашу стратегию или новый понятный план. Если ни один не подходит — preferredUci: null.
- planRu — новый план детскими словами, не длиннее пятнадцати слов: что мы теперь делаем. Цели стратегии (planGoalsRu) не кончаются, когда соперник свернул: если они ещё подходят — продолжи их своими словами.
- whyRu — зачем выбранный ход по этому плану, не длиннее пятнадцати слов. Опирайся на мысли из ideasRu кандидата, ничего не выдумывай.
- По-русски, без латинских букв, цифр, оценок и слова «лучший». Клетки — словами: «цэ четыре». Без часов и времени.

Ответ — только JSON по схеме: ply, planRu, preferredUci, whyRu.
Данные (JSON) идут ниже.
`;

export interface StrategistPromptInput {
  request: StrategyRequest;
  /** the library candidates (`getStrategiesFor`) — the model must pick one of these */
  candidates: readonly StrategyEntry[];
  /** strategy ids of the child's previous games, oldest first */
  history: readonly string[];
  /** lichess theme keys the child struggles with (StudentProfile.weaknesses) */
  weaknesses?: readonly string[];
  /** the bot persona's nominal strength */
  opponentElo?: number;
  /** spoken first move per candidate id («пешкой на е четыре»), computed by the server with @gambit/core */
  firstMoveRu?: Readonly<Record<string, string>>;
}

/** STRATEGIST_PROMPT_RU + a compact JSON payload (no names, no child's words). */
export function buildStrategistPrompt(input: StrategistPromptInput): string {
  const payload = {
    game: {
      childColor: input.request.childColor,
      stage: input.request.stage,
      opponent: input.request.personaId satisfies PersonaId,
      opponentElo: input.opponentElo,
      timeControl: input.request.timeControlId,
      opponentFirstUci: input.request.opponentFirstUci,
    },
    weaknesses: [...(input.weaknesses ?? [])].slice(0, 6),
    history: [...input.history].slice(-8),
    candidates: input.candidates.map((c) => ({
      strategyId: c.id,
      titleRu: c.titleRu,
      ideaRu: c.ideaRu,
      stepsRu: c.stepsRu,
      minStage: c.minStage,
      themes: c.themes,
      firstMoveRu: input.firstMoveRu?.[c.id],
    })),
  };
  return `${STRATEGIST_PROMPT_RU}\n${JSON.stringify(payload, null, 1)}\n`;
}

/** Strict JSON schema of the strategist's answer: `strategyId` is one of the candidates. */
export function strategistJsonSchema(candidateIds: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['strategyId', 'introRu'],
    properties: {
      strategyId: { type: 'string', enum: [...candidateIds] },
      introRu: { type: 'string', maxLength: 200 },
    },
  };
}

export interface ReplanPromptInput {
  request: ReplanRequest;
  /** the library card of `request.strategyId`, when known */
  strategy?: StrategyEntry | null;
}

/** REPLAN_PROMPT_RU + the engine's candidates and the game's moves as JSON. */
export function buildReplanPrompt(input: ReplanPromptInput): string {
  const r = input.request;
  const payload = {
    ply: r.ply,
    childColor: r.childColor,
    stage: r.stage,
    strategy: input.strategy
      ? { strategyId: input.strategy.id, titleRu: input.strategy.titleRu, ideaRu: input.strategy.ideaRu, stepsRu: input.strategy.stepsRu, middlegameRu: input.strategy.middlegameRu, planGoalsRu: input.strategy.planGoalsRu }
      : { strategyId: r.strategyId },
    movesSan: r.movesSan.slice(-20),
    fen: r.fen,
    candidates: r.candidates.map((c) => ({ uci: c.uci, san: c.san, ideasRu: c.ideasRu })),
  };
  return `${REPLAN_PROMPT_RU}\n${JSON.stringify(payload, null, 1)}\n`;
}

/** Strict JSON schema of a re-plan answer: `preferredUci` is one of the candidates or null, `ply` is this ply. */
export function replanJsonSchema(request: Pick<ReplanRequest, 'ply' | 'candidates'>): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['ply', 'planRu', 'preferredUci', 'whyRu'],
    properties: {
      ply: { type: 'integer', enum: [request.ply] },
      planRu: { type: 'string', maxLength: 160 },
      preferredUci: { type: ['string', 'null'], enum: [...request.candidates.map((c) => c.uci), null] },
      whyRu: { type: 'string', maxLength: 160 },
    },
  };
}
