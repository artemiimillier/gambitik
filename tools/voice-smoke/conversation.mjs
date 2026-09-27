#!/usr/bin/env node
/**
 * REAL conversation test of the «Поговорить» coach (NOT part of e2e — costs real money, ≈ $0.05/min for gpt-live-1).
 * See README.md in this folder. Run from the repo root against a THROW-AWAY production server (another port, a temp
 * DATA_DIR — never the child's 8787: guard.ts refuses it and any server that does not report `dataDirIsTemp`):
 *
 *   node tools/voice-smoke/conversation.mjs --base-url http://127.0.0.1:8788 --data-dir "$SMOKE_DATA" --layer live --n 1   # A–E + G
 *   node tools/voice-smoke/conversation.mjs --base-url … --layer live --n 2                       # F: the same again (variety)
 *   node tools/voice-smoke/conversation.mjs --base-url … --layer live --n q --talkativeness quiet --scenario quiet
 *   node tools/voice-smoke/conversation.mjs --base-url … --layer realtime --n 1 --scenario short
 *
 * How the «child» talks: NOT a looping WAV. The page's getUserMedia is replaced (init script, this browser only) by a
 * WebAudio MediaStreamDestination; the script plays a line into it exactly when it wants — after the coach went quiet,
 * after a board move — so every question lands at the right moment. The lines are macOS `say -v Milena` files.
 * The browser runs with --mute-audio: nothing is audible on the Mac; the coach's REMOTE track is recorded
 * (MediaRecorder) and mixed with the child's lines into a dialog file. A Stockfish worker in the page (the app's own
 * /engine build) checks the chess facts. It never reads .env and never sees a key.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Chess } from 'chess.js';
import { sanToSpokenRu, squareToSpokenRu } from '../../packages/core/src/coach/index.ts';
import { argValue, baseUrlOrExit, orExit, outDir, safeHealthOrExit, safeLocalPath, scratchDir, workDir } from './guard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

// ───────────────────────── arguments ─────────────────────────

function arg(name, fallback) {
  return argValue(process.argv, name) ?? fallback;
}

/** mandatory, never the child's server (guard.ts) */
const BASE = baseUrlOrExit();
const LAYER = arg('layer', 'live');
const SAMPLE_NO = arg('n', '1');
const SCENARIO = arg('scenario', 'full'); // full | short | quiet
const TALKATIVENESS = arg('talkativeness', SCENARIO === 'quiet' ? 'quiet' : 'normal');
const OUT_DIR = orExit(() => outDir(ROOT, arg('out', undefined)));
const SHOT_DIR = orExit(() => outDir(ROOT, arg('shots', undefined), join(OUT_DIR, 'screenshots')));
const WORK_DIR = orExit(() => workDir(ROOT, arg('work', undefined), 'conv-voice'));
/** the server's DATA_DIR, to read the game's journal on disk (G); never the child's data/ */
const DATA_DIR = orExit(() => safeLocalPath(ROOT, arg('data-dir', scratchDir('conv-data')), '--data-dir'));
const HEADED = process.argv.includes('--headed');
/** --dry: a KEYLESS server — checks the script's own mechanics (wizard, fake microphone, engine, blunder finder) for free */
const DRY = process.argv.includes('--dry');
const HEADPHONES = arg('headphones', 'no') === 'yes';
/** hard money guard: whatever happens, the session is closed after this long */
const MAX_SECONDS = Number(arg('max-seconds', '300'));
const NAME = `conv-${LAYER}-${SAMPLE_NO}`;

const KIND_OF_LAYER = { live: 'openai-live', realtime: 'openai-realtime' };
if (!(LAYER in KIND_OF_LAYER)) {
  console.error(`unknown layer «${LAYER}» (live | realtime)`);
  process.exit(2);
}

const LINES = {
  hello: 'Привет, Гамбитик! Как дела?',
  opponent: 'А что хочет сделать соперник?',
  knight: 'А если я пойду конём на эф три?',
};

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

// ───────────────────────── page-side set-up ─────────────────────────

function initScript(settings) {
  // opt into real voice — the automation guard stays in force for everything that did not ask for this
  localStorage.setItem('gambit.e2eVoice', 'on');
  if (localStorage.getItem('gambit.settings') === null) localStorage.setItem('gambit.settings', JSON.stringify(settings));
  // the browser-TTS fallback must never reach the loudspeakers
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
  // ── the fake microphone: a WebAudio stream the script speaks into on demand ──
  const micCtx = new AudioContext({ sampleRate: 48000 });
  window.__smokeMic = { dests: [], lines: [], requests: 0 };
  // room noise ≈ −54 dBFS (white), looping
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
  // outgoing RTP audio packets per second (does the microphone really stream?)
  window.__smokeRtp = [];
  const NativePc = window.RTCPeerConnection;
  if (NativePc) {
    window.RTCPeerConnection = function (...args) {
      const pc = new NativePc(...args);
      const timer = setInterval(async () => {
        if (pc.connectionState === 'closed') {
          clearInterval(timer);
          return;
        }
        try {
          const stats = await pc.getStats();
          stats.forEach((report) => {
            if (report.type === 'outbound-rtp' && report.kind === 'audio') window.__smokeRtp.push({ t: Date.now(), packetsSent: report.packetsSent });
          });
        } catch {
          /* closed */
        }
      }, 1000);
      return pc;
    };
    window.RTCPeerConnection.prototype = NativePc.prototype;
  }
  const media = navigator.mediaDevices;
  if (media && media.getUserMedia) {
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      if (!constraints || !constraints.audio) return original(constraints);
      window.__smokeMic.requests += 1;
      try {
        await micCtx.resume();
      } catch {
        /* resumes on the next gesture */
      }
      const dest = micCtx.createMediaStreamDestination();
      // a real room is never digitally silent: with an empty WebAudio stream no audio frames
      // reached the Live model and it froze (appends acknowledged only when the child spoke) — a fake-mic artefact.
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
  // ── record the REMOTE audio of every coach connection ──
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
  // ── Stockfish (the app's own worker build) for fact checks ──
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
    // a phrase that just started playing has not reached the protocol yet: give it a moment
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
    await page.waitForTimeout(250);
  }
}

async function clickMove(page, uci) {
  const board = page.getByTestId('trainer-board');
  await board.locator(`[data-square="${uci.slice(0, 2)}"]`).click();
  await board.locator(`[data-square="${uci.slice(2, 4)}"]`).click();
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

/** normalised token Jaccard: |A∩B| / |A∪B| */
function jaccard(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let common = 0;
  for (const w of ta) if (tb.has(w)) common += 1;
  return Math.round((common / (ta.size + tb.size - common)) * 100) / 100;
}

function spokenOfUci(fen, uci) {
  try {
    const chess = new Chess(fen);
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { san: move.san, spoken: sanToSpokenRu(move.san).replace(/, (шах|мат)$/, ''), toSquare: squareToSpokenRu(move.to) };
  } catch {
    return null;
  }
}

/** which squares (spoken) does a text mention? */
function squaresMentioned(text) {
  const spoken = normalise(text);
  const found = [];
  for (const file of 'abcdefgh') {
    for (let rank = 1; rank <= 8; rank++) {
      const sq = `${file}${rank}`;
      if (spoken.includes(normalise(squareToSpokenRu(sq)))) found.push(sq);
    }
  }
  return found;
}

// ───────────────────────── the session ─────────────────────────

async function main() {
  // a Гамбитик server on a throw-away DATA_DIR, or nothing: the profile «Тигр» is written and a game saved below
  const health = await safeHealthOrExit(BASE);
  console.log(`health: live=${health.voice.live} (${health.voice.liveModel}) realtime=${health.voice.realtime} (${health.voice.model}) voice=${health.voice.voice}`);
  if (!health.llm.openaiKey && !DRY) {
    console.error('The server has no OPENAI_API_KEY — nothing to test.');
    process.exit(3);
  }
  const usageBefore = await (await fetch(`${BASE}/api/voice/usage`)).json().catch(() => null);

  const lines = buildLines();
  const report = {
    name: NAME,
    layer: LAYER,
    scenario: SCENARIO,
    talkativeness: TALKATIVENESS,
    headphones: HEADPHONES,
    startedAt: new Date().toISOString(),
    model: LAYER === 'live' ? health.voice.liveModel : health.voice.model,
    voice: health.voice.voice,
    steps: [],
    checks: {},
    problems: [],
  };
  const t0Global = Date.now();
  const overBudget = () => (Date.now() - t0Global) / 1000 > MAX_SECONDS;
  const step = (name, data) => {
    const entry = { step: name, t: Date.now(), ...data };
    report.steps.push(entry);
    console.log(`[${((Date.now() - t0Global) / 1000).toFixed(1)} s] ${name} ${JSON.stringify(data).slice(0, 400)}`);
    return entry;
  };

  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  const consoleProblems = [];
  let page = null;
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    const context = await browser.newContext({ baseURL: BASE, locale: 'ru-RU', viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
    const settings = { onboarded: true, voice: LAYER, micMode: 'open', headphonesConfirmed: HEADPHONES, muted: false, talkativeness: TALKATIVENESS, autoConversation: true };
    report.settings = settings;
    await context.addInitScript(initScript, settings);
    const put = await context.request.put('/api/student', { data: { nickname: 'Тигр', address: 'm', stage: 1 } });
    if (!put.ok()) throw new Error(`PUT /api/student → ${put.status()}`);

    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error' || (message.type() === 'warning' && /\[coach\]|\[game\]/.test(message.text()))) consoleProblems.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    });
    page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));
    const voiceHttp = [];
    page.on('response', (response) => {
      const url = response.url();
      if (/\/api\/voice\/(live|session|usage)$/.test(url)) voiceHttp.push({ t: Date.now(), url: url.replace(/\?.*$/, ''), status: response.status() });
    });
    report.voiceHttp = voiceHttp;

    const say = async (id) => {
      const line = lines[id];
      const result = await page.evaluate(([lineId, b64]) => window.__smokeSay(lineId, b64), [id, line.base64]);
      if (!result.ok) throw new Error(`could not speak «${line.text}»: ${result.reason}`);
      const endAt = result.startedAt + result.durationMs;
      await page.waitForTimeout(result.durationMs + 200);
      return { ...result, endAt, text: line.text };
    };

    /** a line of the child + the coach's reaction: latency to his first sound, his words, what the app answered */
    const ask = async (id, stepName, { waitQuietBefore = true } = {}) => {
      if (waitQuietBefore) await waitCoachQuiet(page, 1500, 30_000);
      const spoken = await say(id);
      let firstAudio = null;
      try {
        firstAudio = await waitForProbe(page, (e) => e.type === 'rtc.coach-audible' && e.audible === true && e.t > spoken.endAt - 300, 15_000, 'the coach to answer');
      } catch {
        /* no answer: recorded below */
      }
      await page.waitForTimeout(1200);
      await waitCoachQuiet(page, 2000, 40_000);
      const log = await probeLog(page);
      const coachWords = log.filter((e) => e.type === 'transcript' && e.who === 'coach' && e.t >= spoken.startedAt).map((e) => e.text);
      const childHeard = log.filter((e) => e.type === 'transcript' && e.who === 'child' && e.t >= spoken.startedAt - 500).map((e) => e.text);
      const tools = log
        .filter((e) => (e.type === 'delegation' || e.type === 'tool') && e.t >= spoken.startedAt - 500)
        .map((e) => ({ type: e.type, name: e.name ?? e.intent ?? null, question: e.question ?? e.arguments ?? null, answer: e.answer ?? e.output ?? null, t: e.t }));
      return step(stepName, {
        child: spoken.text,
        childStartedAt: spoken.startedAt,
        childEndAt: spoken.endAt,
        childTranscript: childHeard,
        latencyMs: firstAudio ? firstAudio.t - spoken.endAt : null,
        coachSaid: coachWords,
        tools,
      });
    };

    // ───── A: the wizard; the conversation must open by itself ─────
    await page.goto('/#/');
    await page.locator('#root').waitFor();
    await page.getByRole('navigation', { name: 'Главное меню' }).getByRole('button', { name: /Играть/ }).click();
    await page.getByRole('button', { name: /10 минут/ }).click();
    await page.getByRole('button', { name: /Петя/ }).click();
    const fresh = page.getByRole('button', { name: 'Новая партия' });
    const gestureAt = Date.now();
    await page.getByRole('button', { name: /Белые/ }).click();
    await page.waitForTimeout(500);
    if (await fresh.isVisible().catch(() => false)) await fresh.click();
    let listeningAt = null;
    try {
      listeningAt = (await waitForProbe(page, (e) => e.type === 'store' && e.field === 'conversationState' && e.value === 'listening', DRY ? 2000 : 30_000, 'conversationState=listening')).t;
    } catch (error) {
      report.problems.push(String(error.message ?? error));
    }
    const log0 = await probeLog(page);
    const connectedAt = log0.find((e) => e.type === 'rtc.connected')?.t ?? null;
    const micReadyAt = log0.find((e) => e.type === 'rtc.mic-ready')?.t ?? null;
    const buttonClicks = log0.filter((e) => e.type === 'store' && e.field === 'conversationOn');
    step('A.autoConnect', {
      gestureAt,
      msToConnected: connectedAt ? connectedAt - gestureAt : null,
      msToListening: listeningAt ? listeningAt - gestureAt : null,
      msToMicReady: micReadyAt ? micReadyAt - gestureAt : null,
      conversationOnChanges: buttonClicks.map((e) => e.value),
      micRequests: await page.evaluate(() => window.__smokeMic.requests),
    });
    report.checks.A = { pass: listeningAt !== null, msToListening: listeningAt ? listeningAt - gestureAt : null, noButtonPressed: true };
    if (listeningAt === null && !DRY) throw new Error('the conversation did not open by itself');
    // dry run: no session opens the microphone — open the fake one so the child's lines can be played
    if (DRY) await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => undefined));
    await page.getByRole('status').filter({ hasText: 'Твой ход!' }).waitFor({ timeout: 45_000 });
    // the game's own opening words (gameStart brief) — wait until he is done
    await page.waitForTimeout(1500);
    await waitCoachQuiet(page, 1800, 30_000);
    await page.screenshot({ path: join(SHOT_DIR, `${NAME}-listening.png`) });

    if (SCENARIO === 'quiet') {
      // ───── talkativeness 'quiet': only urgent moments + answers ─────
      await clickMove(page, 'e2e4');
      await waitPlies(page, 2);
      await page.waitForTimeout(6000);
      const p2 = await readPosition(page);
      const second = p2.chess.moves({ verbose: true }).find((m) => m.from === 'd2' && (m.to === 'd4' || m.to === 'd3')) ?? p2.chess.moves({ verbose: true }).find((m) => m.piece === 'n');
      await clickMove(page, `${second.from}${second.to}`);
      await waitPlies(page, 4);
      await page.waitForTimeout(6000);
      report.checks.B = await ask('hello', 'B.smallTalk');
    } else {
      // ───── B: small talk, no button ─────
      const b = await ask('hello', 'B.smallTalk');
      report.checks.B = { pass: b.latencyMs !== null && b.latencyMs < 3500 && b.coachSaid.length > 0, latencyMs: b.latencyMs, coachSaid: b.coachSaid, tools: b.tools };

      // a real move and the bot's reply
      await clickMove(page, 'e2e4');
      const afterBot = await waitPlies(page, 2);
      step('move', { sans: afterBot.sans });
      await page.waitForTimeout(2500);
      await waitCoachQuiet(page, 1800, 30_000);

      // ───── C: «what does the opponent want?» ─────
      const posC = await readPosition(page);
      const c = await ask('opponent', 'C.opponent');
      const cText = c.coachSaid.join(' ');
      const cFacts = c.tools.map((t) => t.answer ?? '').join(' ');
      const cSquares = squaresMentioned(cText);
      const cFactSquares = new Set(squaresMentioned(cFacts));
      report.checks.C = {
        fen: posC.fen,
        sans: posC.sans,
        grounded: c.tools.some((t) => t.name === 'position' || t.name === 'analyze_position' || t.name === 'get_position_summary'),
        latencyMs: c.latencyMs,
        coachSaid: c.coachSaid,
        appFacts: cFacts,
        squaresSaid: cSquares,
        squaresNotInFacts: cSquares.filter((sq) => !cFactSquares.has(sq)),
      };
      report.checks.C.pass = report.checks.C.grounded && c.coachSaid.length > 0 && report.checks.C.squaresNotInFacts.length === 0;

      if (SCENARIO === 'full') {
        // ───── D: a hypothetical move «конём на эф три» ─────
        const posD = await readPosition(page);
        const engineD = await page.evaluate((fen) => window.__smokeEngine(fen, { depth: 14, multipv: 3 }), posD.fen);
        const d = await ask('knight', 'D.whatIf');
        const dText = d.coachSaid.join(' ');
        const best = spokenOfUci(posD.fen, engineD.bestmove);
        const nf3Line = engineD.lines.find((line) => line.pv[0] === 'g1f3');
        report.checks.D = {
          fen: posD.fen,
          engineBest: best?.san ?? engineD.bestmove,
          engineTop3: engineD.lines.map((line) => ({ move: spokenOfUci(posD.fen, line.pv[0])?.san ?? line.pv[0], cp: line.cp, mate: line.mate })),
          nf3InTop3: nf3Line ? { cp: nf3Line.cp } : null,
          evaluateCalled: d.tools.some((t) => t.name === 'evaluate' || t.name === 'evaluate_move'),
          latencyMs: d.latencyMs,
          coachSaid: d.coachSaid,
          appFacts: d.tools.map((t) => t.answer ?? '').join(' '),
          saysBestWord: /лучш/i.test(dText),
          namesEngineBest: best !== null && best.san !== 'Nf3' && normalise(dText).includes(normalise(best.spoken)),
        };
        report.checks.D.pass = report.checks.D.evaluateCalled && d.coachSaid.length > 0 && !report.checks.D.namesEngineBest;
      }

      // ───── E: a real blunder — the queen hangs → take-back offer in the model's OWN words ─────
      let blunder = null;
      for (let attempt = 0; attempt < 4 && !blunder && !overBudget(); attempt++) {
        const pos = await readPosition(page);
        const queenMoves = pos.chess.moves({ verbose: true }).filter((m) => m.piece === 'q');
        if (queenMoves.length > 0) {
          const scan = await page.evaluate(([fen, moves]) => window.__smokeEngine(fen, { depth: 10, multipv: moves.length, searchmoves: moves }), [pos.fen, queenMoves.map((m) => `${m.from}${m.to}`)]);
          const top = await page.evaluate((fen) => window.__smokeEngine(fen, { depth: 12, multipv: 1 }), pos.fen);
          const bestCp = top.lines[0]?.mate !== null && top.lines[0]?.mate !== undefined ? 1000 : (top.lines[0]?.cp ?? 0);
          const worst = [...scan.lines].map((line) => ({ uci: line.pv[0], cp: line.mate !== null ? (line.mate > 0 ? 1000 : -1000) : line.cp })).sort((a, b) => a.cp - b.cp)[0];
          if (worst && bestCp - worst.cp >= 500) {
            blunder = { fenBefore: pos.fen, uci: worst.uci, cpAfter: worst.cp, bestCp, best: spokenOfUci(pos.fen, top.bestmove), move: spokenOfUci(pos.fen, worst.uci) };
            break;
          }
        }
        // no queen move loses enough yet: bring the queen out (or develop) with a sound move, let the bot answer
        const prep = pos.chess.moves({ verbose: true }).find((m) => m.piece === 'q' && (m.to === 'h5' || m.to === 'f3' || m.to === 'g4')) ?? pos.chess.moves({ verbose: true }).find((m) => m.piece === 'b' && m.to === 'c4') ?? pos.chess.moves({ verbose: true })[0];
        await clickMove(page, `${prep.from}${prep.to}`);
        await waitPlies(page, pos.sans.length + 2);
        step('E.prep', { move: prep.san });
        await page.waitForTimeout(2000);
        await waitCoachQuiet(page, 1500, 30_000);
      }
      if (!blunder) throw new Error('found no queen blunder');
      step('E.blunder', { move: blunder.move?.san, engineBestBefore: blunder.best?.san, cpBest: blunder.bestCp, cpAfter: blunder.cpAfter });
      const beforeBlunderT = Date.now();
      await clickMove(page, blunder.uci);
      const offerPlay = await waitForProbe(page, (e) => e.type === 'coach.play' && e.kind === 'takebackOffer' && e.t >= beforeBlunderT, 25_000, 'the take-back offer');
      // the bubble with the model's own words, mid-sentence
      try {
        await page.waitForFunction(() => (document.querySelector('.gmb-bubble[data-visible="true"] .gmb-bubble-text')?.textContent ?? '').length > 25, null, { timeout: 8000 });
        await page.screenshot({ path: join(SHOT_DIR, `${NAME}-takeback.png`) });
      } catch {
        /* no caption: recorded by the checks */
      }
      const offerDone = await waitForProbe(page, (e) => e.type === 'say.done' && e.t >= offerPlay.t, 30_000, 'the take-back offer to be said').catch(() => null);
      await page.waitForTimeout(800);
      const logE = await probeLog(page);
      const offerSay = logE.find((e) => e.type === 'coach.say' && e.kind === 'takebackOffer' && e.t >= beforeBlunderT);
      const heardRealtime = logE.find((e) => e.type === 'say.heard' && e.t >= offerPlay.t)?.heard ?? null;
      const spokenOffer = offerDone?.heard || heardRealtime || logE.filter((e) => e.type === 'transcript' && e.who === 'coach' && e.t >= offerPlay.t).map((e) => e.text).join(' ');
      const template = offerSay?.text ?? '';
      const offerText = normalise(spokenOffer);
      report.checks.E = {
        move: blunder.move?.san,
        template,
        brief: offerSay?.brief ?? null,
        spoken: spokenOffer,
        outcome: offerDone?.outcome ?? null,
        similarityJaccard: jaccard(spokenOffer, template),
        conveysGoal: /верн|вернем|вернуть|назад|подума|отмен|переход|переиграть/.test(offerText),
        engineBestBefore: blunder.best?.san ?? null,
        namesBestMove: blunder.best !== null && normalise(spokenOffer).includes(normalise(blunder.best.spoken)),
        latencyFromMoveMs: (logE.find((e) => e.type === 'rtc.coach-audible' && e.audible === true && e.t >= beforeBlunderT)?.t ?? NaN) - beforeBlunderT,
      };
      report.checks.E.pass = spokenOffer.trim() !== '' && report.checks.E.similarityJaccard < 0.5 && report.checks.E.conveysGoal && !report.checks.E.namesBestMove;
      // «Верну ход и подумаю»
      await page.getByRole('button', { name: 'Верну ход и подумаю' }).click();
      await page.waitForTimeout(1500);
      await waitCoachQuiet(page, 1800, 30_000);
    }

    // a sound move (the engine's choice): a game needs two moves of the child on the board to be saved
    {
      const pos = await readPosition(page);
      const engine = await page.evaluate((fen) => window.__smokeEngine(fen, { depth: 10 }), pos.fen);
      await clickMove(page, engine.bestmove);
      await waitPlies(page, pos.sans.length + 2).catch(() => undefined);
      step('G.soundMove', { move: spokenOfUci(pos.fen, engine.bestmove)?.san });
      await page.waitForTimeout(1500);
      await waitCoachQuiet(page, 1800, 25_000);
    }

    // ───── G: finish the game, the journal ─────
    await page.getByRole('button', { name: 'Сдаться' }).click();
    await page.getByRole('button', { name: 'Да, сдаюсь' }).click();
    const result = page.getByRole('region', { name: 'Итог партии' });
    await result.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    await waitCoachQuiet(page, 1800, 25_000);
    const diary = result.getByRole('form', { name: 'Дневник партии' });
    const reviewButton = result.getByRole('button', { name: 'Разбор партии' });
    const endBy = Date.now() + 90_000;
    let saved = false;
    while (Date.now() < endBy) {
      if (await diary.isVisible().catch(() => false)) await diary.getByRole('button', { name: 'Пропустить' }).click().catch(() => undefined);
      if (await reviewButton.isVisible().catch(() => false)) {
        saved = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: join(SHOT_DIR, `${NAME}-result.png`) });
    if (!saved) report.problems.push(`no «Разбор партии»: ${((await result.textContent().catch(() => '')) ?? '').slice(0, 300)}`);
    step('G.gameOver', { saved });
  } catch (error) {
    report.problems.push(`aborted: ${String(error.message ?? error)}`);
    console.error(error);
  } finally {
    if (page) {
      // close the paid session promptly: the «Поговорить» button ends the conversation (the app reports the usage)
      try {
        const talk = page.locator('.gmb-talk[data-active="true"]');
        if (await talk.isVisible().catch(() => false)) await talk.click();
        else {
          const mute = page.getByRole('button', { name: 'Выключить голос Гамбитика' });
          if (await mute.isVisible().catch(() => false)) await mute.click();
        }
        await page.waitForTimeout(2500);
        report.closedBy = 'button';
      } catch (error) {
        report.problems.push(`close: ${String(error)}`);
      }
      try {
        const recording = await collectRecording(page);
        report.probe = await probeLog(page);
        report.micLines = await page.evaluate(() => window.__smokeMic.lines);
        report.rtpAudioPackets = await page.evaluate(() => window.__smokeRtp ?? []);
        report.ttsFallbackCalls = await page.evaluate(() => window.__smokeTtsCalls ?? []);
        report.console = consoleProblems;
        writeAudio(report, recording, lines);
      } catch (error) {
        report.problems.push(`collect: ${String(error)}`);
      }
    }
    await browser.close();
  }

  // ───── G: what the journal says ─────
  try {
    const games = await (await fetch(`${BASE}/api/games?limit=1`)).json();
    const id = games[0]?.id;
    if (id) {
      const record = await (await fetch(`${BASE}/api/games/${id}`)).json();
      const childSaid = record.events.filter((e) => e.type === 'childSaid').map((e) => e.data.text);
      const coachVoice = record.events.filter((e) => e.type === 'coachSaid' && e.data.source === 'voice').map((e) => e.data.text);
      const templates = record.events.filter((e) => e.data.spokenBy === 'model').map((e) => `${e.type}: ${e.data.template}`);
      const md = newestJournal(DATA_DIR);
      const timeline = md ? md.text.split('\n').filter((line) => /^- `\d\d:\d\d`/.test(line)) : [];
      report.checks.G = {
        gameId: id,
        childSaid,
        coachSaidVoice: coachVoice,
        templatesKeptAs: templates,
        journalFile: md?.file ?? null,
        journalTimeline: timeline,
        pass: childSaid.length > 0 && coachVoice.length > 0 && timeline.some((line) => line.includes('Тигр: «')) && timeline.some((line) => line.includes('Тренер: «')),
      };
    }
  } catch (error) {
    report.problems.push(`journal: ${String(error)}`);
  }
  const usageAfter = await (await fetch(`${BASE}/api/voice/usage`)).json().catch(() => null);
  report.usage = { before: usageBefore, after: usageAfter };
  analyse(report);

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${NAME}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 1)}\n`);
  const { probe: _probe, steps: _steps, ...summary } = report;
  console.log(JSON.stringify(summary, null, 1).slice(0, 12_000));
  console.log(`report: ${jsonPath}`);
}

function newestJournal(dataDir) {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.md')) found.push({ file: full, mtime: stat.mtimeMs });
    }
  };
  walk(join(dataDir, 'games'));
  const newest = found.sort((a, b) => b.mtime - a.mtime)[0];
  return newest ? { file: newest.file, text: readFileSync(newest.file, 'utf8') } : null;
}

function writeAudio(report, recording, lines) {
  mkdirSync(OUT_DIR, { recursive: true });
  report.files = [];
  report.recorderError = recording.error;
  recording.segments.forEach((segment, index) => {
    if (segment.bytes < 2000) return;
    const name = `${NAME}${recording.segments.length > 1 ? `-part${index + 1}` : ''}`;
    const webm = join(WORK_DIR, `${name}.webm`);
    writeFileSync(webm, Buffer.from(segment.base64, 'base64'));
    const m4a = join(OUT_DIR, `${name}.m4a`);
    try {
      run('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:a', 'aac', '-b:a', '96k', m4a]);
      const file = { m4a, seconds: Math.round(durationOf(m4a) * 10) / 10, recordingStartedAt: segment.startedAt };
      // the whole conversation to listen to: the coach (recorded) + the child's lines at the moments they were said
      const said = (report.micLines ?? []).filter((line) => line.startedAt >= segment.startedAt);
      if (said.length > 0) {
        const dialog = join(OUT_DIR, `${name}-dialog.m4a`);
        const inputs = ['-i', webm];
        const filters = [];
        said.forEach((line, i) => {
          inputs.push('-i', lines[line.id].wav);
          const delay = Math.max(0, line.startedAt - segment.startedAt);
          filters.push(`[${i + 1}:a]adelay=${delay}:all=1,volume=0.8[c${i}]`);
        });
        const mix = `[0:a]${said.map((_, i) => `[c${i}]`).join('')}amix=inputs=${said.length + 1}:duration=first:normalize=0[a]`;
        try {
          run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', [...filters, mix].join(';'), '-map', '[a]', '-ac', '1', '-c:a', 'aac', '-b:a', '96k', dialog]);
          file.dialog = dialog;
        } catch (error) {
          file.dialogError = String(error.message ?? error).slice(0, 300);
        }
      }
      report.files.push(file);
    } catch (error) {
      report.files.push({ webm, m4a: null, error: String(error.message ?? error).slice(0, 200) });
    }
  });
}

function analyse(report) {
  const log = report.probe ?? [];
  const says = log.filter((e) => e.type === 'coach.say');
  report.coachSays = says.map((e) => ({ t: e.t, kind: e.kind, priority: e.priority, outcome: e.outcome, text: e.text, hasBrief: Boolean(e.brief) }));
  const plays = log.filter((e) => e.type === 'coach.play');
  report.coachPlays = plays.map((e) => ({ t: e.t, kind: e.kind, layer: e.layer, ownWords: e.ownWords }));
  const done = log.filter((e) => e.type === 'say.done');
  report.sayOutcomes = done.map((e) => ({ t: e.t, outcome: e.outcome, mode: e.mode, heard: e.heard ?? null }));
  report.transcripts = log.filter((e) => e.type === 'transcript').map((e) => ({ t: e.t, who: e.who, text: e.text }));
  const wireErrors = log.filter((e) => e.type.startsWith('wire.') && (e.event === 'error' || String(e.event).endsWith('.failed')));
  report.wireErrors = wireErrors;
  const coachTexts = report.transcripts.filter((tr) => tr.who === 'coach').map((tr) => tr.text);
  const latin = coachTexts.flatMap((text) => text.match(/[A-Za-z]{2,}/g) ?? []);
  report.language = { coachUtterances: coachTexts.length, latinWords: latin, russianOnly: coachTexts.length > 0 && latin.length === 0 };
  if (report.talkativeness === 'quiet') {
    const spokenOnOwn = says.filter((e) => e.outcome === 'queued' && e.priority < 2 && e.kind !== 'answer' && e.kind !== 'hint');
    const filtered = says.filter((e) => e.outcome === 'filtered');
    report.checks.quiet = { filtered: filtered.map((e) => `${e.kind} (p${e.priority})`), spokenOnOwnBelowPriority2: spokenOnOwn.map((e) => `${e.kind} (p${e.priority})`), pass: spokenOnOwn.length === 0 && filtered.length > 0 };
  }
  const usage = (report.voiceHttp ?? []).filter((r) => /voice\/usage$/.test(r.url));
  report.usageReported = usage.length > 0;
  report.fallbackVoiceUsed = (report.ttsFallbackCalls ?? []).length;
}

await main();
