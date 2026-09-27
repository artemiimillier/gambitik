#!/usr/bin/env node
/**
 * Live-voice smoke test (NOT part of the e2e suite, costs real money — a few cents per layer).
 * See README.md in this folder. Run from the repo root against a THROW-AWAY server (another port, a temp DATA_DIR —
 * never the child's 8787: guard.ts refuses it and any server that does not report `dataDirIsTemp`):
 *
 *   node tools/voice-smoke/run.mjs --base-url http://127.0.0.1:8788 --layers live,realtime --n 1 [--headphones yes] [--gap 3]
 *
 * What it does per layer: Chromium (muted speakers, fake microphone fed from a WAV with two Russian questions) opens a
 * training game vs Петя with settings.voice = <layer>, opts into real voice (`gambit.e2eVoice=on`), records the REMOTE
 * audio track and reads the app's voice probe (`window.__gambitVoiceProbe`, apps/web/src/coach/voiceProbe.ts).
 * It never reads .env and never sees a key: the browser talks to OUR server only (plus WebRTC / the ephemeral secret).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Chess } from 'chess.js';
import { sanToSpokenRu, squareToSpokenRu } from '../../packages/core/src/coach/index.ts';
import { argValue, baseUrlOrExit, orExit, outDir, safeHealthOrExit, workDir } from './guard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

// ───────────────────────── arguments ─────────────────────────

function arg(name, fallback) {
  return argValue(process.argv, name) ?? fallback;
}

/** mandatory, never the child's server (guard.ts) */
const BASE = baseUrlOrExit();
const LAYERS = arg('layers', 'live,realtime').split(',').map((s) => s.trim()).filter(Boolean);
const SAMPLE_NO = arg('n', '1');
const OUT_DIR = orExit(() => outDir(ROOT, arg('out', undefined)));
const WORK_DIR = orExit(() => workDir(ROOT, arg('work', undefined), 'voice'));
const HEADED = process.argv.includes('--headed');
/** the real default is «no headphones» → the software echo guard mutes the microphone while the coach is audible */
const HEADPHONES = arg('headphones', 'no') === 'yes';

/** seconds after the microphone opened at which the two questions are «asked» */
const Q1_AT = Number(arg('q1-at', '26'));
const GAP_AFTER_Q1 = Number(arg('gap', '24'));
const TAIL = Number(arg('tail', '24'));

const QUESTIONS = [
  { id: 'q1', text: 'Гамбитик, подскажи, какой ход здесь лучший и почему?' },
  { id: 'q2', text: 'А что хочет сделать соперник?' },
];

const KIND_OF_LAYER = { live: 'openai-live', realtime: 'openai-realtime' };

// ───────────────────────── audio fixture (never played aloud: `say -o` writes a file) ─────────────────────────

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function durationOf(file) {
  return Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());
}

function buildMicTimeline() {
  mkdirSync(WORK_DIR, { recursive: true });
  for (const q of QUESTIONS) {
    const wav = join(WORK_DIR, `${q.id}.wav`);
    if (existsSync(wav)) continue;
    const aiff = join(WORK_DIR, `${q.id}.aiff`);
    run('say', ['-v', 'Milena', '-o', aiff, q.text]);
    run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav]);
  }
  const q1 = join(WORK_DIR, 'q1.wav');
  const q2 = join(WORK_DIR, 'q2.wav');
  const d1 = durationOf(q1);
  const d2 = durationOf(q2);
  const out = join(WORK_DIR, `mic-timeline-${Q1_AT}-${GAP_AFTER_Q1}-${TAIL}.wav`);
  const silence = (seconds) => ['-f', 'lavfi', '-t', String(seconds), '-i', 'anullsrc=r=48000:cl=mono'];
  run('ffmpeg', ['-y', '-loglevel', 'error', ...silence(Q1_AT), '-i', q1, ...silence(GAP_AFTER_Q1), '-i', q2, ...silence(TAIL), '-filter_complex', '[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[a]', '-map', '[a]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  const q2At = Q1_AT + d1 + GAP_AFTER_Q1;
  return {
    file: out,
    total: q2At + d2 + TAIL,
    questions: [
      { ...QUESTIONS[0], startS: Q1_AT, endS: Q1_AT + d1 },
      { ...QUESTIONS[1], startS: q2At, endS: q2At + d2 },
    ],
  };
}

// ───────────────────────── page-side helpers ─────────────────────────

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
  // record the REMOTE audio of every coach connection
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
}

async function collectRecording(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const segment of window.__smokeRec.segments) {
      if (segment.recorder.state !== 'inactive') {
        await new Promise((resolve) => {
          segment.recorder.addEventListener('stop', resolve, { once: true });
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

const probeLog = (page) => page.evaluate(() => window.__gambitVoiceProbe?.log ?? []);

async function waitForProbe(page, predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = await probeLog(page);
    const hit = log.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.waitForTimeout(200);
  }
}

// ───────────────────────── position tracking from the DOM (the production bundle has no dev hook) ─────────────────────────

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

function historyOf(report, atT) {
  return [...(report.fenTimeline ?? [])].reverse().find((entry) => entry.t <= atT + 3000)?.sans ?? [];
}

async function readFen(page) {
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
  return { fen: chess.fen(), sans: chess.history() };
}

function normalise(text) {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Which legal moves / squares of the position (for either side) and which moves already PLAYED does the spoken text mention? */
function groundingOf(text, fen, playedSans = []) {
  const spoken = normalise(text);
  const moves = [];
  const squares = new Set();
  const played = [];
  const replay = new Chess();
  for (const san of playedSans) {
    let phrase = '';
    try {
      phrase = normalise(sanToSpokenRu(san, replay.fen()).replace(/, (шах|мат)$/, ''));
      replay.move(san);
    } catch {
      break;
    }
    // «пешка на е пять» is also said as «пешкой на е пять»: compare by the square part as well
    const square = phrase.split(' ').slice(-2).join(' ');
    if (phrase !== '' && (spoken.includes(phrase) || (square.length > 3 && spoken.includes(square)))) played.push(`${san} («${phrase}»)`);
  }
  for (const turn of ['w', 'b']) {
    const parts = fen.split(' ');
    parts[1] = turn;
    parts[3] = '-';
    let chess;
    try {
      chess = new Chess(parts.join(' '));
    } catch {
      continue;
    }
    for (const move of chess.moves({ verbose: true })) {
      const phrase = normalise(sanToSpokenRu(move.san).replace(/, (шах|мат)$/, ''));
      if (phrase !== '' && spoken.includes(phrase)) moves.push(`${turn === 'w' ? 'белые' : 'чёрные'}: ${move.san} («${phrase}»)`);
      for (const square of [move.from, move.to]) if (spoken.includes(normalise(squareToSpokenRu(square)))) squares.add(square);
    }
  }
  return { playedMovesMentioned: played, legalMovesMentioned: [...new Set(moves)], squaresOfLegalMovesMentioned: [...squares] };
}

function overlap(a, b) {
  const wa = new Set(normalise(a).split(' ').filter((w) => w.length > 3));
  const wb = new Set(normalise(b).split(' ').filter((w) => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common += 1;
  return Math.round((common / Math.min(wa.size, wb.size)) * 100) / 100;
}

// ───────────────────────── one layer ─────────────────────────

async function runLayer(layer, mic, health) {
  const kind = KIND_OF_LAYER[layer];
  const report = { layer, kind, sample: SAMPLE_NO, startedAt: new Date().toISOString(), model: layer === 'live' ? health.voice.liveModel : health.voice.model, voice: health.voice.voice };
  const consoleProblems = [];
  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${mic.file}%noloop`,
      '--mute-audio', // nothing is audible; the MediaStream itself is unaffected and is what gets recorded
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  try {
    const context = await browser.newContext({ baseURL: BASE, locale: 'ru-RU', viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
    const settings = { onboarded: true, voice: layer, micMode: 'open', headphonesConfirmed: HEADPHONES, muted: false };
    report.settings = settings;
    report.micTimeline = { q1AtS: Q1_AT, gapAfterQ1S: GAP_AFTER_Q1, tailS: TAIL };
    await context.addInitScript(initScript, settings);
    const put = await context.request.put('/api/student', { data: { nickname: 'Тигр', address: 'm', stage: 1 } });
    if (!put.ok()) throw new Error(`PUT /api/student → ${put.status()}`);

    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error' || (message.type() === 'warning' && /\[coach\]/.test(message.text()))) consoleProblems.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    });
    page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`));
    const voiceResponses = [];
    page.on('response', (response) => {
      const url = response.url();
      if (/\/api\/voice\/(live|session|usage)$/.test(url) || /api\.openai\.com/.test(url)) voiceResponses.push({ t: Date.now(), url: url.replace(/\?.*$/, ''), status: response.status() });
    });

    await page.goto('/#/play?persona=petya&tc=training&color=w&exam=0');
    await page.locator('#root').waitFor();
    // a «Продолжить партию?» dialog of an earlier attempt must not stand in the way
    const fresh = page.getByRole('button', { name: 'Новая партия' });
    if (await fresh.isVisible().catch(() => false)) await fresh.click();

    const gestureAt = Date.now();
    await page.mouse.click(640, 20); // the page gesture: unlocks audio, starts nothing else
    report.gestureAt = gestureAt;

    // (a) connection
    let connected = null;
    try {
      connected = await waitForProbe(page, (e) => e.type === 'rtc.connected' || e.type === 'rtc.connect-failed', 40_000, 'the voice session');
    } catch (error) {
      report.connectError = String(error.message ?? error);
    }
    const logAtConnect = await probeLog(page);
    const connectingAt = logAtConnect.find((e) => e.type === 'rtc.connecting')?.t ?? null;
    if (connected?.type === 'rtc.connected') {
      report.connected = true;
      report.connectMsFromGesture = connected.t - gestureAt;
      report.handshakeMs = connectingAt === null ? null : connected.t - connectingAt;
    } else {
      report.connected = false;
      report.connectFailure = connected?.reason ?? report.connectError ?? 'unknown';
    }

    // keep the game alive: 1.e4 as soon as the engines are ready
    try {
      await page.getByRole('status').filter({ hasText: 'Твой ход!' }).waitFor({ timeout: 45_000 });
      const board = page.getByTestId('trainer-board');
      await board.locator('[data-square="e2"]').click();
      await board.locator('[data-square="e4"]').click();
    } catch (error) {
      report.moveError = String(error.message ?? error);
    }

    const fenTimeline = [];
    if (report.connected) {
      // (b)+(c)+(d): let the microphone file play: greeting → question 1 → answer → question 2 → answer
      let micReady = null;
      try {
        micReady = await waitForProbe(page, (e) => e.type === 'rtc.mic-ready', 15_000, 'the microphone');
      } catch {
        report.micError = 'the microphone never opened';
      }
      const until = (micReady?.t ?? Date.now()) + mic.total * 1000;
      while (Date.now() < until) {
        const position = await readFen(page).catch(() => null);
        fenTimeline.push({ t: Date.now(), fen: position?.fen ?? null, sans: position?.sans ?? [] });
        await page.waitForTimeout(1000);
        const lost = (await probeLog(page)).some((e) => e.type === 'rtc.lost');
        if (lost && Date.now() > (micReady?.t ?? 0) + 5000) {
          // a lost session re-opens lazily; keep listening, the log tells the story
        }
      }
      report.micReadyAt = micReady?.t ?? null;
    }

    // close the paid session promptly: muting the coach closes it (the app reports the usage itself)
    const mute = page.getByRole('button', { name: 'Выключить голос Гамбитика' });
    if (await mute.isVisible().catch(() => false)) await mute.click();
    await page.waitForTimeout(1500);

    const recording = await collectRecording(page);
    const log = await probeLog(page);
    report.ttsFallbackCalls = await page.evaluate(() => window.__smokeTtsCalls ?? []);
    report.voiceHttp = voiceResponses;
    report.console = consoleProblems;
    report.recorderError = recording.error;
    report.probe = log;
    report.fenTimeline = fenTimeline.filter((entry, i, all) => i === 0 || entry.fen !== all[i - 1].fen);

    // ───── files ─────
    mkdirSync(OUT_DIR, { recursive: true });
    report.files = [];
    recording.segments.forEach((segment, index) => {
      if (segment.bytes < 2000) return;
      const name = `${layer}-${SAMPLE_NO}${recording.segments.length > 1 ? `-part${index + 1}` : ''}`;
      const webm = join(OUT_DIR, `${name}.webm`);
      writeFileSync(webm, Buffer.from(segment.base64, 'base64'));
      const m4a = join(OUT_DIR, `${name}.m4a`);
      try {
        run('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:a', 'aac', '-b:a', '96k', m4a]);
        const file = { webm, m4a, seconds: Math.round(durationOf(m4a) * 10) / 10, recordingStartedAt: segment.startedAt };
        // the whole conversation to listen to: the coach (recorded) + the child's questions (the fake microphone file)
        if (report.micReadyAt && index === 0) {
          const dialog = join(OUT_DIR, `${name}-dialog.m4a`);
          const delayMs = Math.max(0, Math.round(report.micReadyAt - segment.startedAt));
          try {
            run('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-i', mic.file, '-filter_complex', `[1:a]adelay=${delayMs}:all=1,volume=0.8[child];[0:a][child]amix=inputs=2:duration=first:normalize=0[a]`, '-map', '[a]', '-ac', '1', '-c:a', 'aac', '-b:a', '96k', dialog]);
            file.dialog = dialog;
            file.childOffsetMs = delayMs;
          } catch (error) {
            file.dialogError = String(error.message ?? error).slice(0, 200);
          }
        }
        report.files.push(file);
      } catch (error) {
        report.files.push({ webm, m4a: null, error: String(error.message ?? error).slice(0, 200) });
      }
    });

    analyse(report, mic);
    await context.close();
  } finally {
    await browser.close();
  }
  return report;
}

// ───────────────────────── analysis ─────────────────────────

function analyse(report, mic) {
  const log = report.probe ?? [];
  const audibleOn = log.filter((e) => e.type === 'rtc.coach-audible' && e.audible === true).map((e) => e.t);
  const transcripts = log.filter((e) => e.type === 'transcript').map((e) => ({ t: e.t, who: e.who, text: e.text }));
  const says = log.filter((e) => e.type === 'say').map((e) => ({ t: e.t, text: e.text, urgent: e.urgent }));
  // Live reports what was heard with `say.done`; Realtime sends a separate `say.heard` (final transcript of that response)
  const heardEvents = log.filter((e) => e.type === 'say.heard');
  const sayDone = log
    .filter((e) => e.type === 'say.done')
    .map((e, i) => ({ t: e.t, outcome: e.outcome ?? null, heard: e.heard || heardEvents[i]?.heard || null }));
  const tools = log.filter((e) => e.type === 'delegation' || e.type === 'tool');
  const wireErrors = log.filter((e) => e.type.startsWith('wire.') && (e.event === 'error' || String(e.event).endsWith('.failed')));
  const wireTypes = {};
  for (const e of log) if (e.type.startsWith('wire.')) wireTypes[`${e.type.slice(5)} ${e.event}`] = (wireTypes[`${e.type.slice(5)} ${e.event}`] ?? 0) + 1;

  report.greeting = { firstSay: says[0] ?? null, outcome: sayDone[0] ?? null, firstAudioMsAfterConnect: null };
  const connectedAt = log.find((e) => e.type === 'rtc.connected')?.t ?? null;
  if (connectedAt !== null) {
    const first = audibleOn.find((t) => t >= connectedAt);
    report.greeting.firstAudioMsAfterConnect = first === undefined ? null : first - connectedAt;
  }

  report.questions = [];
  if (report.micReadyAt) {
    mic.questions.forEach((q, index) => {
      const startT = report.micReadyAt + q.startS * 1000;
      const endT = report.micReadyAt + q.endS * 1000;
      const nextStart = mic.questions[index + 1] ? report.micReadyAt + mic.questions[index + 1].startS * 1000 : Infinity;
      const firstAudio = audibleOn.find((t) => t > startT + 1000 && t < nextStart);
      const heardChild = transcripts.filter((tr) => tr.who === 'child' && tr.t >= startT - 500 && tr.t < nextStart);
      const coachSaid = transcripts.filter((tr) => tr.who === 'coach' && tr.t >= startT && tr.t < nextStart + 4000);
      const tool = tools.filter((e) => e.t >= startT && e.t < nextStart);
      const fen = [...(report.fenTimeline ?? [])].reverse().find((entry) => entry.t <= endT + 3000)?.fen ?? report.fenTimeline?.[0]?.fen ?? null;
      const coachText = coachSaid.map((tr) => tr.text).join(' ');
      const appAnswer = tool.map((e) => e.answer ?? e.output ?? '').join(' ');
      report.questions.push({
        asked: q.text,
        latencyMsFromEndOfQuestionToFirstCoachAudio: firstAudio === undefined ? null : firstAudio - endT,
        childTranscript: heardChild.map((tr) => tr.text),
        coachTranscript: coachSaid.map((tr) => tr.text),
        toolOrDelegation: tool.map((e) => ({ type: e.type, name: e.name ?? e.intent ?? null, question: e.question ?? e.arguments ?? null, answer: e.answer ?? e.output ?? null })),
        fen,
        grounding: fen && coachText ? { ...groundingOf(coachText, fen, historyOf(report, endT)), overlapWithAppAnswer: appAnswer ? overlap(coachText, appAnswer) : null } : null,
      });
    });
  }

  const coachTexts = [...transcripts.filter((tr) => tr.who === 'coach').map((tr) => tr.text), ...sayDone.map((d) => d.heard ?? '')].filter(Boolean);
  const latin = coachTexts.flatMap((text) => text.match(/[A-Za-z]{2,}/g) ?? []);
  report.language = { coachUtterances: coachTexts.length, latinWords: latin, russianOnly: coachTexts.length > 0 && latin.length === 0 };
  // was the coach talking when a question started, and how fast did it yield? (only meaningful without the echo guard)
  const audibleEdges = log.filter((e) => e.type === 'rtc.coach-audible').map((e) => ({ t: e.t, audible: e.audible === true }));
  report.bargeIn = (report.micReadyAt ? mic.questions : []).map((q) => {
    const startT = report.micReadyAt + q.startS * 1000;
    const before = [...audibleEdges].reverse().find((e) => e.t <= startT);
    const coachTalking = before?.audible === true && startT - before.t < 2500;
    if (!coachTalking) return { question: q.id, coachWasTalking: false };
    const quiet = audibleEdges.find((e) => e.t > startT && !e.audible);
    return { question: q.id, coachWasTalking: true, coachQuietAfterMs: quiet ? quiet.t - startT : null };
  });
  const gates = log.filter((e) => e.type === 'rtc.mic-gate');
  report.echoGuard = {
    headphones: HEADPHONES,
    micGateChanges: gates.length,
    muteSent: wireTypes['out session.input_audio.mute'] ?? 0,
    unmuteSent: wireTypes['out session.input_audio.unmute'] ?? 0,
    mutedAcks: wireTypes['in session.input_audio.muted'] ?? 0,
    unmutedAcks: wireTypes['in session.input_audio.unmuted'] ?? 0,
    errors: wireErrors.length,
  };
  report.transcripts = transcripts;
  report.says = says.map((s, i) => ({ ...s, done: sayDone[i] ?? null }));
  report.wireErrors = wireErrors;
  report.wireEventCounts = wireTypes;
  const usage = (report.voiceHttp ?? []).filter((r) => /voice\/usage$/.test(r.url));
  report.usageReported = usage.length > 0;
}

// ───────────────────────── main ─────────────────────────

// a Гамбитик server on a throw-away DATA_DIR, or nothing: the profile «Тигр» is written below
const health = await safeHealthOrExit(BASE);
console.log(`health: openaiKey=${health.llm.openaiKey} live=${health.voice.live} (${health.voice.liveModel}) realtime=${health.voice.realtime} (${health.voice.model}) voice=${health.voice.voice} preferred=${health.voice.preferred}`);
if (!health.llm.openaiKey) {
  console.error('The server has no OPENAI_API_KEY — nothing to test.');
  process.exit(3);
}

const mic = buildMicTimeline();
console.log(`microphone timeline: ${Math.round(mic.total)} s, questions at ${mic.questions.map((q) => `${q.startS.toFixed(1)}–${q.endS.toFixed(1)} s`).join(', ')}; headphones: ${HEADPHONES ? 'yes (no echo guard)' : 'no (echo guard on)'}`);

for (const layer of LAYERS) {
  if (!(layer in KIND_OF_LAYER)) {
    console.error(`unknown layer «${layer}» (use live or realtime)`);
    continue;
  }
  console.log(`\n=== ${layer} ===`);
  const report = await runLayer(layer, mic, health);
  const jsonPath = join(OUT_DIR, `${layer}-${SAMPLE_NO}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 1)}\n`);
  const { probe: _probe, ...brief } = report;
  console.log(JSON.stringify({ ...brief, fenTimeline: undefined, transcripts: undefined }, null, 1));
  console.log(`report: ${jsonPath}`);
}
