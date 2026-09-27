# «Записи»: the demo replay file (`voice/demo/<seed>.json`)

The contract between the tools (`harvest --clip`, which writes the file) and the web layer (which replays it).
Code: `apps/web/src/coach/clips/clipsDemo.ts` (`parseClipsDemo`, `createDemoReplay`, `sampleClipsDemo`) and
`apps/web/src/coach/clips/ClipsDemo.tsx` (the screen). SPEC §9 «Demo game».

## Where it lives and how it is opened

- File: `apps/web/public/voice/demo/<seed>.json` (served next to the library; `<seed>` matches `^[A-Za-z0-9_-]{1,40}$`).
- Opened on the **dev server only**, behind the parental lock: Settings → footer «Для разработчика: демо «Записей»»
  (the built-in `sample`), or the URL `?clipsDemo=<seed>` (also inside the hash: `#/settings?clipsDemo=w0g0`).
  The production bundle contains neither the screen nor the import (`import.meta.env.DEV`).
- The screen runs its **own** coach controller with the chain `['clips', 'silent']` (never a paid or a robot voice),
  its own Гамбитик, a small board, the child's clock and a log of what every phrase became («как написано»,
  «ход по частям», «без хвоста», «фраза выпала», «общая фраза»). Under automation it is silent (or, with
  `gambit.e2eClips`, the clips layer into a muted `GainNode(0)`).

## JSON (v1)

```json
{
  "v": 1,
  "seed": "w0g0",
  "title": "«Учитель», 5 минут, белые, Итальянская",
  "voiceKey": "giselle-mm1",
  "timeControlId": "blitz5",
  "coachStyle": "teacher",
  "childColor": "w",
  "startFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "clockMs": 300000,
  "intro": [
    { "event": { "id": "w0g0-greeting", "kind": "greeting", "priority": 1, "text": "Привет! …", "bubbleText": "Привет! …",
                 "pose": "wave", "pauseClock": false, "clip": { "sentences": [ … ], "generic": "generic.greeting" } } },
    { "event": { "id": "w0g0-start", "kind": "gameStart", … }, "delayMs": 300 }
  ],
  "plies": [
    { "by": "child", "uci": "e2e4", "thinkMs": 4200 },
    { "by": "bot", "uci": "e7e5", "thinkMs": 1500,
      "after": [ { "event": { "id": "w0g0-t2", "kind": "teachTurn", "priority": 1, "text": "…", "bubbleText": "…",
                              "pose": "think", "pauseClock": true,
                              "teach": { "moment": "turn", "style": "short", "ply": 3, "advice": [ { "uci": "g1f3", "san": "Nf3", "source": "engine", "arrow": "green" } ] },
                              "clip": { "sentences": [ { "items": [ { "line": "teach.head.advice" }, { "slot": "ins", "san": "Nf3", "fen": "…" } ], "prio": 100, "end": "." } ],
                                        "generic": "generic.teachTurn.turn", "bark": "think" },
                              "board": { "arrows": [ { "from": "g1", "to": "f3", "color": "green" } ], "highlights": [] } } } ] }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | `1` |
| `seed` | yes | the file name without `.json` |
| `timeControlId` | yes | `training` · `rapid10` · `blitz5` · `bullet1` (5 / 10 minutes: every phrase holds the child's clock, as in the game) |
| `childColor` | yes | `w` / `b` (the board is drawn from the child's side) |
| `plies[]` | yes | every move in order, both sides: `by` (`child` / `bot`), `uci` (`e2e4`, `e7e8q`), optional `thinkMs` (wall time from that side's turn start; defaults 3500 child / 1200 bot), optional `after[]` (what the coach said after this move) |
| `intro[]` | no | said before the first move (greeting, game start / strategy intro) |
| `…after[]` / `intro[]` items | — | `{ "event": CoachEvent, "delayMs"?: number }` — the event exactly as the real builders produced it in the harvest (in clip mode: with `clip`), `delayMs` = pause before it (default 150) |
| `title`, `voiceKey`, `coachStyle`, `startFen`, `clockMs` | no | shown / used as named; no `clockMs` = no clock |

Validation (`parseClipsDemo`): every move must be legal in order from `startFen` and made on its side's turn; the
first bad ply stops the list (everything before it stays replayable) and is reported on the screen. An event needs
`id`, `kind`, `text`; `bubbleText` defaults to `text`, `pose` to `talk`, `priority` to 1.

## Replay rules (mirror the game)

- Events are handed to the coach controller's `say()` in order (its queue, priority rules and bubble apply).
- The child's clock runs on the child's turn and stands while a phrase that holds it is pending (`pauseClock`, or any
  phrase in 5 / 10 minutes) — exactly the game's `sayEvent` rule; `say()` resolves at the audible end.
- A child move that comes while Гамбитик is audible calls `stopSpeaking({ grace: true })` — the gentle stop
  (the sentence being heard ends, ≤ 2 s). The screen counts these.
- Pause / continue / restart; «в 2 раза короче» halves the waits (never the audio).

## Writing the file

`pnpm voice:harvest --clip --games N` writes the best demo candidate (SPEC §9: a seeded 5-minute «Учитель» game,
child as White, ≥ 15 teach turns, with a treasure, a danger, a praise, a take-back offer, a strategy intro and a game
end) as `apps/web/public/voice/demo/<seed>.json`. The committed one is **`g174`** (Italian, Тигр, 35 plies, 29 events,
every one a builder twin). A take-back is replayed as said on the child's turn (the taken-back move itself is not in
`plies`, which hold the game's final moves only). `tools/voice-clips/coverage.test.ts` asserts that 100 % of the demo's
utterances resolve at L1–L2 from the `pilot` tier.
