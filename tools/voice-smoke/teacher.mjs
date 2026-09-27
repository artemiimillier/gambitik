#!/usr/bin/env node
/**
 * REAL teacher-mode test («Учитель», docs/TEACHER-MODE.md §8.3) with the live voice model — NOT part of e2e: it costs
 * real money (gpt-live-1 ≈ $0.05 per minute of an open session). See README.md in this folder. Run from the repo root
 * against a THROW-AWAY production server (another port, a temp DATA_DIR — never the child's 8787: guard.ts refuses it
 * and any server that does not report `dataDirIsTemp`):
 *
 *   node tools/voice-smoke/teacher.mjs --base-url http://127.0.0.1:8788 --n 1          # a 10-minute game in «Учитель», White
 *   node tools/voice-smoke/teacher.mjs --base-url http://127.0.0.1:8788 --n dry --dry  # FREE: a keyless server — the script itself
 *   node tools/voice-smoke/teacher.mjs --base-url http://127.0.0.1:8788 --blitz5       # a 5-minute game in «Учитель» (see below)
 *
 * The game: about ten child moves — mostly the green arrow, two own moves (one as good as the advice, one weaker), one
 * real blunder (the take-back offer is accepted), and one question «А почему не ферзём?» after 1.e4 e5.
 * Measured (§8.3): the share of teacher phrases the model really voiced (≥ 90 %), moves named in its words ⊆ the
 * brief's «Можно назвать» + the opponent's moves / squares of the brief (0 violations), sentences per full phrase
 * (≤ 4 in ≥ 90 %), Latin (0), Jaccard of consecutive teacher phrases (< 0.5), the delay from the bot's move to the
 * teacher's phrase, and whether the opening plan is explained proactively (quoted).
 *
 * The child talks through a replaced getUserMedia (WebAudio + room noise), macOS `say -v Milena` lines played exactly
 * when the script wants. The browser runs with --mute-audio: nothing is audible on the Mac. The coach's remote track is
 * recorded and mixed with the child's line into a dialog file. The script never reads .env and never sees a key.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Chess } from 'chess.js';
import { sanToSpokenRu, squareToSpokenRu } from '../../packages/core/src/coach/index.ts';
import { parseSpokenMove } from '../../apps/web/src/coach/spokenMove.ts';
import { argValue, baseUrlOrExit, orExit, outDir, safeHealthOrExit, safeLocalPath, workDir } from './guard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

function arg(name, fallback) {
  return argValue(process.argv, name) ?? fallback;
}

/** `--reanalyse <report.json>`: recompute the checks of a saved run — offline, no server, no --base-url (it is read AND
 * written back: never a file inside the child's data/) */
const REANALYSE = arg('reanalyse', null);
const REANALYSE_PATH = REANALYSE ? orExit(() => safeLocalPath(ROOT, REANALYSE, '--reanalyse')) : null;
/** mandatory, never the child's server (guard.ts) */
const BASE = REANALYSE ? null : baseUrlOrExit();
const SAMPLE_NO = arg('n', '1');
const OUT_DIR = orExit(() => outDir(ROOT, arg('out', undefined)));
const SHOT_DIR = orExit(() => outDir(ROOT, arg('shots', undefined), join(OUT_DIR, 'screenshots')));
const WORK_DIR = orExit(() => workDir(ROOT, arg('work', undefined), 'teacher-voice'));
const HEADED = process.argv.includes('--headed');
const DRY = process.argv.includes('--dry');
/**
 * `--no-mic` (strategy mode): the microphone is REFUSED — no fake device, no permission, getUserMedia not replaced. The
 * coach must still speak (the placeholder track carries comfort noise, apps/web/src/coach/rtcSession.ts) and must not
 * loop through reconnects: every POST /api/voice/live|realtime is counted (`voiceSessionCalls`).
 */
const NO_MIC = process.argv.includes('--no-mic');
/** hard money guard: whatever happens, the session is closed after this long */
const MAX_SECONDS = Number(arg('max-seconds', '540'));
const CHILD_MOVES = Number(arg('moves', '10'));
const NAME = `teacher-live-${SAMPLE_NO}`;

const LINES = { whyQueen: 'А почему не ферзём?' };

// ───────────────────────── audio fixtures (never played aloud: `say -o` writes a file) ─────────────────────────

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function durationOf(file) {
  return Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());
}

function buildLines() {
  mkdirSync(WORK_DIR, { recursive: true });
  const out = {};
  for (const [id, text] of Object.entries(LINES)) {
    const wav = join(WORK_DIR, `${id}.wav`);
    if (!existsSync(wav)) {
      const aiff = join(WORK_DIR, `${id}.aiff`);
      run('say', ['-v', 'Milena', '-o', aiff, text]);
      run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav]);
    }
    out[id] = { id, text, wav, seconds: durationOf(wav), base64: readFileSync(wav).toString('base64') };
  }
  return out;
}

// ───────────────────────── page-side set-up (as conversation.mjs + a move-list clock) ─────────────────────────

function initScript(options) {
  // (`noMic` is the script's own flag, never stored in the app's settings)
  const { noMic: noMicFlag, ...settings } = options;
  const noMic = noMicFlag === true;
  localStorage.setItem('gambit.e2eVoice', 'on');
  if (localStorage.getItem('gambit.settings') === null) localStorage.setItem('gambit.settings', JSON.stringify(settings));
  window.__smokeTtsCalls = [];
  const synth = window.speechSynthesis;
  if (synth) {
    Object.defineProperty(synth, 'speak', {
      configurable: true,
      value: (utterance) => {
        window.__smokeTtsCalls.push({ t: Date.now(), text: String(utterance?.text ?? '') });
        setTimeout(() => utterance.dispatchEvent(new Event('end')), 50);
      },
    });
  }
  const micCtx = new AudioContext({ sampleRate: 48000 });
  window.__smokeMic = { dests: [], lines: [], requests: 0 };
  const noiseBuffer = micCtx.createBuffer(1, 48000 * 2, 48000);
  const samples = noiseBuffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * 0.002;
  const noiseSource = micCtx.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;
  const noise = micCtx.createGain();
  noise.gain.value = 1;
  noiseSource.connect(noise);
  noiseSource.start();
  const media = navigator.mediaDevices;
  if (media && media.getUserMedia && !noMic) {
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      if (!constraints || !constraints.audio) return original(constraints);
      window.__smokeMic.requests += 1;
      await micCtx.resume().catch(() => undefined);
      const dest = micCtx.createMediaStreamDestination();
      noise.connect(dest);
      window.__smokeMic.dests.push(dest);
      return dest.stream;
    };
  }
  window.__smokeSay = async (id, base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await micCtx.resume().catch(() => undefined);
    const buffer = await micCtx.decodeAudioData(bytes.buffer);
    const dest = window.__smokeMic.dests.at(-1);
    if (!dest) return { ok: false, reason: 'no microphone stream yet' };
    const source = micCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(dest);
    const startedAt = Date.now();
    source.start();
    const entry = { id, startedAt, durationMs: Math.round(buffer.duration * 1000) };
    window.__smokeMic.lines.push(entry);
    return { ok: true, ...entry };
  };
  window.__smokeRec = { segments: [] };
  setInterval(() => {
    const el = document.querySelector('audio[data-gambit="coach-voice"]');
    const stream = el && el.srcObject;
    if (!stream || stream === window.__smokeRec.stream) return;
    window.__smokeRec.stream = stream;
    try {
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      const segment = { startedAt: Date.now(), chunks: [], recorder };
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) segment.chunks.push(event.data);
      };
      recorder.start(500);
      window.__smokeRec.segments.push(segment);
    } catch (error) {
      window.__smokeRec.error = String(error);
    }
  }, 100);
  // the moment every ply appears in the move list (T0 of a teacher turn = the bot's move on the board)
  window.__smokePlies = [];
  setInterval(() => {
    const n = [...document.querySelectorAll('[aria-label="Ходы партии"] li span')].filter((span) => {
      const text = (span.textContent ?? '').trim();
      return text !== '' && text !== '…' && !/^\d+\.$/.test(text);
    }).length;
    const last = window.__smokePlies.at(-1);
    if (!last || last.plies !== n) window.__smokePlies.push({ t: Date.now(), plies: n });
  }, 25);
  // the child's clock, every change of its state / reading (blitz: it must stand still while Гамбитик speaks).
  // 'running' = ticking, 'paused' = the child's turn but held (coach / a decision dialog), 'idle' = the bot's turn, 'off' = no clock
  window.__smokeClock = [];
  const recordClock = () => {
    const el = document.querySelector('[data-side="child"] [role="timer"]');
    const state = !el ? 'off' : el.getAttribute('data-paused') === 'true' ? 'paused' : el.getAttribute('data-running') === 'true' ? 'running' : 'idle';
    const label = el ? el.getAttribute('aria-label') : null;
    const last = window.__smokeClock.at(-1);
    if (!last || last.state !== state || last.label !== label) window.__smokeClock.push({ t: Date.now(), state, label });
  };
  new MutationObserver(recordClock).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-paused', 'data-running', 'aria-label'] });
  window.__smokeEngine = (fen, opts = {}) =>
    new Promise((resolveResult, rejectResult) => {
      const worker = new Worker('/engine/stockfish-19-lite-single.js');
      const lines = new Map();
      const multipv = opts.multipv ?? 1;
      const timer = setTimeout(() => {
        worker.terminate();
        rejectResult(new Error('engine timeout'));
      }, 30_000);
      worker.onmessage = (event) => {
        const text = String(event.data);
        if (text === 'uciok') {
          worker.postMessage(`setoption name MultiPV value ${multipv}`);
          worker.postMessage('isready');
        } else if (text === 'readyok') {
          worker.postMessage(`position fen ${fen}`);
          worker.postMessage(`go depth ${opts.depth ?? 12}${opts.searchmoves ? ` searchmoves ${opts.searchmoves.join(' ')}` : ''}`);
        } else if (text.startsWith('info ') && text.includes(' pv ')) {
          const depth = Number(/ depth (\d+)/.exec(text)?.[1] ?? 0);
          const k = Number(/ multipv (\d+)/.exec(text)?.[1] ?? 1);
          const cp = / score cp (-?\d+)/.exec(text);
          const mate = / score mate (-?\d+)/.exec(text);
          const pv = text.split(' pv ')[1].trim().split(/\s+/);
          lines.set(k, { depth, cp: cp ? Number(cp[1]) : null, mate: mate ? Number(mate[1]) : null, pv });
        } else if (text.startsWith('bestmove')) {
          clearTimeout(timer);
          worker.terminate();
          resolveResult({ bestmove: text.split(/\s+/)[1], lines: [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line) });
        }
      };
      worker.postMessage('uci');
    });
}

async function collectRecording(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const segment of window.__smokeRec.segments) {
      if (segment.recorder.state !== 'inactive') {
        await new Promise((done) => {
          segment.recorder.addEventListener('stop', done, { once: true });
          segment.recorder.stop();
        });
      }
      const blob = new Blob(segment.chunks, { type: 'audio/webm' });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      out.push({ startedAt: segment.startedAt, base64: btoa(binary), bytes: buffer.length });
    }
    return { segments: out, error: window.__smokeRec.error ?? null };
  });
}

// ───────────────────────── probe helpers ─────────────────────────

const probeLog = (page) => page.evaluate(() => window.__gambitVoiceProbe?.log ?? []);

async function waitForProbe(page, predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = await probeLog(page);
    const hit = log.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.waitForTimeout(150);
  }
}

/** the coach has been silent for `quietMs`, nothing he was asked to say is pending, and he is not thinking */
async function waitCoachQuiet(page, quietMs = 1800, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = await probeLog(page);
    const edges = log.filter((e) => e.type === 'rtc.coach-audible');
    const last = edges.at(-1);
    const says = log.filter((e) => e.type === 'say').length;
    const dones = log.filter((e) => e.type === 'say.done').length;
    const lastPlay = [...log].reverse().find((e) => e.type === 'coach.play')?.t ?? 0;
    const state = [...log].reverse().find((e) => e.type === 'store' && e.field === 'conversationState')?.value;
    const quietSince = last === undefined ? 0 : last.audible === true ? Infinity : last.t;
    const quiet = Date.now() - quietSince >= quietMs && says === dones && Date.now() - lastPlay > 2500 && state !== 'thinking' && state !== 'childSpeaking';
    if (quiet) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(250);
  }
}

// ───────────────────────── board (the production bundle has no dev hook: the move list in the DOM) ─────────────────────────

const RU_TO_SAN = [
  [/^Кр/, 'K'],
  [/^Ф/, 'Q'],
  [/^Л/, 'R'],
  [/^С/, 'B'],
  [/^К/, 'N'],
];

function ruToSan(ru) {
  let san = ru.trim().replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O');
  for (const [re, letter] of RU_TO_SAN) {
    if (re.test(san)) {
      san = san.replace(re, letter);
      break;
    }
  }
  return san.replace(/=(Ф|Л|С|К)/, (_all, l) => `=${{ Ф: 'Q', Л: 'R', С: 'B', К: 'N' }[l]}`);
}

async function readPosition(page) {
  const cells = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Ходы партии"] li span')].map((span) => span.textContent ?? ''));
  const chess = new Chess();
  for (const cell of cells) {
    const text = cell.trim();
    if (text === '' || text === '…' || /^\d+\.$/.test(text)) continue;
    try {
      chess.move(ruToSan(text));
    } catch {
      break;
    }
  }
  return { fen: chess.fen(), sans: chess.history(), chess };
}

async function waitPlies(page, n, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const position = await readPosition(page);
    if (position.sans.length >= n) return position;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ply ${n} (have ${position.sans.length})`);
    await page.waitForTimeout(200);
  }
}

async function clickMove(page, uci) {
  const board = page.getByTestId('trainer-board');
  await board.locator(`[data-square="${uci.slice(0, 2)}"]`).click();
  await board.locator(`[data-square="${uci.slice(2, 4)}"]`).click();
  // a promotion asks for the piece
  if (uci.length > 4) await page.getByRole('button', { name: /Ферзь/ }).click().catch(() => undefined);
}

async function gameOver(page) {
  return page
    .getByRole('region', { name: 'Итог партии' })
    .isVisible()
    .catch(() => false);
}

// ───────────────────────── text helpers ─────────────────────────

function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return new Set(normalise(text).split(' ').filter(Boolean));
}

function jaccard(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let common = 0;
  for (const w of ta) if (tb.has(w)) common += 1;
  return Math.round((common / (ta.size + tb.size - common)) * 100) / 100;
}

function sentencesOf(text) {
  return String(text ?? '')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => /[а-яёa-z]/i.test(s));
}

/** squares a text names in speech («е четыре»), in board notation */
function squaresMentioned(text) {
  const spoken = ` ${normalise(text)} `;
  const found = [];
  for (const file of 'abcdefgh') {
    for (let rank = 1; rank <= 8; rank++) {
      const sq = `${file}${rank}`;
      if (spoken.includes(` ${normalise(squareToSpokenRu(sq))} `)) found.push(sq);
    }
  }
  return found;
}

function spokenOfUci(fen, uci) {
  try {
    const chess = new Chess(fen);
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { san: move.san, spoken: sanToSpokenRu(move.san), from: move.from, to: move.to };
  } catch {
    return null;
  }
}

/** a move a sentence names (parseSpokenMove) → its target square, 'O-O' / 'O-O-O', or null */
function namedTarget(sentence) {
  const parsed = parseSpokenMove(sentence);
  if (parsed.kind !== 'move') return null;
  const move = parsed.move;
  if (/^O-O/.test(move)) return move.startsWith('O-O-O') ? 'O-O-O' : 'O-O';
  const m = /([a-h][1-8])(?:[=+#].*)?$/.exec(move);
  return m ? m[1] : null;
}

/** lichess win% of a centipawn score (as the app's judge) */
function winPctOf(cp) {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

// ───────────────────────── the session ─────────────────────────

async function main() {
  // a Гамбитик server on a throw-away DATA_DIR, or nothing: the profile «Тигр» is written and a game saved below
  const health = await safeHealthOrExit(BASE);
  console.log(`health: live=${health.voice.live} (${health.voice.liveModel}) voice=${health.voice.voice} key=${health.llm.openaiKey}`);
  if (!health.llm.openaiKey && !DRY) {
    console.error('The server has no OPENAI_API_KEY — nothing to test (use --dry for a free run).');
    process.exit(3);
  }
  if (health.llm.openaiKey && DRY) {
    console.error('--dry needs a KEYLESS server (OPENAI_API_KEY= … pnpm start): a dry run must never open a paid session.');
    process.exit(3);
  }
  const usageBefore = await (await fetch(`${BASE}/api/voice/usage`)).json().catch(() => null);
  const lines = buildLines();
  const report = { name: NAME, startedAt: new Date().toISOString(), model: health.voice.liveModel, voice: health.voice.voice, dry: DRY, moves: [], steps: [], checks: {}, problems: [] };
  const t0Global = Date.now();
  const overBudget = () => (Date.now() - t0Global) / 1000 > MAX_SECONDS;
  const step = (name, data) => {
    const entry = { step: name, t: Date.now(), ...data };
    report.steps.push(entry);
    console.log(`[${((Date.now() - t0Global) / 1000).toFixed(1)} s] ${name} ${JSON.stringify(data).slice(0, 500)}`);
    return entry;
  };

  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  const consoleProblems = [];
  let page = null;
  try {
    const context = await browser.newContext({ baseURL: BASE, locale: 'ru-RU', viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
    const settings = { onboarded: true, voice: 'live', micMode: 'open', headphonesConfirmed: false, muted: false, talkativeness: 'normal', autoConversation: true };
    report.settings = settings;
    await context.addInitScript(initScript, settings);
    const put = await context.request.put('/api/student', { data: { nickname: 'Тигр', address: 'm', stage: 1 } });
    if (!put.ok()) throw new Error(`PUT /api/student → ${put.status()}`);
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error' || (message.type() === 'warning' && /\[coach\]|\[game\]/.test(message.text()))) consoleProblems.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    });
    page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));

    // ───── the wizard: Играть → 10 минут → Петя → «Учитель» → Белые ─────
    await page.goto('/#/');
    await page.locator('#root').waitFor();
    await page.getByRole('navigation', { name: 'Главное меню' }).getByRole('button', { name: /Играть/ }).click();
    await page.getByRole('button', { name: /10 минут/ }).click();
    await page.getByRole('button', { name: /Петя/ }).click();
    await page.getByRole('group', { name: 'Как помогает Гамбитик?' }).getByRole('button', { name: /Учитель/ }).click();
    const gestureAt = Date.now();
    await page.getByRole('button', { name: /Белые/ }).click();
    await page.waitForTimeout(500);
    const fresh = page.getByRole('button', { name: 'Новая партия' });
    if (await fresh.isVisible().catch(() => false)) await fresh.click();
    let listeningAt = null;
    if (!DRY) {
      listeningAt = (await waitForProbe(page, (e) => e.type === 'store' && e.field === 'conversationState' && e.value === 'listening', 30_000, 'conversationState=listening').catch((error) => {
        report.problems.push(String(error.message ?? error));
        return null;
      }))?.t ?? null;
      if (listeningAt === null) throw new Error('the conversation did not open by itself');
    } else {
      await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => undefined));
    }
    step('start', { msToListening: listeningAt ? listeningAt - gestureAt : null });
    await page.getByRole('status').filter({ hasText: 'Твой ход!' }).waitFor({ timeout: 45_000 }).catch(() => undefined);

    const say = async (id) => {
      const line = lines[id];
      const result = await page.evaluate(([lineId, b64]) => window.__smokeSay(lineId, b64), [id, line.base64]);
      if (!result.ok) throw new Error(`could not speak «${line.text}»: ${result.reason}`);
      await page.waitForTimeout(result.durationMs + 200);
      return { ...result, endAt: result.startedAt + result.durationMs, text: line.text };
    };

    /** the advice for the child's next ply: the newest teacher event of this ply with arrows (a treasure → its reveal) */
    const adviceFor = async (ply, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const log = await probeLog(page);
        const teach = log.filter((e) => e.type === 'coach.say' && e.teach && e.teach.ply === ply && (e.kind === 'teachTurn' || e.kind === 'takebackOffer'));
        const withArrows = teach.filter((e) => e.kind === 'teachTurn' && (e.teach.advice ?? []).length > 0);
        const hidden = teach.find((e) => e.teach.reveal === 'later');
        if (withArrows.length > 0) return { advice: withArrows.at(-1).teach.advice, treasure: Boolean(hidden) };
        if (Date.now() > deadline) return { advice: [], treasure: Boolean(hidden) };
        await page.waitForTimeout(250);
      }
    };

    const engineLines = (fen, opts) => page.evaluate(([f, o]) => window.__smokeEngine(f, o), [fen, opts]);
    const score = (line) => (line.mate !== null ? (line.mate > 0 ? 10_000 - line.mate : -10_000 - line.mate) : line.cp);

    /** a legal move of the child by the plan: follow / own (as good) / weaker / blunder */
    const choose = async (kind, pos, advice) => {
      const legal = pos.chess.moves({ verbose: true });
      const adviceUci = advice.map((a) => a.uci);
      if (kind === 'follow' && adviceUci[0]) return { uci: adviceUci[0], why: 'green arrow' };
      if (kind === 'follow') {
        const e = await engineLines(pos.fen, { depth: 10 });
        return { uci: e.bestmove, why: 'no advice seen — engine move' };
      }
      const all = await engineLines(pos.fen, { depth: 10, multipv: Math.min(legal.length, 40) });
      const best = score(all.lines[0]);
      const scored = all.lines.map((l) => ({ uci: l.pv[0], cp: score(l), drop: best - score(l) })).filter((m) => !adviceUci.includes(m.uci));
      const pieceOf = (uci) => legal.find((m) => `${m.from}${m.to}` === uci.slice(0, 4))?.piece;
      let pickMove;
      if (kind === 'own') pickMove = scored.find((m) => m.drop <= 25 && pieceOf(m.uci) !== 'q' && pieceOf(m.uci) !== 'k');
      else if (kind === 'weaker') pickMove = scored.find((m) => m.drop >= 60 && m.drop <= 220 && pieceOf(m.uci) !== 'q' && pieceOf(m.uci) !== 'k');
      // a real blunder: a piece move that costs ≥ 25 win% (the stage-1 take-back rule needs ≥ 20), not a mate
      else if (kind === 'blunder') {
        pickMove = [...scored]
          .filter((m) => m.drop >= 280 && Math.abs(m.cp) < 5000 && ['n', 'b', 'r'].includes(pieceOf(m.uci)) && winPctOf(best) - winPctOf(m.cp) >= 25)
          .sort((a, b) => a.drop - b.drop)[0];
      }
      if (!pickMove) return null;
      return { uci: pickMove.uci, why: `${kind}: ${pickMove.drop} cp below the engine's first line` };
    };

    // ───── the plan of the game: the green arrow, and from the 3rd move on every other move one special move (a
    // blunder while the game is balanced, an own move as good as the advice, a weaker own move); a special move that
    // the position does not allow is tried again on the next chance ─────
    const specials = ['blunder', 'own', 'weaker'];
    let asked = false;
    for (let i = 0; i < CHILD_MOVES + 4 && report.moves.filter((m) => m.kept).length < CHILD_MOVES; i++) {
      if (overBudget()) {
        report.problems.push('money guard: max seconds reached');
        break;
      }
      if (await gameOver(page)) break;
      let pos = await readPosition(page);
      const ply = pos.sans.length + 1;
      const got = await adviceFor(ply);
      // a hidden treasure: the child «looks» — wait for the reveal (10 s on stage 1) and take the arrow then
      let advice = got.advice;
      if (got.treasure && advice.length === 0) {
        step('treasure', { ply });
        const again = await adviceFor(ply, 16_000);
        advice = again.advice;
      }
      await waitCoachQuiet(page, 1600, 40_000);
      // «А почему не ферзём?» — after 1.e4 e5 (T10 of the spec) or at the first chance with a queen move
      if (!asked && ply >= 3 && pos.chess.moves({ verbose: true }).some((m) => m.piece === 'q')) {
        asked = true;
        const spoken = await say('whyQueen');
        const firstAudio = await waitForProbe(page, (e) => e.type === 'rtc.coach-audible' && e.audible === true && e.t > spoken.endAt - 300, 15_000, 'the answer').catch(() => null);
        await page.waitForTimeout(1200);
        await waitCoachQuiet(page, 2000, 40_000);
        const log = await probeLog(page);
        report.checks.whyQueen = {
          fen: pos.fen,
          sans: pos.sans,
          latencyMs: firstAudio ? firstAudio.t - spoken.endAt : null,
          delegation: log.filter((e) => e.type === 'delegation' && e.t >= spoken.startedAt - 500).map((e) => ({ intent: e.intent, question: e.question, answer: e.answer })),
          childHeard: log.filter((e) => e.type === 'transcript' && e.who === 'child' && e.t >= spoken.startedAt - 500).map((e) => e.text),
          coachSaid: log.filter((e) => e.type === 'transcript' && e.who === 'coach' && e.t >= spoken.startedAt).map((e) => e.text),
        };
        step('whyQueen', report.checks.whyQueen);
        pos = await readPosition(page);
      }
      const keptSoFar = report.moves.filter((m) => m.kept).length;
      let kind = 'follow';
      let choice = null;
      if (keptSoFar >= 2 && keptSoFar % 2 === 0) {
        // the first special move the position allows (a blunder needs a game that is not yet decided)
        for (const special of [...specials]) {
          choice = await choose(special, pos, advice);
          if (choice) {
            kind = special;
            specials.splice(specials.indexOf(special), 1);
            break;
          }
        }
      }
      if (!choice) choice = await choose('follow', pos, advice);
      const move = spokenOfUci(pos.fen, choice.uci);
      const before = Date.now();
      await clickMove(page, choice.uci);
      const entry = { ply, kind, uci: choice.uci, san: move?.san ?? null, why: choice.why, advice: advice.map((a) => `${a.san}(${a.arrow})`), t: before, kept: true };
      report.moves.push(entry);
      step('move', entry);
      // a take-back offer: accept it (the teacher repeats the advice), then the loop plays the advice
      const offer = page.getByRole('button', { name: 'Верну ход и подумаю' });
      const offered = await offer.waitFor({ timeout: kind === 'blunder' ? 20_000 : 4000 }).then(() => true).catch(() => false);
      if (offered) {
        await waitCoachQuiet(page, 1500, 40_000);
        entry.takeback = true;
        entry.kept = false;
        await offer.click();
        step('takeback accepted', { ply });
        await page.waitForTimeout(1500);
        await waitCoachQuiet(page, 1500, 40_000);
        continue;
      }
      await waitPlies(page, ply + 1, 40_000).catch((error) => report.problems.push(String(error.message ?? error)));
      await page.waitForTimeout(800);
    }
    // the last phrase to the end
    await page.waitForTimeout(1500);
    await waitCoachQuiet(page, 2000, 40_000);
    await page.screenshot({ path: join(SHOT_DIR, `${NAME}-game.png`) }).catch(() => undefined);
    // finish: resign — the game is saved, the journal written
    if (!(await gameOver(page))) {
      await page.getByRole('button', { name: 'Сдаться' }).click().catch(() => undefined);
      await page.getByRole('button', { name: 'Да, сдаюсь' }).click().catch(() => undefined);
    }
    await page.getByRole('region', { name: 'Итог партии' }).waitFor({ timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  } catch (error) {
    report.problems.push(`aborted: ${String(error.message ?? error)}`);
    console.error(error);
  } finally {
    if (page) {
      try {
        const talk = page.locator('.gmb-talk[data-active="true"]');
        if (await talk.isVisible().catch(() => false)) await talk.click();
        else {
          const mute = page.getByRole('button', { name: 'Выключить голос Гамбитика' });
          if (await mute.isVisible().catch(() => false)) await mute.click();
        }
        await page.waitForTimeout(2500);
      } catch (error) {
        report.problems.push(`close: ${String(error)}`);
      }
      try {
        const recording = await collectRecording(page);
        report.probe = await probeLog(page);
        report.micLines = await page.evaluate(() => window.__smokeMic.lines);
        report.plies = await page.evaluate(() => window.__smokePlies);
        report.ttsFallbackCalls = await page.evaluate(() => window.__smokeTtsCalls ?? []);
        report.console = consoleProblems;
        writeAudio(report, recording, lines);
      } catch (error) {
        report.problems.push(`collect: ${String(error)}`);
      }
    }
    await browser.close();
  }
  const usageAfter = await (await fetch(`${BASE}/api/voice/usage`)).json().catch(() => null);
  report.usage = { before: usageBefore, after: usageAfter };
  analyse(report);
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${NAME}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 1)}\n`);
  const { probe: _probe, steps: _steps, plies: _plies, ...summary } = report;
  console.log(JSON.stringify(summary.checks, null, 1).slice(0, 20_000));
  console.log(`problems: ${JSON.stringify(report.problems)}`);
  console.log(`report: ${jsonPath}`);
}

function writeAudio(report, recording, lines, baseName = NAME) {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  report.files = [];
  report.recorderError = recording.error;
  recording.segments.forEach((segment, index) => {
    if (segment.bytes < 2000) return;
    const name = `${baseName}${recording.segments.length > 1 && index > 0 ? `-part${index + 1}` : ''}`;
    const webm = join(WORK_DIR, `${name}.webm`);
    writeFileSync(webm, Buffer.from(segment.base64, 'base64'));
    const m4a = join(WORK_DIR, `${name}.m4a`);
    try {
      run('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:a', 'aac', '-b:a', '96k', m4a]);
      const file = { m4a, seconds: Math.round(durationOf(m4a) * 10) / 10, recordingStartedAt: segment.startedAt };
      const said = (report.micLines ?? []).filter((line) => line.startedAt >= segment.startedAt);
      const dialog = join(OUT_DIR, `${name}-dialog.m4a`);
      if (said.length > 0) {
        const inputs = ['-i', webm];
        const filters = [];
        said.forEach((line, i) => {
          inputs.push('-i', lines[line.id].wav);
          filters.push(`[${i + 1}:a]adelay=${Math.max(0, line.startedAt - segment.startedAt)}:all=1,volume=0.8[c${i}]`);
        });
        const mix = `[0:a]${said.map((_, i) => `[c${i}]`).join('')}amix=inputs=${said.length + 1}:duration=first:normalize=0[a]`;
        run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', [...filters, mix].join(';'), '-map', '[a]', '-ac', '1', '-c:a', 'aac', '-b:a', '96k', dialog]);
      } else {
        run('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:a', 'aac', '-b:a', '96k', dialog]);
      }
      file.dialog = dialog;
      report.files.push(file);
    } catch (error) {
      report.files.push({ webm, error: String(error.message ?? error).slice(0, 300) });
    }
  });
}

// ───────────────────────── §8.3 metrics ─────────────────────────

const TEACH_KINDS = new Set(['teachTurn', 'teachReaction']);

function analyse(report) {
  const log = report.probe ?? [];
  const says = log.filter((e) => e.type === 'coach.say');
  const plays = log.filter((e) => e.type === 'coach.play');
  const sayStarts = log.filter((e) => e.type === 'say');
  const dones = log.filter((e) => e.type === 'say.done');
  const transcripts = log.filter((e) => e.type === 'transcript');
  report.transcripts = transcripts.map((e) => ({ t: e.t, who: e.who, text: e.text }));

  // every app phrase: what was asked (brief), what the model said (say.done.heard of the next wire phrase after its play)
  const phrases = says
    .filter((s) => s.outcome === 'queued')
    .map((s) => {
      const play = plays.find((p) => p.id === s.id);
      // the wire phrase is the one carrying THIS brief / text (phrases wait for a connection or for a gap in talk)
      // (the wire text is one line: compare with the whitespace squeezed)
      const flat = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();
      const head = flat(play?.ownWords ? s.brief : s.text).slice(0, 60);
      const wire = play && head !== '' ? sayStarts.find((w) => w.t >= play.t - 50 && flat(w.text).startsWith(head)) : null;
      const done = wire ? dones.find((d) => d.t >= wire.t) : null;
      return { t: s.t, id: s.id, kind: s.kind, teach: s.teach ?? null, brief: s.brief ?? null, template: s.text, played: Boolean(play), playT: play?.t ?? null, ownWords: play?.ownWords ?? null, outcome: done?.outcome ?? null, heard: done?.heard ?? '' };
    });
  report.phrases = phrases.map(({ brief: _b, ...rest }) => rest);
  // (the strategy intro is a teacher `gameStart` and counts like any teacher phrase)
  const teach = phrases.filter((p) => TEACH_KINDS.has(p.kind) || ((p.kind === 'takebackOffer' || p.kind === 'gameStart') && p.teach));
  // a phrase cut by the child's own move (stale) is not the model's fault: counted apart
  const voiced = teach.filter((p) => p.outcome === 'spoken' && p.heard.trim() !== '');
  const notPlayed = teach.filter((p) => !p.played);
  const considered = teach.filter((p) => p.played);
  report.checks.voicedShare = {
    teacherPhrases: teach.length,
    played: considered.length,
    voicedByModel: voiced.length,
    share: considered.length > 0 ? Math.round((voiced.length / considered.length) * 100) : null,
    notVoiced: considered.filter((p) => !voiced.includes(p)).map((p) => ({ kind: p.kind, moment: p.teach?.moment ?? null, outcome: p.outcome, template: p.template })),
    neverPlayed: notPlayed.map((p) => ({ kind: p.kind, moment: p.teach?.moment ?? null, template: p.template })),
  };
  report.checks.voicedShare.pass = (report.checks.voicedShare.share ?? 0) >= 90;

  // moves named ⊆ «Можно назвать» + the opponent's moves / the squares of the brief
  const violations = [];
  const inventedSquares = [];
  for (const p of voiced) {
    const brief = p.brief ?? '';
    const allowedSquares = new Set(squaresMentioned(brief));
    const castleOk = /рокировк/i.test(brief);
    for (const sentence of sentencesOf(p.heard)) {
      const target = namedTarget(sentence);
      if (target === null) continue;
      if (target.startsWith('O-O') ? !castleOk : !allowedSquares.has(target)) violations.push({ kind: p.kind, sentence, target });
    }
    const extra = squaresMentioned(p.heard).filter((sq) => !allowedSquares.has(sq));
    if (extra.length > 0) inventedSquares.push({ kind: p.kind, heard: p.heard, squares: extra });
  }
  report.checks.namedMoves = { violations, squaresNotInBrief: inventedSquares, pass: violations.length === 0 };

  // sentences per full phrase
  const full = voiced.filter((p) => p.teach?.style === 'full');
  const counts = full.map((p) => sentencesOf(p.heard).length);
  const within = counts.filter((n) => n <= 4).length;
  report.checks.sentences = { full: full.length, counts, share: full.length > 0 ? Math.round((within / full.length) * 100) : null, byStyle: Object.fromEntries(['short', 'full', 'concept'].map((st) => [st, voiced.filter((p) => p.teach?.style === st).map((p) => sentencesOf(p.heard).length)])) };
  report.checks.sentences.pass = full.length === 0 || within / full.length >= 0.9;

  // Latin
  const coachTexts = transcripts.filter((e) => e.who === 'coach').map((e) => e.text);
  const latin = coachTexts.flatMap((text) => text.match(/[A-Za-z]+/g) ?? []);
  report.checks.latin = { coachUtterances: coachTexts.length, latin, pass: latin.length === 0 && coachTexts.length > 0 };

  // Jaccard of consecutive teacher phrases (teachTurn)
  const turns = voiced.filter((p) => p.kind === 'teachTurn');
  const pairs = [];
  for (let i = 1; i < turns.length; i++) pairs.push(jaccard(turns[i - 1].heard, turns[i].heard));
  report.checks.variety = { pairs, max: pairs.length > 0 ? Math.max(...pairs) : null, pass: pairs.every((j) => j < 0.5) };

  // delay: the bot's move on the board → the teacher's phrase (app) and → his first sound
  const plies = report.plies ?? [];
  const audible = log.filter((e) => e.type === 'rtc.coach-audible' && e.audible === true);
  const delays = [];
  for (const p of phrases.filter((x) => x.kind === 'teachTurn' && (x.teach?.moment === 'turn' || x.teach?.moment === 'openingPlan') && x.teach.ply > 1)) {
    // T0 = the bot's move (ply N−1) appears in the move list; the LAST time the list reached N−1 (a take-back rewinds it)
    const botPly = p.teach.ply - 1;
    // (the DOM poll runs every 25 ms and the list paints a frame after the store: a phrase decided in the same moment
    // can be logged a few ms BEFORE the sample — such a delay counts as 0)
    const shown = [...plies].reverse().find((x, i, arr) => x.plies === botPly && x.t <= p.t + 250 && (arr[i + 1]?.plies ?? -1) < botPly);
    if (!shown) continue;
    const sound = p.playT ? audible.find((a) => a.t >= p.playT) : null;
    delays.push({ ply: p.teach.ply, appMs: Math.max(0, p.t - shown.t), firstSoundMs: sound ? Math.max(0, sound.t - shown.t) : null });
  }
  const app = delays.map((d) => d.appMs).filter((x) => x >= 0).sort((a, b) => a - b);
  const sound = delays.map((d) => d.firstSoundMs).filter((x) => x !== null && x >= 0).sort((a, b) => a - b);
  const median = (xs) => (xs.length > 0 ? xs[Math.floor(xs.length / 2)] : null);
  report.checks.latency = { delays, appMedianMs: median(app), appMaxMs: app.at(-1) ?? null, firstSoundMedianMs: median(sound), firstSoundMaxMs: sound.at(-1) ?? null, pass: app.length > 0 && (app.at(-1) ?? 99_999) <= 1500 };

  // the opening plan, proactively
  const opening = phrases.find((p) => p.teach?.moment === 'openingPlan');
  report.checks.openingPlan = { template: opening?.template ?? null, heard: opening?.heard ?? null, mentionsPlan: /план|центр|кон|слон|рокиров/i.test(opening?.heard ?? ''), pass: Boolean(opening?.heard) };

  report.fallbackVoiceUsed = (report.ttsFallbackCalls ?? []).length;
  if (report.mode === 'strategy') analyseStrategy(report, { phrases, teach, voiced, transcripts });
  if (report.mode === 'strategy' && report.tc === 'blitz5') analyseBlitz(report, { phrases });

  report.checks.summary = {
    ...(report.mode === 'strategy' ? report.checks.strategySummary : {}),
    ...(report.tc === 'blitz5' ? report.checks.blitzSummary : {}),
    voicedShare: report.checks.voicedShare.share,
    namedMoveViolations: violations.length,
    fullWithin4Sentences: report.checks.sentences.share,
    latinWords: latin.length,
    jaccardMax: report.checks.variety.max,
    appDelayMedianMs: report.checks.latency.appMedianMs,
    firstSoundMedianMs: report.checks.latency.firstSoundMedianMs,
  };
}

// ───────────────────────── strategy mode ─────────────────────────
//
//   node tools/voice-smoke/teacher.mjs --strategy --base-url http://127.0.0.1:8788 --server-log <server stdout file>
//   node tools/voice-smoke/teacher.mjs --blitz5 --base-url http://127.0.0.1:8788 [--games w] [--moves 8] [--blunder-at 2]
//
// Games in «Учитель» against Петя (10 minutes) — by default White, White, Black (`--games w,w,b`), about eight child
// moves each (`--moves 8`): the green arrow, once (`--deviate-at 3`, the 4th move) an own move as good as the advice.
// Each game has its own page, so its own voice session, probe log and recording. Measured per game (`checks`) and over
// all games (`<prefix>-summary.json`): the first remark is the strategy intro («В этот раз …» + the title), the
// strategies differ, words / sentences per teacher remark (≤ 25 words, ≤ 2 sentences in ≥ 90 %), clock words in the
// coach's transcripts (0), remarks tied to the plan («по плану …»), the re-plans (provider, latency, how often the
// preferred move became the green arrow, whether the new plan reached a later brief), the teacher's delay after the
// bot's move, the model-voiced share and the cost (voice seconds from /api/voice/usage + the strategist calls).

/** «минут», «секунд», «часы» (the clock) — never in a coach's words; «время» is reported apart (it can be innocent). */
const CLOCK_STRICT_RE = /минут|секунд|(?<![а-яё])час(ы|ов|ах|ам)?(?![а-яё])|циферблат/iu;
const TIME_WORD_RE = /(?<![а-яё])врем(я|ени|енем)(?![а-яё])/iu;
const PLAN_RE = /план|стратеги/iu;
const BY_PLAN_RE = /по (нашему |своему |этому )?плану|по стратегии|по нашей стратегии/iu;

function wordsOf(text) {
  return String(text ?? '')
    .split(/\s+/)
    .filter((w) => /[а-яёa-z0-9]/iu.test(w)).length;
}

const PRAISE_RE = /(?<![а-яё])(здорово|молодец|отлично|классно|умница|супер|браво|так держать|хорошо, что|правильно, что|ты молодец|тоже хорош[а-яё]*)(?![а-яё])/iu;
const TOPIC_WORDS_RE = /(?<![а-яё])(разбуди|спрячь короля|рокиру|домик|без защиты|висит|незащищ|размен|вилк|связк|правило|центр — это|главные дороги)/iu;

/** The «Факты» / «Момент» / «Цель» lines of a brief (never «Нельзя»: it names what must not be said on purpose). */
function briefLines(brief) {
  const lines = String(brief ?? '').split('\n');
  const line = (name) => lines.find((l) => l.startsWith(`${name}:`)) ?? '';
  return { moment: line('Момент'), facts: line('Факты'), goal: line('Цель') };
}

function briefFactCount(brief) {
  return briefLines(brief)
    .facts.replace(/^Факты: /, '')
    .split(/(?<=[.!?])\s+(?=[А-ЯЁ])/u)
    .filter((f) => f.trim() !== '').length;
}

/**
 * What an over-budget remark carries besides the move and its reason, each with `inBrief` = the brief carried it:
 * the opponent's move, praise, a question, a new topic / principle, the plan, the blue arrow; `elaboration` = nothing of
 * these — the model stretched the reason itself (restated the brief, «так мы быстрее …»).
 */
function extrasOf(p) {
  const heard = String(p.heard ?? '');
  const b = briefLines(p.brief);
  const claims = `${b.moment} ${b.facts}`;
  const out = [];
  if (/соперник/iu.test(heard)) out.push({ what: 'opponent', inBrief: /соперник/iu.test(claims) });
  if (PRAISE_RE.test(heard)) out.push({ what: 'praise', inBrief: /одобрени|похвали|сыграл по совету|свой ход/iu.test(b.facts) });
  if (/\?/.test(heard)) out.push({ what: 'question', inBrief: /спроси|найти ход|найдёт ход|ход сам/iu.test(b.goal) });
  const topicGoal = /нов(ая|ой) тем|правилом/iu.test(b.goal);
  if (topicGoal || TOPIC_WORDS_RE.test(heard)) out.push({ what: 'topic', inBrief: topicGoal || TOPIC_WORDS_RE.test(b.facts) });
  if (/план/iu.test(heard) && /(новый план|план:)/iu.test(b.facts)) out.push({ what: 'plan', inBrief: true });
  if (/синяя стрелка|синей стрелк/iu.test(b.facts) && /(или|а ещё|ещё можно)/iu.test(heard)) out.push({ what: 'blueArrow', inBrief: true });
  if (out.length === 0) out.push({ what: 'elaboration', inBrief: false });
  return out;
}

function stats(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return { n: sorted.length, median: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null, max: sorted.at(-1) ?? null };
}

function analyseStrategy(report, { phrases, teach, voiced, transcripts }) {
  const net = report.network ?? [];
  const strategyCall = net.filter((n) => n.kind === 'strategy').at(-1) ?? null;
  const strategy = strategyCall?.json ?? null;
  report.checks.strategy = strategyCall
    ? { strategyId: strategy?.strategyId ?? null, titleRu: strategy?.titleRu ?? null, introRu: strategy?.introRu ?? null, provider: strategy?.provider ?? null, latencyMs: strategyCall.latencyMs, requests: net.filter((n) => n.kind === 'strategy').length, request: strategyCall.body }
    : { strategyId: null, problem: 'no /api/coach/strategy call seen' };

  // the first remark of the GAME (after the colour tap — the home greeting and the wizard's words come before) is the intro
  const first = phrases.find((p) => p.t >= (report.gestureAt ?? 0)) ?? null;
  const intro = phrases.find((p) => p.kind === 'gameStart' && p.teach) ?? null;
  const title = String(strategy?.titleRu ?? '');
  const stem = normalise(title).slice(0, 5);
  report.checks.intro = {
    firstKind: first?.kind ?? null,
    firstIsIntro: first !== null && first === intro,
    template: intro?.template ?? null,
    heard: intro?.heard ?? null,
    templateHasTitle: Boolean(intro && /В этот раз/u.test(intro.template) && stem !== '' && normalise(intro.template).includes(stem)),
    heardHasTitle: Boolean(intro && stem !== '' && normalise(intro.heard).includes(stem)),
    heardSaysThisTime: Boolean(intro && /в этот раз/iu.test(intro.heard)),
  };
  report.checks.intro.pass = report.checks.intro.firstIsIntro && report.checks.intro.templateHasTitle && (report.dry || report.checks.intro.heardHasTitle);

  // length of every teacher remark: the model's words (voiced) and the app's template
  const heardWords = voiced.map((p) => wordsOf(p.heard));
  const heardSentences = voiced.map((p) => sentencesOf(p.heard).length);
  const templWords = teach.map((p) => wordsOf(p.template));
  const templSentences = teach.map((p) => sentencesOf(p.template).length);
  const within = voiced.filter((p) => wordsOf(p.heard) <= 25 && sentencesOf(p.heard).length <= 2).length;
  const templWithin = teach.filter((p) => wordsOf(p.template) <= 25 && sentencesOf(p.template).length <= 2).length;
  report.checks.brevity = {
    heard: { words: stats(heardWords), sentences: stats(heardSentences), withinShare: voiced.length > 0 ? Math.round((within / voiced.length) * 100) : null },
    template: { words: stats(templWords), sentences: stats(templSentences), withinShare: teach.length > 0 ? Math.round((templWithin / teach.length) * 100) : null },
    longest: [...voiced].sort((a, b) => wordsOf(b.heard) - wordsOf(a.heard)).slice(0, 3).map((p) => ({ kind: p.kind, words: wordsOf(p.heard), heard: p.heard })),
  };
  const share = report.dry ? report.checks.brevity.template.withinShare : report.checks.brevity.heard.withinShare;
  report.checks.brevity.pass = (share ?? 0) >= 90;
  // every remark past the budget: what the model added, and whether the brief CARRIED it (we fed it) or not (invented)
  report.checks.brevity.over = voiced.filter((p) => wordsOf(p.heard) > 25 || sentencesOf(p.heard).length > 2).map((p) => ({ kind: p.kind, moment: p.teach?.moment ?? null, style: p.teach?.style ?? null, words: wordsOf(p.heard), sentences: sentencesOf(p.heard).length, heard: p.heard, briefFacts: briefFactCount(p.brief), added: extrasOf(p) }));
  const overCats = {};
  for (const o of report.checks.brevity.over) for (const a of o.added) {
    const c = (overCats[a.what] ??= { n: 0, inBrief: 0 });
    c.n += 1;
    if (a.inBrief) c.inBrief += 1;
  }
  report.checks.brevity.overByCategory = overCats;

  // the clock is never read out: every coach transcript (and the templates the bubble shows)
  const coachTexts = transcripts.filter((e) => e.who === 'coach').map((e) => e.text);
  const clockHits = coachTexts.filter((t) => CLOCK_STRICT_RE.test(t));
  const timeHits = coachTexts.filter((t) => TIME_WORD_RE.test(t));
  const templateClock = phrases.filter((p) => CLOCK_STRICT_RE.test(p.template ?? '') && !/Поторопись/u.test(p.template ?? '')).map((p) => p.template);
  report.checks.clock = { coachUtterances: coachTexts.length, clockWords: clockHits, timeWords: timeHits, templatesWithClockWords: templateClock, pass: clockHits.length === 0 && templateClock.length === 0 };

  // remarks tied to the plan
  const planHeard = voiced.filter((p) => PLAN_RE.test(p.heard));
  const byPlanHeard = voiced.filter((p) => BY_PLAN_RE.test(p.heard));
  const planTemplates = teach.filter((p) => PLAN_RE.test(p.template ?? ''));
  report.checks.planReasons = {
    heardWithPlan: planHeard.length,
    heardByPlan: byPlanHeard.length,
    templatesWithPlan: planTemplates.length,
    teacherRemarks: teach.length,
    quotes: (report.dry ? planTemplates.map((p) => p.template) : planHeard.map((p) => p.heard)).slice(0, 6),
  };
  report.checks.planReasons.pass = (report.dry ? planTemplates.length : planHeard.length) > 0;

  // the re-plans: provider, latency, the preferred move as the green arrow of its ply, the plan in a later brief
  const says = (report.probe ?? []).filter((e) => e.type === 'coach.say' && e.outcome === 'queued');
  const replans = net
    .filter((n) => n.kind === 'replan')
    .map((n) => {
      const ply = n.body?.ply ?? null;
      const green = says
        .filter((e) => e.teach && e.teach.ply === ply && (e.teach.advice ?? []).length > 0)
        .map((e) => e.teach.advice.find((a) => a.arrow === 'green')?.uci ?? null)
        .filter(Boolean)
        .at(-1) ?? null;
      const planRu = n.json?.planRu ?? '';
      const head = normalise(planRu).split(' ').slice(0, 3).join(' ');
      const laterBrief = head !== '' ? says.find((e) => e.t > (n.respT ?? Infinity) && normalise(e.brief ?? '').includes(head)) : null;
      const firstSayOfPly = says.find((e) => e.teach && e.teach.ply === ply) ?? null;
      return {
        ply,
        candidates: (n.body?.candidates ?? []).map((c) => c.san),
        status: n.status ?? null,
        failed: n.failed ?? null,
        latencyMs: n.latencyMs ?? null,
        provider: n.json?.provider ?? null,
        preferredUci: n.json?.preferredUci ?? null,
        planRu,
        whyRu: n.json?.whyRu ?? '',
        greenOfPly: green,
        preferredWasGreen: n.json?.preferredUci != null && n.json.preferredUci === green,
        answeredBeforeTheTeacherLine: firstSayOfPly !== null && n.respT !== undefined ? n.respT < firstSayOfPly.t : null,
        planInLaterBrief: Boolean(laterBrief),
      };
    });
  const answered = replans.filter((r) => r.provider !== null);
  const byProvider = {};
  for (const r of answered) byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;
  report.checks.replans = {
    count: replans.length,
    answered: answered.length,
    byProvider,
    latency: stats(answered.map((r) => r.latencyMs).filter((x) => x !== null)),
    preferredUsed: answered.filter((r) => r.preferredWasGreen).length,
    planInLaterBrief: answered.filter((r) => r.planInLaterBrief).length,
    list: replans,
    journal: report.journalStrategy ?? null,
  };

  const lat = report.checks.latency ?? {};
  report.checks.strategySummary = {
    strategy: report.checks.strategy.strategyId,
    strategyProvider: report.checks.strategy.provider ?? null,
    strategyLatencyMs: report.checks.strategy.latencyMs ?? null,
    introFirst: report.checks.intro.firstIsIntro,
    introHeardTitle: report.checks.intro.heardHasTitle,
    wordsMedian: report.dry ? report.checks.brevity.template.words.median : report.checks.brevity.heard.words.median,
    wordsMax: report.dry ? report.checks.brevity.template.words.max : report.checks.brevity.heard.words.max,
    within25w2sShare: share,
    overBudget: report.checks.brevity.over.length,
    overByCategory: report.checks.brevity.overByCategory,
    clockWords: clockHits.length,
    timeWords: timeHits.length,
    planRemarks: report.dry ? report.checks.planReasons.templatesWithPlan : report.checks.planReasons.heardWithPlan,
    planRemarksTemplate: report.checks.planReasons.templatesWithPlan,
    replans: replans.length,
    replanProviders: byProvider,
    replanLatencyMedianMs: report.checks.replans.latency.median,
    preferredUsed: report.checks.replans.preferredUsed,
    appDelayMaxMs: lat.appMaxMs ?? null,
  };
}

// ───────────────────────── blitz5: «Учитель» in a 5-minute game ─────────────────────────
//
// 5-minute games are common. «Учитель» there: the strategy in one line at the start, 1–2 short sentences per move,
// and the CHILD'S CLOCK STANDS STILL WHILE ГАМБИТИК SPEAKS. One game by default (`--games w`), eight child moves, the
// 3rd one (`--blunder-at 2`) a real blunder whose take-back offer is accepted. On top of the strategy checks:
//   clockWhileSpeaking — the child's clock (`[data-side="child"] [role="timer"]`, data-running / data-paused) sampled
//     on every change, against the intervals the coach was audible (rtc.coach-audible). `leakMs` = the child's clock
//     ran while he spoke on the child's turn. Pass: ≤ 10 % of that speech time (dry run: the clock was held at all).
//   takeback — the blunder, the offer (latency, the model's words), the clock during the offer, the offer accepted.

/** what one game of a mode looks like (the wizard tile, defaults of the command line) */
const RAPID10 = { tc: 'rapid10', tile: /10 минут/, prefix: 'strategy-live', games: 'w,w,b', moves: 8, blunderAt: null, gameMaxSeconds: 330 };
const BLITZ5 = { tc: 'blitz5', tile: /5 минут/, prefix: 'blitz5-live', games: 'w', moves: 8, blunderAt: 2, gameMaxSeconds: 330 };

/** state of the child's clock at `t` from the change samples */
function clockStateAt(samples, t) {
  let state = 'off';
  for (const s of samples) {
    if (s.t > t) break;
    state = s.state;
  }
  return state;
}

/** ms per clock state within [a, b) */
function clockSplit(samples, a, b) {
  const out = { running: 0, paused: 0, idle: 0, off: 0 };
  let cursor = a;
  let state = clockStateAt(samples, a);
  for (const s of samples) {
    if (s.t <= a) continue;
    if (s.t >= b) break;
    out[state] += s.t - cursor;
    cursor = s.t;
    state = s.state;
  }
  out[state] += Math.max(0, b - cursor);
  return out;
}

function analyseBlitz(report, { phrases }) {
  const log = report.probe ?? [];
  const samples = report.childClock ?? [];
  const endT = Math.max(samples.at(-1)?.t ?? 0, log.at(-1)?.t ?? 0);
  // the coach audible: rising → falling edges
  const intervals = [];
  let since = null;
  for (const e of log.filter((x) => x.type === 'rtc.coach-audible')) {
    if (e.audible === true && since === null) since = e.t;
    else if (e.audible !== true && since !== null) {
      intervals.push({ from: since, to: e.t });
      since = null;
    }
  }
  if (since !== null) intervals.push({ from: since, to: endT });
  const spoken = intervals
    .map((i) => ({ ...i, ...clockSplit(samples, i.from, i.to) }))
    .map((i) => ({ from: i.from, ms: i.to - i.from, onChildTurnMs: i.running + i.paused, leakMs: i.running, heldMs: i.paused }))
    .filter((i) => i.onChildTurnMs > 0);
  const onTurn = spoken.reduce((sum, i) => sum + i.onChildTurnMs, 0);
  const leak = spoken.reduce((sum, i) => sum + i.leakMs, 0);
  // every hold of the child's clock (coach phrase or a decision dialog)
  const holds = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].state !== 'paused' || samples[i - 1]?.state === 'paused') continue;
    const end = samples.slice(i + 1).find((s) => s.state !== 'paused')?.t ?? endT;
    holds.push({ from: samples[i].t, ms: end - samples[i].t });
  }
  report.checks.clockWhileSpeaking = {
    remarksOnChildTurn: spoken.length,
    speechOnChildTurnMs: onTurn,
    leakMs: leak,
    leakShare: onTurn > 0 ? Math.round((leak / onTurn) * 100) : null,
    worstLeaks: [...spoken].sort((a, b) => b.leakMs - a.leakMs).slice(0, 5),
    holds: holds.length,
    heldMs: holds.reduce((sum, h) => sum + h.ms, 0),
    clockAtEnd: [...samples].reverse().find((s) => s.label)?.label ?? null,
  };
  const c = report.checks.clockWhileSpeaking;
  c.pass = report.dry ? holds.length > 0 : spoken.length > 0 && (c.leakShare ?? 100) <= 10;

  // the take-back: the blunder, the offer, the model's words, the clock during the offer, accepted
  const blunder = report.moves.find((m) => m.kind === 'blunder') ?? null;
  const offer = blunder ? phrases.find((p) => p.kind === 'takebackOffer' && p.t >= blunder.t - 50) ?? null : null;
  report.checks.takeback = blunder
    ? {
        attempted: true,
        move: blunder.san,
        why: blunder.why,
        offered: Boolean(blunder.takeback),
        offerLatencyMs: blunder.offerSeenAt ? blunder.offerSeenAt - blunder.t : null,
        template: offer?.template ?? null,
        heard: offer?.heard ?? null,
        clockDuringOffer: blunder.offerSeenAt ? clockStateAt(samples, blunder.offerSeenAt + 300) : null,
        accepted: Boolean(blunder.takeback),
      }
    : { attempted: false, why: 'no blunder the position allowed (see moves)' };
  const t = report.checks.takeback;
  t.pass = t.attempted ? t.offered && t.clockDuringOffer !== 'running' : null;

  const heardTurns = (report.checks.brevity?.heard?.words ?? {});
  report.checks.blitzSummary = {
    tc: 'blitz5',
    clockLeakShare: c.leakShare,
    clockLeakMs: c.leakMs,
    clockHolds: c.holds,
    clockPass: c.pass,
    takebackOffered: t.offered ?? null,
    takebackClock: t.clockDuringOffer ?? null,
    takebackPass: t.pass,
    wordsPerRemarkMedian: report.dry ? report.checks.brevity?.template?.words?.median ?? null : heardTurns.median ?? null,
  };
}

async function playStrategyGame(context, { color, name, lines, moves, deviateAt, maxSeconds, health, mode = RAPID10, blunderAt = null }) {
  const report = { name, mode: 'strategy', tc: mode.tc, color, startedAt: new Date().toISOString(), model: health.voice.liveModel, voice: health.voice.voice, dry: DRY, moves: [], steps: [], checks: {}, problems: [], network: [] };
  const t0 = Date.now();
  const overBudget = () => (Date.now() - t0) / 1000 > maxSeconds;
  const step = (what, data) => {
    report.steps.push({ step: what, t: Date.now(), ...data });
    console.log(`[${name} ${((Date.now() - t0) / 1000).toFixed(1)} s] ${what} ${JSON.stringify(data).slice(0, 400)}`);
  };
  const usageBefore = await (await fetch(`${BASE}/api/voice/usage`)).json().catch(() => null);
  const lastGameId = async () => ((await (await context.request.get('/api/games?limit=1')).json().catch(() => [])) ?? [])[0]?.id ?? null;
  const idBefore = await lastGameId().catch(() => null);
  const page = await context.newPage();
  const consoleProblems = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || (message.type() === 'warning' && /\[coach\]|\[game\]/.test(message.text()))) consoleProblems.push(`${message.type()}: ${message.text().slice(0, 300)}`);
  });
  page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));
  // the strategist's calls as the page made them (request body, answer, latency, aborts)
  const calls = new Map();
  report.voiceSessionCalls = [];
  page.on('request', (request) => {
    const voice = /\/api\/voice\/(live|realtime)(?:$|[?/])/.exec(request.url());
    if (voice && request.method() === 'POST') report.voiceSessionCalls.push({ t: Date.now(), kind: voice[1] });
    const m = /\/api\/coach\/(strategy|replan)$/.exec(request.url());
    if (!m || request.method() !== 'POST') return;
    let body = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    const entry = { kind: m[1], t: Date.now(), body };
    calls.set(request, entry);
    report.network.push(entry);
  });
  page.on('response', async (response) => {
    const entry = calls.get(response.request());
    if (!entry) return;
    entry.respT = Date.now();
    entry.latencyMs = entry.respT - entry.t;
    entry.status = response.status();
    entry.json = await response.json().catch(() => null);
    step(`${entry.kind} answered`, { ply: entry.body?.ply ?? null, ms: entry.latencyMs, provider: entry.json?.provider ?? null, id: entry.json?.strategyId ?? null, planRu: entry.json?.planRu ?? undefined, preferredUci: entry.json?.preferredUci ?? undefined });
  });
  page.on('requestfailed', (request) => {
    const entry = calls.get(request);
    if (entry) entry.failed = request.failure()?.errorText ?? 'failed';
  });

  try {
    await page.goto('/#/');
    await page.locator('#root').waitFor();
    await page.getByRole('navigation', { name: 'Главное меню' }).getByRole('button', { name: /Играть/ }).click();
    await page.getByRole('button', { name: mode.tile }).click();
    await page.getByRole('button', { name: /Петя/ }).click();
    const teacherTile = page.getByRole('group', { name: 'Как помогает Гамбитик?' }).getByRole('button', { name: /Учитель/ });
    const teacherOffered = await teacherTile.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!teacherOffered) throw new Error(`«Учитель» is not offered for ${mode.tc} in the wizard — nothing to check`);
    await teacherTile.click();
    const gestureAt = Date.now();
    report.gestureAt = gestureAt;
    await page.getByRole('button', { name: color === 'w' ? /Белые/ : /Чёрные/ }).click();
    await page.waitForTimeout(500);
    const fresh = page.getByRole('button', { name: 'Новая партия' });
    if (await fresh.isVisible().catch(() => false)) await fresh.click();
    let listeningAt = null;
    if (!DRY) {
      listeningAt =
        (
          await waitForProbe(page, (e) => e.type === 'store' && e.field === 'conversationState' && e.value === 'listening', 30_000, 'conversationState=listening').catch((error) => {
            report.problems.push(String(error.message ?? error));
            return null;
          })
        )?.t ?? null;
      if (listeningAt === null) throw new Error('the conversation did not open by itself');
    }
    step('start', { color, msToListening: listeningAt ? listeningAt - gestureAt : null });
    // Black: the bot moves first (the strategy request goes out when it has decided that move)
    if (color === 'b') await waitPlies(page, 1, 60_000);

    const adviceFor = async (ply, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const log = await probeLog(page);
        const teach = log.filter((e) => e.type === 'coach.say' && e.teach && e.teach.ply === ply && (e.kind === 'teachTurn' || e.kind === 'gameStart' || e.kind === 'takebackOffer'));
        const withArrows = teach.filter((e) => (e.kind === 'teachTurn' || e.kind === 'gameStart') && (e.teach.advice ?? []).length > 0);
        const hidden = teach.find((e) => e.teach.reveal === 'later');
        if (withArrows.length > 0) return { advice: withArrows.at(-1).teach.advice, treasure: Boolean(hidden) };
        if (Date.now() > deadline) return { advice: [], treasure: Boolean(hidden) };
        await page.waitForTimeout(250);
      }
    };
    const engineLines = (fen, opts) => page.evaluate(([f, o]) => window.__smokeEngine(f, o), [fen, opts]);
    const score = (line) => (line.mate !== null ? (line.mate > 0 ? 10_000 - line.mate : -10_000 - line.mate) : line.cp);
    const choose = async (kind, pos, advice) => {
      const legal = pos.chess.moves({ verbose: true });
      const adviceUci = advice.map((a) => a.uci);
      if (kind === 'follow' && adviceUci[0]) return { uci: adviceUci[0], why: 'green arrow' };
      if (kind === 'follow') {
        const e = await engineLines(pos.fen, { depth: 10 });
        return { uci: e.bestmove, why: 'no advice seen — engine move' };
      }
      const all = await engineLines(pos.fen, { depth: 10, multipv: Math.min(legal.length, kind === 'blunder' ? 40 : 12) });
      const best = score(all.lines[0]);
      const pieceOf = (uci) => legal.find((m) => `${m.from}${m.to}` === uci.slice(0, 4))?.piece;
      if (kind === 'blunder') {
        // a real blunder (as main()): a minor piece / rook move that costs ≥ 25 win% — the take-back rule needs ≥ 20
        const pick = all.lines
          .map((l) => ({ uci: l.pv[0], cp: score(l), drop: best - score(l) }))
          .filter((m) => !adviceUci.includes(m.uci) && m.drop >= 280 && Math.abs(m.cp) < 5000 && ['n', 'b', 'r'].includes(pieceOf(m.uci)) && winPctOf(best) - winPctOf(m.cp) >= 25)
          .sort((a, b) => a.drop - b.drop)[0];
        return pick ? { uci: pick.uci, why: `blunder: ${pick.drop} cp below the engine's first line` } : null;
      }
      const own = all.lines
        .map((l) => ({ uci: l.pv[0], drop: best - score(l) }))
        .find((m) => !adviceUci.includes(m.uci) && m.drop <= 30 && pieceOf(m.uci) !== 'q' && pieceOf(m.uci) !== 'k');
      return own ? { uci: own.uci, why: `own move, ${own.drop} cp below the engine's first line` } : null;
    };

    let deviated = false;
    let blundered = false;
    for (let i = 0; i < moves + 4 && report.moves.filter((m) => m.kept).length < moves; i++) {
      if (overBudget()) {
        report.problems.push('money guard: max seconds of this game reached');
        break;
      }
      if (await gameOver(page)) break;
      const pos = await readPosition(page);
      const ply = pos.sans.length + 1;
      const got = await adviceFor(ply);
      let advice = got.advice;
      if (got.treasure && advice.length === 0) {
        step('treasure', { ply });
        advice = (await adviceFor(ply, 16_000)).advice;
      }
      await waitCoachQuiet(page, 1600, 40_000);
      const kept = report.moves.filter((m) => m.kept).length;
      let kind = 'follow';
      let choice = null;
      // blitz5: one real blunder (`blunderAt` kept moves in) — the take-back offer is checked and accepted
      if (blunderAt !== null && !blundered && kept >= blunderAt) {
        choice = await choose('blunder', pos, advice);
        if (choice) {
          kind = 'blunder';
          blundered = true;
        }
      }
      if (!choice && !deviated && kept >= deviateAt) {
        choice = await choose('own', pos, advice);
        if (choice) {
          kind = 'own';
          deviated = true;
        }
      }
      if (!choice) choice = await choose('follow', pos, advice);
      const move = spokenOfUci(pos.fen, choice.uci);
      const entry = { ply, kind, uci: choice.uci, san: move?.san ?? null, why: choice.why, advice: advice.map((a) => `${a.san}(${a.arrow})`), t: Date.now(), kept: true };
      await clickMove(page, choice.uci);
      report.moves.push(entry);
      step('move', entry);
      const offer = page.getByRole('button', { name: 'Верну ход и подумаю' });
      const offered = await offer.waitFor({ timeout: kind === 'blunder' ? 20_000 : 3000 }).then(() => true).catch(() => false);
      if (offered) {
        entry.offerSeenAt = Date.now();
        await waitCoachQuiet(page, 1500, 40_000);
        entry.takeback = true;
        entry.kept = false;
        await offer.click();
        step('takeback accepted', { ply });
        await page.waitForTimeout(1500);
        await waitCoachQuiet(page, 1500, 40_000);
        continue;
      }
      await waitPlies(page, ply + 1, 40_000).catch(async (error) => {
        if (!(await gameOver(page))) report.problems.push(String(error.message ?? error));
      });
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(1500);
    await waitCoachQuiet(page, 2000, 40_000);
    await page.screenshot({ path: join(SHOT_DIR, `${name}-game.png`) }).catch(() => undefined);
    if (!(await gameOver(page))) {
      await page.getByRole('button', { name: 'Сдаться' }).click().catch(() => undefined);
      await page.getByRole('button', { name: 'Да, сдаюсь' }).click().catch(() => undefined);
    }
    await page.getByRole('region', { name: 'Итог партии' }).waitFor({ timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    // the game is saved (POST /api/games) before the page goes — else its journal is lost with the page
    for (let i = 0; i < 40 && (await lastGameId().catch(() => idBefore)) === idBefore; i++) await page.waitForTimeout(500);
  } catch (error) {
    report.problems.push(`aborted: ${String(error.message ?? error)}`);
    console.error(error);
  } finally {
    try {
      const talk = page.locator('.gmb-talk[data-active="true"]');
      if (await talk.isVisible().catch(() => false)) await talk.click();
      else {
        const mute = page.getByRole('button', { name: 'Выключить голос Гамбитика' });
        if (await mute.isVisible().catch(() => false)) await mute.click();
      }
      await page.waitForTimeout(2500);
    } catch (error) {
      report.problems.push(`close: ${String(error)}`);
    }
    try {
      const recording = await collectRecording(page);
      report.probe = await probeLog(page);
      report.micLines = await page.evaluate(() => window.__smokeMic.lines);
      report.plies = await page.evaluate(() => window.__smokePlies);
      report.childClock = await page.evaluate(() => window.__smokeClock ?? []);
      report.ttsFallbackCalls = await page.evaluate(() => window.__smokeTtsCalls ?? []);
      report.console = consoleProblems;
      writeAudio(report, recording, lines, name);
    } catch (error) {
      report.problems.push(`collect: ${String(error)}`);
    }
    // the game's journal: the strategy / re-plan lines the game recorded (trigger, dropped answers)
    try {
      const id = await lastGameId();
      if (id && id !== idBefore) {
        const record = await (await context.request.get(`/api/games/${id}`)).json();
        report.gameId = id;
        report.journalStrategy = (record.events ?? []).filter((e) => e.type === 'coachSaid' && (e.data?.kind === 'strategy' || e.data?.kind === 'replan')).map((e) => ({ ply: e.ply ?? null, ...e.data }));
      }
    } catch (error) {
      report.problems.push(`journal: ${String(error)}`);
    }
    await page.close().catch(() => undefined);
  }
  await new Promise((done) => setTimeout(done, 1500));
  const usageAfter = await (await fetch(`${BASE}/api/voice/usage`)).json().catch(() => null);
  report.usage = { before: usageBefore, after: usageAfter };
  const liveSeconds = (u) => Number(u?.byProvider?.['openai-live']?.todaySeconds ?? 0);
  report.voiceSeconds = usageBefore && usageAfter ? Math.max(0, liveSeconds(usageAfter) - liveSeconds(usageBefore)) : null;
  analyse(report);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(report, null, 1)}\n`);
  console.log(`[${name}] ${JSON.stringify(report.checks.summary)}`);
  console.log(`[${name}] problems: ${JSON.stringify(report.problems)}`);
  return report;
}

async function mainStrategy(mode = RAPID10) {
  const games = arg('games', mode.games)
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c === 'w' || c === 'b');
  const prefix = arg('prefix', mode.prefix);
  const firstNo = Number(arg('first', '1'));
  const moves = Number(arg('moves', String(mode.moves)));
  const deviateAt = Number(arg('deviate-at', '3'));
  const blunderAt = mode.blunderAt === null ? null : Number(arg('blunder-at', String(mode.blunderAt)));
  const gameMaxSeconds = Number(arg('game-max-seconds', String(mode.gameMaxSeconds)));
  const serverLog = arg('server-log', null);
  // a Гамбитик server on a throw-away DATA_DIR, or nothing: the profile «Тигр» is written and games saved below
  const health = await safeHealthOrExit(BASE);
  console.log(`health: live=${health.voice.live} (${health.voice.liveModel}) key=${health.llm.openaiKey}`);
  if (!health.llm.openaiKey && !DRY) {
    console.error('The server has no OPENAI_API_KEY — nothing to test (use --dry for a free run).');
    process.exit(3);
  }
  if (health.llm.openaiKey && DRY) {
    console.error('--dry needs a KEYLESS server: a dry run must never open a paid session.');
    process.exit(3);
  }
  const lines = buildLines();
  const startedAt = Date.now();
  const logStart = serverLog && existsSync(serverLog) ? readFileSync(serverLog, 'utf8').length : 0;
  const browser = await chromium.launch({ headless: !HEADED, args: [...(NO_MIC ? [] : ['--use-fake-ui-for-media-stream']), '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const reports = [];
  try {
    const context = await browser.newContext({ baseURL: BASE, locale: 'ru-RU', viewport: { width: 1280, height: 800 }, permissions: NO_MIC ? [] : ['microphone'] });
    const settings = { onboarded: true, voice: 'live', micMode: 'open', headphonesConfirmed: false, muted: false, talkativeness: 'normal', autoConversation: true, ...(NO_MIC ? { noMic: true } : {}) };
    await context.addInitScript(initScript, settings);
    const put = await context.request.put('/api/student', { data: { nickname: 'Тигр', address: 'm', stage: 1 } });
    if (!put.ok()) throw new Error(`PUT /api/student → ${put.status()}`);
    for (let g = 0; g < games.length; g++) {
      const name = `${prefix}-${firstNo + g}`;
      reports.push(await playStrategyGame(context, { color: games[g], name, lines, moves, deviateAt, maxSeconds: gameMaxSeconds, health, mode, blunderAt }));
      // (> 2 minutes apart would be a new entry of the strategy history anyway; the server replaces an entry served
      // within 2 minutes only for the SAME game's repeated request — distinct games must still differ)
    }
  } finally {
    await browser.close();
  }
  // the server's own log of this run: which provider answered the strategist, how fast; the reviews
  const serverLines = serverLog && existsSync(serverLog) ? readFileSync(serverLog, 'utf8').slice(logStart).split('\n').filter((l) => /\[strategist\]|\[llm\]|\[review/.test(l)) : [];
  const strategies = reports.map((r) => r.checks.strategy?.strategyId ?? null);
  const whites = reports.filter((r) => r.color === 'w').map((r) => r.checks.strategy?.strategyId ?? null);
  const voicedAll = reports.flatMap((r) => (r.phrases ?? []).length ? [r.checks.voicedShare] : []);
  const openrouterCalls = reports.flatMap((r) => (r.network ?? []).filter((n) => n.json?.provider === 'openrouter')).length;
  const voiceSeconds = reports.reduce((sum, r) => sum + (r.voiceSeconds ?? 0), 0);
  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    minutes: Math.round((Date.now() - startedAt) / 600) / 100,
    tc: mode.tc,
    server: health.build ?? null,
    noMic: NO_MIC,
    games: reports.map((r) => ({ name: r.name, color: r.color, ...r.checks.summary, voiceSessionCalls: (r.voiceSessionCalls ?? []).map((c) => c.kind), problems: r.problems })),
    strategies,
    whiteStrategiesDiffer: new Set(whites.filter(Boolean)).size === whites.filter(Boolean).length && whites.filter(Boolean).length >= 2,
    allStrategiesDiffer: new Set(strategies.filter(Boolean)).size === strategies.filter(Boolean).length,
    voiced: voicedAll.map((v) => ({ played: v.played, voiced: v.voicedByModel, share: v.share })),
    cost: {
      voiceSeconds,
      voiceUsd: Math.round(voiceSeconds * (0.05 / 60) * 100) / 100,
      strategistOpenrouterCalls: openrouterCalls,
      strategistUsdEstimate: Math.round(openrouterCalls * 0.01 * 100) / 100,
      note: 'voice: the app’s own usage (≈ $0.05 per minute of an open gpt-live-1 session); strategist: ≈ 1 cent per OpenRouter Sol call; reviews: see serverLog',
    },
    serverLog: serverLines,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${prefix}-summary.json`), `${JSON.stringify(summary, null, 1)}\n`);
  console.log(JSON.stringify(summary, null, 1).slice(0, 12_000));
}

// `--reanalyse <report.json>`: recompute the checks of a saved run (free — the probe log is in the report)
if (REANALYSE_PATH) {
  const report = JSON.parse(readFileSync(REANALYSE_PATH, 'utf8'));
  analyse(report);
  writeFileSync(REANALYSE_PATH, `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify(report.checks.summary, null, 1));
} else if (process.argv.includes('--blitz5')) {
  await mainStrategy(BLITZ5);
} else if (process.argv.includes('--strategy')) {
  await mainStrategy(RAPID10);
} else {
  await main();
}
