#!/usr/bin/env node
/**
 * Text-path smoke test (NOT part of the e2e suite; may cost a few cents on OpenRouter). See README.md in this folder.
 * Posts one short finished game (the server's own test fixture: scholar's mate with one taken-back blunder) to a
 * THROW-AWAY server with real keys — as an ordinary client, NOT flagged as automation — waits for the background review
 * and reports which provider wrote it. The first lines of the Russian markdown go to
 * test-results/voice-samples/review-sample.md (`--out` to change).
 *
 *   node tools/voice-smoke/review.mjs --base-url http://127.0.0.1:8788
 *
 * The server has no route to delete a game: guard.ts refuses the child's 8787 and any server that does not report a
 * temp DATA_DIR (`dataDirIsTemp`), so the child's journal stays clean. It never reads .env and never sees a key.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleGameRecord } from '../../apps/server/src/testing/fixtures.ts';
import { argValue, baseUrlOrExit, orExit, outDir, safeHealthOrExit } from './guard.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

function arg(name, fallback) {
  return argValue(process.argv, name) ?? fallback;
}

/** mandatory, never the child's server (guard.ts) */
const BASE = baseUrlOrExit();
const OUT = orExit(() => (arg('out', undefined) !== undefined ? outDir(ROOT, arg('out', undefined)) : join(outDir(ROOT, undefined), 'review-sample.md')));
const WAIT_S = Number(arg('wait', '420'));
const LINES = Number(arg('lines', '15'));

// a Гамбитик server on a throw-away DATA_DIR, or nothing: a game is saved below and cannot be deleted
const health = await safeHealthOrExit(BASE);
console.log(`health.llm: ${JSON.stringify(health.llm)}`);

const startedMs = Date.now() - 8 * 60_000;
const record = sampleGameRecord({
  id: `smoke-review-${Date.now().toString(36)}`,
  startedAt: new Date(startedMs).toISOString(),
  endedAt: new Date(startedMs + 7 * 60_000 + 30_000).toISOString(),
});

const posted = await fetch(`${BASE}/api/games`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: BASE },
  body: JSON.stringify(record),
});
if (!posted.ok) {
  console.error(`POST /api/games → ${posted.status} ${await posted.text()}`);
  process.exit(4);
}
const { id } = await posted.json();
console.log(`posted game ${id}; waiting for the review (≤ ${WAIT_S} s)…`);

const t0 = Date.now();
let review = null;
while (Date.now() - t0 < WAIT_S * 1000) {
  const response = await fetch(`${BASE}/api/games/${encodeURIComponent(id)}/review`);
  if (response.ok) {
    review = await response.json();
    if (review.status !== 'pending') break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
const seconds = Math.round((Date.now() - t0) / 100) / 10;
if (!review || review.status === 'pending') {
  console.error(`no finished review after ${seconds} s (last status: ${review?.status ?? 'none'})`);
  process.exit(5);
}

const lines = String(review.markdown ?? '').split('\n');
const head = lines.slice(0, LINES).join('\n');
console.log(`review: status=${review.status} provider=${review.provider} after ${seconds} s, ${lines.length} lines`);
if (Array.isArray(review.keyTakeaways)) console.log(`keyTakeaways: ${JSON.stringify(review.keyTakeaways)}`);
if ('suggestedTheme' in review) console.log(`suggestedTheme: ${review.suggestedTheme} (${review.suggestedThemeTitle ?? '—'})`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  [
    '# Пример разбора партии (живой прогон)',
    '',
    `Дата: ${new Date().toISOString().slice(0, 10)}. Разбор написал провайдер **${review.provider}** (статус \`${review.status}\`) за ${seconds} с после сохранения партии.`,
    `Партия — тестовая (детский мат с одним возвращённым зевком, \`apps/server/src/testing/fixtures.ts\`), сохранена во временную папку данных, а не в \`data/\`.`,
    `Ниже — первые ${LINES} строк markdown ровно так, как их получил сервер.`,
    '',
    '---',
    '',
    head,
    '',
  ].join('\n'),
);
console.log(`\n${head}\n\nwritten: ${join(OUT)}`);
