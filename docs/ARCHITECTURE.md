# Architecture — «Гамбитик» kids chess trainer

Architecture reference for contributors. Read it together with `packages/shared/src/contracts.ts` (the type contracts between all modules) and `docs/TEACHING.md` (the lesson model the child's game runs on; «Учитель» details: `docs/TEACHER-MODE.md`). The pedagogy and the stack rationale are summarised at the end of this file. Research with verified details lives in `docs/research/*.md` — read the relevant report(s), including their «Верификация» section, before coding. Library APIs change between major versions (e.g. the react-chessboard v5 API differs completely from v4) — trust the reports and the installed package typings.

## 0. Principles

0. **No generative AI in the child's game** — docs/TEACHING.md. Stockfish + `@gambit/core` decide, and every word is a pre-written, lint-checked wording of `@gambit/content` (`packages/content/src/teaching/`), picked by the lesson engine (`packages/core/src/coach/lesson/`, the director is its one entry point for the game and the 50-game report). The voice never names a square. The live voice, the microphone, the LLM strategist, re-plans and LLM reviews described below exist in the code but run only with `GAMBIT_RUNTIME_AI=1` (default off); principle 1 describes that optional mode.
1. **Engine decides, code proves, the voice model finds the words** («Движок решает, код доказывает, ИИ только пересказывает»). LLMs hallucinate at chess, so no LLM output may decide a move verdict, a best move, a motif, a hint level or a take-back trigger — Stockfish + `@gambit/core` do; a language / voice model only receives finished facts and says them in a child's words. That is also why the coach works fully without any paid API (principle 2). A conversational voice (Live / Realtime) does not read templates (so that it sounds alive and does not speak only after «Подсказка»): every `CoachEvent` carries a **brief** (`Момент / Факты / Цель / Нельзя`, Russian, spoken notation, never the best move below hint level 4; «Учитель» adds a `Можно назвать` line — the only moves of the child the model may say) and the model says it in its own words; the child can talk to it at any time and its answers are grounded by tools that return FACTS. Templates (`text` / `bubbleText`) remain for the browser voice, the silent layer and the speech bubble until the model's own transcript arrives.
2. **Works with zero paid APIs.** Template Russian phrases + browser `speechSynthesis` are the baseline; OpenAI voice (Live `gpt-live-1` full duplex — preferred; Realtime `gpt-realtime-2.1` — alternative) and Codex / OpenRouter / OpenAI text are optional upgrades behind interfaces, auto-detected via `GET /api/health`.
3. **Event journal is the source of truth**; PGN/markdown are derived files.
4. **Kid first**: big targets, little text, Russian only, no dark patterns, the child can always say «Оставлю свой ход».
5. Local only: server binds `127.0.0.1`, Host/Origin allowlist, secrets only in `.env` (never committed, never logged, never sent to the browser — the browser only ever gets an ephemeral Realtime secret or, for Live, the SDP answer of a session our server created).
6. **Automation is silent and free** (`apps/web/src/automation.ts`): under `navigator.webdriver` the coach uses the silent layer, no sounds, and every API call carries `X-Gambit-Automation: 1` (template reviews, no voice session). Only `localStorage['gambit.e2eVoice']='on'` opts a manual smoke test (`tools/voice-smoke/`) into real voice.

## 1. Monorepo layout (pnpm workspaces)

```
Chess/
├─ package.json                 root scripts: dev, build, start, test, typecheck, puzzles:import, openings:build
├─ pnpm-workspace.yaml          packages: apps/*, packages/*, tools ; allowBuilds: { stockfish: false }
├─ tsconfig.base.json           strict, noEmit, allowImportingTsExtensions, verbatimModuleSyntax, erasableSyntaxOnly
├─ .env.example                 GAMBIT_RUNTIME_AI=0 (master switch, default off), OPENAI_API_KEY, VOICE_PREFERRED=clips, VOICE_LIVE_MODEL=gpt-live-1, VOICE_LIVE_VOICE=marin, VOICE_MODEL=gpt-realtime-2.1, VOICE_NAME=marin,
│                               LLM_PROVIDER=template, CODEX_MODEL, OPENROUTER_API_KEY (text only), OPENROUTER_REVIEW_MODEL, OPENROUTER_FALLBACK_MODELS, REVIEW_INCLUDE_CHILD_SPEECH=0,
│                               CODEX_STRATEGY_MODEL / OPENROUTER_STRATEGY_MODEL / OPENAI_STRATEGY_MODEL (the «Учитель» strategist, gpt-5.6-sol),
│                               GAMBIT_API_PORT / GAMBIT_WEB_PORT (a second stack on other ports: e2e / smoke tests while the main server holds 8787)
├─ Шахматы.command              double-click launcher (build if needed → start server → open browser)
├─ apps/
│  ├─ web/                      @gambit/web — Vite 8 + React 19 + TS SPA (dev port 5173, proxies /api → 127.0.0.1:8787)
│  │  ├─ public/engine/         stockfish-19-lite-single.js + .wasm (copied from node_modules/stockfish by a script)
│  │  └─ src/
│  │     ├─ api/client.ts       typed fetch wrappers for every route in contracts.ts
│  │     ├─ ui/                 design tokens, primitives, PersonaAvatar, sounds
│  │     ├─ engine/             UciEngine, createJudgeEngine, createBotEngine, BOT_LEVELS
│  │     ├─ coach/              Mascot, MascotDock, voice layers, coach controller + store
│  │     ├─ features/game/      game store (state machine), clock, TrainerBoard, GameScreen
│  │     ├─ features/review/    ReviewScreen
│  │     ├─ features/puzzles/   PuzzlesScreen
│  │     ├─ features/progress/  ProgressScreen (parent dashboard)
│  │     ├─ features/curriculum/ CurriculumScreen («Путь пешки»)
│  │     └─ app/                App.tsx, router, Home, NewGame flow, Settings
│  └─ server/                   @gambit/server — Hono on Node 26, runs .ts natively
├─ packages/
│  ├─ shared/                   @gambit/shared — contracts.ts (+ index.ts re-export)
│  ├─ core/                     @gambit/core
│  │  └─ src/analysis/          eval math, judgeMove, position facts, motifs, game summary, PGN
│  │  └─ src/coach/             spoken Russian, intervention policy, CoachEvent builders, template review
│  ├─ content/                  @gambit/content — personas, curriculum, concept cards, prompts
│  └─ openings/                 @gambit/openings — EPD→name lookup + generated JSON
├─ tools/                       import-puzzles.ts, build-openings.ts
│  └─ voice-smoke/              MANUAL paid smoke tests with the real keys (run.mjs / conversation.mjs = live voice, teacher.mjs = «Учитель» §8.3 incl. --strategy / --blitz5, review.mjs = text path) — not part of e2e.
│                               guard.ts: --base-url is mandatory, ports 8787 / 5173 always refused, the server must report
│                               /api/health dataDirIsTemp:true before anything is written, no --out / --work / --reanalyse path inside data/
├─ kb/puzzles-starter.json      ~400 bundled puzzles so the trainer works before the big import
├─ data/                        RUNTIME, git-ignored: app.sqlite (schema v3), build/puzzles.sqlite, games/ (.pgn + .md + .json twin), student/, server.log, voice-diag.log
└─ docs/
```

Modules talk to each other only through the public APIs in §3.

### TypeScript rules (so the server can run `.ts` natively and Vite can bundle the same sources)
- Workspace packages are consumed as source: `"exports": { ".": "./src/index.ts" }`, no build step.
- Relative imports carry the `.ts`/`.tsx` extension. `import type` for types. No `enum`, no `namespace`, no constructor parameter properties (erasable syntax only).
- `packages/*` must be isomorphic (no DOM, no `node:` imports) except where stated. `chess.js@1.4.0` is the only chess rules library (no chessops/chessground — GPL).
- Tests: Vitest, colocated `*.test.ts`. Every package must pass `pnpm -r typecheck` and `pnpm -r test`.

## 2. Runtime flow of one child move (the core loop)

```
child drops piece ──► game store: validate with chess.js, apply, state='judging', bot is NOT asked yet
      │
      ├─► judge engine (own worker): judgeMove(fenBefore, uci)  — uses the cached MultiPV-3 analysis of fenBefore
      │       computed while the child was thinking; quick search of fenAfter (~depth 12, ≤300 ms),
      │       if it looks bad → confirm search (depth 14–16) → MoveJudgement{confidence:'confirmed'}
      │
      ├─► decideIntervention(judgement, ctx)   (@gambit/core/coach — pure function)
      │       'offerTakeback' → state='coachIntervention', clock paused, coach.say(buildTakebackOffer(j))
      │                         UI shows two big buttons: «Верну ход и подумаю» / «Оставлю свой ход»
      │                         accept → chess.undo(), clock restored to the value before the move, hint ladder available
      │                         decline → continue
      │       'logForReview' / 'none' → continue (+ optional praise for best/excellent moves, priority 0)
      │
      └─► state='botThinking' → botEngine.pickMove(fen, persona) → wait thinkMs → apply → state='childTurn'
              → start background analysis of the new position (cache for the next judgement + hints + threat warning)
              «Учитель»: the analysis starts (prewarm) as soon as pickMove resolved, during the bot's pause; ≤ 1.5 s after the
              bot's move planTeachTurn → coach.say(teachTurn) with the advice arrows (rapid10 and blitz5: the child's clock
              stands while it is said); a child's move during the phrase stops it GENTLY
              (coach.stopSpeaking({ grace: true }): queued / not-yet-audible phrases dropped, the audible one ends its sentence,
              ≤ 2 s, then the newest) — docs/TEACHER-MODE.md §2.1
              + the smart strategist (TEACHER-MODE §3.6): at the moment pickMove resolved (the REAL move, ~1 s before it is
              shown) the game checks the strategy's line on the prewarmed analysis and, when the opponent left it / the phase
              changed / every 6 plies in the middlegame, POSTs /coach/replan with the engine's candidates; the answer (codex
              Sol ≈ 6–8.5 s) is used from the next teacher line — no teacher line ever waits for a model
```
Bullet (coachMode 'off'): judgements are still computed and logged (in background, not blocking the bot) but nothing is said until the game ends.

## 3. Public APIs between modules

### @gambit/core — `src/analysis`
```ts
winPct(score: EvalScore): number                       // lichess: 50+50*(2/(1+exp(-0.00368208*cp))-1), cp clamp ±1000, mate → ±1000
moveAccuracy(winPctBefore: number, winPctAfter: number): number   // lila AccuracyPercent incl. +1 bonus, clamp 0..100
gameAccuracy(judgements: MoveJudgement[]): number      // lila: mean of volatility-weighted mean and harmonic mean
classifyMove(args: { winPctBefore: number; winPctAfter: number; evalBefore: EvalScore; evalAfter: EvalScore; isBest: boolean }): MoveClass
toMoverPov(line: EvalScore, sideToMove: Color, mover: Color): EvalScore
judgeMove(engine: IJudgeEngine, args: { fenBefore: string; uci: string; ply: number; cachedBefore?: AnalysisResult; quickDepth?: number; confirmDepth?: number }): Promise<MoveJudgement>
computePositionFacts(fen: string, openingName?: string): PositionFacts
findHanging(fen: string): HangingPiece[]
detectMotif(fen: string, pvUci: string[]): MotifId | undefined       // motif realised by the side to move along the PV
materialSwing(fen: string, pvUci: string[], plies?: number): number  // pawns lost by the side NOT to move… document precisely
summarizeGame(args: { judgements: MoveJudgement[]; events: GameEvent[]; openingName?: string }): GameSummary
buildPgn(args: { headers: Record<string,string>; moves: { san: string; clkMs?: number; comment?: string }[]; result: GameResult }): string
uciToSan(fen: string, pvUci: string[]): string[]
```
### @gambit/core — `src/coach`
```ts
sanToSpokenRu(san: string): string            // 'Nf3' → 'конь на эф три'; 'exd5' → 'пешка бьёт на дэ пять'; 'O-O' → 'короткая рокировка'; '+' → ', шах'; '#' → ', мат'
sanToBubbleRu(san: string): string            // 'Nf3' → 'Кf3' (Russian piece letters Кр Ф Л С К)
squareToSpokenRu(sq: Square): string
pieceNameRu(p: PieceType, grammaticalCase: 'nom' | 'acc' | 'gen' | 'ins'): string
motifTitleRu(m: MotifId): string
decideIntervention(j: MoveJudgement, ctx: InterventionContext): InterventionDecision
buildGreeting(a: { profile: StudentProfile; hour: number; lastGame?: GameListItem }): CoachEvent
buildGameStart(a: { persona: Persona; timeControl: TimeControl; childColor: Color; profile: StudentProfile }): CoachEvent
buildTakebackOffer(j: MoveJudgement, profile: StudentProfile): CoachEvent
buildHint(level: HintLevel, a: { fen: string; best: AnalysisResult; facts: PositionFacts; profile: StudentProfile }): CoachEvent
buildExplainBest(j: MoveJudgement, profile: StudentProfile): CoachEvent
buildPraise(j: MoveJudgement, profile: StudentProfile): CoachEvent
buildThreatWarning(a: { fen: string; facts: PositionFacts; profile: StudentProfile }): CoachEvent | null
buildThinkingRoutine(profile: StudentProfile): CoachEvent
buildGameEnd(a: { result: GameResult; childColor: Color; termination: Termination; summary: GameSummary; persona: Persona; profile: StudentProfile }): CoachEvent
buildTemplateReview(record: GameRecord, persona: Persona, profile: StudentProfile): string   // Russian markdown, used by the server when no LLM is available
// the conversational coach:
// every builder above (+ buildGameResumed, buildOpeningIdea, buildTakebackDeclined/Accepted, buildDeclineReasonReply,
// buildVoluntaryTakeback) also fills CoachEvent.brief: 'Момент: …\nФакты: …\nЦель: …\nНельзя: …' (Latin-free, ≤ MAX_BRIEF_CHARS = 1100,
// the child in the third person, no numbers / engine jargon, the CURRENT best move only at hint level 4)
buildThreatWarning(a: { fen; facts; profile; threat?: Threat | null; lastMove?: { san; fenBefore } | null }, rng?): CoachEvent | null   // engine threat → mate / tactic warnings
buildPraise(j, profile, rng?, foundMotif?, opts?: { onlyMove?: boolean }): CoachEvent      // priority 1 for a real tactic / mate, else 0
buildSilenceNudge(profile, rng?): CoachEvent;  isRealTacticMotif(m): boolean
composeBrief(parts: BriefParts): string; stripLatinRu; studentWords; materialBalanceRu; winChanceWordsRu; winChanceChangeRu   // brief.ts
nullMoveFen(fen); threatFromNullMoveLine(fen, line); mateInOneThreat(fen); threatFactsRu(fen, threat)                      // threats.ts
parseMoveText(fen, text): MoveTextResult; moveTextProblemRu; buildMoveCheckAnswerRu(a); buildPositionAnswerRu(a)          // answers.ts (tool host facts)
// «Учитель» (docs/TEACHER-MODE.md; all pure, rng last):
// moveIdeas.ts — the deterministic «why» of a move (no LLM, no engine call; conservative: no idea rather than a false one)
explainMove({ fen, uci, pvUci?, lineScore?, phase?, prev? }): MoveIdea[]   // §4.2 ideas in priority order; [] for an illegal move / a move that just gives material away
//   prev = the move before `fen`: a capture on the same square is `recapture` («забирает … в ответ — это размен»), never a gift
//   (for the opponent always; for the child unless it still nets ≥ 2 pawns); a «winning» capture the engine line takes back is a `trade`
//   ids include recapture (A), answerCheck (A: «закрывается / уходит от шаха», «забирает фигуру, которая ставит шах»),
//   fightCenter (C: «нападает на пешку на дэ пять в центре»); supportCenter also «поддерживает пешку на дэ пять»
pickIdeas(ideas, { stage, max: 1 | 2, avoid? }): MoveIdea[]; joinIdeasRu(ideas, voice?: 'brief' | 'you'): string   // «выводит коня и нападает на пешку на е пять»
explainOpponentMove(fenBefore, uci, childFenAfter, opts?: { threat?, prev? }): { ideas; wants: Threat | null }   // static ideas only (§4.3)
explainMoveLoss({ judgement, adviceUci?, phase?, prev? }): MoveLoss        // «чуть слабее / заметно слабее» + ≤ 2 verified facts (§4.4); adviceWin = the A/B idea the advice had («нападает на ферзя»)
isEarlyQueenMove(fen, uci) (a DEFENSIVE queen move — guarding an attacked unit, saving from mate / check, recapturing — is not «early»);
isKidFilteredQueenMove(fen, uci, ideas) (the advice kid filter: ANY queen move while two own minors sleep, unless it wins ≥ 2 / saves / recaptures); ideaWordCount; MAX_IDEA_WORDS = 12; MAX_IDEA_PAIR_WORDS = 14; IDEA_PRIORITY; IDEA_GROUP; STATIC_IDEA_IDS
// teacher.ts — the teacher's brain
pickAdvice(ctx: TeachContext, opts?): AdviceCandidate[]                   // ≤ 2 moves of MultiPV-3 within 30 cp (20 cp / one move at depth 8–11), book moves via searchmoves
bookMovesToVerify(ctx): string[]                                          // the game runs judge.analyze(fen, { searchmoves: [uci] }) and passes the lines back as ctx.verified
planTeachTurn(ctx, rng?): TeachPlan; buildTeachTurn(plan, rng?): CoachEvent   // kind 'teachTurn', moment 'turn' | 'openingPlan'; store plan.memory → next ctx.memory
buildTeachReveal / buildTeachRepeat(plan, rng?, opts?); reactionVerdict(a): ReactionVerdict; buildTeachReaction(v, a, rng?): CoachEvent | null
buildCompareMoveAnswerRu(a): string                                      // «а почему не ферзём?»: comparison with the advice + the queen chase + the rule
middlegamePlan(facts, board, childColor, opts?) (+ mateTechnique for a lone king; tradeWhenAhead only while the opponent has a piece); openingPlanFacts(a); queenChase(fen, pvUci); teachModeOf(analysis); treasureRevealMs(stage); initialTeachMemory()
TEACH_TOLERANCE_CP = 30; TEACH_MIN_DEPTH = 12; TEACH_FALLBACK_DEPTH = 8; PRINCIPLE_BONUS = 1.0; TEACH_NOISE_DEPTH = 16 / TEACH_NOISE_CP = 20 (a gap ≤ 20 cp below depth 16 counts 0); RESCUE_BONUS = 3.0 (stages 1–2: saving the attacked unit first); IDEA_TO_CONCEPT; TEACH_BRIEF_CHARS { 1000, 600, 1100 }
// brevity (the teacher neither talks too much nor reads out the clock): TEACH_MAX_WORDS = 25; TEACH_TEXT_WORDS { full 25, short 15, concept 25 };
// TEACH_TEXT_SENTENCES { full 2, short 1, concept 2 } (the web voice frame uses the same numbers); CHOICE_EVERY_TURNS = 4 («Что выбираешь?» at most
// every 4th turn, only with two arrows; the blue arrow is in the brief only on those turns); CALM_SHORT_P = 0.65; CONCEPTS_PER_GAME { quiet 0, normal 2,
// chatty 4 }, CONCEPT_EVERY_PLIES = 8; OPPONENT_MENTION_WORDS = 6 (the opponent's move only when it matters); no clock, colour,
// whose-turn words in any text or brief (CLOCK_WORDS_RE; the one exception: «Поторопись!» once, under HURRY_MS = 30 s via TeachContext.remainingMs)
// the game strategy (strategy.ts + teacher.ts): TeachContext adds strategy?: TeachStrategy | null (GameStrategy over its library card), strategyCard?,
// replan?: ReplanResponse | null, introSaid?, remainingMs?; TeachPlan adds strategy, intro, alreadySaid, deviation, newPlanRu, opponentMentionRu, choice, hurry;
// AdviceCandidate.planFit 'line' | 'lineLater' | 'middlegame' | 'theme' | 'replan' (+ planWhyRu / planStepRu → «По нашему плану — слон на цэ четыре: …»)
// STRATEGY_LINE_BONUS = 2.5 (the main-line move, accepted up to STRATEGY_TOLERANCE_CP = 50 in the opening, never worse than «good»), STRATEGY_LATER_BONUS = 1,
// STRATEGY_MIDDLEGAME_BONUS = 0.5; resolveTeachStrategy(ctx); strategyProgress(s, historySan, color) (a Black system `against: 'other'` compares only the
// child's own moves); replanReason / replanCandidates / buildReplanRequest / acceptReplan / buildReplanFollowUp; strategyIntroRu (the server's template);
// introFromStrategist, cleanStrategistRu, replanWords (lower-cased for use inside a sentence), freshReplan (a stale ply: words yes, move no)
// brief.ts: BriefParts.advice → the «Можно назвать» line (never cut); MAX_TEACH_BRIEF_CHARS = 1000; FORBID_OTHER_MOVES, FORBID_BEST_WORD, FORBID_POPULARITY, FORBID_MOVE_FOR_CHILD; forbidFor
// events.ts: buildTakebackOffer(j, profile, rng?, { advice? }) — the teacher variant (the loss, the opponent's reply, the earlier advice; sets event.teach);
//            buildGameStart({ …, coachStyle?, strategy?, fen? }) — teacher + strategy: ONE line «В этот раз разыграем <title acc> — <idea>. Начни/Ответь …»
//            (kind 'gameStart', teach { moment 'openingPlan', style 'full', advice [first move, green] }, pauseClock false); no «по N минут» in any start brief
// policy.ts: TEACHER_DEFAULT_MAX_STAGE = 5; coachStylesFor(tc): CoachStyle[]; defaultCoachStyle(tc, stage): CoachStyle
// answers.ts: MoveCheckArgs.advice?: ScoredAdvice[] («так же хорошо, как совет» / «слабее совета»); adviceGapOf(gapCp); teachScoreCp(score)
```
`@gambit/core` does not depend on `@gambit/content` / `@gambit/openings`: the repertoire plan, the main-line moves, the opening names and the concept cards reach the teacher through `TeachContext` (the game fills it, `features/game/teacherContent.ts`).
Phrase builders pick randomly from several variants (pass an optional `rng` for tests), never shame, praise process, use `profile.address` for verb gender, never put Latin notation into `text`. A brief never quotes a template question as «например: «…»» for the model to copy — it gives the thought and asks for other words.

### apps/web/src/engine
```ts
class UciEngine { constructor(workerUrl?: string); ... }     // classic Worker('/engine/stockfish-19-lite-single.js'); detects 'CRITICAL ERROR' and '(none)'; watchdog timeout; serialises searches
createJudgeEngine(): IJudgeEngine                            // Skill 20, MultiPV per call, Hash 64, UCI_ShowWDL false
createBotEngine(): IBotEngine                                // separate worker; sampler per BotLevelConfig; validates every move with chess.js
BOT_LEVELS: Record<PersonaId, BotLevelConfig>
```
### apps/web/src/coach
```ts
<Mascot pose={MascotPose} mouthLevel={number} size?={number} />           // pure presentational inline SVG
<MascotDock />                                                            // fixed bottom-right: mascot + speech bubble + mic / mute / «Подсказка» buttons, reads useCoachStore
useCoachStore: { pose; mouthLevel; bubbleText; speaking; annotations: BoardAnnotations | null; voiceKind; muted; micAvailable }
coach.init(): Promise<void>                                               // picks voice layer from /api/health + settings
coach.say(event: CoachEvent): Promise<void>                               // queue by priority; sets pose/bubble/annotations; resolves when finished
coach.stopSpeaking(opts?: { clearBubble?: boolean; grace?: boolean }): void   // grace: stopGraceMs 2000, sentenceTailMs 300; priority 2 / hard stops cut at once
coach.setToolHost(host: CoachToolHost | null): void                       // game registers itself for realtime tools / hint button
coach.onHintRequested(cb): () => void
createBrowserTtsVoice(): VoiceLayer; createOpenAiRealtimeVoice(): VoiceLayer; createOpenAiLiveVoice(): VoiceLayer; createSilentVoice(): VoiceLayer
// settings, microphone, context:
coach.applySettings(): Promise<void>        // re-reads gambit.settings {voice:'auto'|'live'|'realtime'|'browser'|'off', muted, micMode:'open'|'push', headphonesConfirmed}
coach.setMicMode(mode) / confirmHeadphones() / setMicMuted(m) / toggleMic()
coach.pushContext(note: string): void       // silent Russian facts for the voice model (never spoken, never wakes a sleeping session)
coach.setHintAvailable(available: boolean)  // exam mode hides the dock's «Подсказка» button
// the conversational coach:
coach.startConversation(): Promise<void>; coach.endConversation(): void; coach.toggleConversation(): void   // the «Поговорить» button
coach.conversationState: ConversationState  // getter; 'connecting' is set SYNCHRONOUSLY by an auto-start
coach.setTalkativeness(t: Talkativeness); coach.setAutoConversation(on: boolean)   // persisted in gambit.settings
coach.onGameStart(info: CoachGameInfo /* { timeControlId, examMode? } — the game passes a superset */); coach.onGameEnd()
passesTalkativeness(event, t): boolean      // priority 2 or kind 'answer'|'hint'|'teachTurn'|'teachReaction' always; quiet: nothing else; normal: priority ≥ 1; chatty: all
useCoachStore adds: conversationState, conversationOn, micLevel (0..1), talkativeness, autoConversation, voiceModel
<MascotDock/>: big «Поговорить» button (.gmb-talk, data-state = ConversationState, 72 px) for a Live / Realtime voice; «Подсказка» 56 px; mute 48 px
// «Учитель»:
coach.onGameStart(info: { timeControlId, examMode?, coachStyle?: CoachStyle })   // no style = examMode ? 'exam' : 'helper'; kept in useCoachStore.coachStyle until onGameEnd
coach.talkativeness / coach.coachStyle      // read-only getters (the game picks the length of a teacher phrase from talkativeness)
//  teacher: the dock button reads «Совет» (aria-label) and calls host.repeatAdvice() when nobody subscribed; no 60 s nudge; a teachTurn for a
//           newer move drops a waiting older one.   exam: teach* events dropped, the button hidden, no nudge.
hintButtonText(coachStyle): { caption: 'Совет' | 'Подсказка'; title }; TEACH_MAX_SENTENCES = { short: 1, full: 2, concept: 2 } (= core TEACH_TEXT_SENTENCES; every default frame asks for 1–2 sentences and «не пересказывай очевидное — время на часах, цвет фигур, чей ход»; a teacher frame adds wordCapRu — «всего не больше двадцати / пятнадцати слов» — and NO_EXTRA_QUESTION_RU); teachMaxSentences(event)
passesTalkativeness: any event carrying `teach` (the teacher's strategy intro is a `gameStart` with teach) always passes
voice.speakBrief(brief, { interrupt?, fallbackText?, maxSentences? })   // Live / Realtime frame «до N коротких предложений» from event.teach.style
classifyChildRequest adds { intent: 'whyNot'; move; piece } («а почему не ферзём?» → host.compareMove) and { intent: 'more' } (Live, P1); «что мне ходить?» = hint
Realtime tools add compare_move { move?, piece? (Russian word) }; get_hint of a teacher game returns the advice (no ladder caveat)
// voice robustness (the child must hear the coach and be heard):
coach.interrupt()                           // a tap on the speaking mascot (and «Поговорить» on loudspeakers) cuts him off, hushes playback 600 ms, opens the mic in the same tick
coach.recheckHearing()                      // «Не слышно? Нажми сюда»: play() + AudioContext.resume() inside the click
coach.retryMicrophone(); coach.dismissMicHelp()   // a refused mic: «Микрофон закрыт — нажми, чтобы разрешить»; permission 'denied' → no retry,
                                            // the note «Браузер запретил микрофон» with per-browser steps (said once, not again within 20 s);
                                            // a permission change to 'granted' / 'prompt' re-attaches the mic on the SAME session
useCoachStore adds voiceFallback { from, to, reason, code, retryAt } | null, micHelp: boolean
CoachTimings adds voiceRestoreBaseMs 60 000 / voiceRestoreMaxMs 15 min (a passing failure of the preferred paid voice is retried at the next
                                            // conversation start after 1, 2, 4 … ≤ 15 min; permanent failures — no key, key refused, no WebRTC — never),
                                            // stopGraceMs 2000, sentenceTailMs 300
RTC_TIMEOUTS.echoStuckMs 4000, echoStuckDeafMs 12 000, interruptHushMs 600
voiceDiag.ts — the voice black box: diag(event, fields) → ring of 400 → POST /api/voice/diag every 5 s (+ sendBeacon on pagehide);
                                            // strings only /^[A-Za-z0-9 _.:/+()-]{0,64}$/ (no Russian text can pass); off under automation
soundCheck.ts — «Проверить звук» (chime through the voice's output path) and «Проверить микрофон» (≈ 3 s, RMS ≥ 0.02 → «Я тебя слышу ✓»); local, free, hidden under automation
voicePreview.ts / app/VoicePicker.tsx — the parent's voice pick (22 gpt-live-1 voices, 10 also on gpt-realtime-2.1) and a PAID one-line «Послушать»
```
**Words.** `coach.say(event)`: on a conversational layer (not muted, not ended by the child) with `event.brief` → `voice.speakBrief(brief, { interrupt: priority === 2, fallbackText: event.text })`; otherwise `voice.speak(event.text)`. The bubble shows the model's own transcript as it streams (the template only if no words come within 1.5 s, or if the model did not voice the brief). While a Live / Realtime session is up, a brief the model did not voice is **not** re-said by the robot browser voice (bubble only); the browser voice speaks only when there is no session. Talkativeness filters only conversational layers.

**Conversation lifecycle.** A game start (`onGameStart`, the wizard click is the user gesture) opens the conversation by itself when a conversational voice is available, `autoConversation` is on, the coach is not muted and it is not 1-minute bullet (there the coach is silent and the session closed). It stays open while the child plays (reconnect after a drop, at most 3 times in a row; a give-up of the preferred paid voice does not last for the page's lifetime — the fallback voice speaks and the preferred one is tried again at a later conversation start, see `voiceRestoreBaseMs`); 2 minutes without CHILD activity close it (`voiceIdleInGameMs` — the coach's phrases, bot moves, context notes and timers do not count, and while the mascot dozes they never reopen it), the child's next move / tap reopens it.
Money rules: a tab hidden ≥ 15 s closes it (visible again → only a game with the conversation on reconnects), `pagehide` closes it at once and reports the seconds with `navigator.sendBeacon` (the server accepts that `text/plain` POST on `/api/voice/usage` only, same-origin proven), and the parent's daily limit `gambit.settings.voiceDailyLimitMin` (30 / 60 default / 90 / 120 / 0 = none; server `todaySeconds` + this page's sessions) closes it for the rest of the local day — the coach goes on in the bubble, «Поговорить» shows «Лимит на сегодня». Outside a game the paid session closes after 90 s idle.
«Поговорить» toggles it; ending it («Пока!») closes session + microphone until the next tap or game. One gentle nudge after ≥ 60 s of the child's silence (training / 10-minute games, not exams, never twice within 2 min) — owned by the coach controller; the game's own copy is off in the browser wiring (`timings.silenceNudgeMs: 0`).

**Tools = facts.** `CoachToolHost` (implemented by the game): `analyzePosition()` (cached analysis + null-move threat + last moves + clocks + opening idea; never the best move; in «Учитель» it ends with the current advice), `evaluateMove(move)` («а если я пойду…» — judged on a scratch position, nothing in the game changes, never says whether it is the best move; in «Учитель» compared with the advice), `getHint(level)` (the ladder is enforced in code: one step at a time, the move only at level 4; in «Учитель» it returns the current advice as a `teachTurn` / `repeat`), `explainLastMove()`, `showOnBoard()`, `takeBackMove()`, and for «Учитель» `compareMove({ move } | { piece })` («а почему не ферзём?», ≤ 1.5 s: the best move of that piece by `searchmoves`, compared with the advice, the engine line, the queen chase, the opening rule) and `repeatAdvice()` (the current advice again with its arrows; a hidden «сокровище» is revealed; null outside «Учитель»).
Live (`gpt-live-1`) reaches them by CLIENT delegation: the child's last words (waiting until they settle, ≤ 1.8 s) are routed by `classifyChildRequest` + `parseSpokenMove`, the FACTS go back as commentary «answer in your own words, only from these facts». Realtime (`gpt-realtime-2.1`) tools: `analyze_position`, `evaluate_move{move}`, `get_hint{level}`, `explain_last_move`, `show_on_board`, `take_back_move`, `wait_for_user` (`get_position_summary` = alias); outputs are facts JSON (`факты`, `как_отвечать`, …).

**Game ↔ coach.** `GameCoach` (features/game/gameTypes.ts) has optional `onGameStart(info: GameConversationInfo)` (called once per game after `setToolHost`; carries `info.coachStyle`), `onGameEnd({ result, termination })`, `onConversationState`, `conversationState`, `talkativeness` (read-only; «Тихо» makes every teacher phrase short). Journal: while the model speaks (conversation connecting or open), `coachSaid` / `hintGiven` / `takebackOffered` keep the template under `{ template, spokenBy: 'model' }` and the model's real words arrive as `coachSaid { text, source: 'voice' }`; the child's words as `childSaid { text, source: 'voice' }`. The markdown journal renders the voice lines as the dialogue («Тренер: …», «<ник>: …») and marks moments said in the model's own words.

**Live wire rules.** Every brief — urgent ones too — is `session.commentary.append` (urgent = sent at once, with an «important moment» frame); `session.instructions.append` is used only for the session policy at start and for a ONE-TIME-worded stop, because instructions stay in the session for good (an urgent «…потом замолчи и слушай» instruction would keep the model silent from then on). An append is ≤ 1200 characters; a long brief loses facts first, never its «Цель» / «Нельзя» (`fitBrief`). Wordless «...» transcripts are dropped; the child's and the coach's utterances are grouped per side (full duplex overlaps) and reported in the order they started. The Live model advances only while audio frames arrive: a real microphone always sends room noise (a digitally silent microphone freezes it).

Voice chain (auto): `health.voice.preferred` (live by default) → the other OpenAI layer → browser TTS → silent; the same order at runtime (failover after the current phrase). `init()` opens nothing paid; outside a game the session + microphone open on the first phrase / tap and close after 90 s idle; in a game see «Conversation lifecycle» above (the same 2 minutes without the child when the conversation is off); on mute and when the mascot sleeps the session closes (closing never counts as activity, so an idle close cannot reopen the session). Every closed session is reported to `POST /api/voice/usage`. Open microphone is the default; without confirmed headphones a software echo guard mutes the input while the coach is audible (Live: `session.input_audio.mute/unmute`).
Live specifics (`liveProtocol.ts`): app phrases = `session.commentary.append` (urgent = `session.instructions.append`), context notes = `session.thinking.append` prefixed «Служебная заметка…» and never sent while an app phrase is being said, chess questions reach the app through CLIENT delegation (engine facts / hint ladder via `CoachToolHost`), a normal app phrase waits (bounded) until the child and the model's answer to the child are done. `speak()` completion is a heuristic (the Live API has no per-response done event) and is hard-capped.

### apps/web/src/ui
`tokens.css` (CSS variables: palette, radii, spacing, font), `global.css`, `<Button variant size>`, `<Card>`, `<Screen title onBack>`, `<BigChoice>` (large tappable tile), `<PersonaAvatar persona size>`, `<Stars>`, `<ProgressBar>`, `sounds.ts` (`playSound('move'|'capture'|'check'|'win'|'lose'|'click'|'oops')`, synthesised with WebAudio — no asset downloads), `confetti.ts`.

### apps/web/src/features/* screens — fixed props
```ts
GameScreen      { personaId: PersonaId; timeControlId: TimeControlId; childColor: Color; examMode: boolean; coachStyle?: CoachStyle; onExit(gameId?: string): void }
                // coachStyle absent = examMode ? 'exam' : 'auto' (the stage default of defaultCoachStyle)
ReviewScreen    { gameId: string; onExit(): void; onStartPuzzles?(theme: string): void }
PuzzlesScreen   { theme?: string; onExit(): void; sessionSize?: number; onPuzzleDone?(): void }  // #/puzzles?warmup=1 = 3 puzzles
ProgressScreen  { onExit(): void; onOpenGame(gameId: string): void }
CurriculumScreen{ onExit(): void; onStartPuzzles(theme: string): void }
```
### apps/web/src/features/game — «Учитель»
```ts
GameConfig.coachStyle?: CoachStyle | 'auto'     // absent = examMode ? 'exam' : 'helper'; 'auto' = defaultCoachStyle(tc, stage); a style the time control
                                                // does not offer becomes the default; the resolved style is written back (examMode = style === 'exam')
GameState adds coachStyle; advice: TeachAdvice[] | null (the arrows live until the child moves); treasure: { ply; revealAt } | null; teachMode
GameTimings adds teachDeadlineMs 1500, teachMinDepth 12, teachAnalysisMs 1100, teachFallbackDepth 8, teachHoldMaxMs 20000, treasureRevealMs 10000 (stages 3–4 ×1.5), teachVerifyMovetimeMs 300
GameDeps.teacherContent?: Partial<TeacherContent>   // { repertoirePlan, mainLineMoves, openingNameRu, conceptCard } — defaults: teacherContent.ts (@gambit/content, the lazy opening book)
resolveCoachStyle(config, stage); TEACHER_CONCEPTS_KEY = 'gambit.teacher.concepts' (cards already explained to this child)
toolHost.compareMove / repeatAdvice implemented (above); requestHint in «Учитель» repeats the advice (no ladder, never journaled as a hint)
resume.ts: RESUME_VERSION = 2 — config.coachStyle + the teacher's memory; version-1 snapshots are read too (style from examMode);
           also config.strategy + teach.strategy { lineStatus, lastReplanPly, planPhase, replan } (a resumed game asks nothing again)
// the smart strategist: GameDeps.strategist?: GameStrategist { strategy(req, {signal}), replan(req, {signal}), card?(id) } (browser:
// createBrowserStrategist over api/client getStrategy / replan and the wizard's prefetch); GameConfig.strategy?; GameState.strategy / replan;
// GameTimings adds strategyWaitMs 8500 (the intro waits for the strategy, counted from its request), replanMinDepth 10, replanWaitMs 1500,
// replanEveryPlies 6, hurryBelowMs 30000. strategy.ts: sanitizeStrategy, acceptReplan, createStrategyPrefetcher / strategyPrefetch /
// prefetchStrategyFor (the wizard's colour tap, teacher + White; Black asks when the bot DECIDED its first move); strategyPlan.ts (pure):
// strategyLineStatus, replanTrigger ('leftLine' | 'phase' | 'cadence'), replanCandidates (≤ 3 engine lines within 30 cp, ideas on «ты»).
// The intro is core's teacher buildGameStart; the first teachTurn is planned with introSaid and not spoken when core returns plan.alreadySaid.
// journal: coachSaid { kind: 'strategy' | 'replan', … } (no text keys: the markdown journal renders them as their own lines)
journal: child 'move' data.advice (SAN, green first) + data.followed ('primary' | 'alternative' | 'own'); coachSaid / takebackOffered data.teach (TeachSummary);
         GameRecord.coachStyle is always set
// hello, thoughts, clock holds: GameDeps.helloHeard?() (features/game/hello.ts: a wave with ≥ 1.5 s of speech counts, fresh 15 min; not heard →
// the start line begins «Привет, <имя>!», the teacher waves a one-word hello first); GameDeps.appendThoughts?(gameId, thoughts) → POST
// /games/:id/thoughts (thoughts.ts: words said AFTER the record went out, with the last coach question; batches ≤ 20, 3 s after the last
// sentence; offline → localStorage gambit.unsentThoughts, flushed at the next game start after the parked games; 4xx drops them);
// the diary question stays open after childNoteWaitMs (the record goes without it) and may be answered aloud; GameClock.holdFor(color);
// resume snapshot (RESUME_VERSION 2) + pendingOffer { ply, uci, childClockBefore, botClockBefore }; coachSaid {kind:'strategy'}
// carries model + billing; the child's move calls coach.stopSpeaking({ grace: true })
```
Shell (`app/`): the play route is `#/play?persona=&tc=&color=&coach=teacher|helper|exam` (a link without `coach=` reads `exam=1` as «Экзамен», otherwise «Подсказчик»; a style the time control does not offer is corrected); `Route['play']` carries `coachStyle` and the derived `examMode`. The wizard's step 3 asks «Как помогает Гамбитик?» (`CoachStylePicker`, tiles for `coachStylesFor(tc)`) and remembers the choice per time control in `localStorage['gambit.coachStyle'] = { [tc]: { style, at } }` for 30 days (choosing the stage default removes the entry).

### @gambit/content
`PERSONAS: Record<PersonaId, Persona>`, `PERSONA_ORDER: PersonaId[]`, `CURRICULUM: CurriculumStage[]`, `CONCEPT_CARDS: ConceptCard[]`, `getConceptCard(id)`, `THEME_TITLES_RU: Record<string,string>` (lichess theme key → kid-friendly Russian title), `COACH_SYSTEM_PROMPT_RU: string` (realtime voice persona + hard rules; one prompt for every coach style, with the «Можно назвать» rule), `REVIEW_PROMPT_RU: string`, `MASCOT: { name: 'Гамбитик'; catchphrases: string[] }`.

Strategies: `STRATEGIES: StrategyEntry[]` (24 engine-verified cards: 9 White; Black 6 vs 1.e4, 4 vs 1.d4, 5 systems vs any other first move, each with `answersUci` — the first moves it answers, verified by `strategies.engine.test.ts` on the real Stockfish WASM; every card has `planGoalsRu` — 2–4 «мы» goals the plan keeps after the opponent leaves the line; `OTHER_FIRST_MOVES_UCI`, `answersFirstMove()`; `StrategyEntry` = `StrategyCard` + `titleAccRu`, `mainLineSan` (both sides), `middlegameSan`), `getStrategy(id)`, `strategyGroupOf(uci)`, `getStrategiesFor(color, stage, opponentFirstUci?)`, `pickStrategyDeterministic(candidates, history, rng?)` (never one of the last `STRATEGY_NO_REPEAT = 3` while there is another), `STRATEGIST_PROMPT_RU` / `REPLAN_PROMPT_RU` + builders + strict schemas, `TEACHER_ADDENDUM_RU` (1–2 sentences, ≤ 25 words, «по нашему плану …», never the clock / colours / whose turn; part of `COACH_SYSTEM_PROMPT_RU`).

«Учитель»: `getRepertoirePlan(history, childColor): RepertoirePlan | undefined` (the repertoire as a plan at any stage — `inBook`, the child's next 2–4 model moves, the rest of the line), `PLAN_CHILD_MOVES = 4`, `MAIN_LINE_TABLE` / `MAIN_LINE_MOVES` / `mainLineMoves(fen)` (curated frequent moves of the first plies — the only basis of «так часто начинают»), `MAIN_LINE_EXPLORER_CHECKED: string | null` (a marker of a one-time manual check against the lichess explorer — no code reads it; the coach always says only «так часто начинают партию»).
### @gambit/openings
`lookupOpening(fen: string): { eco: string; name: string; nameRu?: string } | undefined`, `openingFromHistory(fens: string[]): …` (last hit wins).

## 4. Server

Hono on `127.0.0.1:8787`; routes exactly as listed at the bottom of `contracts.ts`. In production also serves `apps/web/dist` with SPA fallback.

- **Storage**: `data/app.sqlite` via built-in `node:sqlite` (`DatabaseSync`) behind a thin adapter. Tables: `game(id, started_at, ended_at, persona_id, time_control_id, child_color, result, termination, accuracy, blunders, exam_mode, excluded, record_json)`, `review(game_id, status, provider, markdown, updated_at)`, `puzzle_attempt(id, puzzle_id, solved, ms_spent, hints_used, themes, puzzle_rating, created_at)`, `kv(key, value)` (student profile JSON, rating history, `strategy-history`, `voice.choice`), `game_thought(game_id, item_id, source, question, text, said_at, created_at)`. Schema version 3; a server built for an older schema refuses it. `game.excluded` ('adult' | 'archived') leaves a game out of every progress number, profile.md, progress.json and the profile the voice / strategist / review see.
  Files are written atomically (tmp + rename):
  - `data/games/YYYY/MM/YYYY-MM-DD_HHMM_vs-<persona>.pgn` + `.md` (journal: header table incl. «ИИ в этой партии» and «В прогрессе ребёнка», move list with judgement icons, every take-back offer / hint / coach phrase / child utterance with timestamps — the model's own words marked «голосом», «расшифровки нет — могло не прозвучать» when no transcript came —, key moments, «Мысли после партии», review) + `.json` (machine twin `game-data/1`: record, excluded, review, thoughts — `tools/rebuild-db.ts` rebuilds a database from them into a NEW file);
  - `data/student/profile.md` (human + LLM readable), `data/student/progress.json`.
- **Puzzles**: reads `data/build/puzzles.sqlite` (schema below) if present, else `kb/puzzles-starter.json`. Converts raw Lichess rows to the `Puzzle` contract (apply first move with chess.js). Adaptive pick: rating window around the student's theme rating (start 600), avoid recently seen. Ratings: Glicko-2 (`glicko2-lite`).
  ```sql
  CREATE TABLE puzzle (id TEXT PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, popularity INTEGER, nb_plays INTEGER, themes TEXT NOT NULL);
  CREATE TABLE puzzle_theme (theme TEXT NOT NULL, rating INTEGER NOT NULL, puzzle_id TEXT NOT NULL, PRIMARY KEY (theme, rating, puzzle_id)) WITHOUT ROWID;
  ```
- **Runtime AI switch** (docs/TEACHING.md §4.4): `GAMBIT_RUNTIME_AI` (`config.runtimeAi`, default **off**) is applied in `loadConfig` AFTER the overrides merge (`withRuntimeAi`: off → `llmProvider 'template'`, `voicePreferred 'clips'`, `codexBin null`; the keys stay, so `/api/health` still reports them). Re-checked in `context.ts` (template-only chain, codex without a binary; injected test providers are left alone), `routes/voice.ts` (`/voice/live`, `/voice/session` → 503 `no-api-key`) and `routes/health.ts` (`ai: { runtime }`, `voice.live/realtime` false, `preferred 'clips'`, no `codex login status` spawn). The start-up log says `runtime AI: off`. Test fixtures default to off; tests of the paid paths pass `runtimeAi: true`.
- **LLM gateway** `llm/gateway.ts`: `generateJson<T>(task, prompt, jsonSchema)`; providers in order (`LLM_PROVIDER=auto`):
  1. `codex` (spawn official CLI, hardened: `codex exec --skip-git-repo-check --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --json --color never -m $CODEX_MODEL -c model_reasoning_effort="low" -c web_search="disabled" --output-schema <file> -C <empty tmp dir> -`, prompt on stdin, stdin closed, timeout + SIGKILL, child env is an ALLOW-LIST (PATH, HOME, USER, LANG, LC_*, CODEX_HOME …, nothing named *KEY/TOKEN/SECRET/PASSWORD*), feature hardening fails closed, usage-limit error → circuit breaker)
  2. `openrouter` (`/chat/completions`, strict json_schema, `provider: {data_collection:'deny', require_parameters:true}`, text only)
  3. `openai-api` (Responses API, only if key present)
  4. `template` (`buildTemplateReview`).

  Review prompts carry moves + engine judgements + the pseudonym, never the child's words (only a count; `REVIEW_INCLUDE_CHILD_SPEECH=1` opts API providers — never codex — into redacted snippets). Concurrency-1 job queue; reviews are generated in the background after `POST /games`. **Never read `~/.codex/auth.json`.** Do not run real `codex exec` calls in tests (they spend the ChatGPT subscription's weekly limit) — unit-test the wrapper with a fake binary.
- **Voice**: `POST /api/voice/session` (Realtime) mints an ephemeral secret via `POST https://api.openai.com/v1/realtime/client_secrets` with session config from research 03 (model/voice from env, `COACH_SYSTEM_PROMPT_RU`, semantic VAD eagerness low, far-field noise reduction, Russian input transcription). `POST /api/voice/live {sdp}` (Live) creates the session server-side (`POST /v1/live/sessions`, JSON: model, instructions = `COACH_SYSTEM_PROMPT_RU` + Live addendum + student brief, voice, `delegation:{type:'client'}`, data-channel allow-list, `store:false`, `transport:{type:'webrtc', sdp}`) and returns only the SDP answer.
  Both: 503 `{error:'no-api-key'}` without a key or for `X-Gambit-Automation`, 502 `{error:'voice-upstream', status}` (no upstream text), 429 `voice-rate-limited` above 10 session creations/minute. One retry after a network error or HTTP 500/502/503/504 when ≥ 2.5 s of the 8 s budget is left (never after a timeout, 4xx or 429); the 502 body carries `reason` (`net:<CODE>` | `timeout` | `http:<status>` | `nosdp` | `nosecret`), also logged to server.log and as a `page:'server'` line in `voice-diag.log` (`srv.live.fail` / `srv.live.retry` / `srv.rt.fail`).
  `GET|PUT /api/voice/voices` — the parent's voice pick (kv `voice.choice`, 22 gpt-live-1 built-ins, 10 also Realtime; an automated PUT stores nothing); both session routes accept an optional `voice` for the paid «Послушать» only. `POST /api/voice/diag` — the voice black box (strict zod, short Latin strings only, 2 MB with one rotation, never readable over HTTP; automated batches dropped). `POST/GET /api/voice/usage` keeps billed seconds per provider per day (shown on the parent page).
- **Health**: `GET /api/health` also reports `build { gitSha, startedAt, distBuiltAt }`, `activity { idleSeconds }` (seconds since the last non-health /api request — the launcher restarts an outdated server only after ≥ 600), `dataDirIsTemp` (voice-smoke refuses any other server) and `llm.codexPaused { reason: 'limit' | 'login' | 'failing' | 'slow', until }`; no paths, no keys.
- **Games and progress**: `GET /games?limit=&offset=` (all games, `excluded`), `GET /games/:id/journal` (that game's .md only, path from the database, inside data/games, no symlink), `PUT /games/:id/excluded`, `POST /student/reset-progress` (archives, deletes nothing, the stage is never lowered), `POST /games/:id/thoughts` (the child's words after the record: idempotent by item id, newest 3 games only — 409 `too-old`, ≤ 20 per request, ≤ 60 per game). `profile.conceptsIntroduced` is derived from the teach events of the games that count.
- **Reviews**: `GET /api/games/:id/review` includes `keyTakeaways`, `suggestedTheme`, `suggestedThemeTitle`. Failed / hinted puzzles are re-served by `GET /puzzles/next` when due (FSRS, `services/repetition.ts`).
- **Smart strategist of «Учитель»** (`strategist/`): `POST /api/coach/strategy` (StrategyRequest → GameStrategy, ≤ 8 s + 0.3 s) and `POST /api/coach/replan` (ReplanRequest → ReplanResponse, ≤ 15 s + 0.3 s; the `ply` is echoed, the game drops stale answers).
  The code computes the candidates — library cards for colour / stage / the opponent's first move minus the last `STRATEGY_NO_REPEAT` = 3 of the student's strategies OF THIS COLOUR (kv `strategy-history` `{ ids, sides, servedAt }`, the last 5 per colour, every served strategy counts; entries without sides count for both colours), or the engine's candidate moves the game sent (checked for legality) — the model may only CHOOSE (strict JSON schema enums) and phrase ≤ 20 / ≤ 15 words; the server re-validates (Latin, digits, clock / colour / whose-turn words, «лучший ход», squares nobody allowed) and falls through to the next provider, finally to the deterministic template.
  Chains (per task, `LLM_PROVIDER` still restricts them):
  - **strategy** (`STRATEGY_CODEX_FIRST`, default on): codex (`CODEX_STRATEGY_MODEL`, default `gpt-5.6-sol`, capped at `STRATEGY_CODEX_MS` = 7500 when an API could answer after it) → openrouter (`OPENROUTER_STRATEGY_MODEL`, default `openai/gpt-5.6-sol`) → openai-api (`OPENAI_STRATEGY_MODEL`) → template — the game's first line waits for it; a paid API is started only with ≥ 2.5 s left (`strategyApiMinMs`); a codex that timed out / failed on a strategy is asked AFTER the APIs for 30 min (`codexSlowPauseMs`); reasoning effort `none`, `low` only for the first provider when its measured latency fits 80 % of its cap (`reasoningEffortFor`); every answer records `provider`, `model`, `billing` ('subscription' | 'paid' | 'free'); `Strategist.codexPause()` feeds `/api/health llm.codexPaused`; a new game's strategy supersedes the last game's queued re-plans. `STRATEGY_CODEX_FIRST=0` uses the order openrouter → openai-api → codex (Sol takes ≈ 2.6–6 s via OpenRouter and ≈ 6–8.5 s via codex).
  - **re-plan**: codex (the ChatGPT subscription, 9 s of the 15 s, reasoning effort `none`) → openrouter → openai-api → template — background work.

  `X-Gambit-Automation` → template only, history untouched. The gateway has an `interactive` lane (in-game calls never wait behind a review), a shared deadline (`MIN_ATTEMPT_MS` = 400), «latest wins» (a superseded request skips every paid provider) and lane-scoped breakers (in-game timeouts / bad answers pause a provider for in-game calls only; usage limit / auth stay global). Logs: provider + latency only.
- **Security**: Host header allowlist (`127.0.0.1:8787`, `localhost:8787`; dev `localhost:5173` only outside `NODE_ENV=production`), Origin / Sec-Fetch-Site check on non-GET, every non-GET must be `Content-Type: application/json` (415 otherwise; one exception: the `text/plain` usage beacon of a closing page on `POST /api/voice/usage`, accepted only with an allow-listed Origin or `Sec-Fetch-Site: same-origin`), body size limits, zod validation of every body, strict Content-Security-Policy (header; the production bundle also carries it as a `<meta>`), data dir 0700 / files 0600, secrets masked in every log line.

## 5. Coach behaviour (summary of research 05 + 07 — details there)

**Three coach styles** (`CoachStyle`, docs/TEACHER-MODE.md — binding for the details): «Учитель» `teacher` (default in training, 10- and 5-minute games on stages 1–5, `TEACHER_DEFAULT_MAX_STAGE`), «Подсказчик» `helper` (everything below; default on stage 6+; its opening idea at any stage and in 5 minutes), «Экзамен» `exam` (silent until the end). Bullet: no choice, the coach only says hello (the wizard says so aloud).
- **«Учитель»** leads every move: ≤ 1.5 s after the bot's move (analysis prewarmed during the bot's pause) one `teachTurn` — one danger if there is one, 1–2 advised moves with arrows (green = main, blue = spare) and a kid-level «why» from `explainMove` tied to the game's strategy when it fits («По нашему плану — слон на цэ четыре: он смотрит на слабую точку эф семь.»), the opponent's move only when it matters (≤ 6 words) or «opponent first» as ONE sentence ≤ 20 words («Соперник вывел коня на цэ шесть — по плану отвечаем слоном на цэ четыре: …», only when his move, our answer and the reason fit); every advice sentence starts unlike the last two (`TeachOpener`), the brief's «Цель» names the start; off the strategy's line the plan goes on through its goals (`planGoalFor` / `planGoalDone` / `planGoalRu`), and «по плану» is said only for a move the code proves (line move, card theme, re-plan, a goal it serves) — never for a capture, tactic, rescue or check, and never beside a danger.
  **Brevity**: the game starts with ONE line naming this game's strategy and the first move («В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е четыре.»); every later remark is 1–2 sentences, ≤ 25 words; «Что выбираешь?» at most every 4th turn; never the clock, colours, whose turn or what is visible (the one exception: «Поторопись!» once under 30 s).
  **Variety**: each game of a colour a different strategy from the curated library (the student's per-colour history, the smart model's choice among the code's candidates). The strategy only adds a bonus / words to moves the engine already accepts.
  Truth only from the engine and code: an advised move is in MultiPV-3 within 30 cp (or proved by a `searchmoves` check), its «how common» words come only from its source (repertoire → «так обычно играют в этом дебюте», main-line table → «так часто начинают», named book position → «известный ход», engine → «я проверил»). The brief's «Можно назвать» line is the only list of the child's moves the model may say; no «лучший ход», no numbers.
- The child's move gets a verdict: followed / own good / fine are folded into the next turn (own good moves are praised), a weaker move gets an honest `teachReaction` while the bot waits, a real find is praised, a bad blunder still gets the take-back offer (same `decideIntervention`) whose brief names the loss, the opponent's reply and the earlier advice. A «сокровище» (a mate / a real win on stages 1–4) is first a riddle without an arrow and revealed after 10 s (15 s on stages 3–4) or on «Совет».
- In 10- and 5-minute games the child's clock stands from the bot's move until the teacher's words end (≤ 20 s per phrase). In every style the CHILD's clock (only his — `GameClock.holdFor(childColor)`, 25 s safety per hold; the bot never waits for words) also stands during any app phrase and while the conversational voice is `coachSpeaking` or `thinking`; it runs while the child himself speaks. Bullet never holds. «Совет» (panel + dock) repeats the advice; the hint ladder, the threat warning, the thinking routine, the opening idea and the silence nudge are off. Talkativeness sets the length (quiet = always short), not whether the teacher speaks. Automated runs stay silent and free.

- Classification on lichess win% loss (mover POV): best (engine's first choice or loss <1), excellent <2, good <5, inaccuracy <10, mistake <20, blunder ≥20; `missedWin` when a forced mate / ≥+5 advantage was available and the move keeps less than +2. Mate rules as in lila.
- Take-back offer requires ALL of: coachMode≠off, not examMode, `confidence==='confirmed'`, winPctLoss ≥ threshold (stage 1–3: 20, stage 4–6: 15, stage 7+: 12), **explainable** (materialLossPawns ≥ 2 or a mate within 3 or a recognised `allowedMotif`), the position was not already lost (winPctBefore ≥ 15), budget left (`TAKEBACK_BUDGET` full: 3, light: 3), ≥ 4 plies since the last offer (skipped once per position when the child took a move back and then played ANOTHER losing move there: `decideIntervention(j, ctx, { retryAfterTakeback: true })`, «И этот ход теряет …»; the same move again = `insisted`, no offer), remainingMs null or > 30 s. Otherwise `logForReview`. A pending offer survives a reload (resume snapshot `pendingOffer`).
- Hint ladder 1→4 on the «Подсказка» button (and in take-back flow). Level 4 draws the green arrow. Hints used are journaled and reduce stars for the game, never punish.
- Praise: only for `best`/`excellent` moves that were non-obvious (a motif was found or only-move) — at most every ~6 plies; priority 1 for a real tactic / mate, 0 otherwise.
- Threat warning (priority 1): after the BOT's move, 4 s later, when a new danger appears — a hanging piece (SEE ≥ 200 cp) or an engine null-move threat (mate within 3 or ≥ 2 pawns) / static mate-in-1; never in exams or bullet, ≥ 4 plies apart, not within 2 plies of a take-back offer, never twice about the same danger.
- Talkativeness of the conversational coach (setting, default «Обычно»): «Тихо» = only priority 2 (take-back offer, game end, hints) + answers to the child; «Обычно» = priority ≥ 1 (game start/end, threats, real finds); «Болтливо» = everything. Outside «Учитель» the coach never narrates every move; the silent context notes after each move are for the model's memory only. In «Учитель» the teacher's phrases always pass (only their length follows the setting).
- The long-silence nudge: see §3 «Conversation lifecycle».
- Thinking routine reminder «Что хочет соперник? Что могу я — шахи, взятия, угрозы? Безопасно ли?» at game start on early stages and after a declined take-back that got punished.
- Clock is paused (reason-counted) whenever the coach speaks with `pauseClock`, with a 25 s auto-resume safety timeout.

## 6. Design direction (research 08)

Playful but calm: warm cream background, deep teal + sunny yellow accents, rounded 20 px cards, Nunito Variable, board in soft green/cream, big 56 px+ buttons, minimal text. Mascot «Гамбитик» — a foal chess knight, peer-mentor, speaks in short energetic sentences. One voice in the app (the mascot); bots speak in text bubbles only. Rewards: stars for effort, no streak-loss, no currency.

## Pedagogy (research 05)

- **Curriculum**: 10 stages, from «не зеваю фигуры» to «план и профилактика». The skeleton is the Dutch Steps Method; the habits come from the Soviet school — endgames early, reviewing one's own games, «сначала реши — потом смотри» (decide first, then look). Stage transitions use criteria the app can measure: theme puzzle ratings, blunder rate, accuracy.
- **Thinking ritual** the mascot teaches: «Что хочет соперник? → Что могу я (шахи, взятия, угрозы)? → Безопасно ли?»
- **Session** of 25–35 minutes: puzzle warm-up → mini-lesson → game with the coach → review of 1–2 moments → one sentence in the diary.
- **Dosed interventions**: take-back ≤ 3 per game, «Оставлю свой ход» is always available, «Экзамен» plays without hints; praise the process, not talent.
- **Honest limit**: the app gives a strong base and daily practice; no system guarantees a grandmaster, and from ~1600–2000 a live coach and tournaments are needed.

## Stack rationale

| Layer | Choice | Why |
|---|---|---|
| Board | `react-chessboard@5.12.1` (MIT) behind our own `<TrainerBoard>` | arrows / highlights as props, React 19, permissive licence (chessground is GPL) |
| Rules | `chess.js@1.4.0` (BSD-2) | `undo()`, FEN before / after a move; it loses PGN variations, so our own event journal is the source of truth |
| Engine | `stockfish@19.0.0`, `lite-single` build (WASM ≈ 1.8 MB) in two Web Workers: «bot» and «judge» | needs no COOP/COEP headers; depth 12 × MultiPV 3 ≈ 0.1 s |
| Bot ladder | own sampler: `go depth D` + MultiPV K + softmax over the eval loss + a random-move probability | Stockfish's `UCI_Elo` does not go below 1320, and the child must be able to win |
| Front end | Vite + React 19 + TypeScript + Zustand | standard, fast |
| Server | Hono on Node 26 running `.ts` natively, `127.0.0.1` only | holds the keys, mints ephemeral voice tokens, runs `codex exec`, writes files |
| Storage | built-in `node:sqlite` + PGN / Markdown / JSON files in `data/` | the parent (and an LLM) read the markdown; a damaged database is set aside and recreated; the `.json` twins can rebuild it |
| Puzzles | Lichess puzzle DB (CC0) → filtered kid-level subset → SQLite | legal to ship, with themes and ratings |
| Ratings / repetition | Glicko-2 (`glicko2-lite`) per theme; FSRS (`ts-fsrs`) for puzzles failed or solved with a hint | as on Lichess |
| Mascot | layered inline SVG + CSS animations, mouth driven by the audio level | built in code, no designer needed |
| Font / sounds | Nunito Variable (OFL, Cyrillic); sounds synthesised in the browser (WebAudio) | free licence, no third-party sound files |
