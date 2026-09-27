# «Записи»: the web layer

Spec: `SPEC.md` §5, §6, §8; demo file: `demo-format.md`; on-demand recording: `ONDEMAND.md`.
Code: `apps/web/src/coach/clips/` + small integrations in `apps/web/src/coach/*`, `apps/web/src/app/Settings*`,
`apps/web/src/features/game/{gameStore,gameTypes,GameScreen}`. Nothing here plays audio in tests, spends, or touches
`data/`.

## 1. Modules

| File | What it does |
|---|---|
| `clips/clipAudio.ts` | one lazy `AudioContext({ sampleRate: 32000 })` → master gain → soft limiter; `unlockInGesture()` (resume + 1-frame silent buffer); `muted` = GainNode(0) for the e2e opt-in |
| `clips/clipLibrary.ts` | `voice/index.json` → `voice/<voiceKey>/manifest.<hash>.json` → the planner's `ClipIndex` (a new object per load); `ensure(ids)` = deduplicated fetch → `decodeAudioData` on a COPY → sample scan of the audible edges at −55 dBFS (+6 ms / +12 ms) → mouth envelope → decoded LRU ≤ 60 s; compressed hot-set bytes ≤ 6 MB; `failed(id)` for the planner's `available`; `prefetch` / `prewarm` in idle time (decode only, never generate) |
| `clips/clipPlayer.ts` | WebAudio scheduling: the plan's gaps, the real decoded windows, 5 ms raised-cosine fades, `speaking(true)` at the audible start (`outputLatency`), resolve at the last `onended` + latency, `stop()` (25 ms fade, resolves at once), `endAfterSentence()`, `msToSentenceEnd()`, watchdog `ms + 1.5 s` |
| `clips/clipVoice.ts` | the `VoiceLayer` of kind `'clips'` (+ `GestureGated`, `ClipExtras`, the hearing self-check): `speakEvent` → `planClips(clipInputOf(event, { name }), index, ctx)` → `ensure` (a take that fails or is slow is re-planned without it — never a hole) → play; a suspended context → silent timing + `needsUserGesture` (never hangs); recency / stats / misses in localStorage; black box codes only |
| `clips/clipMemory.ts` | `gambit.clipRecency` (≤ 240 ids), `gambit.clipStats` (last game), `gambit.clipMisses` (local miss log), the cached child name |
| `clips/clipAsk.ts` | «Спроси» chips, the opponent answer (piece-only, board facts), «Повтори», a poke's twin, the thought chips and his replies |
| `clips/clipSettings.ts` | the Settings option, status and «Послушать» event |
| `clips/clipOnDemand.ts`, `clips/shellTwin.ts` | «Дозапись голоса»: when to request a missing phrase and when to play it late (`ONDEMAND.md`) |
| `clips/clipsDemo.ts`, `ClipsDemo.tsx` | the dev-only demo replay (`demo-format.md`) |
| `clips/ThoughtChips.tsx` | «Как тебе партия?» on the result card |
| `clips/clipFlags.ts` | `gambit.e2eClips` / `?e2eClips=on`, `?clipsDemo=<seed>`, storage keys |
| `clips/testAudio.ts` | test-only fakes: AudioContext on fake timers, fake "MP3" bytes, a library served from memory |

## 2. Integration points

- **Controller** (`coachController.ts`): `selectVoiceChain('clips') = ['clips', 'silent']`; automation → `['silent']`,
  or `['clips', 'silent']` with the e2e opt-in (the factory then builds the layer muted). `play()` calls
  `layer.speakEvent(event, { interrupt, blitz })` when the layer has it (the brief path of the live voice is
  untouched). The gentle stop asks the clips layer: `msToSentenceEnd() ≤ stopGraceMs` → `endAfterSentence()` and the
  phrase ends by itself ('finish'), else it is cut. Additive API: `ask(question)`, `onAsk(cb)`, `lastSpoken`,
  `clipVoice` (true while «Записи» speaks), `prewarmClips(hint)`. Store: `clipLibrary` (phrases, version).
- **Game** (`gameStore.ts`): subscribes `coach.onAsk` — «Почему так?» (the take-back question again while it is open
  or right after «Верну ход», `buildTakebackQuestion`; in «Учитель» on the child's turn the advice WITH its reason,
  core `buildTeachWhy` — a hidden treasure stays hidden: its gift line + «Найдёшь ход сам?», nothing revealed, the
  reveal timer and the arrows untouched; else `explainLastMove`, else `ask.why.think`), «Что задумал соперник?»
  (`opponentAnswerEvent` with the null-move threat the game already searched: `ask.opp.mate` / `fork` /
  `hanging@piece` / `threat`, else his move `opp.*` + `ask.opp.none` when the engine found nothing; no squares, the
  threatened piece highlighted red), «Совет» / «Подсказка» (`requestHint`), «Повтори» (the last phrase, new id — a
  phrase about the board (`isAboutThePosition`) only while the board is the same; after a move / take-back «Учитель»
  says the current advice (a hidden treasure only as its gift line), anything else `ask.repeat.stale`) — all through
  `sayEvent`, so the clock is held.
  `tapThought(chip)` after the game (≤ 2): journaled as `childSaid { source: 'choice', about: 'gameFeeling' }`
  before the record goes out, or `POST /games/:id/thoughts` (`source: 'typed'`) after it.
- **Dock**: in clips mode no microphone UI at all (as for every free voice); a round «Спроси» in a game (none in an
  exam) with 4 big chips; «Не слышно? Нажми сюда» kept; an idle poke carries `clip: pokeClip(pose)`. For an `answer`
  event with a clip twin and no teacher facts (a poke, a «Спроси» answer, a thought reply) the controller replaces the
  bubble with the words really heard (`onPlan` → `heard`): the planner picks any take of the pool, `text` is only its
  first wording. A teacher turn (move in notation) or a plan that fell to the generic line keeps its own bubble.
- **Settings**: «Записанный голос — бесплатно, без микрофона» first in the grid; its status (library, last game %);
  free «Послушать» (never under automation); the default preference is `'auto'` (without the server's runtime AI it
  speaks with «Записи», `AI_OFF_VOICE`).

## 3. What the catalogue must record for the web layer (line ids)

The exact list is `CLIP_TAP_LINES` of @gambit/core (`catalog.game.ru.ts`): the tools force every one of them into the
Starter tier (2 wordings of a plain line, the poke 4, each piece pool once), clipAsk.test.ts checks that clipAsk emits
nothing else and that every id written in `apps/web/src/coach/clips/*.ts` and the dock has a `pilot` or Starter take.

| Line id | Role | Variants | Sample wording (a boy speaking, no squares) |
|---|---|---|---|
| `poke` | whole | — | catchphrases: «И-го-го! Дай копыто!» (9 wordings) |
| `preview` | whole | — | «Привет! Я Гамбитик. Вот так звучит мой голос.» (Settings «Послушать») |
| `ask.why.think` | whole | — | «Давай подумаем вместе: какая фигура ещё не в игре?» |
| `ask.opp.notYet` | whole | — | «Соперник ещё не ходил — ход за тобой!» |
| `ask.opp.none` | whole | — | «Пока ничего страшного он не задумал.» (after his move, when the engine found no threat) |
| `ask.opp.mate` · `ask.opp.fork` · `ask.opp.threat` | whole | — | «Он грозит матом!» · «Он готовит вилку!» · «Он что-то задумал — посмотри внимательно!» |
| `ask.opp.hanging` | whole | byPiece p n b r q | «Он хочет забрать {твоего} {коня}!» |
| `ask.repeat.stale` | whole | — | «Это я про прошлый ход говорил — смотри на доску!» |
| `opp.developed` | whole | byPiece n, b | «Соперник вывел {коня}.» · «Ага, {конь} соперника вышел в игру!» |
| `opp.took` | whole | byPiece p n b r q | «Соперник забрал {твоего} {коня}.» · «Ой, {твоего} {коня} забрали!» |
| `opp.attack` | whole | byPiece n b r q | «Соперник напал на {твоего} {коня}!» · «{Твой} {конь} под ударом!» |
| `opp.moved` | whole | byPiece n b r q k | «Соперник пошёл {конём}.» · «Он сходил {конём}.» |
| `opp.pawn` · `opp.castled` · `opp.check` | whole | — | «Пешка шагнула вперёд.» · «Он спрятал короля в домик.» · «Шах от соперника!» |
| `thought.easy` · `thought.hard` · `thought.goodMove` · `thought.mistake` · `thought.rematch` | whole | — | «Легко? Тогда в следующий раз позовём соперника посильнее!» · «Трудно — значит, ты растёшь!» · «Здорово! Я тоже заметил этот ход.» · «Молодец! Найти свою ошибку — это уже победа.» · «Давай! Я готов к реваншу!» |
| generic pools | whole | — | `generic.answer` (+ `.poke`, `.why`, `.thought`, `.repeat`), `generic.botMoveComment` (+ `.opponent`), `generic.greeting` — ≥ 4 wordings of every generic line are in the Starter |

At most half of an opponent pool opens with «Соперник» (catalog.test.ts). Barks come from `bark.<pose>` (`wave`,
`cheer`, `think`, `oops`, `talk`) on every utterance with a pose.

## 4. What the manifest must carry for the web layer

- `fallbacks` (catalogue L3 siblings) — the browser reads it; without it the L3 sibling step is skipped.
- `interj: true` on bark takes and on takes that begin with an interjection (no bark in front of them). The planner
  also recognises «Ого», «Ой-ой», «Хм» … by text.
- `file` as `<id[1..2]>/<id>.mp3` (other paths are ignored and `clipFile(id)` is used); `on` / `off` are a fallback
  only — the browser trims by scanning the decoded samples.
- The library lives in `apps/web/public/voice/` (served by Vite in dev and from `dist` in production). Without it the
  layer's `init()` rejects and the chain falls to the silent layer; the parent's status says why.

## 5. Interpretations (documented in the code)

- **Talkativeness** applies to «Записи» only at «Тихо»; at «Обычно» the recorded coach keeps his short praise
  (priority 0, still rate-limited by the chatter rule) — a lively coach, and a recording is free.
- **Tap thoughts** use the existing routes: in the record as `childSaid { source: 'choice' }` (rendered «выбрал
  ответ»), after it as `GameThought { source: 'typed' }` with the text «… (выбрал кнопкой)». A real `'tap'` source
  needs a DB migration on the server (its CHECK allows only 'voice' / 'typed').
- **«Почему так?»** = the take-back question while it is open (or while the child tries again after «Верну ход»); in
  «Учитель» on the child's turn the current advice WITH its reason in one S·T sentence («Конь на эф три — выводишь коня
  в игру.»: a split move keeps the reason; a move without an idea is «спокойный крепкий ход»), a hidden treasure never
  revealed by it; in «Подсказчик» `explainLastMove`; otherwise a question back. **«Что задумал соперник?»** = a check
  first, then his threat from the game's null-move search of this very position (unknown → the static mate-in-one
  check), then his last move from board facts (capture › castling › attack on a piece › developed piece › pawn ›
  other move) — never a square.
- A take that fails to load (404 / decode error / slower than 1.5 s) is re-planned once without it.
- **Black box under automation**: off, except with the `gambit.e2eClips` opt-in — then
  it records in memory only (`__gambitVoiceDiag.recent()`: `clip.plan` with its level, `clip.end` …), never posted or
  beaconed, so a headless run can check the plans without writing any server log (`voiceDiag.ts`).
- The miss log is local (`gambit.clipMisses`); there is no server route for it.

## 6. Not wired

- Prewarm calls from `gameStore` for the SPEC §5.4 windows — the API is `coach.prewarmClips({ moves, events, pools })`.
- Journal `spokenBy: 'clips'` / heard text (`ClipExtras.onPlan` gives it).
