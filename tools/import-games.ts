/**
 * Imports finished game records (GameRecord JSON files) into the data folder through the server's own
 * POST /api/games route, in-process — no port, no browser, no voice. Used to recover games that the
 * browser parked while the server was unreachable and that were later delivered to a different data dir.
 *
 *   node --env-file-if-exists=.env tools/import-games.ts <record.json>... [--no-review]
 *
 * With a text-AI key configured, each imported game gets a review (codex → openrouter → openai-api → template);
 * the script waits up to 3 minutes for them. DATA_DIR selects the target folder (default: <repo>/data).
 */
import { readFileSync } from 'node:fs';
import { createApp, createServerContext, loadConfig } from '../apps/server/src/index.ts';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const skipReview = args.includes('--no-review');
if (files.length === 0) {
  console.error('usage: node --env-file-if-exists=.env tools/import-games.ts <record.json>... [--no-review]');
  process.exit(2);
}

const config = loadConfig(process.env, skipReview ? { autoReview: false } : {});
const ctx = await createServerContext(config);
const app = createApp(ctx);
const host = `127.0.0.1:${config.port}`;

const imported: string[] = [];
try {
  for (const file of files) {
    const record = JSON.parse(readFileSync(file, 'utf8')) as { id: string };
    const res = await app.request('/api/games', {
      method: 'POST',
      headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    console.log(`${record.id}: HTTP ${res.status} ${await res.text()}`);
    if (res.ok) imported.push(record.id);
  }

  if (!skipReview) {
    const deadline = Date.now() + 180_000;
    for (const id of imported) {
      let status = 'pending';
      let provider = '';
      while (status === 'pending' && Date.now() < deadline) {
        const res = await app.request(`/api/games/${id}/review`, { headers: { Host: host } });
        const review = (await res.json()) as { status?: string; provider?: string };
        status = review.status ?? 'unknown';
        provider = review.provider ?? '';
        if (status === 'pending') await new Promise((r) => setTimeout(r, 2000));
      }
      console.log(`${id}: review ${status}${provider ? ` (${provider})` : ''}`);
    }
  }
} finally {
  await ctx.close();
}
