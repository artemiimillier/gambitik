# «Записи» voice mode: specification (Giselle, pre-recorded clips)

«Записи» is the voice mode in which Гамбитик speaks with pre-recorded takes of one voice, without a microphone and
without any model at runtime. This document is the design; the other files of this folder go into more depth:
`architecture.md` (the clip layer), `web-layer.md` (the browser modules), `demo-format.md` (the demo replay file),
`ONDEMAND.md` («Дозапись голоса», recording a missing phrase on first use). Where this spec and `architecture.md`
differ, this spec is authoritative (format MP3 instead of AAC, gap table, unit model). A short Russian summary is at
the end.

**The lesson model** (`../TEACHING.md`) never names a square: its utterances say the piece and the idea, the board
shows where. Its words come from the lesson library of `packages/content/src/teaching/` (≈ 3000 wordings). «Записи»
plays a lesson utterance from whole recorded units by their exact keys (`packages/core/src/coach/clips/lessonPlan.ts`):
the utterance is voiced whole or not at all, and one with an unrecorded part is shown in the bubble only
(«не озвучено») until it is recorded (the static library or «Дозапись голоса», `ONDEMAND.md`). The move slots of §3.2
serve the catalogue families that name a move.

Voice: Higgsfield `text2speech_v2`, `--variant minimax --voice_type preset --voice_id 9d3128b8-dd25-5158-9bdb-2e69ac8998b9`
(«Giselle»; a reference sample `24-Giselle-minimax.mp3` lives in a local listening folder, git-ignored). voiceKey:
**`giselle-mm1`**.

---

## 0. Design summary

### 0.1 Why this shape

Three shapes were weighed: **fragments** (cut today's `event.text` at pauses and splice), **sentences** (a cache of
whole sentences plus generation on a miss) and **hybrid** (a closed catalogue plus one typed move slot per sentence).
The hybrid is used:

| Criterion | Hybrid |
|---|---|
| Naturalness | whole sentences, heads and tails; the only seam is at a real `—`/`:` pause around one move phrase |
| Chess-fact correctness | slots are typed keys built from chess.js SAN; lint + ASR gates |
| Cost per game | zero; filling gaps is an operator-side batch (§6.3) |
| Latency | everything local, ≤ 20 ms fetch + decode |
| Main risk | effort of the clip twins; the split-fallback prosody (§6.1 L2) |

### 0.2 Decision

The catalogue is closed *by construction*: in clip mode the core builders emit a structured `ClipUtterance`
(catalogue line ids + at most one typed slot per sentence) instead of free text, so every utterance the game can
produce is recordable, testable in CI, and correct about pieces and squares.

Elements taken from the other two shapes:

| From | Idea | Where in this spec |
|---|---|---|
| fragments | Text compiler `compileText()` (pause-bounded segmentation of `event.text`) as the bridge for families without clip twins, with its hard rule «a slot is never voiced without the fragment carrying its piece; nothing before a slot is ever dropped» | §3.4, §6 |
| fragments | The measured gap table | §5.3 |
| fragments | Holdout coverage method (rank on most of the harvest, test on held-out games) for every tier estimate and the CI gate | §4, §11 |
| fragments | Take rotation with no repeat in the last 10 plays; cross-game memory for greeting/start/end; `!` and `.` takes of praise | §7 |
| fragments | Probe questions (slot pause, `atempo`, «я готов» in a female voice, «е два» pronunciation) | §9 |
| sentences | **Piece-only wording** for opponent, danger and treasure lines («Соперник вывел коня.», «Твой конь под боем!») — the board already highlights the square; this shrinks the slot domain and can never give away a gift square | §3.2 |
| sentences | **Cache-aware choice** among equivalent wordings: prefer one that is recorded | §3.5 |
| sentences | Prewarm/decode windows (colour tap, bot thinking, child thinking) | §5.4 |
| sentences | Server safety rules for recording on the server (re-parse, never trust client ids, automation header ⇒ refused, caps) | §6.3 |
| sentences | Opt-in child-name clips behind the parental lock; measured liveliness test | §7, §11 |

**Not used:** synthesis inside an utterance during a game (a job takes ≈ 4 s, the teacher deadline is 1.5 s) — a
missing phrase is shown in the bubble and, where «Дозапись голоса» is enabled, recorded for later plays
(`ONDEMAND.md`); word-level seams (+15…+18 st jumps measured, §10.1); AAC (MP3 gapless behaviour is the one
measured); mixing a second voice inside a sentence.

---

## 1. Goals

1. **Free for the child.** Speech is recorded once and reused; a game needs no network (a home install runs fully
   offline). Recording costs are operator-side and capped (§6.3, `ONDEMAND.md`).
2. **No microphone.** No permission prompt, echo guard, headphone note or mic help. No child audio leaves the device.
3. **Lively, dynamic, speaks well.** Real expressive Giselle takes, many wordings for frequent lines, multiple takes,
   interjections («Ого!», «Ой-ой!»), human timing, short lines. Target: a line heard ≥ 3×/game has ≥ 12 distinct clips.
4. **Correct by construction.** Only engine-grounded template content is voiced. Pieces and squares come from SAN/FEN,
   never from text. The faults of a generative voice (a wrong piece such as «слон на аш три» for a pawn, invented
   «Соперник ничего не меняет», gift moves given away, odd greeting words) cannot occur.
5. **Clock-exact.** The child's clock is held exactly while Гамбитик is audible.
6. **Separate from the live voice.** `sessionVoice.ts`, `liveVoice.ts`, `realtimeVoice.ts` and the conversation logic
   in `coachController.ts` are independent of the clip layer; the OpenAI live mode is a separate optional paid mode.
7. **Automation silent and free.** Under `automationSilenced()` the factory returns the silent layer; tools never
   play audio and never spend without `--spend --budget N` and the operator's explicit OK.

## 2. Non-goals

- Free-form questions from the child (needs a mic + model → paid live mode only).
- Voicing the Codex strategist's free text (`introRu`/`planRu`/`whyRu`), briefs, model answers, persona bubble lines,
  mic-only lines (conversation hello, silence nudge, mic help, voice limit) and the answers the live model gives to the
  child's questions. In clip mode the library's own intros/goals/steps are spoken instead; free text stays in the
  bubble only.
- Child names by default (opt-in only, §7.6).
- Speaking disambiguation («конь с бэ один…»): the arrow shows which piece moves.
- Synthesis inside an utterance during a game; browser TTS inside an utterance.
- Transcribing the child (no `webkitSpeechRecognition`: it sends audio to Google).
- Opus: MP3 is the format; Opus with MP3 as the `canPlayType` fallback is an option for the public site.

---

## 3. Unit model and core changes (`packages/core/src/coach/clips/`)

### 3.1 Sentence grammar (the only shapes the planner may build)

| Shape | Example (clips separated by ·) | Seams |
|---|---|---|
| W | «Найдёшь ход сам?» | 0 |
| H·S | «Мой совет —» · «конём на эф шесть.» | 1 |
| S·T | «Конём на эф шесть» · «— так мы давим на центр.» | 1 |
| H·S·T | «Попробуй так:» · «слоном на цэ четыре» · «— нападаешь на коня!» | 2 |
| split S (fallback L2) | «Попробуй так:» · «конём» · «— на эф шесть!» | 2 |

Limits: ≤ 1 slot and ≤ 3 clips per sentence; ≤ 2 sentences per utterance (+ optional bark in front).
Seams exist **only** at `—`, `:`, sentence end — never inside a phrase and never between words.

### 3.2 Slots (typed keys, never text)

| Key | Example | Used for |
|---|---|---|
| `ins:<p>:<sq>` | «конём на эф шесть» | advice («Мой совет —», «Ходи»), reveal, level-4 hint; non-captures |
| `nom:<p>:<sq>` | «конь на эф шесть» | advice after «Мой совет —», «Сильнее было так:», post-game review |
| `cap:<p>:<sq>` | «конь бьёт на дэ пять» | captures in advice/reveal |
| split set | «на X» ×64, «бьёт на X» ×64, 6 ins heads («конём», «пешкой»…), 6 nom heads | L2 fallback; ships in every tier |

- Opponent moves, dangers, threats and treasures are **piece-only** in clip mode
  («Соперник вывел коня.», «Осторожно!» · «Твой конь под боем!», «Смотри, тут подарок!» · «Можно забрать ферзя!»).
  The square is highlighted on the board. A treasure's square is voiced only in `buildTeachReveal` (after
  `treasureRevealMs`), so `reveal: 'later'` holds by construction. Squares are spoken only in the advice move and the
  reveal.
- Castling and promotion are whole lines («Делай короткую рокировку!»; «пешка на е восемь» · «— и станет ферзём!»).
  Check/mate are tails («— шах!», «— и это мат!»).
- Every slot unit is recorded with a final fall (fits both before `—` and at a sentence end: 179–186 Hz measured vs
  184 Hz natural).
- `slotKeyOf(san, fen, form)` in `keys.ts` works on chess.js-verified SAN. `canonicalSlotText(key)` =
  `pieceNameRu` + `squareToSpokenRu` (`FILE_SPOKEN`/`RANK_SPOKEN` exported from `spoken.ts`).

### 3.3 Types

```ts
// packages/shared/src/contracts.ts
type ClipLineId = string;                  // catalogue id, e.g. 'teach.head.advice'
type ClipItem =
  | { line: ClipLineId; piece?: PieceType; g?: 'm' | 'f' }       // piece → enum-keyed variant, never free text
  | { slot: 'nom' | 'cap' | 'ins'; san: string; fen: string };
interface ClipSentence { items: ClipItem[]; prio: number; end: '.' | '!' | '?' }
interface ClipUtterance { sentences: ClipSentence[]; bark?: Pose; generic: ClipLineId; moment?: string }
```

```ts
// packages/core/src/coach/clips/catalog.teach.ru.ts / catalog.game.ru.ts
{ id: 'teach.head.advice', role: 'head', join: '—', freq: 4.1, fallback: 'teach.head.arrow',
  wordings: [{ t: 'Мой совет —' }, { t: 'Попробуй так:' }, { t: 'Смотри, что можно:', mood: 'calm' }] }
{ id: 'reason.attack', role: 'tail', byPiece: true, wordings: [{ t: '— нападаешь на {коня}!' }] } // ×5 at script time
```

The catalogue lives in `packages/core/src/coach/clips/catalog.ru.ts` (+ `catalog.teach.ru.ts` for the teacher turn,
`catalog.game.ru.ts` for greeting, start, strategy intros, praise, take-backs, game end, generics, barks, «Спроси»
answers and thought-chip replies): ≈ 300 lines, ≈ 1150 wordings, `lintCatalog` clean. It is in @gambit/core, not
@gambit/content, because the twins must know which lines exist and how long they are. `CLIP_TAP_LINES` lists what the
web layer says on taps; the tools force those lines into the Starter tier.

### 3.4 Two routes from event to clips

1. **Clip twins (primary).** Builders have twins with the same parts and `prio`: `teachTurnClip(plan)` next to
   `teachTurnText` (`teacher.ts`), etc. Builders always attach a validated `CoachEvent.clip`. Twins exist for
   teachTurn, reveal, repeat, replan follow-up, greeting, game hello/start (all 24 strategies)/resumed, praise,
   take-back offers and replies, gameEnd, «Почему так?» (`buildTeachWhy`) and the take-back question
   (`buildTakebackQuestion`).
2. **Text compiler (bridge).** For families without a twin, `compileText(event.text)` (`clips/compile.ts`, same
   function in browser and tools): strip names; split at `. ! ? …`; split at `— : ;`; find square slots with a regex
   from `FILE_SPOKEN`/`RANK_SPOKEN`; merge a lone piece word left; key = `f:<norm>|<end>`; resolve each fragment by
   **exact** match in the manifest (no fuzzy lookup). A slot found by text is voiced only if its fragment with the
   piece word is also recorded, and the square must equal the SAN target when one is known
   (`event.teach.advice[0].san` / hint L4); otherwise that sentence falls down the ladder. The hint ladder, threat
   warnings, explainBest, teachReaction, thinkingRoutine, review, puzzles and shell go this way; the hint ladder and
   «weaker than the advice» reactions mostly fall to generic lines (their sentences name squares that are not the
   advice).

### 3.5 Other core rules

- No `Voice.clip` flag and no `pick(…, clipReady)` in the builders: every builder attaches its `CoachEvent.clip`, so the
  web needs no flag. The preference for recorded wordings lives in the lesson book (`lesson/book.ts`, rule P(3) of
  `ONDEMAND.md`) and in the planner's L1 step (§6.1).
- Clip-mode limits (`plan.ts`): teacher ≤ 2 sentences / 18 words / 12 s; short style and `blitz5` ≤ 1 sentence /
  10 words / 7 s; other events ≤ 2 sentences / 9 s. Over the cap, drop sentences with `prio < 100`, then tails.
- Self-references are **masculine**: Гамбитик is a boy even in Giselle's voice, so clip wordings use masculine
  self-reference («я готов», «я заметил», «я рад»); the lint rejects feminine self-reference («я заметила», «Рада тебя
  видеть»). The child's gender stays a placeholder (`{g:сам|сама}`).
- Wording rules that recordings freeze: a treasure line uses the accusative («ферзя»); a nominative move always
  follows a colon («Сильнее было так:» · slot, never «Сильнее было конь бьёт на …»); «Смотри: мой совет…»; the bubble
  never capitalises notation. «Соперник сделал рокировку — отвечаем…» without a reason is not confirmed fixed.

### 3.6 Contracts (`packages/shared/src/contracts.ts`, additive)

```ts
readonly kind: 'browser-tts' | 'openai-realtime' | 'openai-live' | 'silent' | 'clips';
speakEvent?(event: CoachEvent, opts?: { interrupt?: boolean }): Promise<void>;
// CoachEvent
clip?: ClipUtterance;
```

`apps/web/src/coach/voiceTypes.ts` → `ClipExtras`: `msToSentenceEnd()`, `endAfterSentence()`, `replayLast()`,
`onPlan(cb)` (heard text for the bubble + black box).

---

## 4. Library structure, manifest, sizes

### 4.1 Layout

```
apps/web/public/voice/index.json                              {"default":"giselle-mm1","voices":{"giselle-mm1":"giselle-mm1/manifest.<hash>.json"}}
apps/web/public/voice/giselle-mm1/manifest.<hash>.json        immutable, cached forever
apps/web/public/voice/giselle-mm1/<id[1..2]>/<id>.mp3         one file per take; MP3 CBR 48 kbps, mono, 32 kHz (≈ 5.9 KB/s)
apps/web/public/voice/demo/<seed>.json                        demo replay files (demo-format.md)
tools/voice-clips/script.giselle-mm1.json                     committed: units with recipe, prompt, tier, priority, batch
tools/voice-clips/ledger.giselle-mm1.jsonl                    local, git-ignored: one line per job, written BEFORE waiting
tools/voice-clips/review.giselle-mm1.json                     committed: listener verdicts {"<id>":{"verdict":"ok|redo|reject","note":""}}
tools/voice-clips/.masters/                                   gitignored raw 128k masters (downloaded immediately; CDN URLs expire)
<VOICE_OVERLAY_DIR>/                                          outside the repo: on-demand recordings, their manifest and ledger (ONDEMAND.md)
```

Clips never go into `data/` (that is the child's runtime data). Processed MP3s are paid assets and are committed
(Starter ≈ 11 MB, Full ≈ 48 MB; tools warn above 60 MB). Served by Vite in dev and by Hono `serveStatic` from `dist`.

### 4.2 Manifest (v1)

```json
{ "v": 1, "voiceKey": "giselle-mm1", "libraryVersion": 1,
  "voice": {"provider":"higgsfield","model":"text2speech_v2","variant":"minimax","voiceType":"preset","voiceId":"9d3128b8-dd25-5158-9bdb-2e69ac8998b9"},
  "codec": {"c":"mp3","kbps":48,"hz":32000,"ch":1}, "loudness": {"lufs":-18,"truePeak":-1.5},
  "units": {
    "c3f0a91b2c4d5": {"key":"line:teach.head.advice#1","text":"Попробуй так:","take":1,"ms":820,"on":30,"off":790,
                      "file":"c3/c3f0a91b2c4d5.mp3","mood":"calm","qa":"ear","sylps":4.2,"tier":"starter"},
    "c91a0b7e44f10": {"key":"slot:ins:n:f6","text":"конём на эф шесть","take":1,"ms":1010,"on":34,"off":990,
                      "file":"c9/c91a0b7e44f10.mp3","qa":"asr","tier":"pilot"},
    "c55e0d1a9b3f2": {"key":"frag:f:смотри, тут подарок|!","text":"Смотри, тут подарок!","take":2,"ms":1180,
                      "file":"c5/c55e0d1a9b3f2.mp3","qa":"ok","tier":"starter"} },
  "pools": {"teach.head.advice":["c3f0a91b2c4d5","…"],"bark.cheer":["…"],"generic.teachTurn":["…"]},
  "keys":  {"slot:ins:n:f6":["c91a0b7e44f10"],"frag:f:смотри, тут подарок|!":["c55e0d1a9b3f2","…"]} }
```

- id = `c` + cyrb53(voiceKey + `\n` + prompt + `\n` + cutIndex), 13 hex chars; identical in Node and browser;
  changes only when a new recording is paid for. Hex ids pass `voiceDiag` `DIAG_STRING_RE`.
- The manifest also carries `fallbacks` (catalogue L3 siblings) and `interj` (takes that begin with an interjection),
  and publishes only **checked** takes (`isPublishable`: qa `asr` without a failed transcript, or a listener's `ok`).
- ≈ 150 B per unit; Full ≈ 90 KB gzipped.

### 4.3 Tiers (`pnpm voice:plan` recomputes them for free from the harvest)

Pricing (measured, §10.1): credits = Σ jobs 0.15 × ⌈chars/50⌉; `<#0.6#>` counts as 7 chars; batched ≈ 0.003 cr/char.

| # | Family | Starter units / cr | Full units / cr |
|---|---|---|---|
| 1 | Split slot set (64 «на X» + 64 «бьёт на X» + 12 heads) | 140 / 10 | 140 / 10 |
| 2 | Whole move units `ins`/`nom`/`cap` by harvest rank (advice only, thanks to piece-only lines) | 120 / 10 | 650 / 54 |
| 3 | Teacher heads (openers, advice, deviation, choice, reveal, «Совет», weaker-move reactions) | 115 / 15 | 260 / 34 |
| 4 | Reason tails (41 ideas, plain wording, ×5 piece variants where needed) | 80 / 11 | 220 / 31 |
| 5 | Piece-only opponent/danger/treasure lines (6 pieces × forms × ≥ 4 wordings) | 60 / 6 | 120 / 12 |
| 6 | Strategy intros (24, first move included) + plan goals | 24+40 / 12.7 | 25+245 / 42 |
| 7 | Praise, take-back, hurry, game start/end, greeting (gendered forms doubled) | 100 / 14 | 300 / 42 |
| 8 | Generic pools (≥ 4 per `CoachEventKind`/moment), «Спроси» answers, thought-chip replies | 45 / 6.3 | 120 / 17 |
| 9 | Barks by pose | 30 / 1.5 | 60 / 3 |
| 10 | «Подсказчик»/«Экзамен»: hint ladder, threat warnings, explain-best | — | 250 / 35 |
| 11 | Shell: wizard, puzzles, review, curriculum hello, break nudge | — | 180 / 25 |
| 12 | Opening names, concept/opening cards, 2nd–3rd takes of the top 80 | — | 232 / 50 |
| | **Total** (+10 % re-render reserve) | **≈ 750 units, ≈ 95 cr** (86.5 + 8.5 reserve) | **≈ 2,800 units, ≈ 390 cr** |

- The `pilot` tier (§9) is the starter clip set that covers the demo game; its 117 demo clips are Starter clips.
- Audio: Starter ≈ 30 min / ≈ 11 MB; Full ≈ 2.2 h / ≈ 48 MB MP3 (≈ 25 MB as Opus). Full generation ≈ 700 jobs.
- Runtime cost per game: **0**, for any number of children.
- Coverage targets (gate, §11): Starter ≥ 97 % of «Учитель» utterances voiced without L5 generic; 100 % of move
  mentions voiced (whole unit or split); split ≤ 15 %. Full ≥ 97 % across all modes.
- Measured by `pnpm voice:plan` / `voice:cost` on a 480-game harvest (120 held-out games):

  | Tier | Jobs | Takes | Credits | «Учитель» turns without L5 | fully voiced | split |
  |---|---|---|---|---|---|---|
  | pilot | 75 | 137 | 13.5 | 23.7 % (demo game: 29/29 at L1–L2) | 8.3 % | 44 % |
  | + starter | 374 | 809 | +84 | 100 % | 74.2 % | 37.7 % |
  | + full | 656 | 1714 | +172.5 | 100 % | 100 % | 0 % |

  The starter always carries every tap line and ≥ 4 wordings of every generic line, so at 84 credits the split share
  is 37.7 % (≈ 97 credits → ≈ 24 %, ≈ 110 → ≤ 15 %); the CI gate allows < 45 %.

---

## 5. Runtime player and integration points

### 5.1 Flow

```
builder ─► CoachEvent.clip ─► gameStore.sayEvent (holds clock) ─► coachController queue
  ─► play(): layer.speakEvent ? layer.speakEvent(event,{interrupt}) : layer.speak(event.text,…)
  ─► clipVoice.speakEvent: planClips(event.clip ?? compileText(event.text), manifest, {recency, blitz, pose}) ≤ 2 ms
  ─► clipLibrary.ensure(ids): memory hit | local fetch ≤ 20 ms + decode ≈ 5 ms/clip
  ─► clipPlayer.schedule(AudioBufferSourceNode.start(when, trimStart, dur), gaps) ─► onPlan(heard text → bubble, black box)
  ─► speaking(true) at when + outputLatency … resolve at last onended + outputLatency | stop() | watchdog plan.ms + 1.5 s
```

A lesson utterance goes through `planLessonClips` (`clips/lessonPlan.ts`) instead of `planClips`: exact unit keys, no
generic line, no sentence caps (see the note at the top).

### 5.2 Files

| File | Role |
|---|---|
| `packages/shared/src/contracts.ts` | §3.3 types, §3.6 fields |
| `packages/core/src/coach/clips/{types,keys,plan,compile,lint,catalog*,twins,lessonPlan,lines,tts}.ts` | pure, shared by browser and tools |
| `packages/core/src/coach/teacher.ts`, `events.ts`, `moveIdeas.ts`, `spoken.ts` | clip twins; piece-only wordings; spoken tables |
| `apps/web/src/coach/clips/{clipAudio,clipLibrary,clipPlayer,clipVoice}.ts` | the layer (`kind: 'clips'`) |
| `apps/web/src/coach/coachController.ts` | factory: `'clips'` → `['clips','silent']` (browser-tts only if the parent picks it); `play()` prefers `speakEvent`; talkativeness applies |
| `apps/web/src/coach/settings.ts` | `VoicePreference` includes `'clips'` |
| `apps/web/src/coach/voiceTypes.ts` | `ClipExtras` |
| `apps/web/src/coach/voiceDiag.ts` | `clip.plan {src, units, slots, split, planMs}`, `clip.miss`, `clip.mismatch`, `clip.long` |
| `apps/web/src/coach/MascotDock.tsx` | «Спроси» chips, tap-to-stop (§8) |
| `apps/web/src/features/game/gameStore.ts` | no hold changes; chips route through `sayEvent` |
| `apps/web/src/features/game/thoughts.ts` + result card in `GameScreen.tsx` | tap thoughts (§8.3) |

The miss log is local (`gambit.clipMisses`); there is no server route for it.

### 5.3 Timing (measured gap table)

| Boundary | Gap |
|---|---|
| `.` / `!` | 450 ms |
| `?` | 500 ms |
| `—` | 280 ms |
| `:` | 240 ms |
| `;` | 260 ms |
| split-form dash | 250 ms |
| bark → line | 200 ms |

±30 ms jitter; ×0.75 in `blitz5`; no crossfades; 5 ms raised-cosine fades; `playbackRate` always 1; onset/offset
from the manifest (`on`/`off`), re-verified by scanning decoded samples at −55 dBFS (MP3 priming 34.5 ms).
`AudioContext({ sampleRate: 32000 })` where supported. Gesture unlock as in `gestureGate.ts`.
The gaps follow the pauses measured in whole Giselle takes (`—` 280–300 ms, between sentences 300–710 ms); a seam at
such a pause measured +2.6…+4.5 semitones against a natural +7.2, so it hides inside normal prosody (§10.1).

### 5.4 Preload / prewarm (decode only — never generate)

| Window | Action |
|---|---|
| App start / Settings | load `index.json` + manifest; decode the hot set (barks, generics, split set, top 50 moves, priority-2 lines, greeting/start/end; ≈ 2.5 MB compressed) in idle time |
| Colour tap / bot's first move (strategy known 2.6–8 s ahead) | decode the strategy intro, first-move line, goals |
| `botTurn` after `prewarm(fen, uci)` | decode `ins`/`nom` units of MultiPV-3 candidates (≤ 6) |
| `showTeach` → child thinking | decode reveal, repeat, hint-L4 units |
| Game end | decode the gameEnd pool |

Decoded LRU ≤ 60 s of audio. The API is `coach.prewarmClips({ moves, events, pools })`; the game-side calls for the
windows after app start are not wired.

### 5.5 Clock holds and stops

- `speaking` = audible interval (`outputLatency` included), so `sayEvent`/`holdTeach`/`clock.holdFor` follow real
  sound with no `gameStore` change. Barks and inner gaps count as speech. `plan.ms` is known before the first sample;
  teacher plans ≤ 12 s (≤ 7 s blitz) < `teachHoldMaxMs` 20 s; longer ⇒ `clip.long`.
- Child moves mid-line: if `msToSentenceEnd() ≤ stopGraceMs` (2 s) the sentence finishes, else 25 ms fade.
- Priority 2 (mate threat, «Стоп!», take-back offer) cuts in with `stop()`; its clips are in the hot set.
- Watchdog `plan.ms + 1.5 s`; suspended context ⇒ silent timing, never a hang; autoplay blocked ⇒ `needsUserGesture`,
  queue held ≤ 45 s.

---

## 6. Missing-clip policy

### 6.1 Ladder (per sentence; no level ever mixes voices inside a sentence; nothing generated inside an utterance)

| Level | Missing | Action |
|---|---|---|
| L1 | a wording or take | another wording/take from the same pool |
| L2 | whole move unit | split form «Конём — на эф шесть!» (split set ships in every tier) |
| L3 | a line with a `fallback` sibling | sibling (`reason.fork#n` → `reason.fork`); else drop the tail if `prio < 100` |
| L3b | text-compiled sentence (bridge route) | trim after the slot when only later units miss; never drop anything before a slot; never voice a slot without its piece fragment |
| L4 | optional sentence (index > 0 / `prio < 100`) | drop it |
| L5 | core sentence | recorded generic line for `(kind, moment, pose)`, e.g. «Смотри на зелёную стрелку!» — never names a move; bubble and arrows keep the exact content |
| L6 | library not loaded | silent timing + bubble (browser TTS only if the parent chose it); parent status line says why |

The planner looks for recordings of every sentence before it applies the length limit, so an optional sentence that a
5-minute game would drop anyway is logged as L4 («фраза выпала» in the demo log) when it is not recorded. A split move
(L2) keeps the head and drops the reason tail when the sentence would exceed three clips.

### 6.2 Runtime guards

- SAN guard: the planned move slot must equal `event.teach.advice[0].san` (or the reveal / hint-L4 move); mismatch ⇒
  L5 + `clip.mismatch`.
- Every L2–L6 appends `(unitKey, kind, count)` to the local miss log (`gambit.clipMisses`).

### 6.3 Filling gaps (operator side, never per child)

- **Static library:** a larger tier (`pnpm voice:plan --tier …` → `voice:generate --jobs … --budget N --spend`) or the
  whole library in advance (`voice:library-plan`, `voice:library-run --spend --budget N`), each with the operator's
  explicit OK, then the free `process` / `verify` / `review` steps.
- **«Дозапись голоса» (home server only, off by default, the parent's switch in Settings):** a phrase that is not
  recorded is shown in the bubble and recorded once for later plays, under a total and a daily budget
  (`ONDEMAND.md`). The server renders the text from catalogue/lesson ids itself, never trusts client text, refuses
  under `X-Gambit-Automation: 1` and with a temporary data dir, and runs the CLI via `execFile` (no shell). The
  public server never records.

---

## 7. Variety and naturalness («запрограммированно, неживо» must not happen)

1. **Pool size follows frequency** (harvest): ≥ 1×/game ⇒ ≥ 4 wordings; ≥ 3×/game ⇒ ≥ 6 wordings × 2 takes.
   «Смотри, тут подарок» (6.5/game), «Осторожно» (6.0), «Найдёшь ход сам/сама?» (6.2) each get ≥ 12 clips.
2. **Head × slot × tail** combinations: a teacher turn is a fresh combination nearly every time.
3. **Takes**: minimax varies a lot between takes (3.11 s vs 4.82 s, 242 vs 302 Hz) — free variety. LRU per pool,
   no identical take within the last 10 plays; recency persisted across games in `localStorage`
   `gambit.clipRecency` (try/catch, may be empty); greeting/start/end remember the last 20.
4. **Mood**: top 30 praise lines get `!` (excited) and `.` (calm) takes; pose picks.
5. **Barks** («Ого!», «Ух ты!», «Ой-ой!», «Хм…», «Так-так…», «И-го-го!»): before ≈ 35 % of priority-1 utterances,
   never twice in a row, never before an interjection, never in `blitz5`.
6. **Names**: never recorded; every catalogue line has a nameless form. Child-name clips (opt-in behind the parental
   lock, «Миша,»/«Привет, Миша!»/«Молодец, Миша!» ≈ 0.45 cr, which would send the name to Higgsfield) are not
   implemented.
7. **Writing**: spoken Russian for a 6-year-old — short sentences, questions, «давай», «мы», interjections. A reviewer
   reads the catalogue on the review page and can veto any line before it is recorded.
8. **Measured liveliness (gate)**: any clip ≤ 1.5 plays/game (barks ≤ 2); distinct clips ÷ plays ≥ 0.8; neighbouring
   utterances share ≤ 1 identical clip id (excluding slots); no fixed line repeats within 3 events.

---

## 8. UI

### 8.1 Mode switch (Settings, behind the parent gate)

«Каким голосом говорит Гамбитик»:
- **«Записанный голос — бесплатно, без микрофона»** (first in the grid): voice name (Giselle), «Послушать» (plays a
  local clip; never offered to an automated browser), library line (phrases, version; share of the last game spoken
  from recordings).
- «Живой разговор OpenAI — платно, нужен микрофон».
- «Голос браузера». «Без голоса».

`VoicePreference` includes `'clips'`; the default preference is `'auto'`. Without the server's runtime AI
(`AI_OFF_VOICE` in `apps/web/src/coach/settings.ts`), `'auto'` / `'live'` / `'realtime'` speak with «Записи». A
per-parent miss policy and an offline download for the public site are not part of the Settings.

### 8.2 No-mic flow in a game

- Dock: no «Поговорить» for non-conversational layers. A round **«Спроси»** button opens big chips:
  «Почему так?», «Что задумал соперник?», «Совет»/«Подсказка» (existing `requestHint`; hidden in exams),
  «Повтори» (`replayLast()`, free). All go through `gameStore.sayEvent` (clock held), all answers are recorded clips.
- Tap Гамбитик while he speaks ⇒ he stops (`coach.interrupt()`); idle tap ⇒ a recorded catchphrase.
- Hidden in clips mode: mic indicator, «Я в наушниках», `micHelp`, «Микрофон закрыт», «Лимит на сегодня».
  Kept: «Привет! Нажми на меня» (gesture unlock), «Не слышно? Нажми сюда» (`ctx.resume()` + silent buffer in the click).

### 8.3 Child's thoughts after the game

Result card, before `DiaryNote`: «Как тебе партия?» with 4–6 big icon chips («Было легко», «Было трудно»,
«Я нашёл(ла) хороший ход», «Понял(а) свою ошибку», «Хочу реванш!», gendered by `address`), up to 2 taps.
A tap is journaled as `childSaid { source: 'choice' }` while the game record is open, or sent as
`GameThought { source: 'typed' }` with «(выбрал кнопкой)» after it (a separate `'tap'` source would need a DB
migration); Гамбитик answers with a recorded line («Трудно — значит, ты растёшь!»).
The child's voice is never recorded to a cloud and never transcribed; the app has no voice diary
(`architecture.md` §11).

---

## 9. Demo game and the `pilot` tier

**Demo game:** a seeded 5-minute «Учитель» game from the harvest (short style, child as White, ≥ 15 teach turns,
containing at least one treasure, one danger, one praise, one take-back offer, a strategy intro and a game end). The
committed one is **`g174`** (`apps/web/public/voice/demo/g174.json`: Italian, 35 plies, 29 events, every one a builder
twin). A **demo replay** (`?clipsDemo=<seed>`, dev server only, parent-gated; `demo-format.md`) replays the child's
harvested moves in the real app through the real layer, clock holds and stops — a listener watches and hears a real
game. The coverage test asserts 100 % of the demo's utterances resolve at L1–L2 from the `pilot` tier (29/29). The
Settings footer link opens the seed `demo`, which is not a committed file; open the committed demo with
`?clipsDemo=g174`. A fresh game falls to L5 generics where lines are not recorded, which exercises the ladder.

**The `pilot` tier** (`tools/voice-clips/jobs.pilot.json`, budget cap 15 credits): the clips of the demo game plus
probes that compare recipes.

| Group | Contents | Clips | ≈ chars (incl. tags/carriers) | Credits |
|---|---|---|---|---|
| D1 Whole lines | greeting 2, gameStart 2, praise 6, «Осторожно»-family 4, «Найдёшь ход сам(а)?» 4, piece-only opponent 8, danger 4, treasure 3, take-back 2, hurry 2, gameEnd 2, generics 6, «Спроси» answers 3 | 48 | 1,490 in 16 jobs of ≤ 3 lines | 4.8 |
| D2 Strategy intro | the demo's intro, single job | 1 | 95 | 0.3 |
| D3 Heads | 12 teacher heads, head recipe with dummy-slot carrier («Мой совет — конь на эф три.») | 12 | 445 | 1.5 |
| D4 Tails | 10 reason tails, tail recipe («Конём на эф три<#0.3#>— так мы давим на центр.») | 10 | 520 | 1.65 |
| D5 Move units | the demo's 22 advice/reveal moves as whole `ins`/`nom`/`cap` units, slot-batch | 22 | 570 | 1.8 |
| D6 Split sample | 8 «на X» + 4 ins heads (A/B: whole vs split form) | 12 | 215 | 0.75 |
| D7 Barks | 12 by pose | 12 | 145 | 0.45 |
| **Demo subtotal** | | **117** | | **11.25** |
| P1 References | 2 whole teacher turns as single jobs (blind A/B vs composed) | 2 | 140 | 0.6 |
| P2 Packed vs single | 5 top lines re-rendered as single jobs (also measures take variance / tempo reject rate) | 5 | 125 | 0.75 |
| P3 Pronunciation | one packed job: «е два», «же пять», «аш семь», «а шесть», «бьёт», «ладьёй», «ферзём», ё, U+0301 stress marks | 12 | 290 | 0.9 |
| **Probe subtotal** | | **19** | | **2.25** |
| **Total** | | **136 clips** | ≈ 4,000 | **≈ 13.5 (cap 15, ≈ 1.5 reserve for re-renders)** |

Masters go to `tools/voice-clips/.masters/`. The review page (`test-results/voice-review/index.html`) holds the A/B
pairs with «живо / не живо» verdict buttons that export JSON; `pnpm voice:demo-game` writes the whole demo game as one
MP3 + SAN transcript to a local listening folder (`docs/voice-samples/clips-pilot/`, git-ignored). **Only a human plays
audio; tools never do.**

The probes compare: (a) H·S («Мой совет —» · «конём на эф шесть») liveliness; (b) whole move unit vs split form;
(c) head/tail recipes (carrier cut vs tag); (d) packed (≤ 3 per job) vs single prosody; (e) `atempo` 0.8–1.3;
(f) Giselle for a boy mascot with masculine self-reference; (g) «е», «же», «аш» and stress marks.

---

## 10. Generation tool (`tools/voice-clips/*.ts`, `pnpm voice:*`)

| Command | Does | Cost |
|---|---|---|
| `harvest --clip --games 300 [--blitz]` | Node + Stockfish WASM + real builders in clip mode; records line ids, slot keys, compiled fragments; commits a 24-game sample for tests; writes the best demo candidate | free |
| `script` | catalogue + harvest ⇒ units with recipe/prompt/tier/priority/batch; **lint**: no square pattern `на (а\|бэ\|цэ\|дэ\|е\|эф\|же\|аш) (один…восемь)` outside slots, correct piece word per variant, masculine self-reference only, length caps (whole ≤ 12 words/80 chars, head ≤ 5 words, tail ≤ 8, slot ≤ 5) | free |
| `plan --tier pilot\|starter\|full` | dry run: jobs, chars, credits, holdout coverage gain, minutes, MB; writes `tools/voice-clips/jobs.<tier>.json` | free |
| `generate --jobs tools/voice-clips/jobs.<tier>.json --budget N --spend` (there is no `--tier` flag) | see protocol below | **paid: operator's explicit OK only** |
| `process` | loudnorm −18 LUFS / −1.5 dBTP → split at tag silences (≥ 550 ms below −55 dBFS; piece count ≠ unit count ⇒ requeue as smaller job) → trim at −55 dBFS keeping 30/60 ms, strip edge breaths → clamp inner slot pauses > 120 ms to 60 ms → tempo gate 4.0 ± 0.6 syl/s (`atempo` 0.8–1.3, else re-render ≤ 2×, else `needsEar`) → edge-F0 ≤ 190 Hz for falling units → MP3 48k → atomic manifest write | free |
| `verify` | gates: 55–140 ms/char, peaks, F0; whisper.cpp ASR on every unit (`ggml-small.bin`, 487.6 MB, in `~/.cache/gambitik/whisper/`, outside the repo; `pnpm voice:whisper --check` verifies its SHA-256/SHA-1; a unit ASR cannot confirm goes to a human listener) | free |
| `review` | `test-results/voice-review/index.html`: units + composed lines rendered offline with the runtime gap table; `<audio controls>` + verdict buttons | free |
| `coverage` | report + CI gate (§11) | free |
| `demo-game` | the whole demo game as one MP3 + SAN transcript | free |
| `library-plan`, `library-run` | the whole library in advance (`ONDEMAND.md`, `tools/voice-clips/README.md`) | run: paid |

**Prompt recipes:** whole (`Текст.`, ≤ 3 per job separated by `<#0.6#>`, `?` lines last or alone); head (head + dummy
slot, cut at the pause, re-render alone if no pause); tail (dummy head + `<#0.3#>` + tail, cut at the tag);
slot-batch (≤ 15 units / ≤ 450 chars); slot-carrier («Ход — конь на эф шесть.») if isolated units sound flat.
Prompts spell file letters as «а бэ цэ дэ е эф же аш» and always write ё.

**Spend protocol:** check `higgsfield account status --json` and `higgsfield model get text2speech_v2` first; refuse
without `--spend` + `--budget`, or above the account's available credits; `generate create … --json` (no `--wait`) ⇒
write a `created` ledger line ⇒ `generate wait <id> --json` ⇒ download master immediately. Resume polls ledgered ids,
never re-creates. 429 only when exit ≠ 0 **and** stderr has `rate_limit_reached` (never grep JSON — a «429» can occur
inside a timestamp); before any retry look in `generate list --audio --json` for an identical prompt; backoff
2 → 60 s with jitter, ≤ 8 tries; concurrency 1; stop when ledgered charges reach the budget; `--max-jobs` second cap;
reject empty or > 480-char prompts (an empty prompt still creates a failed job). `generate` asks the server's price
before every job and audits the balance after each run (a mismatch blocks further runs until `--accept-audit`).
`runCli` is injected so tests can never spend. Tools never play audio.

### 10.1 Measured facts behind the recipes

Offline measurements (ffmpeg + a Node F0/energy tracker: 40 ms frames, 10 ms hop, F0 by normalised autocorrelation
over 110–520 Hz) on Giselle takes:

- **Seams.** At a prosodic pause (`—`, `:`, sentence end) a seam measured +2.6…+4.5 st at 290–330 ms of silence,
  against a natural +7.2 st at 295 ms. Word fragments recorded alone each end in a sentence-final fall (150–188 Hz,
  like a real sentence end at 167–175 Hz), so word-level seams jump +15…+18 st and +10…+16 dB.
- **Tempo.** The same words run at 5.5 syl/s inside a sentence and ≈ 2.9 syl/s in carriers or alone; one prompt
  rendered twice gave 3.11 s and 4.82 s (5.2 vs 3.2 syl/s). There is no speed parameter, hence the tempo gate.
- **Pause tags.** `<#x#>` passes through Higgsfield (`<#0.5#>` → 730–790 ms of silence), is billed as characters and
  forces a final fall on the text before it — good for units that end at `—` or a sentence end.
- **Provider.** Output is MP3 32 kHz mono 128 kbps; server-side params are fixed (`speed 1`, `pitch 0`, `volume 1`,
  `language_boost auto`, `text_normalization false`) and the CLI rejects any other param. Price: 0.15 × ⌈code points /
  50⌉ per job (spaces and tags count), confirmed by free `generate cost` probes. ≈ 4 s per job.
- **Level.** Raw takes range −14.4…−18.6 LUFS (single-word jobs loudest); normalising to −18 LUFS / ≤ −1.5 dBTP before
  cutting needs no limiter.
- **Trim.** The noise floor in pauses is −66…−67 dBFS; word-final «ф», «ть», «сть» sit at −36…−50 dBFS for 80–150 ms,
  so trimming at −40/−45 dBFS cuts them and −55 dBFS keeps them.
- **Breaths.** Minimax inserts breaths between sentences of one job: −42…−47 dBFS, 130–200 ms, no F0, high-band energy
  close to full-band (flat spectrum). They are trimmed from unit edges.
- **Format.** MP3 48 kbps 32 kHz mono ≈ 5.9 KB/s; MP3 adds 34.5 ms of priming (plus up to one 36 ms frame at the end)
  when a decoder ignores the LAME tag, so the player scans decoded samples for the real edges. Opus 24 kbps is half the
  size and sample-exact, but Safari support depends on the version.
- **Words.** Level, tempo and pitch cannot see a wrong word (the «слон/пешка» class of error); only the ASR transcript
  compared with the prompt catches it.

---

## 11. Test plan (vitest, fakes only: silent, free, no ports 8787/5173, temp `DATA_DIR`)

| Test | Proves |
|---|---|
| `packages/core/src/coach/clips/keys.test.ts` | golden id hashes; for every piece × square × form `canonicalSlotText(key)` equals `sanToSpokenRu`/`moveInsRu` minus disambiguation; castling/promotion lines |
| `…/clips/plan.test.ts` | only §3.1 shapes; ≤ 1 slot, ≤ 3 clips per sentence; L1–L6 in order; split on a missing move; prio drop to 12 s / 7 s; blitz gaps ×0.75; LRU/recency; bark rules; SAN mismatch ⇒ L5 |
| `…/clips/compile.test.ts` | bridge route: golden harvest lines; names stripped; commas never split; lone-piece merge; trim never drops pre-slot fragments; slot never without piece fragment |
| `…/clips/catalog.test.ts` | every `CoachEventKind` has ≥ 4 generics; lint rules; pool minimums by frequency; piece-only lines contain no square |
| `…/clips/twins.test.ts` | clip twin and text builder agree on parts/prio for 200 harvested positions; LLM free text (`introRu`/`planRu`/`whyRu`) never reaches a `ClipUtterance`; treasure square never before reveal |
| `…/clips/coverage.test.ts` **(CI gate)** | on the committed harvest sample + manifest: tier thresholds (§4.3), liveliness thresholds (§7.8); `pilot`: 100 % of the demo game at L1–L2. A template edit that un-voices a line fails here and lists the units to record |
| `apps/web/src/coach/clips/clipPlayer.test.ts` | FakeAudioContext: gaps, jitter, fades; audible start/end; `stop()` immediate; `endAfterSentence`; watchdog; suspended context never hangs |
| `clipLibrary.test.ts` / `clipVoice.test.ts` | fake fetch/decode: dedupe, sample-scan trim, LRU by seconds, manifest failure ⇒ `init()` rejects ⇒ chain falls to silent; `VoiceLayer` contract; `onPlan` |
| `coachController.test.ts`, `coachGrace.test.ts`, gameStore tests | chain `['clips','silent']`; `speakEvent` preferred; clock held exactly between say and resolve; grace uses `msToSentenceEnd` |
| `MascotDock.test.tsx`, settings tests | «Спроси» chips in clips mode, mic UI hidden, `'clips'` preference round-trips |
| `tools/voice-clips/*.test.ts` | fake `runCli`: no `--spend` ⇒ zero calls; budget cap; 429 never duplicates; ledger resume; cost function; real ffmpeg on synthetic tones in `$TMPDIR` (skipped if missing) |
| e2e | automation ⇒ silent layer; optional `gambit.e2eClips` routes clips to a muted `GainNode(0)`, and the black box then records in memory only |

Manual (a human listener only): the A/B review page; the demo replay; real games with the black-box `clip.plan` stats.

---

## 12. Tiers and gates

| Tier | Contents | Credits | Gate |
|---|---|---|---|
| free groundwork | catalogue, clip twins, compiler bridge, layer, tools, harvest, dry-run plans, demo replay | 0 | a reviewer reads/vetoes catalogue text |
| `pilot` | §9 | ≈ 13.5 (cap 15) | operator's explicit OK to spend; a listener picks recipes |
| `starter` | §4.3 Starter, «Спроси» chips, thought chips | ≈ 84 on top of `pilot` | explicit OK; real games; coverage/repetition report |
| `full` | Подсказчик/Экзамен, shell, cards, extra takes, remaining moves | ≈ +172.5 measured (≈ +290 estimated) | explicit OK |
| on demand | «Дозапись голоса» (`ONDEMAND.md`) | operator's total and daily caps | parent's switch, home server only |

## 13. Risks

| Risk | Mitigation |
|---|---|
| Seams/split form measured but to be judged by ear | A/B review page; slot-carrier recipe; more whole move units |
| Tempo drift between takes (5.2 vs 3.2 syl/s) | tempo gate + `atempo` + re-render; P2 measures the reject rate (> 30 % ⇒ costs ×1.3) |
| Mispronounced chess words | prompt spelling, ё, stress marks (P3), ASR gate, human ear |
| Clip twins take effort; porting drifts | compiler bridge for unported families; coverage gate |
| Repetition over dozens of games | pool-size rule, takes, persistent LRU, liveliness gate |
| Budget for the Full tier | Starter covers «Учитель»; other modes use generics until recorded |
| Higgsfield changes voice/pricing; the licence for redistributing preset-voice audio on a public site is unverified | keep masters + ledger; versioned `voiceKey` folders; check terms before a public launch (home use fine) |
| No free-form questions without a mic | «Спроси» chips; paid live mode stays available |

---

## Кратко (по-русски)

- Гамбитик говорит целыми записанными фразами голосом Giselle, и только ход вставляется отдельной записью на
  естественной паузе: «Мой совет —» + «конём на эф шесть» + «— так мы давим на центр». Урок (`docs/TEACHING.md`)
  клеток не называет и звучит целиком или никак.
- Ход соперника, опасность и подарок называются без клетки («Соперник вывел коня»), клетка подсвечена на доске;
  частые фразы — 6+ вариантов и дубли. Гамбитик говорит о себе как мальчик («я готов», «я заметил»).
- Внутри фразы ничего не генерируется: для ребёнка бесплатно, без микрофона, дома без интернета. Недостающую фразу
  можно дозаписать на домашнем сервере с лимитом (`ONDEMAND.md`).
- Фигура и клетка берутся из хода движка, не из текста, поэтому «слон вместо пешки» и выданные подарки невозможны.
- Если записи нет: запасной ход «Конём — на эф шесть!», иначе общая фраза («Смотри на зелёную стрелку!»).
- Вместо «Поговорить» — кнопка «Спроси» (Почему? / Что задумал соперник? / Совет / Повтори), после партии — кнопки
  «Как тебе партия?».
- Наборы записей: `pilot` ≈ 13,5 кредита (137 записей) — настоящая 5-минутная партия с «Учителем» (`g174`); стартовый
  набор «Учителя» — ещё ≈ 84; полный — ещё ≈ 172,5.
