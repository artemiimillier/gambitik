/**
 * `voice:review` (free): a static page for the parent — `test-results/voice-review/index.html` — with every unit
 * (`<audio controls preload="none">`, never autoplay, nothing starts by itself), the automatic findings (qa, flags,
 * what the recogniser heard) and three verdict buttons per clip: «Хорошо» (ok), «Переписать» (redo), «Убрать» (reject).
 * «Скачать оценки» exports `review.giselle-mm1.json` (the existing verdicts merged with the new ones); the parent
 * puts that file into tools/voice-clips/ and the next `voice:process` / `voice:verify` applies it.
 *
 * Optional composed lines (`--composed file.json`, written by the planner): sequences of unit ids and gaps rendered
 * OFFLINE with the runtime gap table (SPEC §5.3: «.»/«!» 450 ms, «?» 500, «—» 280, «:» 240, «;» 260, split 250,
 * bark 200; ±30 ms jitter; ×0.75 in blitz) into MP3s next to the page, so the parent hears whole utterances as the
 * child will. Tools never play audio themselves.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FADE_MS, GAP_JITTER_MS, GAP_MS, SAMPLE_RATE, VOICE_KEY } from './config.ts';
import type { GapKind } from './config.ts';
import { decodeToPcm, writeMp3 } from './audio.ts';
import { applyFades, msToSamples } from './dsp.ts';
import { readStore, readVerdicts } from './manifest.ts';
import type { UnitRecord, UnitStore, Verdicts } from './manifest.ts';
import { isSoftFlag } from './overlay.ts';

export interface ComposedLine {
  name?: string;
  blitz?: boolean;
  items: ({ id: string } | { gap: GapKind })[];
}

export interface ReviewOptions {
  storeFile: string;
  reviewFile: string;
  libraryRoot: string;
  outDir: string;
  work: string;
  composedFile?: string;
  now?: () => Date;
}

export interface ReviewResult {
  page: string;
  units: number;
  composed: number;
  skipped: string[];
}

/** Deterministic PRNG (mulberry32) so a re-render of the review is byte-identical. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The gap before the next clip, in ms: table value ± jitter, ×0.75 in blitz. */
export function gapMs(kind: GapKind, random: () => number, blitz = false): number {
  const base = GAP_MS[kind] + (random() * 2 - 1) * GAP_JITTER_MS;
  return Math.round(base * (blitz ? 0.75 : 1));
}

/**
 * Renders one composed line to PCM exactly as the runtime player schedules it: each clip from its onset to its offset
 * (`on`/`off` of the manifest) with 5 ms raised-cosine fades, then silence for the gap.
 */
export async function renderComposed(line: ComposedLine, store: UnitStore, libraryRoot: string, seed: number): Promise<{ pcm: Float32Array; text: string } | { missing: string }> {
  const random = mulberry32(seed);
  const parts: Float32Array[] = [];
  const words: string[] = [];
  for (const item of line.items) {
    if ('gap' in item) {
      parts.push(new Float32Array(msToSamples(gapMs(item.gap, random, line.blitz === true), SAMPLE_RATE)));
      continue;
    }
    const unit = store.units[item.id];
    if (unit === undefined) return { missing: item.id };
    const pcm = await decodeToPcm(path.join(libraryRoot, VOICE_KEY, unit.file), SAMPLE_RATE);
    const from = Math.max(0, msToSamples(unit.on, SAMPLE_RATE) - msToSamples(FADE_MS, SAMPLE_RATE));
    const to = Math.min(pcm.length, msToSamples(unit.off, SAMPLE_RATE) + msToSamples(FADE_MS, SAMPLE_RATE));
    parts.push(applyFades(pcm.slice(from, to), SAMPLE_RATE));
    words.push(unit.text);
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { pcm: out, text: words.join(' ') };
}

function relUrl(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).map(encodeURIComponent).join('/');
}

interface PageUnit {
  id: string;
  key: string;
  text: string;
  pool: string;
  tier: string;
  kind: string;
  qa: string;
  flags: string[];
  heard: string;
  score: number | null;
  ms: number;
  take: number;
  src: string;
}

interface PageComposed {
  name: string;
  text: string;
  src: string;
}

/** `<` never appears raw inside the embedded JSON, so no text can close the script element. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function reviewHtml(units: PageUnit[], composed: PageComposed[], verdicts: Verdicts, generatedAt: string): string {
  const data = jsonForScript({ units, composed, verdicts, generatedAt, voiceKey: VOICE_KEY });
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Гамбитик: проверка записей</title>
<style>
  :root { --bg: #fbfaf7; --fg: #1d1b16; --muted: #6b665a; --card: #ffffff; --line: #e6e1d6; --ok: #2f7d32; --redo: #b26a00; --bad: #b3261e; --accent: #3b5bdb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16150f; --fg: #eeeadf; --muted: #a39d8f; --card: #201f18; --line: #34322a; --ok: #7bc47f; --redo: #f0a84a; --bad: #f28b82; --accent: #8ea6ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 -apple-system, system-ui, "Segoe UI", sans-serif; }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 16px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .bar button, .verdict button { font: inherit; font-size: 14px; border: 1px solid var(--line); background: var(--card); color: var(--fg); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
  .bar button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
  .muted { color: var(--muted); font-size: 13px; }
  main { max-width: 960px; margin: 0 auto; padding: 12px 16px 64px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin: 10px 0; }
  .text { font-size: 19px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 12px; word-break: break-all; }
  .flags span { display: inline-block; font-size: 12px; border-radius: 6px; padding: 1px 6px; margin: 4px 4px 0 0; background: rgba(179, 38, 30, 0.1); color: var(--bad); }
  .heard { font-size: 13px; color: var(--muted); margin-top: 4px; }
  audio { width: 100%; margin-top: 8px; }
  .verdict { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
  .verdict button.on[data-v="ok"] { background: var(--ok); border-color: var(--ok); color: #fff; }
  .verdict button.on[data-v="redo"] { background: var(--redo); border-color: var(--redo); color: #fff; }
  .verdict button.on[data-v="reject"] { background: var(--bad); border-color: var(--bad); color: #fff; }
  .verdict input { flex: 1 1 180px; min-width: 0; font: inherit; font-size: 14px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
  h2 { font-size: 17px; margin: 22px 0 6px; }
</style>
</head>
<body>
<header>
  <h1>Гамбитик: проверка записей</h1>
  <div class="bar">
    <button type="button" data-filter="all" aria-pressed="true">Все</button>
    <button type="button" data-filter="ear">Нужно послушать</button>
    <button type="button" data-filter="slot">Ходы</button>
    <button type="button" data-filter="open">Без оценки</button>
    <button type="button" id="export">Скачать оценки</button>
    <span class="muted" id="count"></span>
  </div>
  <div class="muted">Звук включается только кнопкой ▶ у каждой записи. Оценки сохраняются в этом браузере; «Скачать оценки» даёт файл review.${VOICE_KEY}.json — положите его в tools/voice-clips/.</div>
</header>
<main>
  <section id="composed"></section>
  <section id="units"></section>
</main>
<script id="data" type="application/json">${data}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById('data').textContent);
  var STORE_KEY = 'gambit.voiceReview.' + DATA.voiceKey;
  var draft = {};
  try { draft = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { draft = {}; }
  function verdictOf(id) { return draft[id] || DATA.verdicts[id] || null; }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(draft)); } catch (e) { /* private window: keep in memory */ } }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function audio(src) { var a = document.createElement('audio'); a.controls = true; a.preload = 'none'; a.src = src; return a; }

  // one clip at a time: starting one pauses the others (the page never starts anything by itself)
  document.addEventListener('play', function (e) {
    var all = document.querySelectorAll('audio');
    for (var i = 0; i < all.length; i++) if (all[i] !== e.target) all[i].pause();
  }, true);

  var composed = document.getElementById('composed');
  if (DATA.composed.length) {
    composed.appendChild(el('h2', null, 'Собранные фразы (как услышит ребёнок)'));
    DATA.composed.forEach(function (c) {
      var card = el('div', 'card');
      card.appendChild(el('p', 'text', c.text));
      card.appendChild(el('div', 'meta', c.name));
      card.appendChild(audio(c.src));
      composed.appendChild(card);
    });
  }

  var list = document.getElementById('units');
  var cards = [];
  DATA.units.forEach(function (u) {
    var card = el('div', 'card');
    card.appendChild(el('p', 'text', u.text));
    card.appendChild(el('div', 'meta', u.key + (u.pool ? ' · ' + u.pool : '') + ' · дубль ' + u.take + ' · ' + (u.ms / 1000).toFixed(2) + ' с · ' + u.tier + ' · ' + u.id));
    if (u.flags.length || u.qa === 'needsEar') {
      var flags = el('div', 'flags');
      (u.flags.length ? u.flags : ['нужно послушать']).forEach(function (f) { flags.appendChild(el('span', null, f)); });
      card.appendChild(flags);
    }
    if (u.heard) card.appendChild(el('div', 'heard', 'Распознано: «' + u.heard + '»' + (u.score != null ? ' (' + u.score + ')' : '')));
    card.appendChild(audio(u.src));
    var row = el('div', 'verdict');
    var buttons = [['ok', 'Хорошо'], ['redo', 'Переписать'], ['reject', 'Убрать']].map(function (b) {
      var btn = el('button', null, b[1]); btn.type = 'button'; btn.setAttribute('data-v', b[0]); row.appendChild(btn); return btn;
    });
    var note = el('input'); note.placeholder = 'заметка (необязательно)'; row.appendChild(note);
    function paint() {
      var v = verdictOf(u.id);
      buttons.forEach(function (b) { b.classList.toggle('on', !!v && v.verdict === b.getAttribute('data-v')); });
      note.value = v && v.note ? v.note : '';
    }
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        var v = verdictOf(u.id);
        var next = b.getAttribute('data-v');
        if (v && v.verdict === next) { draft[u.id] = { verdict: '', note: note.value }; }
        else draft[u.id] = { verdict: next, note: note.value };
        save(); paint(); count();
      });
    });
    note.addEventListener('change', function () {
      var v = verdictOf(u.id) || { verdict: '' };
      draft[u.id] = { verdict: v.verdict, note: note.value }; save();
    });
    paint();
    card.appendChild(row);
    list.appendChild(card);
    cards.push({ u: u, card: card });
  });

  var filter = 'all';
  function visible(u) {
    var v = verdictOf(u.id);
    if (filter === 'ear') return u.qa === 'needsEar' || u.flags.length > 0;
    if (filter === 'slot') return u.kind === 'slot';
    if (filter === 'open') return !v || !v.verdict;
    return true;
  }
  function count() {
    var done = 0, shown = 0;
    cards.forEach(function (c) { var v = verdictOf(c.u.id); if (v && v.verdict) done++; var s = visible(c.u); c.card.hidden = !s; if (s) shown++; });
    document.getElementById('count').textContent = 'оценено ' + done + ' из ' + cards.length + ' · показано ' + shown;
  }
  var filterButtons = document.querySelectorAll('[data-filter]');
  for (var i = 0; i < filterButtons.length; i++) filterButtons[i].addEventListener('click', function (e) {
    filter = e.currentTarget.getAttribute('data-filter');
    for (var j = 0; j < filterButtons.length; j++) filterButtons[j].setAttribute('aria-pressed', String(filterButtons[j] === e.currentTarget));
    count();
  });
  count();

  document.getElementById('export').addEventListener('click', function () {
    var out = {};
    Object.keys(DATA.verdicts).forEach(function (id) { out[id] = DATA.verdicts[id]; });
    Object.keys(draft).forEach(function (id) {
      var v = draft[id];
      if (v && v.verdict) out[id] = v.note ? { verdict: v.verdict, note: v.note } : { verdict: v.verdict };
      else delete out[id];
    });
    var blob = new Blob([JSON.stringify(out, null, 1) + '\\n'], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'review.' + DATA.voiceKey + '.json';
    document.body.appendChild(a); a.click(); a.remove();
  });
})();
</script>
</body>
</html>
`;
}

/** Needs the ear first, then published takes with a soft flag of the overlay's rule (./overlay.ts), slots, the rest. */
function unitOrder(a: UnitRecord, b: UnitRecord): number {
  const rank = (u: UnitRecord) => (u.qa === 'needsEar' ? 0 : u.flags.some(isSoftFlag) ? 1 : u.kind === 'slot' ? 2 : 3);
  return rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.take - b.take);
}

export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const store = readStore(opts.storeFile);
  const verdicts = readVerdicts(opts.reviewFile);
  mkdirSync(opts.outDir, { recursive: true });
  const units: PageUnit[] = Object.values(store.units)
    .sort(unitOrder)
    .map((u) => ({
      id: u.id,
      key: u.key,
      text: u.text,
      pool: u.pool ?? '',
      tier: u.tier ?? '',
      kind: u.kind ?? '',
      qa: u.qa,
      flags: u.flags,
      heard: u.asr?.heard ?? '',
      score: u.asr?.score ?? null,
      ms: u.ms,
      take: u.take,
      src: relUrl(opts.outDir, path.join(opts.libraryRoot, VOICE_KEY, u.file)),
    }));
  const composed: PageComposed[] = [];
  const skipped: string[] = [];
  if (opts.composedFile !== undefined && existsSync(opts.composedFile)) {
    const raw = JSON.parse(readFileSync(opts.composedFile, 'utf8')) as { lines?: ComposedLine[] };
    const lines = Array.isArray(raw.lines) ? raw.lines : [];
    for (const [index, line] of lines.entries()) {
      const name = line.name ?? `фраза ${index + 1}`;
      const rendered = await renderComposed(line, store, opts.libraryRoot, index + 1);
      if ('missing' in rendered) {
        skipped.push(`${name}: нет записи ${rendered.missing}`);
        continue;
      }
      const file = path.join(opts.outDir, 'composed', `${String(index + 1).padStart(3, '0')}.mp3`);
      await writeMp3(rendered.pcm, file, 64, opts.work);
      composed.push({ name, text: rendered.text, src: relUrl(opts.outDir, file) });
    }
  }
  const page = path.join(opts.outDir, 'index.html');
  const generatedAt = (opts.now ?? (() => new Date()))().toISOString();
  writeFileSync(page, reviewHtml(units, composed, verdicts, generatedAt), 'utf8');
  return { page, units: units.length, composed: composed.length, skipped };
}
