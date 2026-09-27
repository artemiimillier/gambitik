/**
 * «Дозапись голоса» — the overlay's layout and publishing rule (./overlay.ts, docs/voice-clips/ONDEMAND.md), pure parts:
 * where the overlay may live, what a take also serves (`alsoKeys`), the placeholder words ASR must hear, hard vs soft
 * flags, `blocked[]`, the overlay manifest, the tempo decision after clamping, and the pack split at 700 ms on
 * synthetic PCM (no ffmpeg, nothing played).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIP_CATALOG } from '../../packages/core/src/coach/clips/catalog.ru.ts';
import { catalogFallbacks } from '../../packages/core/src/coach/clips/catalog.ts';
import { PACK_SPLIT, PACK_TAG } from '../../packages/core/src/coach/clips/tts.ts';
import { repoPath } from '../lib/cli.ts';
import { ASR_MIN_SCORE, criticalItems, matchTranscript, normalizeRu } from './asr.ts';
import { DEFAULT_OVERLAY_DIR, PUBLISH_LOCK, TAG_SILENCE_MS, VOICE_KEY } from './config.ts';
import { splitAtSilences } from './dsp.ts';
import type { GenJob } from './jobs.ts';
import { LedgerLocked } from './ledger.ts';
import { buildManifest, isPublishable } from './manifest.ts';
import type { UnitRecord, UnitStore, Verdicts } from './manifest.ts';
import { ONDEMAND_CAMPAIGN, onDemandViewOf, unitAttempts } from './ondemand.ts';
import type { OnDemandLine } from './ondemand.ts';
import { alsoKeysOf, asrRuleOf, blockedKeys, criticalWordsOfKey, currentTextOfKey, isHardFlag, lockPublish, overlayPaths, parseLineKey, partRoleOf, placeholderWords, resolveOverlayDir, softTextFlags } from './overlay.ts';
import { tempoDecision } from './process.ts';
import { RATE, concat, silence, tone } from './testkit.ts';

describe('where the overlay lives', () => {
  const ov = path.join(path.sep, 'Users', 'someone', 'Library', 'Application Support', 'Gambitik', 'voice-overlay');

  it('flag, then VOICE_OVERLAY_DIR, then the default — never the default under vitest', () => {
    expect(resolveOverlayDir(ov, {})).toBe(ov);
    expect(resolveOverlayDir('off', { VOICE_OVERLAY_DIR: ov })).toBeNull();
    expect(resolveOverlayDir(undefined, { VOICE_OVERLAY_DIR: ov })).toBe(ov);
    expect(resolveOverlayDir(undefined, { VOICE_OVERLAY_DIR: 'off' })).toBeNull();
    expect(resolveOverlayDir(undefined, {})).toBe(DEFAULT_OVERLAY_DIR);
    expect(resolveOverlayDir(undefined, { VITEST: 'true' })).toBeNull();
    expect(resolveOverlayDir(ov, { VITEST: 'true' })).toBe(ov);
  });

  it('absolute and outside the checkout only (a git clean must never delete paid audio)', () => {
    expect(() => resolveOverlayDir('voice-overlay', {})).toThrow(/absolute path/);
    expect(() => resolveOverlayDir(repoPath('voice-overlay'), {})).toThrow(/inside this checkout/);
    expect(() => resolveOverlayDir(undefined, { VOICE_OVERLAY_DIR: repoPath('data', 'ov') })).toThrow(/inside this checkout/);
  });

  it('the server’s own check: never inside ANOTHER git checkout, the child’s DATA_DIR or the web build', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gambit-ov-place-'));
    try {
      const here = path.join(root, 'Chess-voice');
      const other = path.join(root, 'Chess');
      mkdirSync(here, { recursive: true });
      mkdirSync(path.join(other, '.git'), { recursive: true });
      // the main checkout next to this worktree: the server would refuse it ('repo'), so the tools must too
      expect(() => resolveOverlayDir(path.join(other, 'voice-overlay'), {}, here)).toThrow(/git checkout/);
      expect(() => resolveOverlayDir(path.join(root, 'kid-data', 'ov'), { DATA_DIR: path.join(root, 'kid-data') }, here)).toThrow(/DATA_DIR/);
      expect(resolveOverlayDir(path.join(root, 'voice-overlay'), {}, here)).toBe(path.join(root, 'voice-overlay'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('VOICE_OVERLAY_DIR from the checkout’s .env (the server’s file) — that one line only, never under vitest', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gambit-ov-env-'));
    try {
      const repo = path.join(root, 'checkout');
      mkdirSync(repo, { recursive: true });
      const custom = path.join(root, 'GambitVoice');
      writeFileSync(path.join(repo, '.env'), `OPENAI_API_KEY=sk-test-secret\n# the overlay\nexport VOICE_OVERLAY_DIR="${custom}"  \nDATA_DIR=kid-data\n`);
      const env: NodeJS.ProcessEnv = {};
      expect(resolveOverlayDir(undefined, env, repo)).toBe(custom);
      // nothing else from the file reaches the environment
      expect(env).toEqual({});
      expect(process.env.OPENAI_API_KEY === 'sk-test-secret').toBe(false);
      // the process environment and the flag still win; a test never reads a .env
      expect(resolveOverlayDir(undefined, { VOICE_OVERLAY_DIR: 'off' }, repo)).toBeNull();
      expect(resolveOverlayDir('off', {}, repo)).toBeNull();
      expect(resolveOverlayDir(undefined, { VITEST: 'true' }, repo)).toBeNull();
      // DATA_DIR of the same file guards the child's data
      expect(() => resolveOverlayDir(path.join(repo, '..', 'x'), {}, repo)).not.toThrow();
      writeFileSync(path.join(repo, '.env'), `DATA_DIR=${path.join(root, 'kid-data')}\n`);
      expect(() => resolveOverlayDir(path.join(root, 'kid-data', 'ov'), {}, repo)).toThrow(/DATA_DIR/);
      expect(resolveOverlayDir(undefined, {}, repo)).toBe(DEFAULT_OVERLAY_DIR);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the layout', () => {
    expect(overlayPaths(ov)).toEqual({
      dir: ov,
      ledgerFile: path.join(ov, 'ledger.giselle-mm1.jsonl'),
      mastersDir: path.join(ov, '.masters'),
      storeFile: path.join(ov, 'units.giselle-mm1.json'),
      reviewFile: path.join(ov, 'review.giselle-mm1.json'),
      reportFile: path.join(ov, 'process-report.giselle-mm1.json'),
      verifyReportFile: path.join(ov, 'verify-report.giselle-mm1.json'),
      libraryRoot: ov,
    });
  });
});

describe('the publish lock (one writer of the overlay store and manifest)', () => {
  it('free: taken and released; held by another live process: refused; held by our parent (the server`s finish): ours already', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-publish-lock-'));
    try {
      const lock = path.join(dir, PUBLISH_LOCK);
      const release = await lockPublish(dir);
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
      release();
      expect(existsSync(lock)).toBe(false);
      // this very process stands in for a server that is publishing (alive, not our parent)
      writeFileSync(lock, String(process.pid));
      await expect(lockPublish(dir)).rejects.toBeInstanceOf(LedgerLocked);
      let waited = 0;
      await expect(lockPublish(dir, { waitMs: 1_000, sleep: async (ms) => void (waited += ms) })).rejects.toThrow(/сервер публикует/);
      expect(waited).toBeGreaterThanOrEqual(1_000);
      // the server's own `process` / `verify` child: the lock is its parent's — go on, and leave it to the parent
      writeFileSync(lock, String(process.ppid));
      const inner = await lockPublish(dir);
      inner();
      expect(readFileSync(lock, 'utf8')).toBe(String(process.ppid));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what a line unit key says', () => {
  it('parses pool, piece, gender and wording number', () => {
    expect(parseLineKey('line:v3.lead.subject@q#2')).toEqual({ pool: 'v3.lead.subject', piece: 'q', n: 2 });
    expect(parseLineKey('line:v3.self.develop/f#5')).toEqual({ pool: 'v3.self.develop', g: 'f', n: 5 });
    expect(parseLineKey('frag:f:ладью, коня или слона|?')).toBeNull();
  });

  it('alsoKeys: the variants whose wording expands to exactly the same words', () => {
    // «— {он} дойдёт до края и превратится!»: «она» for the pawn and the rook, «он» for the others
    expect(alsoKeysOf('line:v3.idea.promotion@p#1', '— она дойдёт до края и превратится!')).toEqual(['line:v3.idea.promotion@r#1']);
    expect(alsoKeysOf('line:v3.idea.promotion@n#1', '— он дойдёт до края и превратится!')).toEqual(['line:v3.idea.promotion@b#1', 'line:v3.idea.promotion@q#1', 'line:v3.idea.promotion@k#1']);
    // a stale text (the wording changed) serves nothing else; frag / unknown keys neither
    expect(alsoKeysOf('line:v3.idea.promotion@p#1', 'другие слова')).toEqual([]);
    expect(alsoKeysOf('frag:f:ладью, коня или слона|?', 'Ладью, коня или слона?')).toEqual([]);
  });

  it('a piece without a role is a lead when its pool is one (the continuing-lead check never depends on the caller)', () => {
    expect(partRoleOf({ key: 'line:v3.lead.subject@n#1' })).toBe('lead');
    expect(partRoleOf({ key: 'line:v3.lead.subject@n#1', role: 'leadAlone' })).toBe('leadAlone');
    expect(partRoleOf({ key: 'line:v3.idea.promotion@p#1' })).toBeUndefined();
    expect(partRoleOf({ key: 'frag:f:ладью, коня или слона|?' })).toBeUndefined();
  });

  it('the words the placeholders produced', () => {
    expect(placeholderWords('{Твой} {конь} {p:готов|готова} к делу', { piece: 'r' })).toEqual(['Твоя', 'ладья', 'готова']);
    expect(criticalWordsOfKey('line:v3.lead.subject@q#2')).toEqual(['Твой', 'ферзь', 'готов']);
    expect(criticalWordsOfKey('line:v3.self.develop/f#5')).toEqual(['сама']);
    expect(criticalWordsOfKey('line:no.such.pool#1')).toEqual([]);
  });
});

describe('what a catalogue key says (a whole sentence of an older event, recorded on demand)', () => {
  it('its words today, its placeholder words (the ASR must hear them), no lead role, twins only for the same words', () => {
    expect(parseLineKey('line:greet.win/f#1')).toEqual({ pool: 'greet.win', g: 'f', n: 1 });
    expect(currentTextOfKey('line:greet.win/f#1')).toBe('В прошлый раз ты победила — здорово! Сыграем ещё?');
    expect(currentTextOfKey('line:greet.hello.day#1')).toBe('Добрый день!');
    expect(currentTextOfKey('line:greet.hello.day#99')).toBeNull();
    expect(criticalWordsOfKey('line:greet.win/f#1')).toEqual(['победила']);
    expect(criticalWordsOfKey('line:ask.opp.hanging@q#1')).toEqual(['твоего', 'ферзя']);
    expect(asrRuleOf({ key: 'line:ask.opp.hanging@q#1', text: 'Он хочет забрать твоего ферзя!' }, 'overlay').extra.words).toEqual(['твоего', 'ферзя']);
    expect(partRoleOf({ key: 'line:greet.hello.day#1' })).toBeUndefined();
    expect(partRoleOf({ key: 'line:greet.hello.day#1', role: 'whole' })).toBe('whole');
    // other pieces say other words: a catalogue take serves only its own key
    expect(alsoKeysOf('line:ask.opp.hanging@q#1', 'Он хочет забрать твоего ферзя!')).toEqual([]);
    expect(alsoKeysOf('line:greet.hello.day#1', 'Добрый день!')).toEqual([]);
  });

  it('attempts and blocked[] count for a catalogue key exactly as for a lesson key (one budget, the same S6 rule)', () => {
    const KEY = 'line:greet.hello.day#1';
    const TEXT = 'Добрый день!';
    const job = (jobId: string, text: string): OnDemandLine[] => {
      const g: GenJob = { prompt: `${jobId}:${text}`, take: 101, recipe: 'single', pieces: [{ key: KEY, text, role: 'whole' }] };
      return [
        { ev: 'created', at: 't', run: 'r', campaign: ONDEMAND_CAMPAIGN, key: jobId, jobId, milli: 150, job: g },
        { ev: 'charged', at: 't', key: jobId, jobId, campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://x' },
      ];
    };
    const view = onDemandViewOf([...job('j1', TEXT), ...job('j2', TEXT)]);
    expect(unitAttempts(view, { key: KEY, text: TEXT })).toBe(2);
    expect(unitAttempts(view, { key: KEY, text: 'Другие слова.' })).toBe(0);
    const store: UnitStore = {
      v: 1,
      voiceKey: VOICE_KEY,
      units: {
        c0000000000031: unit('c0000000000031', KEY, { text: TEXT, qa: 'needsEar', jobId: 'j1', flags: ['asr:0.6'] }),
        c0000000000032: unit('c0000000000032', KEY, { text: TEXT, qa: 'needsEar', jobId: 'j2', flags: ['asr:0.7'] }),
      },
    };
    const publishable = (u: UnitRecord) => isPublishable(u, undefined);
    expect(blockedKeys(store, {}, view, publishable)).toEqual([KEY]);
    // the same failures of words the key does not name today block nothing
    const stale: UnitStore = { ...store, units: Object.fromEntries(Object.entries(store.units).map(([id, u]) => [id, { ...u, text: 'Старые слова.' }])) };
    expect(blockedKeys(stale, {}, onDemandViewOf([...job('j1', 'Старые слова.'), ...job('j2', 'Старые слова.')]), publishable)).toEqual([]);
  });

  it('the overlay manifest publishes a catalogue take under its key and every pool it joins', () => {
    const store: UnitStore = {
      v: 1,
      voiceKey: VOICE_KEY,
      units: { c0000000000041: unit('c0000000000041', 'line:greet.win#2', { text: 'Помню твою прошлую победу. Поехали дальше?', pool: 'greet.win', pools: ['greet.win', 'greet.win/m', 'greet.win/f'], role: 'whole' }) },
    };
    const m = buildManifest(store, {}, 1, { rule: 'overlay' });
    expect(m.keys['line:greet.win#2']).toEqual(['c0000000000041']);
    expect(Object.keys(m.pools).sort()).toEqual(['greet.win', 'greet.win/f', 'greet.win/m']);
    expect(m.fallbacks['greet.win']).toBe('greet.none');
  });
});

describe('the ASR check of the overlay', () => {
  const said = 'Есть ход с нападением на короля. Попробуй найти его сама, не торопись!';

  it('a dropped placeholder word fails even when the words are ≥ 0.90 alike', () => {
    const heard = 'Есть ход с нападением на короля. Попробуй найти его сразу, не торопись!';
    expect(matchTranscript(said, heard).ok).toBe(true);
    expect(matchTranscript(said, heard, ASR_MIN_SCORE, { words: ['сама'] })).toMatchObject({ ok: false, missing: ['сама'] });
    expect(criticalItems(normalizeRu(said), { words: ['сама'] })).toContainEqual({ kind: 'word', word: 'сама' });
  });

  it('an opening interjection is critical; a unit of 1–2 words passes at 0.75 (the piece word still required)', () => {
    const wow = asrRuleOf({ key: 'line:v3.react.wow#1', text: 'Ого!' }, 'overlay');
    expect(matchTranscript('Ого!', 'Оху!', wow.minScore, wow.extra)).toMatchObject({ ok: false, missing: ['ого'] });
    expect(matchTranscript('Ого, вилка!', 'Ого, вилка!', ASR_MIN_SCORE, { interjection: true }).ok).toBe(true);
    const rook = asrRuleOf({ key: 'line:v3.helper@r#3', text: 'Ладья!' }, 'overlay');
    expect(rook.minScore).toBe(0.75);
    expect(matchTranscript('Ладьёй!', 'Ладьйой!', rook.minScore, rook.extra).ok).toBe(true);
    expect(matchTranscript('Ладьёй!', 'Ладьйой!').ok).toBe(false);
    expect(matchTranscript('Ладьёй!', 'Слоном!', rook.minScore, rook.extra).ok).toBe(false);
    // the static library keeps its rule
    expect(asrRuleOf({ key: 'line:v3.helper@r#3', text: 'Ладья!' }, 'static')).toEqual({ minScore: ASR_MIN_SCORE, extra: {} });
  });
});

describe('hard and soft flags', () => {
  it('the overlay publishes past soft flags; the static library holds back on any gate flag', () => {
    for (const f of ['tempo-soft:4.8', 'edge-f0-soft:201', 'yo', 'name', 'frag-comma']) {
      expect(isHardFlag(f, 'overlay'), f).toBe(false);
      expect(isHardFlag(f, 'static'), f).toBe(true);
    }
    for (const f of ['tempo:6.1', 'ms-per-char:30', 'clipped:3', 'voiced:12%', 'asr:0.8', 'asr-missing:конем', 'lufs:-21.9', 'missing-file']) expect(isHardFlag(f, 'overlay'), f).toBe(true);
    for (const f of ['breath-stripped', 'pauses-clamped:1', 'cont:236', 'regain:+1.4']) {
      expect(isHardFlag(f, 'overlay'), f).toBe(false);
      expect(isHardFlag(f, 'static'), f).toBe(false);
    }
  });

  it('texts that go first on the review page', () => {
    expect(softTextFlags({ text: 'Вот и всё, молодец.' })).toEqual(['yo']);
    expect(softTextFlags({ text: 'Все фигуры в игре!' })).toEqual(['yo']);
    expect(softTextFlags({ text: 'Всему своё время.' })).toEqual([]);
    expect(softTextFlags({ text: 'Разыграем «Итальянскую партию».' })).toEqual(['name']);
    expect(softTextFlags({ text: 'Да, это подарок, просто меняемся или нет, будет хуже?', kind: 'frag' })).toEqual(['frag-comma']);
    expect(softTextFlags({ text: 'Ладью, коня или слона?', kind: 'frag' })).toEqual([]);
  });

  it('the rate is judged after the clamped atempo (5.63 syl/s reaches 4.5 at ×0.8)', () => {
    expect(tempoDecision(5.63)).toEqual({ factor: 0.8, inRange: true });
    expect(tempoDecision(2.5)).toEqual({ factor: 1.3, inRange: false });
  });
});

// ── blocked[] and the overlay manifest ──────────────────────────────────────────────────────────────────────────────

const unit = (id: string, key: string, extra: Partial<UnitRecord> = {}): UnitRecord => ({
  id,
  key,
  text: '— она дойдёт до края и превратится!',
  take: 101,
  ms: 900,
  on: 30,
  off: 840,
  file: `${id.slice(1, 3)}/${id}.mp3`,
  qa: 'asr',
  asr: { heard: 'x', score: 1, ok: true, missing: [], model: 'm', at: 't' },
  jobId: `j-${id}`,
  jobKey: 'k',
  cut: 0,
  bytes: 1000,
  flags: [],
  processedAt: 't',
  ...extra,
});

const genJob = (keys: string[]): GenJob => ({ prompt: keys.join('|'), take: 101, recipe: 'pack', pieces: keys.map((key) => ({ key, text: key })) });
function charged(jobId: string, keys: string[], state: 'charged' | 'pending' = 'charged'): OnDemandLine[] {
  const job = genJob(keys);
  const created: OnDemandLine = { ev: 'created', at: 't', run: 'r', campaign: ONDEMAND_CAMPAIGN, key: jobId, jobId, milli: 150, job };
  return state === 'pending' ? [created] : [created, { ev: 'charged', at: 't', key: jobId, jobId, campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://x' }];
}

describe('blocked[]', () => {
  const A = 'line:v3.a#1';
  const B = 'line:v3.b#1';
  const C = 'line:v3.c#1';
  const D = 'line:v3.d#1';
  const E = 'line:v3.e#1';

  it('two processed paid attempts without a publishable take, or a reject, block a key; redo allows one more; in flight never', () => {
    const store: UnitStore = {
      v: 1,
      voiceKey: VOICE_KEY,
      units: {
        c0000000000001: unit('c0000000000001', A, { qa: 'needsEar', jobId: 'j1', flags: ['asr:0.6'] }),
        c0000000000002: unit('c0000000000002', A, { qa: 'needsEar', jobId: 'j2', flags: ['asr:0.7'] }),
        c0000000000003: unit('c0000000000003', B, { qa: 'needsEar', jobId: 'j3' }),
        c0000000000004: unit('c0000000000004', C, { qa: 'needsEar', jobId: 'j4' }),
        c0000000000005: unit('c0000000000005', C, { qa: 'needsEar', jobId: 'j5' }),
        c0000000000006: unit('c0000000000006', D, { jobId: 'j6' }),
      },
      requeued: { j7: 'split: 1 pieces, expected 2' },
    };
    const verdicts: Verdicts = { c0000000000003: { verdict: 'reject' }, c0000000000004: { verdict: 'redo' } };
    const view = onDemandViewOf([
      ...charged('j1', [A]),
      ...charged('j2', [A]),
      ...charged('j3', [B]),
      ...charged('j4', [C]),
      ...charged('j5', [C]),
      ...charged('j6', [D]),
      ...charged('j7', [E]),
      ...charged('j8', [E], 'pending'),
    ]);
    const publishable = (u: UnitRecord) => isPublishable(u, verdicts[u.id]?.verdict);
    // A: 2 failed attempts → blocked · B: rejected → blocked · C: redo → a third attempt allowed · D: published · E: one
    // requeued attempt + one in flight → not blocked (yet)
    expect(blockedKeys(store, verdicts, view, publishable)).toEqual([A, B]);
    // a charged job not processed yet is in flight too
    const later = onDemandViewOf([...charged('j1', [A]), ...charged('j9', [A])]);
    expect(blockedKeys({ ...store, units: { c0000000000001: store.units.c0000000000001! } }, {}, later, publishable)).toEqual([]);
  });

  it('only the words a key names today: after a wording was inserted, the old words’ failures block nothing', () => {
    // two failed paid attempts at `line:v3.whole.castle#1` when it still said other words (the writers inserted one since)
    const OLD = 'Старая фраза про рокировку.';
    const KEY = 'line:v3.whole.castle#1';
    const today = currentTextOfKey(KEY);
    expect(today).not.toBeNull();
    expect(today).not.toBe(OLD);
    const store: UnitStore = {
      v: 1,
      voiceKey: VOICE_KEY,
      units: {
        c0000000000021: unit('c0000000000021', KEY, { text: OLD, qa: 'needsEar', jobId: 'j1', flags: ['asr:0.6'] }),
        c0000000000022: unit('c0000000000022', KEY, { text: OLD, qa: 'needsEar', jobId: 'j2', flags: ['asr:0.7'] }),
      },
    };
    const job = (jobId: string, text: string): OnDemandLine[] => {
      const g: GenJob = { prompt: `${jobId}:${text}`, take: 101, recipe: 'pack', pieces: [{ key: KEY, text }] };
      return [
        { ev: 'created', at: 't', run: 'r', campaign: ONDEMAND_CAMPAIGN, key: jobId, jobId, milli: 150, job: g },
        { ev: 'charged', at: 't', key: jobId, jobId, campaign: ONDEMAND_CAMPAIGN, milli: 150, status: 'completed', resultUrl: 'https://x' },
      ];
    };
    const view = onDemandViewOf([...job('j1', OLD), ...job('j2', OLD)]);
    const publishable = (u: UnitRecord) => isPublishable(u, undefined);
    expect(blockedKeys(store, {}, view, publishable)).toEqual([]);
    // the same failures of today's words do block it
    const now: UnitStore = { ...store, units: Object.fromEntries(Object.entries(store.units).map(([id, u]) => [id, { ...u, text: today as string }])) };
    expect(blockedKeys(now, {}, onDemandViewOf([...job('j1', today as string), ...job('j2', today as string)]), publishable)).toEqual([KEY]);
  });

  it("the overlay manifest: ctx, the alsoKeys in `keys`, blocked, the catalogue's fallbacks (its whole catalogue sentences walk the pool route); the static one unchanged", () => {
    const store: UnitStore = {
      v: 1,
      voiceKey: VOICE_KEY,
      units: {
        c0000000000011: unit('c0000000000011', 'line:v3.idea.promotion@p#1', { pool: 'v3.idea.promotion@p' }),
        c0000000000012: unit('c0000000000012', 'line:v3.lead.subject@n#1', { text: 'Конь просится в бой', ctx: 'cont', role: 'lead', flags: ['cont:236', 'tempo-soft:4.9'] }),
      },
    };
    const m = buildManifest(store, {}, 3, { rule: 'overlay', blocked: ['line:v3.b#1', 'line:v3.a#1'] });
    expect(m.keys['line:v3.idea.promotion@r#1']).toEqual(['c0000000000011']);
    expect(m.keys['line:v3.idea.promotion@p#1']).toEqual(['c0000000000011']);
    expect(m.units.c0000000000012).toMatchObject({ ctx: 'cont' });
    expect(m.blocked).toEqual(['line:v3.a#1', 'line:v3.b#1']);
    expect(m.fallbacks).toEqual(catalogFallbacks(CLIP_CATALOG));
    const plain = buildManifest(store, {}, 3);
    expect(plain.keys['line:v3.idea.promotion@r#1']).toBeUndefined();
    expect(plain.units.c0000000000012).not.toHaveProperty('ctx');
    expect(plain).not.toHaveProperty('blocked');
  });
});

describe('the pack split (tags ≥ 700 ms) on synthetic PCM', () => {
  // three parts: a lead, a tail with a natural colon pause of 610 ms (the longest natural pause of the `pilot` takes),
  // a whole; the `<#0.6#>` pauses between them 780 and 1100 ms (the `pilot` takes: 770–1170)
  const pcm = concat(
    silence(150),
    tone(260, 1400),
    silence(780),
    tone(170, 600),
    silence(610),
    tone(170, 700),
    silence(1100),
    tone(180, 1500),
    silence(250),
  );

  it('cuts at every tag and never inside a part', () => {
    expect(PACK_SPLIT).toEqual({ mode: 'tags', minSilenceMs: 700 });
    expect(PACK_TAG).toBe('<#0.6#>');
    const cut = splitAtSilences(pcm, RATE, 3, PACK_SPLIT.mode, PACK_SPLIT.minSilenceMs);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const ms = (n: number) => Math.round((n * 1000) / RATE);
    // the second part keeps its natural pause: it runs from the first tag gap to the second one
    expect(ms(cut.segments[1]!.end - cut.segments[1]!.start)).toBeGreaterThan(600 + 610 + 700);
  });

  it('the tools` 550 ms tag threshold would cut the natural pause (why the pack uses 700); a short tag re-queues', () => {
    expect(splitAtSilences(pcm, RATE, 3, 'tags', TAG_SILENCE_MS)).toEqual({ ok: false, found: 4, expected: 3 });
    const merged = concat(silence(150), tone(260, 1400), silence(650), tone(170, 600), silence(1000), tone(180, 1500), silence(250));
    expect(splitAtSilences(merged, RATE, 3, 'tags', 700)).toEqual({ ok: false, found: 2, expected: 3 });
  });
});
