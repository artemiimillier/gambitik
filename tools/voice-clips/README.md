# tools/voice-clips — generating the «Записи» library

Implements `docs/voice-clips/SPEC.md` §10: the paid generator with its spend protocol, `process`, `verify` (with
whisper.cpp), `review`, the manifest/index writer (§4.2) — and the catalogue half: `harvest`, `script`, `plan` and
`coverage` (section «The catalogue step» below), which produce the **jobs file** described below and read the manifest.

Nothing here plays audio. `generate` is the only command that can spend credits, and only with `--spend --budget N`
after the operator's explicit OK.

## Commands (from the repository root)

| Command | Cost | Does |
|---|---|---|
| `pnpm voice:cost --jobs <file>` | free, no CLI call | jobs, units, characters, SPEC price; what the ledger already holds |
| `pnpm voice:generate --jobs <file> --budget N --spend [--max-jobs N] [--accept-audit] [--campaign C] [--overlay DIR\|off] [--resume-server-jobs]` | **paid** | spend protocol below |
| `pnpm voice:process [--force] [--job <jobId>…] [--qa static\|overlay]` | free | masters → library MP3s + unit store + manifest/index |
| `pnpm voice:verify [--no-asr] [--reasr] [--unit <id>…] [--qa static\|overlay]` | free | gates + ASR; report `test-results/voice-review/verify.json` |
| `pnpm voice:review [--composed <file>]` | free | `test-results/voice-review/index.html` for a human listener |
| `pnpm voice:ledger` | free | per campaign: jobs, pending, failed, masters, credits |
| `pnpm voice:whisper [--check]` | free | is ASR ready; `--check` verifies the model's SHA-256 |
| `pnpm voice:harvest --clip --games N [--from N] [--blitz] [--workers N]` | free, local Stockfish only | engine games with the real builders in clip mode → `.harvest/`, stats, sample, the demo game; `--analyse` redoes the outputs from the saved harvest without playing |
| `pnpm voice:script [--demo <seed>] [--budget N]` | free | catalogue + harvest ⇒ `script.giselle-mm1.json`: every unit with recipe, tier, priority, batch, takes + the catalogue lint |
| `pnpm voice:plan --tier pilot\|starter\|full [--no-write]` | free, dry run | the exact jobs of a tier (`jobs.<tier>.json`), SPEC price, reserve, minutes, MB, holdout coverage and its gain |
| `pnpm voice:coverage [--tier T \| --manifest file] [--games all] [--gate]` | free | demo game at L1–L2, «Учитель» coverage, move mentions, split share, liveliness; stale takes of a real manifest |
| `pnpm voice:demo-game [--demo <seed>] [--out file.mp3] [--planned]` | free | the whole demo game as ONE listening file: `docs/voice-samples/clips-pilot/demo-game.mp3` + `demo-game.txt` (a local, git-ignored listening folder) (section «The demo game as one file») |

Path flags (`--ledger`, `--masters`, `--units`, `--review-file`, `--library`, `--work`, `--report`, `--out`) are resolved against
the repository root; anything inside `data/` (the child's data) is refused. `--overlay <dir>` (absolute, outside every
checkout) makes the recorded overlay's files the defaults of every command and switches `process` / `verify` to the
overlay's QA rule — section «Дозапись голоса» below.

## Files

| Path | Git | What |
|---|---|---|
| `tools/voice-clips/ledger.giselle-mm1.jsonl` | ignored | one line per job event, fsync'ed before any wait; local spending history (job ids, result URLs), never committed (`.gitignore`: `tools/voice-clips/ledger.*.jsonl`) |
| `tools/voice-clips/.harvest/harvest.giselle-mm1.jsonl.gz` | ignored | the full harvest (480 games, ≈ 2.4 MB gzip) |
| `tools/voice-clips/harvest-stats.giselle-mm1.json` | commit | demand per pool / move / fragment of the ranking ¾, the held-out ¼ counts, the demo's facts |
| `tools/voice-clips/harvest-sample.giselle-mm1.jsonl.gz` | commit | 24 games (the demo + 23 held-out ones of every style / time control) for the tests |
| `tools/voice-clips/script.giselle-mm1.json` | commit | every recordable unit: key, text, recipe, tier, takes, priority, batch, lint (one unit per line) |
| `tools/voice-clips/jobs.pilot.json`, `jobs.starter.json`, `jobs.full.json` | commit | the exact paid jobs of each campaign (one job per line); `generate` reads them |
| `tools/voice-clips/composed.pilot.json` | commit | the demo's utterances + the P1 references composed from the `pilot` tier's takes, for `voice:review --composed` |
| `apps/web/public/voice/demo/<seed>.json` | commit | the demo replay (`docs/voice-clips/demo-format.md`), `?clipsDemo=<seed>` |
| `tools/voice-clips/.masters/<jobId>.mp3` | ignored | raw 128 kbps masters, downloaded immediately (CDN links expire) |
| `tools/voice-clips/units.giselle-mm1.json` | commit | unit store: every processed unit + provenance (job, cut, atempo, LUFS, flags, ASR) |
| `tools/voice-clips/review.giselle-mm1.json` | commit | listener verdicts `{"<id>":{"verdict":"ok\|redo\|reject","note":""}}` |
| `tools/voice-clips/process-report.giselle-mm1.json` | commit | last `process`: `requeue`, `rerender`, `needsEar`, `missingMasters` |
| `apps/web/public/voice/index.json` | commit | `{"default":"giselle-mm1","voices":{"giselle-mm1":"giselle-mm1/manifest.<hash>.json"}}` |
| `apps/web/public/voice/giselle-mm1/manifest.<hash>.json` | commit | SPEC §4.2 manifest (immutable, content-hashed) |
| `apps/web/public/voice/giselle-mm1/<id[1..2]>/<id>.mp3` | commit | MP3 CBR 48 kbps, mono, 32 kHz, −18 LUFS, no ID3 |

Nothing is written before there is at least one unit (no empty library for the app to load). The manifest and the
index are written with tmp + rename, the index last; the previous manifest file is kept one generation.

## The jobs file (written by `script` / `plan`)

```json
{ "v": 1, "voiceKey": "giselle-mm1", "campaign": "pilot",
  "jobs": [
    { "prompt": "Ого!<#0.6#>Смотри, тут подарок!", "take": 1, "recipe": "whole", "tier": "pilot",
      "pieces": [ { "key": "line:bark.wow#1", "text": "Ого!", "pool": "bark.wow", "kind": "bark" },
                  { "key": "line:treasure.look#1", "text": "Смотри, тут подарок!", "pool": "treasure.look" } ] },
    { "prompt": "Мой совет — конь на эф три.", "take": 1, "recipe": "head", "split": { "mode": "longest", "minSilenceMs": 150 },
      "pieces": [ { "key": "line:teach.head.advice#1", "text": "Мой совет —", "pool": "teach.head.advice" },
                  { "discard": true, "text": "конь на эф три." } ] }
  ] }
```

- One job = one Higgsfield call. `prompt` is sent exactly (tags included; 1–480 characters). `take` ≥ 1; a second
  take or a re-render of the same prompt needs `take + 1` (job key = prompt + take; a duplicate key is refused).
- `pieces` in spoken order = what the audio is cut into; `{ "discard": true }` for carrier parts.
  Unit piece fields: `key` (manifest key: `line:<pool>#<n>`, `slot:<slotKey>`, `frag:f:<norm>|<end>`), `text` (exact
  words, no tags — ASR compares against it), optional `pool`, `mood`, `tier`, `kind` (`line|slot|frag|bark`),
  `end` (`fall|any`; default: slot units and texts ending in «.»/«—» must fall), `tempo: false` to skip the tempo gate;
  for the lesson model («Дозапись голоса») `role` (`whole|lead|leadAlone|tail|frag`: a lead is checked for a continuing end)
  and `critical` (the words its placeholders produced, which the overlay's ASR check must hear). Recipe `pack`: the
  parts joined by `<#0.6#>`, split `{ "mode": "tags", "minSilenceMs": 700 }`.
- `split`: default `{ "mode": "tags", "minSilenceMs": 550 }` (every gap ≥ 550 ms is a boundary; the count must match
  `pieces`, else the job lands in `process-report.requeue` to be re-planned as smaller jobs). `longest` uses the N−1
  longest gaps ≥ `minSilenceMs` (head recipe cut at the natural dash pause).
- `campaign`: lowercase name; the budget of `generate` applies to the campaign's whole ledgered spend across runs.
- Unit ids: `c` + 13 hex of cyrb53(`giselle-mm1\n<prompt>\n<cutIndex>` [+ `\n<take>` when take > 1]) — identical
  to `packages/core/src/coach/clips/keys.ts` (`clipId`), pinned by the same golden values in both test suites.

## Spend protocol (`generate`)

1. No `--spend` or no positive `--budget` ⇒ refusal with **zero** CLI calls; every prompt is validated first.
2. One generator per ledger (`<ledger>.lock` with the pid; a dead owner's lock is taken over).
3. `higgsfield account status --json` (only `credits` is read — the e-mail in that answer is never stored or printed),
   `higgsfield model get text2speech_v2 --json` (params must be unchanged).
4. Resume: ledgered jobs without a result are polled with `generate wait`, never re-created; charged jobs without a
   master are downloaded (fresh URL via `generate get` if the old one fails).
5. Budget: campaign spend in the ledger (pending jobs at full price) + next job ≤ `--budget`; `--max-jobs` caps new
   jobs per run (`0` = resume only); the run may not need more than the balance; `generate cost` (free) of EVERY
   prompt, asked right before its create, must equal the SPEC price 0.15 × ⌈chars/50⌉ the budget and the ledger count
   with — the first one before anything is created (refusal), a later one stops the run (`stop: price`).
6. Per job, strictly sequential: an un-ledgered identical job in `generate list --audio --json` is adopted; else
   `generate create … --json` (no `--wait`) ⇒ `created` line ⇒ `generate wait` ⇒ `charged`/`failed` ⇒ download ⇒
   `downloaded`. Rate limit = exit ≠ 0 **and** `rate_limit_reached` in stderr (never the JSON): back off 2 → 60 s with
   ±25 % jitter, check `generate list` for an identical prompt before every retry, ≤ 8 tries, then stop. Any other
   create failure: adopt if the job exists, otherwise stop (no blind retry).
7. Audit: the balance read after the run must have fallen by what the ledger charged in this run — between the jobs
   created here and charged, and every job created, adopted or charged here (whichever way the provider debits;
   ± 0.01). A mismatch is an `audit` line with `ok: false`: every later run refuses with ZERO CLI calls until the operator
   has checked the provider's history and passes `--accept-audit` (an `audit` line `accepted: true`).

Ledger events: `created` (full job spec inside, so `process` needs nothing else), `charged`, `failed`, `downloaded`,
`error`, `balance` (before/after each run), `audit` (after each run that could read the balance).

## Processing (`process`)

loudness of the whole take → −18 LUFS / ≤ −1.5 dBTP (linear gain) → split (a «piece» with < 80 ms of sound is a
click, not a unit) → per unit: edge breaths stripped (a separate 80–400 ms island below −38 dBFS, unvoiced,
noise-like, ≥ 80 ms from the speech) and clicks (< 60 ms, below −35 dBFS, ≥ 120 ms away), trim at −55 dBFS, slot
units' inner pauses > 120 ms clamped to 60 ms, tempo gate 4.0 ± 0.6 syl/s (vowel letters ÷ articulation time;
outside the band `atempo` pulls to 3.5 / 4.5 within 0.8–1.3; a take that needs more is kept at the clamp, flagged
`tempo:<rate>` + `needsEar`, and listed in `rerender` while it has < 3 recordings), edge F0 ≤ 190 Hz for falling
units (`edge-f0:<Hz>` + `needsEar`) → `atempo` on the speech core → 30 ms / 60 ms margins → 5 ms raised-cosine fades
→ per-unit loudness touch-up → MP3 → `on`/`off` re-measured on the decoded MP3.

Checked on real Giselle takes (the SPEC §10.1 measurement set, scratch copy, silent, free): the tagged take M splits into
its 3 pieces (its 20 ms end click dropped), «конём на эф шесть» measured 2.96 syl/s and was pulled to 3.5 (`atempo`
1.18), K2 at 5.2 syl/s to 4.5 (0.86), the isolated «на эф шесть» (2.16 syl/s) was flagged for a re-render, K4 was
flagged for its 197 Hz ending; whisper confirmed the words of all 10 units. The period-separated batch NB (no tags)
was re-queued — natural sentence pauses are shorter than 550 ms, which is why batches need `<#0.6#>`.

`qa`: `auto` (gates passed) → `asr` (recogniser agrees) → `ear` (a listener's «Хорошо»); `needsEar` when anything is
flagged. **Only checked units are published** (`isPublishable`, manifest.ts): `asr` without a failed transcript, or a
listener's verdict `ok` (→ `ear`). Unchecked (`auto`: no ASR yet), flagged (`needsEar`: a failed ASR — maybe a wrong
square —, tempo, edge F0) and verdicts `redo` / `reject` stay out: nothing at runtime reads `qa`, so the planner then
treats the take as missing (the split form, or the generic line). The MP3 stays; nothing paid is ever deleted. So the
library appears after `voice:verify` (with whisper) or a listener's review, not after `process` alone.

## ASR (`verify`)

- whisper.cpp from Homebrew (`brew install whisper-cpp`, binary `whisper-cli`); model `ggml-small.bin`
  (multilingual «small», 487 601 967 bytes) from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin`,
  stored at `~/.cache/gambitik/whisper/ggml-small.bin` (outside the repo). Published checksums, verified on download:
  SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` (Hugging Face LFS),
  SHA-1 `55356645c2b361a969dfd0ef2c5a50d530afd8d5` (whisper.cpp `models/README.md`). `pnpm voice:whisper --check`.
- Run: `whisper-cli -m <model> -l ru -nt -np -otxt` on a 16 kHz WAV copy; ≈ 0.6 s per clip on this Mac (Metal).
- Match (`asr.ts`): normalise (ё → е, digits → words, «F6»/«Ц-4»/«С4» → «эф шесть»/«цэ четыре»), then a coarse
  phonetic key (akanye «конём» ≈ «канём», devoicing «ферзь» ≈ «ферс», word boundaries ignored). Pass =
  similarity ≥ **0.90** and every critical item heard **in order**: each square as file word + rank word adjacent,
  each piece word, «бьёт», «шах», «мат», castling words (a lone «а»/«е» is a conjunction, not a file).

### ASR calibration (26 test takes in the local, git-ignored listening folder `docs/voice-samples/clips-test/`, silent)

| Set | Result |
|---|---|
| 25 correct takes (whole, carrier, naive, list) | pass, similarity 0.94–1.00 |
| L (comma list of 6 moves) | flagged: whisper heard «Кролём ножа 1» for «королём на же один» → needs a human ear |
| 15 wrong texts against real audio (wrong piece ×6, wrong square ×4, swapped/dropped words ×5) | all fail: pieces/squares by the critical check, words by similarity ≤ 0.87 |
| every take against every other take's text | no false pass at 0.90 (closest: M vs A, 0.85, differs by «так мы») |

Whisper-small writes what it hears: «Ходи к нему на F6» for «Ходи конём на эф шесть» (akanye) — why matching is
phonetic. Slot units in isolation are short; a clip the recogniser cannot confirm becomes `needsEar`, never `asr`.

## Review page

`<audio controls preload="none">` per unit (never autoplay, nothing starts by itself, one clip at a time),
flags and what the recogniser heard, «Хорошо» / «Переписать» / «Убрать» + note, filters (все / послушать / ходы /
без оценки), «Скачать оценки» → `review.giselle-mm1.json` (existing verdicts merged; put it into `tools/voice-clips/`
and re-run `voice:process` or `voice:verify` to publish). Drafts persist in `localStorage` (wrapped in try/catch).
`--composed <file>` renders whole utterances offline with the runtime gap table (SPEC §5.3):
`{"lines":[{"name":"совет","blitz":false,"items":[{"id":"c…"},{"gap":"—"},{"id":"c…"}]}]}`; gap kinds
`. ! ? — : ; split bark`.

## The demo game as one file (`demo-game`, `demoGame.ts`)

`pnpm voice:demo-game` (after `process`): every utterance of the demo game (`apps/web/public/voice/demo/<seed>.json`,
default: the script's demo) in order, planned by the runtime planner against the published manifest (stale takes left
out; one game's recency, so a repeated pool rotates its takes as in the app) and rendered by the review renderer
(`renderComposed`: onset → offset, 5 ms fades, the SPEC §5.3 gap table, ×0.75 in 5-minute games); 0.3 s lead-in,
0.6 s between two phrases after the same move, **1.5 s between moves**; 64 kbps MP3, 32 kHz mono. Next to it
`demo-game.txt`: every move numbered in SAN («1. e4», «1… a6»), under it each phrase with its time stamp in the file,
what it became («как написано», «ход по частям», «без хвоста», «фраза выпала», «общая фраза» — the in-app demo's words)
and the builder's text when the words differ. A phrase whose take has no file is left out and listed (exit code 1).
Every phrase is heard to its end (in the app a child's move during a phrase ends it gently). The whole
`docs/voice-samples/` folder is a local, git-ignored listening folder; nothing there ships in the repo.

`--planned` needs no recording: the transcript of what the `pilot` tier's jobs WILL let Гамбитик say (marked «ПЛАН», no MP3).
Checked on a scratch stand-in library (a tone per `pilot` take, ids as `process` names them; never in the repo): 29 of 29
phrases, 2.4 min.

## «Дозапись голоса»: the recorded overlay (`docs/voice-clips/ONDEMAND.md`)

A lesson phrase without a recording is recorded on its first use by the child's server (apps/server/src/voiceGen,
through its bridge — the only server file that imports these tools) and reused from then on; the words stay the
pre-written ones of `@gambit/content`, only the voice is synthesised. The operator can also buy a stock before the child's
first game (the prefetch below). Everything paid follows the spend protocol above, on the same primitives.

### Where it lives (`overlay.ts`)

ONE folder per Mac, outside every checkout — `~/Library/Application Support/Gambitik/voice-overlay` by default,
`VOICE_OVERLAY_DIR` overrides it (`off` = none; under vitest only an explicit folder counts). The tools run without
`--env-file`, so they read that ONE line (and DATA_DIR) from this checkout's `.env` themselves — never another line, never
a key: a custom folder in `.env` is the tools' folder too (the same lock, the same ledger as the server's). A `git clean`
never deletes paid audio, and every checkout and the server share one ledger, one budget and one lock. The tools and the
server refuse the same folders (`placement.ts`): inside any git checkout, DATA_DIR or the web build.

| Path | What |
|---|---|
| `<ov>/ledger.giselle-mm1.jsonl` | the ONE on-demand ledger: the server's campaign `ondemand`, the operator's `prefetch` |
| `<ov>/higgsfield.lock` | the machine-wide generator lock (pid inside; a dead holder's lock is taken over) |
| `<ov>/publish.lock` | one writer of the unit store and manifest: the server's finish, or `process` / `verify --overlay` (they wait up to 3 min while the server publishes; the server's own `process` / `verify` children go on under their parent's lock) |
| `<ov>/index.json`, `<ov>/giselle-mm1/manifest.<hash>.json`, `<ov>/giselle-mm1/<xx>/<id>.mp3` | the overlay library, served read-only under `/api/voice/clips/overlay/` and merged over the static one by the web (core `mergeClipIndexes`) |
| `<ov>/units.giselle-mm1.json`, `<ov>/review.giselle-mm1.json`, `<ov>/process-report.giselle-mm1.json`, `<ov>/verify-report.giselle-mm1.json`, `<ov>/.masters/` | unit store (with `requeued`), the listener's verdicts, the last `process` / `verify`, the raw masters (the review page of the overlay: `test-results/voice-review/overlay/`) |
| `<ov>/state.json` | the server's breaker (not the tools') |

### The paid primitives (`ondemand.ts`, used by the server and by `generate`)

- **Ledger lines** on top of the tools' ones: `intent` (fsync'ed BEFORE `generate create`; until a `created` or `absent`
  line of its job key the job may exist and may have been debited — it counts at full price), `absent` (three fresh list
  checks found nothing), and on `created` the fields `via` (`parse` / `get` / `list`) and `createShape` (the create
  output's key skeleton, values masked: the next paid job reveals the real shape of `generate create --json` for free).
- **`createJob`**: intent → create → `parseCreated` (the id at the top, under `job` / `data`, the single element of
  `jobs` / `items` / `data` / `results` / `job_ids` — never `job_set_id` / `request_id`, never one of several ids) →
  accepted only when the output carries our prompt, or a free `generate get` confirms prompt and voice → otherwise one
  fresh look at `generate list` (exactly our prompt and voice, not failed, unknown to BOTH ledgers, created ≥ intent − 5 s)
  → `created`. Rate limit: back off 2 → 60 s, look at the list before every retry, ≤ 8 tries. Two or more matching
  un-ledgered jobs: all are ledgered as spend, outcome `duplicate`. No credits / an expired sign-in: outcome
  `no-credits` / `login` (the intent stays open). Anything else unresolved stays an open intent — never re-created blindly.
- **`adoptIntents`**: resolves open intents (at start, after an ambiguous create): ≤ 3 list checks 1 s apart, adopted
  or `absent`; an unreadable list resolves nothing.
- **`downloadJob`** (atomic MP3, a fresh URL once via `generate get`), **`unitAttempts`** (charged + pending + open
  intents holding a unit key — failed jobs never count; ≤ 2 paid attempts per unit key EVER, +1 after a listener's
  `redo`), **`spentByDay(view, tz)`** (charged + pending + open intents at full price, by the local day of the line),
  **`isNoCredits`** / **`isAuthProblem`** (exit ≠ 0 and the error text; never the whole JSON), **`waitArgs`**
  (`--interval 1s`), **`lockGlobal(dir, {waitMs})`**.
- `realRunCli` runs the CLI with `NO_COLOR=1 HIGGSFIELD_NO_UPDATE_CHECK=1 HIGGSFIELD_DISABLE_TELEMETRY=1`.

### `generate` and the overlay

- Every run holds the machine-wide lock of the overlay folder for its whole length (`--overlay DIR`, else
  `VOICE_OVERLAY_DIR`, else the default; `--overlay off` = none, printed as a warning). It waits up to 60 s for it (the
  server holds it ≈ 5 s per phrase) and then refuses with zero calls. `lockLedger(file, { globalDir, waitMs })` takes
  both locks (global first); plain `lockLedger(file)` only the ledger's (the server takes `lockGlobal` itself first).
- **S7**: it refuses — with zero CLI calls — while the overlay ledger has a job of another campaign pending or an intent
  nobody resolved: that job's debit or refund would land inside this run's balance audit. The server finishes its jobs
  itself only while recording is on (GAMBIT_CLIP_GEN=1, CLIP_GEN_BUDGET, the parent's switch); otherwise pass
  `--resume-server-jobs`: the run first brings them home itself, free (`generate list` / `wait` / `get`, the download
  into `<ov>/.masters`), before it reads the balance.
- Into the overlay, right before each create, every unit of the job is checked again BY UNIT (`dedup.ts`): published
  (exact key or the text index, static or overlay), blocked or rejected, or held by any overlay job that did not fail —
  a job with such a piece is skipped (`skipped` in the summary): the plan is out of date, make it again.
- It never adopts a job the other ledger owns (the overlay's when writing the tools ledger, and the other way round).
- Into the overlay ledger (`--overlay DIR` without `--ledger`, or `--ledger <ov>/ledger.giselle-mm1.jsonl`) it writes
  intent lines, counts open ones in the budget, resolves a crash's open intents first, and keeps its masters in
  `<ov>/.masters`. On the (local, git-ignored) tools ledger nothing changes: no intent lines, the same tests.

### The overlay's QA rule (`process` / `verify` with `--overlay DIR` or `--qa overlay`)

The static library keeps its strict rule. The overlay publishes only ASR-confirmed takes (`qa: "asr"`, or a listener's
«Хорошо»), but only HARD gates hold a take back:

| Hard (not published) | Soft (published, first on the review page) | What processing does instead |
|---|---|---|
| ASR ≥ 0.90 with the critical items in order — the placeholder words of the wording (`{конём}`, `{g:сам\|сама}` …, from the unit or its key) and an opening interjection too; units of 1–2 words ≥ 0.75 (the piece word still required) | rate after `atempo` outside 3.4–4.6 (`tempo-soft`) | a lead (`role: lead\|leadAlone`) whose end F0 stays > 210 Hz: published `ctx: "cont"` (only before its tail) |
| 55–140 ms per character, ≥ 20 % voiced, no peaks / clipping, median F0 140–480 Hz | end F0 190–210 Hz (`edge-f0-soft`; any F0 on a non-lead falling unit) | loudness 1–2.5 LU off: re-encoded with the corrected gain (`regain`) |
| the split count (else re-cut, else `requeued`) | «всё/все» (`yo`), a quoted opening name (`name`), an options sentence with a comma inside a label (`frag-comma`) | a tag that came out short: re-cut for free at the longest pauses ≥ 250 ms (`recut`, soft; ASR checks each piece) |
| rate after `atempo` outside 3.2–5.4 syl/s (`tempo`); loudness > 2.5 LU off | | |

`tempoDecision` judges the rate after the clamped `atempo` (for both libraries: 5.63 syl/s reaches 4.5 at ×0.8).
The overlay manifest also carries every take under the keys of the piece / gender variants whose wording expands to the
same words (`alsoKeys`), and **`blocked[]`**: unit keys with no publishable take and nothing in flight whose paid
attempts are used up (2 processed charged jobs — a take or a re-queued split —, 3 after `redo`) or whose take a listener
rejected. The book avoids them, the server never requests them again; a later good take or verdict unblocks.

The pack recipe (core `clips/tts.ts`, `pack.ts`): a request's uncovered parts in spoken order joined by `<#0.6#>`,
≤ 4 parts, ≤ 240 characters (≤ 0.75 credits), one question at most and last, a lone lead with «.», a lead before its
tail without an end mark, quotes dropped (the unit's `text` keeps the exact expansion); split `tags` ≥ 700 ms (in the
`pilot` tier's takes every tag pause measured ≥ 770 ms, every natural pause ≤ 610 ms). The options sentence of stages 1–2 is a job of its own.

### Prefetch: a stock before the first game

Free plan (plays nothing, calls nothing): from a reference run of the «recorded first» book on another seed, the units
a game of the child's stage needs most per credit, packed:

```
pnpm teach:report --games 50 --voice k3c --seed 7 --out test-results/voice-ref        # once, free, ≈ 1 min
pnpm teach:report --prefetch-plan 20 --prefetch-from test-results/voice-ref --stage 1 --gender m \
                  --overlay ~/Library/Application\ Support/Gambitik/voice-overlay    # required: skips what it holds
```

It writes `test-results/voice-prefetch/prefetch.s<stage><g>.jobs.json` (campaign `prefetch`, take 101, the packed jobs
with each piece's role and placeholder words), skipping what the static library, the overlay and its ledger already
hold (`--overlay` is required: a plan blind to the server's recordings would pay for them again). At stages 1–2 the question, right / wrong and the options sentences count double (a child
who cannot read yet). Recording it is PAID — the operator, or an agent with the operator's explicit OK and a named budget:

```
pnpm voice:cost     --jobs test-results/voice-prefetch/prefetch.s1m.jobs.json --overlay <ov>
pnpm voice:generate --jobs test-results/voice-prefetch/prefetch.s1m.jobs.json --overlay <ov> --budget 20 --spend
pnpm voice:process --overlay <ov> && pnpm voice:verify --overlay <ov> && pnpm voice:review --overlay <ov>
```

(the same as `voice:generate --campaign prefetch --ledger <ov>/ledger.giselle-mm1.jsonl --masters <ov>/.masters …`).
`pnpm voice:ledger --overlay <ov>` shows both campaigns, today's and the total spend, and any open intent.

The server records whole catalogue sentences on demand under the static library's own keys (`line:greet.hello.day#2`),
so a static campaign (`voice:generate --jobs jobs.full.json`, the tools ledger) checks every job BY UNIT against the
overlay too, right before its create (`dedup.ts` `generateCoverage`): a job holding a sentence the server published or
is recording is skipped (rebuild the plan with `pnpm voice:plan --tier …`). A unit is its words: the same words under
another piece's or another line's key (`alsoKeysOf`) are the same unit, and the server never buys again a `pilot` take
the recogniser confirmed that still waits for `voice:review`, and counts the tools ledger's paid attempts in its 2.

## The whole library in advance: `voice:library-plan` / `voice:library-run`

Every phrase the app can say, recorded before a child needs it — campaign `library`, at most
`LIBRARY_MAX_BUDGET` = **1700 credits** (a hard cap in `library.ts`; `--budget` above it is refused). `library.ts` plans, `libraryRun.ts` records.

| Command | Cost | Does |
|---|---|---|
| `pnpm voice:library-plan [--overlay DIR] [--ref DIR] [--out DIR]` | free, no CLI call | the library minus what is covered, packed; `tools/voice-clips/.library/library.jobs.json` |
| `pnpm voice:library-run --dry-run` | free, no CLI call | the same plan and the portions a run would make |
| `pnpm voice:library-run --spend --budget N [--portion 40] [--in-flight 3] [--max-jobs N] [--accept-audit]` | **paid** | records the plan into the overlay, checks it with whisper, publishes it |

- **What**: every lesson part (each wording × the pieces of its subject × the child's gender, exactly as the server
  renders it — `library.test.ts` re-renders every unit with the server's own `unitFromPiece`), every stage 1–2 options
  sentence (each order × each button wording: 716), every whole catalogue sentence the server records on demand
  (greetings, the new-game wizard, answers, start and end, take-back replies, the parent's gates …). One unit per
  words (the twins). 9 078 units for the committed catalogue.
- **Minus** what is covered — the server's rule (`dedup.ts` `coveredWhy`): published (static or overlay), blocked,
  rejected, held by an overlay job or an open intent, a `pilot` take waiting for `voice:review`, out of paid attempts.
- **Order**: the plain and the boy's variants first, the girl's after them; inside, the expected uses per game — a
  pool's uses in a free reference run (`pnpm teach:report --games 60 --voice k3c --seed 7 --out tools/voice-clips/.library/voice-ref`,
  shared by its wordings), a catalogue sentence's harvest demand (at ¼ for the families only «Подсказчик»
  says), an options sentence's quiz kind shared by its orders.
- **Packing**: the pack recipe above (≤ 4 parts, `<#0.6#>`, ≤ 240 characters, one question only last, split at tag silences
  ≥ 700 ms); a part joins a job only when that costs no more than recording it alone, within blocks of 400 units of
  the order. A lead before a tag is sent without its end mark, as a job's last part with «.». Options sentences alone.
  For the committed catalogue: 8 971 units in 2 963 jobs, 1 539.75 credits at the SPEC price (alone: 1 666).
- **Run**: portions of `runGenerate` (the whole spend protocol above, the machine-wide lock let go between portions);
  `--in-flight N` waits overlap, creates stay one at a time. Each charged job is finished in the background — the
  tools' `process` + `verify --overlay` as children, their own reports in `.library/` — and published if whisper agrees.
  After the plan is empty and every take is checked, the **retake pass**: a unit whose take really failed gets its take
  2 alone (take 101 + attempts); never a third. Stops on the budget, on what a person must look at (no credits, the
  sign-in, a price or model change, a failed audit, duplicates), on the finish failing 3 times, on Ctrl-C or
  `touch tools/voice-clips/.library/STOP`. A passing hiccup (a 5xx at a create, a wait without answer, the rate limit)
  pauses 2 minutes and the same portion goes on (≤ 5 times in a row). A new run resumes from the ledger.
- **Progress**: `tools/voice-clips/.library/progress.json` (jobs, credits, balance, published / to hear, what is left).
  Not in `test-results/`: Playwright empties that folder when it starts.

## Tests

`pnpm vitest run tools/voice-clips` — fake `runCli` for everything paid (no `--spend` ⇒ zero calls, budget cap,
`--max-jobs`, 429 backoff without duplicates, resume from the ledger, adoption, torn ledger lines), a fake
`higgsfield` on PATH for the real CLI entry, real ffmpeg on synthetic tones in `$TMPDIR` for process/verify/review
(skipped without ffmpeg), golden whisper transcripts for the matcher, and one real whisper run on a recorded test take
(skipped without the model or the take). «Дозапись голоса»: `ondemand.test.ts` / `ondemand.paid.test.ts` (the create
path with every output shape, intents, adoption windows, duplicates, the global lock, S7, the prefetch into the
overlay — a fake CLI on a fake clock), `overlay.test.ts` (the overlay's rule, `alsoKeys`, `blocked[]`, the 700 ms pack
split on synthetic PCM) and `process.overlay.test.ts` (process + verify under the overlay rule with ffmpeg on tones).

## The catalogue step: harvest → script → plan → coverage

All four are free and silent: no Higgsfield call, no network, no audio, nothing in `data/`, no port. The catalogue itself
(the Russian lines, the twins, the planner) lives in `packages/core/src/coach/clips/`; the tools import it by relative
path (the tools package has no `@gambit/core` dependency).

### `harvest --clip` (`harvest.ts`, `harvestWorker.ts`)

- Each worker process runs the production
  `createJudgeEngine` / `createBotEngine` (apps/web/src/engine, loaded by path) on Stockfish 19 lite-single WASM child
  processes, the real builders of `@gambit/core` (every ported builder attaches `CoachEvent.clip`), the real content
  (strategies, repertoire, main lines, concept cards, openings). 480 games take ≈ 3 minutes on 16 workers.
- Game `i` is a pure function of `i` (`gameConfigOf`): ≈ ¾ «Учитель» (stages 1–4), ≈ ¼ «Подсказчик» (stage 5); half
  the games 5-minute, a quarter 10-minute, a quarter untimed (`--blitz`: all 5-minute); colours alternate; talkativeness
  70 % «Обычно», 15 % «Тихо» (the short style), 15 % «Болтливо». The bot's random choices come from a per-game
  generator and both engines clear their hash per game, so any game replays identically on any worker. A simulated
  clock (the child thinks 1.5–7.5 s, now and then 7–27 s; speech holds the clock) gives «Поторопись!» and time-outs.
- Child policy: 60 % green arrow, 10 % blue, 15 % one of the engine's three, 15 % any move; take-back
  offers accepted 70 %; «Совет» on 12 % of turns; a treasure found 50 % of the time.
- A quarter of the games (index pairs 2–3, 10–11, …: both colours) is **held out**: the script ranks on the others,
  `plan` / `coverage` measure on these (SPEC §11 holdout method).
- Demand = what the planner would voice: every event is planned against a *probe* library that has every catalogue
  pool, move slot and compiled fragment exactly once, with the event's real context (5-minute caps, SAN guard, generic
  fallback, no bark), so the chosen take ids name the exact pools / keys heard.
- The demo game (SPEC §9): a 5-minute «Учитель» game, the child White, ≥ 15 teacher turns, a treasure, a danger, a
  praise, a take-back offer, a strategy intro and a game end, and every event voiceable (no text-compiler sentence that
  must fall to the generic line); among those the score prefers the default talkativeness, a boy, a won game by mate,
  no bridge events and a length one can watch. The committed demo: **`g174`** — «Учитель», 5 минут, белые, Итальянская
  партия, Тигр (m), 35 half-moves, 17 teacher turns, 3 treasures (two forks, mate in one), 2 reveals, a danger, 3
  praises, a take-back offer (declined, «Риск — дело интересное»), a promotion with «— и станет ферзём!», castling,
  mate. `?clipsDemo=g174`.

### `script` (`script.ts`)

Units: every wording × variant of every catalogue line (`catalogUnits`: a plain wording of a `byPiece` line is one unit
serving every piece pool — `pools` —, a `{g:…}` wording two), all 1 140 move slots, the 140 split units, and the
recordable bridge fragments (never one right before a square). Recipes by role: whole · head · tail · bark ·
slot-batch. Lint: masculine self-reference (a feminine «я рада» / «я заметила» is an error), no square
outside slot units, the piece word of each variant, length caps, no Latin, slot text = `canonicalSlotText(key)`;
catalogue lint clean; 2 bridge fragments over 12 words are excluded.

Tiers: `pilot` = what `planPilot` records for the demo; `starter` (≈ 84 credits on top of `pilot`, the packed price is
searched to fit) = the split set → what the harvest never hears, whatever the budget: every line the web says on a
tap (`CLIP_TAP_LINES` of core: «Спроси» answers, the opponent's move and threat, thought replies, poke, «Послушать»;
2 wordings of a plain line, the poke 4, each piece pool once) and ≥ 4 wordings of every generic line of L5 (`generic`,
`generic.<kind>[.<moment>][.<pose>]`) → one recording for every pool the ranking games hear (the exact variant first) →
teacher bridge fragments ≥ 0.3×/game → more wordings up to SPEC §7.1 (≥ 1×/game 4, ≥ 3×/game 6) → a second take of the
≥ 3×/game pools → whole move units by rank (as many as the starter's heads and tails carry for free, then paid ones);
`full` = the rest. The committed script must equal a fresh build (script.test.ts): after a catalogue edit run
`pnpm voice:script` and `pnpm voice:plan --tier pilot|starter|full`.

### `plan --tier` (`planJobs.ts`): recipes and packing

| Recipe | Prompt | Split |
|---|---|---|
| whole | ≤ 3 lines joined by `<#0.6#>`, only where they fill the 50-character bucket the first line opened; a `?` line last, one per job | tags ≥ 550 ms |
| bark | ≤ 4 interjections by `<#0.6#>`, `tempo: false` | tags |
| head | «Мой совет — конём на эф три.»: the head + a REAL move unit of the campaign in the head's form (`HEAD_SLOT_FORM`; a capture fits both) — recorded in context for free —, else a discarded carrier | `longest` ≥ 150 ms |
| tail | «Конём на эф три<#0.3#>— выводишь коня в игру.»: a real move unit (else a discarded carrier), the short tag, the tail | `longest` ≥ 250 ms |
| slot-batch | ≤ 15 units, ≤ 450 characters, «Конём на эф три.» by `<#0.6#>` (a final fall for every slot) | tags |
| single | one line alone (the `pilot` tier's probes) | — |

Two jobs with one prompt become take 1 and take 2 (a unit with `takes: 2` is packed twice, in different jobs).

### The `pilot` job list (SPEC §9, hard cap 15)

`tools/voice-clips/jobs.pilot.json`, campaign `pilot` — the starter clip set that covers the demo game: **75 jobs, 137 takes, 3 570 characters, 13.5 credits at the SPEC
price** (14.85 with the 10 % re-render reserve ≤ 15). `pnpm voice:plan --tier pilot` recomputes it (and fails above
13.5 / 15 or when the demo is not fully voiced). planJobs.test.ts checks that it pays only for lines the runtime can
play (a builder of the demo, the planner's walk from there, a bark, a tap of the web).

- Demo units (D1–D5): every pool, move and tail of EVERY sentence of the demo's utterances — also the ones a 5-minute
  game's caps drop, because the planner resolves every sentence before it caps and a missing one would count as L4
  («фраза выпала» in the demo log) —: 14 heads (+ 3 second wordings; every head job carries one of the demo's moves),
  13 tails (+ 1), 18 moves (castling in the slot batch), the demo's whole lines (greeting, the Italian intro,
  «Стоп-стоп…», praise, treasures, game end …).
- D6 split sample: «пешка», «конь», «конём», «слон» + «на е четыре», «на эф три», «на дэ два», «на цэ четыре» and four
  more squares — A/B with the whole units of the same moves.
- P1: two whole teacher turns alone («По нашему плану — конь на эф три — выводишь коня в игру.», «Следующий шаг плана —
  слон на дэ три — готовишь рокировку.»); `composed.pilot.json` puts each next to the same words composed from the
  `pilot` tier's head · move · tail takes (blind A/B).
- P2: the five whole lines the demo says most, alone (packed vs single, take variance, tempo reject rate).
- P3: one packed job: «на е два», «на же пять», «на аш семь», «на а шесть» each plain and with U+0301 stress marks,
  «бьёт на е шесть», «ладьёй», «ферзём», «пешко́й».
- Extras while ≤ 13.5: a second wording wherever the demo repeats a pool, «Послушать» (`preview`), the generic lines of
  the demo's moments (the danger / hidden-treasure turn's `generic.teachTurn.turn.think` first: its L5 never walks up
  to a line that names an arrow), the «Спроси» answers exactly as clipAsk says them (`ask.why.think`,
  `ask.opp.notYet`, `ask.opp.none`, `ask.repeat.stale`), 12 barks (3 per pose; never in 5-minute games), the
  opponent's moves of the demo as «Что задумал соперник?» says them, dangers.

Recording it («Озвучка», with an explicit OK only): `pnpm voice:cost --jobs tools/voice-clips/jobs.pilot.json` →
`pnpm voice:generate --jobs tools/voice-clips/jobs.pilot.json --budget 15 --spend` → `pnpm voice:process` →
`pnpm voice:verify` → `pnpm voice:review --composed tools/voice-clips/composed.pilot.json` →
`pnpm voice:coverage --gate` (the real manifest: the demo at L1–L2, stale takes listed).

### Coverage (`coverage.ts`, gate `coverage.test.ts`)

Measured on the 120 held-out games of the committed harvest (`pnpm voice:plan --tier …`), each library including the tiers
below it:

| Library | Price (SPEC) | «Учитель» turns without the generic line | fully (no tail dropped) | moves named voiced | split form | liveliness |
|---|---|---|---|---|---|---|
| `pilot` | 13.5 | 23.7 % | 8.3 % | 23.6 % | 44 % | — (demo only) |
| + starter | + 84 | 100 % | 74.2 % | 100 % | 37.7 % | distinct ÷ plays 0.78 (the helper's hint generic repeats) |
| + full | + 172.5 | 100 % | 100 % | 100 % | 0 % | 0.88, no take > 1.5× a game |

- The demo game resolves 29 of 29 utterances at L1–L2 from the `pilot` tier alone (gate).
- Split form: the starter carries every tap line and ≥ 4 wordings of every generic line whatever the budget —
  ≈ 13 credits that would otherwise buy whole move units (84 cr: split 37.7 % instead of 24.7 %, «fully» 74.2 %
  instead of 82.8 %). Measured with the same harvest: ≈ 97 credits give ≈ 24 % split, ≈ 110 give
  ≤ 15 % (SPEC); the move mentions of «Учитель» are spread over ≈ 960 distinct moves in 360 games. A split move in
  H·S·T also costs the reason tail (≤ 3 clips per sentence). The Starter budget is chosen after hearing the `pilot` tier's split sample
  (D6). The CI gate (coverage.test.ts) allows < 45 % split for the 84-credit starter.
- The helper's hint ladder and the «слабее, чем совет» reactions still speak through the text compiler: their
  sentences name squares that are not the advice, so they fall to the generic line until their families get twins
  (no recording can fix that). Threat warnings compile into fragments the starter records.
- A real manifest is checked the same way (`pnpm voice:coverage`); takes whose key has different words in the
  catalogue than the take are listed as stale and left out.
