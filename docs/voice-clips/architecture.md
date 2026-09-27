# Voice mode «Записи» (pre-recorded clips): architecture

The clip layer plays pre-recorded Giselle clips (Higgsfield `text2speech_v2` / minimax / preset
`9d3128b8-dd25-5158-9bdb-2e69ac8998b9`) instead of synthesising speech live. The live voice, the browser voice and the
silent layer are separate layers. This document describes how the layer is built; `SPEC.md` is the design and wins
where the two differ (units, grammar, gap table, tiers). A summary in Russian is at the end (§13).

---

## 0. Overview

| Question | Answer |
|---|---|
| Where the player lives | `apps/web/src/coach/clips/`: a `VoiceLayer` of kind `'clips'` — `clipVoice.ts` (the layer), `clipPlayer.ts` (WebAudio scheduling), `clipLibrary.ts` (manifest, fetch, decode, LRU). Pure planning code lives in `packages/core/src/coach/clips/`, and the tools reuse it (one normalisation, one set of ids). |
| How an event becomes clips | `planClips(event.clip ?? compileText(event.text), index, ctx)`: a builder's clip twin, else the text compiler (exact match, seams only at punctuation or around a move slot, ≤ 3 clips per sentence), else a recorded **generic line** for the event kind — the bubble and the arrows still carry the exact move — else silent timing (`SPEC.md` §6.1). A lesson utterance is planned by `planLessonClips`: whole or not at all, never a generic line. |
| A needed clip is missing | **Never mix voices inside a phrase, and never generate inside an utterance.** The miss is voiced by a generic recorded line (or, for a lesson utterance, shown as «не озвучено») and counted in the local miss log. Gaps are filled operator-side (`SPEC.md` §6.3, `ONDEMAND.md`). |
| Storage | `apps/web/public/voice/<voiceKey>/` (static, copied into `dist`, served by Vite and Hono), content-hashed manifest name, one MP3 per take. Clips never go in `data/`: that is the child's runtime data. On-demand recordings live outside the repo (`VOICE_OVERLAY_DIR`). |
| Format | MP3, mono, 32 kHz, 48 kbps (≈ 5.9 KB/s); every browser decodes it with `decodeAudioData`. |
| Generation | `tools/voice-clips/*.ts`, driving the signed-in `higgsfield` CLI. Dry run by default; spending needs `--spend --budget <credits>`. Idempotent (id = hash of voice + prompt), resumable (a JSONL ledger is written *before* waiting on a job); a rate limit is retried with backoff. |
| No microphone | «Спроси» chips (Почему так? · Что задумал соперник? · Совет/Подсказка · Повтори) instead of «Поговорить». Tapping Гамбитик while he speaks makes him stop. Post-game thoughts are big tap answers. |
| Clock | The layer resolves at the **audible** end (last `onended` + `outputLatency`) and reports `speaking` at the audible start, so the `sayEvent` / `holdTeach` holds follow real sound. |

---

## 1. Goals and hard constraints

1. **Free for the child**: no per-minute voice cost; clips are paid once, by the operator.
2. **No microphone needed**: no permission prompt, echo guard, headphones note or mic-help steps, and no child audio
   leaves the device. No child voice goes to a speech provider, so provider country limits and the COPPA / 152-ФЗ voice
   issues do not apply.
3. **Lively, dynamic, speaks well**: a real expressive voice, varied wording, emotional interjections, human-like
   timing, and no robot voice mixed in.
4. **Correct by construction**: the clip layer only says engine-grounded template content. That excludes the faults of
   a generative voice: the wrong piece («слон на аш три» instead of a pawn), invented repeated openers («Соперник ничего
   не меняет»), treasure moves given away (a template respects `reveal: 'later'`), and odd greeting words.
5. **Additive to the live voice**: the conversational code paths (`sessionVoice.ts`, `liveVoice.ts`,
   `realtimeVoice.ts`, the conversation, daily limit and hearing logic in `coachController.ts`) do not depend on it.
6. **Automation stays silent and free**: `createBrowserVoice()` returns the silent layer under `automationSilenced()`
   (or, with the `gambit.e2eClips` opt-in, the clips layer into a muted output). Tools never play audio.

---

## 2. Provider facts

| Fact | Value | How |
|---|---|---|
| Cost function | **credits = 0.15 × ⌈chars / 50⌉** per job (Unicode code points, spaces and pause tags included): 50 chars 0.15, 51 → 0.30, 101 → 0.45, 1,200 → 3.6. | `higgsfield generate cost text2speech_v2 … --variant minimax` (an estimate, no job) |
| Consequence | Cost is linear in characters with a 50-char minimum bucket. Packing short units (squares, moves) into one job saves up to 5× on them; for sentences of ≥ 40 chars packing gains nothing. | as above |
| Model params | Only `prompt` (≤ 10,000 chars for minimax), `variant`, `voice_id` and `voice_type` are accepted. No speed, pitch or emotion. Jobs record `format: mp3`, `sample_rate: 32000`, `speed: 1`, `pitch: 0`, `language_boost: auto`, `text_normalization: false`. | `higgsfield model get text2speech_v2`, `generate list --audio --json` |
| Job shape | `{ id, status: completed/failed, result_url: https://…cloudfront.net/…/hf_<date>_<id>.mp3, params }` | `generate list --audio --json` |
| Throughput | ≈ 4 s per short job, sequential. | job timestamps |
| Reference sample `24-Giselle-minimax.mp3` | 144-char prompt («Привет! Я Гамбитик — шахматный жеребёнок! И-го-го! …»), 0.45 credits. **15.23 s**, mono 32 kHz MP3 128 kbps, mean −18.9 dB, peak −2.1 dB; six inner pauses of 0.12–0.76 s at `.`, `!` and `—`. | `afinfo`, `ffmpeg -af silencedetect,volumedetect` (offline, nothing played) |
| Speech rate | ≈ 9.5 chars/s (105 ms/char) including pauses, ≈ 10.8 chars/s of speech alone. `estimateSpeechMs` assumes 75 ms/char, which is optimistic for this voice. | derived |

More measurements (seams, tempo, trimming, breaths, pause tags) are in `SPEC.md` §10.1.

---

## 3. Where it plugs in

```
gameStore.sayEvent(event) ──► coach.say(event) ──► controller queue (priority 2 cut-in, chatter drop, grace)
   holds the child's clock                                   │ play(item): layer = clips
   until the promise resolves                                ▼
                                          clipVoice.speakEvent(event, { interrupt, blitz })
                                            1 plan   = planClips(…) / planLessonClips(…)   core, pure, ≤ 2 ms
                                            2 bufs   = library.ensure(plan.ids)     cache hit 0 ms · local fetch+decode ≈ 10–40 ms
                                            3 player.schedule(bufs, gaps)           WebAudio, sample-accurate
                                            4 speaking(true) at audible start … speaking(false) at audible end
                                            5 resolve at real end | stop() | watchdog (plan.ms + 1.5 s)
```

| File | Role |
|---|---|
| `packages/shared/src/contracts.ts` | `VoiceLayer.kind` includes `'clips'`; optional `speakEvent?(event, opts)` for a layer that needs the whole event (kind, teach, pose, clip) instead of only `text`; `CoachEvent.clip?: ClipUtterance`. |
| `apps/web/src/coach/voiceTypes.ts` | `ClipExtras` (feature-detected like `VoiceHealthExtras`): `msToSentenceEnd(): number \| null`, `endAfterSentence(): boolean`, `replayLast(): Promise<void>`, `onPlan(cb)` (source, coverage and heard text for the bubble and the black box). |
| `apps/web/src/coach/coachController.ts` | `selectVoiceChain`: `'clips'` → `['clips', 'silent']`; without the server's runtime AI `'auto'` / `'live'` / `'realtime'` use `AI_OFF_VOICE` (`'clips'`). `play()`: `layer.speakEvent ? layer.speakEvent(event, …) : layer.speak(event.text, …)`. Talkativeness applies to clips (only at «Тихо»). The gentle stop uses `msToSentenceEnd()` (§4.5). `modelOf('clips')` returns the voice key for the status line. |
| `apps/web/src/coach/settings.ts` | `VoicePreference` includes `'clips'`. |
| `apps/web/src/coach/voiceStatus.ts` | `VOICE_NAMES.clips = 'записанный голос (бесплатно)'`; the parent's status line adds the library version and phrase count. |
| `apps/web/src/coach/MascotDock.tsx` | With a non-conversational voice in a game, the «Спроси» chips replace «Поговорить» (§11). A tap while speaking calls `coach.interrupt()`, which for clips only stops. |
| `apps/web/src/features/game/gameStore.ts` | The ask actions go through `sayEvent`, so they hold the clock; tap thoughts after the game. |
| `apps/web/src/app/Settings.tsx` | The «Записанный голос» option behind the parent gate (§11). |

Independent of the layer: `sessionVoice.ts`, `liveVoice.ts`, `realtimeVoice.ts`, `rtcSession.ts`, briefs
(`coachBrief.ts`, `packages/core/src/coach/brief.ts`), the daily limit, usage reporting, conversation state and
reconnect logic. For the clips layer `conversationState` stays `'off'`, so `gameStore.syncVoiceHold` never
double-holds.

---

## 4. The clip layer (`apps/web/src/coach/clips/`)

### 4.1 Modules

| Module | Responsibility |
|---|---|
| `clipAudio.ts` | One lazy `AudioContext({ sampleRate: 32000 })` → master `GainNode` → a soft limiter → destination. Created on first use, never at import. `unlockInGesture()` (called synchronously from a click via the voice's gesture gate) resumes it and plays a 1-frame silent buffer *inside* the gesture (Safari). iOS `'interrupted'` (a phone call) counts as suspended. `muted` routes everything into a `GainNode(0)` for the e2e opt-in. |
| `clipLibrary.ts` | Loads `voice/index.json` → `voice/<voiceKey>/manifest.<hash>.json` (+ the on-demand overlay), builds the core `ClipIndex`. `ensure(ids)`: dedupes concurrent loads, `fetch` → `ArrayBuffer`. **Copy before `decodeAudioData`, which detaches the buffer.** Scans the decoded samples for the audible edges at −55 dBFS (+6 ms / +12 ms), so seams are robust to MP3 priming regardless of the manifest; computes the mouth envelope (RMS per 20 ms frame). Caches: compressed hot-set bytes ≤ 6 MB and an LRU of decoded `AudioBuffer`s ≤ 60 s of audio. Prefetch / prewarm in idle time (decode only). |
| `clipPlayer.ts` | Schedules a plan: one `AudioBufferSourceNode` → per-clip `GainNode` (fades) per segment, `start(when, trimStart, duration)`. `stop()` (25 ms fade, resolves at once), `endAfterSentence()`, `msToSentenceEnd()`, watchdog `plan.ms + 1.5 s`. |
| `clipVoice.ts` | The `VoiceLayer` of kind `'clips'` (+ `GestureGated`, `ClipExtras`, the hearing self-check). `init()` loads the manifest; if it fails, it rejects and the controller moves down the chain. `speakEvent` runs plan → ensure (a take that fails or is slow is re-planned without it) → schedule. A suspended context gives silent timing + `needsUserGesture` (never hangs). Mouth level follows the envelope in step with `ctx.currentTime`. |

The other modules (`clipMemory`, `clipAsk`, `clipSettings`, `clipOnDemand`, `shellTwin`, `clipsDemo`, `ThoughtChips`,
`clipFlags`) are listed in `web-layer.md`.

### 4.2 Scheduling, gaps, fades and loudness

- **Lead**: the first segment starts at `ctx.currentTime + 0.03` s.
- **Gaps**: the measured table of `SPEC.md` §5.3 (lessons: `LESSON_GAPS_MS`), ±30 ms jitter so it never sounds
  metronomic; ×0.75 in 5-minute games. **Never** change `playbackRate`: `AudioBufferSourceNode` does not preserve pitch.
  No crossfades: seams sit only in pauses.
- **Fades**: 5 ms raised-cosine fades on every clip edge, which avoids clicks. Stop uses a 25 ms fade-out.
- **Loudness**: the generator normalises every take to −18 LUFS integrated, −1.5 dBTP (ffmpeg `loudnorm`) before
  cutting, so concatenated clips do not jump in volume.
- **Ducking**: SFX duck while `coachStore.speaking` is true (`ui/sounds.ts`). Clips only have to report `speaking`
  correctly.

### 4.3 Real start and end, and the clock

The child's clock stops only while Гамбитик is really audible.

- **Audible start** = `when + (ctx.outputLatency || ctx.baseLatency || 0)`. `onSpeakingChange(true)` fires at that
  moment (a timer aligned to the audio clock), not at `speakEvent()` time.
- **Audible end** = the last source's `onended` + `outputLatency`. `speakEvent` resolves then. `gameStore.sayEvent`
  releases `clock.holdFor(child)` and the `'coach'` hold in its `finally`; `holdTeach` is released through
  `teachSpeaking → maybeReleaseTeach`.
- `stop()` (priority-2 cut-in, the child's move without grace, mute, dispose) resolves **immediately** after cancelling
  every scheduled source, so the clock resumes at once.
- **Watchdog**: `plan.ms + 1500` ms, in case `onended` never comes. The controller's outer cap
  (`estimateSpeechMs(text, 140) + 8000`) is a second net.
- A suspended context at `speakEvent` (autoplay block): the layer sets `needsUserGesture = true` and the controller's
  `publishGesture` holds the queue. Held phrases older than `gestureHoldMaxMs` (45 s) are dropped. The phrase that found
  the context suspended resolves after silent timing, so it never hangs the clock.
- **Budget check**: `plan.ms` is known before playing. A plan over the cap is recorded as `clip.long`
  (`teachHoldMaxMs` = 20 s).

### 4.4 Priority 2, queue and chatter

All queue rules stay in the controller. `interruptCurrent` calls `layer.stop()`, which fades out over 25 ms and
resolves. A priority-2 plan must never wait for the network, so the hot set (§4.6) contains every urgent line (mate
threats, «Стоп!», take-back offers).

### 4.5 Gentle stop (`stopSpeaking({ grace: true })`, `coachGrace.test.ts`)

- `msToSentenceEnd()` returns the exact milliseconds to the end of the sentence being heard, or `null` when nothing is
  audible yet.
- If `msToSentenceEnd() ≤ stopGraceMs` (2 s), the controller calls `layer.endAfterSentence()`: the layer cancels every
  not-yet-started source after that sentence, `speakEvent` resolves at the real sentence end, and the phrase ends by
  itself. Otherwise the phrase is cut.
- Result: no mid-word cuts in fast play.

### 4.6 Preloading

| Set | When | Size |
|---|---|---|
| Hot set: barks, every generic pool, the split set, top moves, greeting / gameStart / gameEnd lines, urgent lines | `init()` (idle) | ≈ 2.5 MB compressed |
| Strategy / move candidates / reveal and repeat units | the windows of `SPEC.md` §5.4 (`coach.prewarmClips`) | small |
| Everything else | on demand; the local server answers in < 20 ms and decode takes ≈ 2–8 ms per short clip | — |

### 4.7 Black box (`voiceDiag.ts`, Latin-only fields; clip ids are hex, so they pass `DIAG_STRING_RE`)

`clip.init` · `clip.plan {src, units, slots, split, planMs}` · `clip.lesson` · `clip.load` · `clip.end` ·
`clip.long` · `clip.gesture` · `clip.miss` · `clip.mismatch` · `clip.late` · `clip.gen`.
Miss **texts** are Cyrillic and never go to the black box. Under automation the black box is off, except with the
`gambit.e2eClips` opt-in, where it records in memory only.

---

## 5. Event → clip sequence (`packages/core/src/coach/clips/`)

### 5.1 Units, ids and normalisation

- A **unit** is one recorded clip: its key (`line:<id>#<n>`, `slot:<form>:<p>:<sq>`, `frag:<norm>|<end>` or a lesson
  unit key), `text` (what is heard: used for matching, the bubble and QA), the prompt it was cut from, take number,
  duration and QA state.
- **id** = `c` + cyrb53(`voiceKey \n prompt \n cutIndex`) as 13 hex chars: a sync 53-bit hash, the same code in Node and
  the browser, no WebCrypto needed. The id depends on what was *paid for*, never on the normalisation rules, so
  improving matching never forces a re-recording.
- **Match key** of a text fragment: NFC, lowercase, ё→е, quotes stripped, dashes unified to `—`, spaces collapsed,
  punctuation kept as boundary tokens. It is computed from `text` and is never the key of truth.

### 5.2 Resolution

1. **`event.clip`** (a `ClipUtterance` from a builder's clip twin): catalogue line ids and at most one typed slot per
   sentence (`SPEC.md` §3).
2. **Text compile** of `event.text` (`compileText`, `SPEC.md` §3.4): seams only at `— : ;` and sentence ends or around a
   slot; exact match only; ≤ 3 clips per sentence. The child's name is dropped (the bubble keeps it). A sentence that
   is not fully covered goes down the ladder.
3. **Generic line**: a pool chosen by `(kind, teach.moment, pose)`, e.g. «Смотри на зелёную стрелку!». The bubble still
   shows `event.bubbleText`, and the arrows and highlights still come from `event.board`: the specifics stay exact,
   only the voice is generic. A pool exists for every `CoachEventKind` (a unit test enforces it).
4. **None** (library not loaded, load failed): silent timing, with the mouth whispering and the bubble shown.

`onPlan` reports the exact heard text; for an answer event with a clip twin and no teacher facts the controller shows
the heard words in the bubble.

### 5.3 Liveliness

- **Barks**: a short interjection before the main line, chosen by pose (`cheer` «Ого!» «Ух ты!», `oops` «Ой-ой!»,
  `think` «Хм…» «Так-так…», `wave` «И-го-го!»), never when the line already starts with an interjection and never the
  same one twice in a row (`SPEC.md` §7.5).
- **Variety**: pool sizes follow harvest frequency, recency window of the last 10 clip ids per pool, several takes
  rotated (`SPEC.md` §7).
- **Writing for the ear**: expressiveness comes only from the text and punctuation, because the model exposes no
  emotion or speed params (§2): short sentences, exclamations, questions to the child, «мы» and «давай».

---

## 6. Misses

| Option | Used | Why |
|---|---|---|
| Browser TTS for the missing bit | **No** (inside a phrase) | Two voices in one sentence are jarring. |
| Browser TTS for the whole phrase | Only if the parent picks the browser voice | The clips chain is `['clips', 'silent']`. |
| **Generic recorded line + bubble with the full text + arrows** | **Default** (not for lesson utterances) | Always alive and in one voice; the specifics are on screen. Costs nothing at runtime. |
| Lesson utterance not fully recorded | bubble with «не озвучено» | the voice says every sentence of the bubble or none |
| Server generates the clip inside the utterance | **No** | ≈ 4 s per short job (§2) plus download, against a 1.5 s teacher deadline and 3–6 s blitz thinking times. |
| Server records it for **next time** («Дозапись голоса») | Home server only, off by default, the parent's switch, total and daily caps | `ONDEMAND.md` |

**Miss log**: the layer counts misses locally (`gambit.clipMisses`); ids, keys and kinds only, no names and no child
words.

---

## 7. Storage and manifest

### 7.1 Layout

The layout and the manifest are in `SPEC.md` §4.1–§4.2.

- `voiceKey` = a short name for (provider, variant, voice id). `giselle-mm1` = higgsfield / minimax / preset
  `9d3128b8…`. A new voice or engine gets a new folder, and the old one keeps working (A/B testing, rollback).
- **Why not `data/`**: `data/` is the child's runtime data (git-ignored, per install, backed up with games). Clips are
  product assets, identical for every child, paid once. `public/` is also where `engine/` (Stockfish) lives, served by
  Vite (dev) and by `serveStatic` from `dist` (prod, `apps/server/src/app.ts`).
- **Git**: the shipped MP3 files and the script are committed. The ledger stays local and git-ignored (its CDN URLs are
  account-specific). Masters (MP3 128k) are not committed; the tool downloads them immediately and keeps them locally,
  because CDN URLs expire.

### 7.2 Manifest

≈ 150 bytes per unit, ≈ 80–90 KB gzipped for a full library. `pools` maps catalogue pool names to ids and `keys` maps
unit keys to takes, so the planner resolves without hashing at runtime.

---

## 8. Generating the library (`tools/voice-clips/`)

The commands, prompt recipes and the spend protocol are in `SPEC.md` §10 and `tools/voice-clips/README.md`. The
structural rules:

- **Todo** = script units whose `id` has no processed file; a second run costs 0.
- **Two-step jobs for resumability**: `higgsfield generate create … --json` (no `--wait`), the job id appended to the
  ledger **immediately** as `created`, then `higgsfield generate wait <jobId> --json`. A crash between the two steps is
  resumed from the ledgered id and **never re-created**, so nothing is paid twice.
- **Rate limit** creates no job, so it is safe to retry: backoff 2 s → … → 60 s with jitter, up to 8 tries.
  Other errors keep the job id, and the next run polls it.
- **Budget**: the tool refuses without `--spend` (dry run is the default), refuses when the budget exceeds the
  account's available credits, and stops as soon as the ledgered charges reach the budget. `--max-jobs` gives a second
  cap. Agents never pass `--spend` without the operator's explicit OK.
- **Packing** (where the 50-char bucket wastes money): units are joined with `<#0.6#>` pause tags and split on the
  tag silences; if the number of pieces ≠ the number of units, the job is re-queued as smaller jobs.
- **CLI runner is injected** (`runCli(args) → Promise<json>`). Tests use a fake, so no test can spend credits.

---

## 9. Offline behaviour

- **Home install** (the server on 127.0.0.1 serves `dist`, clips included): the coach works **fully offline** at
  runtime. In clips mode the strategist's free-text `introRu` / `planRu` / `whyRu` are **not voiced**: the library's
  recorded intro, steps and goals are voiced instead, and free text stays in the bubble.
- **Degradation**: manifest unreachable → `init()` rejects → `silent`, and the status line says why. A single clip
  fails → re-planned without it (a generic line, preloaded), and if that fails too, silent timing. The game never waits
  for the network.

---

## 10. Tests (vitest, fakes only: silent and free)

The test plan is `SPEC.md` §11. The web layer's fakes: a `FakeAudioContext` (controllable `currentTime`, recorded
`start(when, offset, dur)` / `stop`, `onended` fired when fake time advances), fake `fetch` / `decodeAudioData`, fake
"MP3" bytes and a library served from memory (`clips/testAudio.ts`). Tools use a fake `runCli` and real ffmpeg only on
synthetic tones in `$TMPDIR` (skipped when ffmpeg is missing). e2e runs are silent; the opt-in `gambit.e2eClips` runs
the clips layer into a muted `GainNode(0)` in headless Chromium with `--mute-audio`.

---

## 11. «No microphone» UI

- **Dock**: with a non-conversational voice (clips, browser, silent) in a game there is no «Поговорить». A round
  **«Спроси»** button opens big chips:
  - «Почему так?»: the take-back question while it is open; in «Учитель» the current advice with its reason (a hidden
    treasure stays hidden); in «Подсказчик» `explainLastMove`; otherwise a question back.
  - «Что задумал соперник?»: a check first, then his threat from the game's null-move search, then his last move from
    board facts — never a square.
  - «Совет» / «Подсказка»: `requestHint` (teacher → repeat the advice, helper → the hint ladder). Hidden in exams.
  - «Повтори»: `replayLast()` replays the last phrase. Free, and kids miss things.

  All chips go through `gameStore.sayEvent`, so the clock is held while the answer plays. There is no free-form
  question; that needs a mic and a model.
- **Tap on Гамбитик while he speaks**: he stops (`coach.interrupt()` → `layer.stop()`; no mic opens). A tap when idle
  gives a recorded catchphrase.
- **Hidden in clips mode**: the mic indicator, the «Я в наушниках» note, `micHelp` steps, «Микрофон закрыт», the daily
  limit («Лимит на сегодня»). **Kept**: the gesture prompt «Привет! Нажми на меня» and «Не слышно? Нажми сюда»
  (`recheckAudio` → `ctx.resume()` + a silent buffer inside the click).
- **Child's thoughts after the game** (the result card, before `DiaryNote`): «Как тебе партия?» with big chips
  («Было легко», «Было трудно», «Я нашёл(ла) хороший ход», «Понял(а) свою ошибку», «Хочу реванш!», gendered by
  `address`), up to 2 taps, through the existing journal / `thoughts.ts` outbox. Гамбитик answers each chip with a
  **recorded** line («Трудно — значит, ты растёшь!»). The journal renders «(выбрал кнопкой)».
- **Voice notes from the child**: a child's voice is never transcribed (Chrome's `webkitSpeechRecognition` sends audio
  to Google, which the privacy rules do not allow). A voice diary, if offered, records locally only (the home server's
  `DATA_DIR` or the device), behind the parental lock, off by default; the app has none.
- **Settings (behind the parent gate)**: «Каким голосом говорит Гамбитик» — «Записанный голос — бесплатно, без
  микрофона» (Giselle, «Послушать» — a local clip, never offered to an automated browser — and the library line),
  «Живой разговор OpenAI — платно, нужен микрофон», «Голос браузера», «Без голоса».

---

## 12. Risks

1. **Seam naturalness** of the pieces (head + move + tail): whole sentences where frequent, seams only in punctuation
   pauses, loudness normalisation; judged on the review page.
2. **Pronunciation and stress** of chess words and ё (`text_normalization: false`): prompt spelling, the ASR gate and
   the listening review.
3. **Voice and grammar gender**: Гамбитик talks about himself in the masculine and Giselle sounds young and female, as
   Russian animation often casts actresses for boys.
4. **Template quality becomes audible**: clips say exactly what the templates say; the writing rules and the coverage
   gate guard it.
5. **Licence**: redistributing generated preset-voice audio in a public product needs a check of Higgsfield's terms;
   home use is fine.
6. **Decoded memory on low-end tablets**: float32 audio is large, so the decoded LRU stays ≤ 60 s and the hot set
   compressed.
7. **Codec gapless**: MP3 priming differs between decoders, so the player trims by scanning samples and does not trust
   container metadata.

---

## 13. Кратко (по-русски)

- **Что это.** Голос «Записи»: Гамбитик говорит заранее записанными фразами голосом Giselle. Никаких платежей за минуту,
  микрофон не нужен, дома работает без интернета. Живой голос — отдельный режим.
- **Почему это надёжно.** Записи произносят только проверенный текст приложения, поэтому нет ошибок генеративного
  голоса: не та фигура, выдуманные «Соперник ничего не меняет», выданные подарки-ходы, странные приветствия.
- **Если нужной фразы нет.** Гамбитик говорит подходящую общую фразу тем же голосом («Смотри на зелёную стрелку!»), а
  точный ход виден стрелкой и в облачке. Фраза урока звучит целиком или показывается в облачке с пометкой «не
  озвучено». Голос браузера в середину фразы не вмешивается. Недостающие фразы дозаписывает оператор (или домашний
  сервер с лимитом, `ONDEMAND.md`).
- **Для ребёнка.** Вместо «Поговорить» — кнопка «Спроси» («Почему так?», «Что задумал соперник?», «Совет», «Повтори»).
  Если нажать на Гамбитика, пока он говорит, он замолкает. После партии ребёнок отвечает большими кнопками («Было
  трудно», «Хочу реванш!»), и Гамбитик отвечает записанной фразой.
- **Часы.** Пока Гамбитик действительно звучит, часы ребёнка стоят. Если ребёнок сходил во время фразы, Гамбитик
  договаривает текущее предложение (не дольше 2 секунд) и замолкает.
