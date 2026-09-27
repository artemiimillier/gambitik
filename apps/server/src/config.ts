/**
 * Server configuration: everything that depends on the environment lives here so the rest of
 * the code (and the tests) can work from a plain object.
 *
 * Secrets: OPENAI_API_KEY (voice + text fallback) and OPENROUTER_API_KEY (text only) are read from
 * the environment only, kept in memory, never logged and never sent to the browser.
 * `~/.codex/auth.json` is never touched — the official `codex` CLI handles its own authentication.
 *
 * GAMBIT_RUNTIME_AI (default off): without it no generative model runs in the child's game, whatever LLM_PROVIDER,
 * VOICE_PREFERRED, CODEX_BIN or the keys say (`withRuntimeAi`; docs/TEACHING.md §4.4).
 *
 * GAMBIT_CLIP_GEN (default off, «Дозапись голоса»): the server may record a missing pre-written lesson phrase with the
 * owner's Higgsfield account (paid) — see `ClipGenConfig`. The Higgsfield CLI is never looked up under vitest.
 *
 * GAMBIT_BIND_HOST / GAMBIT_PUBLIC_HOSTS / GAMBIT_PUBLIC_HTTP (default: 127.0.0.1, none, off): the family instance in a
 * container behind a TLS proxy with basic auth (deploy/docker-ssh). Unset, the server behaves exactly as on the Mac.
 */
import { accessSync, constants } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_PORT, WEB_DEV_PORT } from '@gambit/shared';
import { overlayDirProblem, realish } from './voiceGen/bridge.ts';
import type { OverlayDirProblem } from './voiceGen/bridge.ts';

export type LlmProviderSetting = 'auto' | 'codex' | 'openrouter' | 'openai-api' | 'template';

/** Which conversational voice the browser should try first (both need OPENAI_API_KEY). */
/** 'clips' = the pre-recorded «Записи» voice (free, no microphone) — e.g. for a test instance */
export type VoicePreference = 'live' | 'realtime' | 'clips';

/** Why a VOICE_OVERLAY_DIR was refused (logged for the owner; never sent to the browser). */
export type { OverlayDirProblem };

/**
 * «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): recording a missing lesson phrase once, with the owner's Higgsfield account, then
 * reusing it forever. Everything is off by default; money is kept in integer milli-credits (1 credit = 1000).
 */
export interface ClipGenConfig {
  /** GAMBIT_CLIP_GEN (default off): may the server record at all */
  enabled: boolean;
  /** CLIP_GEN_BUDGET (credits over the overlay ledger's lifetime, campaign `ondemand`); 0 = unset → paused 'no-budget' */
  budgetMilli: number;
  /** CLIP_GEN_DAILY_MAX (credits per local day, default 3, clamped to 0.15–30 — `0` is the floor): the parent's cap can only be lower */
  dailyMaxMilli: number;
  /**
   * CLIP_GEN_DATA_DIR (absolute): generation refuses ('data-dir') unless the real DATA_DIR is exactly this folder — an
   * agent's or a test's server that inherited GAMBIT_CLIP_GEN=1 from `.env` never spends (docs/voice-clips/ONDEMAND.md).
   */
  dataDirPin: string | null;
  /** HIGGSFIELD_BIN (absolute, or `off`), else looked up — only when enabled and never under vitest; null = none */
  bin: string | null;
  /**
   * VOICE_OVERLAY_DIR (absolute, or `off`; default ~/Library/Application Support/Gambitik/voice-overlay — off under
   * vitest): the ONE folder of recorded phrases, the overlay ledger and the global lock on this Mac, outside every
   * checkout. null = off or refused (`overlayProblem`). Its phrases are served whenever it is valid, flag or not.
   */
  overlayDir: string | null;
  overlayProblem: OverlayDirProblem | null;
}

export const CLIP_GEN_DAILY_DEFAULT_MILLI = 3_000;
export const CLIP_GEN_DAILY_MIN_MILLI = 150;
export const CLIP_GEN_DAILY_MAX_MILLI = 30_000;
/** a typo in CLIP_GEN_BUDGET (an extra zero) must not open the whole account: the lifetime budget is clamped */
export const CLIP_GEN_BUDGET_MAX_MILLI = 500_000;

export interface ServerConfig {
  /**
   * GAMBIT_RUNTIME_AI=1 (default OFF — docs/TEACHING.md §4.4: no generative AI in the child's game): may a
   * generative model be used at run time — the OpenAI live / realtime voice, the LLM strategist and re-plans, LLM
   * reviews, codex. Off wins over LLM_PROVIDER, VOICE_PREFERRED and CODEX_BIN (applied AFTER the overrides in
   * `loadConfig`): every text is the template, codex is never spawned, /voice/live and /voice/session answer 503 and
   * the browser is told to use the recorded voice. The keys stay known (the settings may still say one is there) but
   * nothing uses them.
   */
  runtimeAi: boolean;
  /** GAMBIT_BIND_HOST: the listen address — 127.0.0.1 unless it is `0.0.0.0` or another IP literal (a container) */
  hostname: string;
  /**
   * GAMBIT_PUBLIC_HOSTS (comma separated, at most 5 lowercase DNS names, optional `:port`; default none): the names a
   * TLS proxy in front of the server answers to. Each is trusted as a Host and as the Origin `https://<name>` —
   * `http://<name>` only with GAMBIT_PUBLIC_HTTP=1. The proxy must pass the browser's Host header on (Traefik does).
   */
  publicHosts: string[];
  /** GAMBIT_PUBLIC_HTTP=1: the public names are also trusted over plain http (a proxy without TLS — not the default) */
  publicHttp: boolean;
  /** GAMBIT_BUILD_SHA (a container has no .git): the commit GET /api/health reports when the checkout cannot say */
  buildSha: string | null;
  /** refused network settings, logged once at start-up (the values are host names, never secrets) */
  networkWarnings: string[];
  port: number;
  webDevPort: number;
  /** absolute path of the repository root */
  repoRoot: string;
  /** absolute path of the runtime data directory (SQLite, journals, profile) */
  dataDir: string;
  /** absolute path of the built SPA (served when index.html exists) */
  webDistDir: string;
  /** absolute path of data/build/puzzles.sqlite (may not exist) */
  puzzlesDbPath: string;
  /** absolute path of kb/puzzles-starter.json (may not exist) */
  starterPuzzlesPath: string;
  /** true under NODE_ENV=production: the Vite dev origin (:5173) is NOT trusted then */
  production: boolean;
  /** null = no key: live / realtime voice and the OpenAI text fallback are unavailable */
  openaiApiKey: string | null;
  openaiBaseUrl: string;
  /** text model for the Responses API fallback */
  openaiTextModel: string;
  /** null = no key. TEXT only (game reviews); voice never goes through OpenRouter. */
  openrouterApiKey: string | null;
  openrouterBaseUrl: string;
  /** OPENROUTER_REVIEW_MODEL */
  openrouterReviewModel: string;
  /** OPENROUTER_FALLBACK_MODELS (comma separated) — tried by OpenRouter when the main model is unavailable */
  openrouterFallbackModels: string[];
  /** Realtime API (turn-based + barge-in): VOICE_MODEL / VOICE_NAME */
  voiceModel: string;
  voiceName: string;
  voiceTranscribeModel: string;
  voiceSecretTtlSeconds: number;
  /** Live API (full duplex): VOICE_LIVE_MODEL / VOICE_LIVE_VOICE */
  voiceLiveModel: string;
  voiceLiveVoice: string;
  /** VOICE_PREFERRED */
  voicePreferred: VoicePreference;
  /** REVIEW_INCLUDE_CHILD_SPEECH=1: parent opt-in, see llm/prompts.ts. Default false: no child utterance ever reaches an LLM. */
  reviewIncludeChildSpeech: boolean;
  llmProvider: LlmProviderSetting;
  codexModel: string;
  /**
   * The smart strategist of «Учитель» (POST /coach/strategy, /coach/replan) — a stronger model than the reviews:
   * CODEX_STRATEGY_MODEL (ChatGPT subscription, asked first) → OPENROUTER_STRATEGY_MODEL (≈ 1 cent per call) → OPENAI_STRATEGY_MODEL.
   */
  codexStrategyModel: string;
  openrouterStrategyModel: string;
  openaiStrategyModel: string;
  /**
   * STRATEGY_CODEX_FIRST (default on: the thinking goes through the ChatGPT subscription): the strategy of a game asks
   * codex first and the paid APIs only when codex is missing, logged out, over its limit or too slow. `0` = the fast APIs
   * first (OpenRouter → OpenAI API → codex).
   */
  strategyCodexFirst: boolean;
  /** STRATEGY_CODEX_MS (default 7500, 3000–7800): how long the strategy waits for codex before the next provider */
  strategyCodexMs: number;
  /** absolute path of the official codex CLI; null = not installed / disabled */
  codexBin: string | null;
  /** timeout of one background LLM job (game review) */
  llmTimeoutMs: number;
  /** generate reviews automatically after POST /games */
  autoReview: boolean;
  /** log to the console (disabled in tests) */
  log: boolean;
  /** «Дозапись голоса»: GAMBIT_CLIP_GEN and friends (off by default) */
  clipGen: ClipGenConfig;
  /** accounts of the public site (GAMBIT_ACCOUNTS; off = the family server: one child, no sign-in) */
  accounts: AccountsConfig;
}

/**
 * GAMBIT_ACCOUNTS=1 — the public site (deploy/docker-ssh): every child signs in (login + password, no e-mail) and has
 * data of its own, `DATA_DIR/users/<id>/` (apps/server/src/accounts). Off (default) = the family server exactly as
 * before: no sign-in, one child in DATA_DIR.
 *  - GAMBIT_INVITE_CODE: the owner's invite code for sign-up (6–100 characters); missing = sign-up closed;
 *  - GAMBIT_TRUST_PROXY=1: the client address for the attempt limits is the proxy's X-Real-IP (Traefik sets it);
 *  - the session cookie is `Secure` (and `__Host-`) whenever the site is reached over https (GAMBIT_PUBLIC_HOSTS
 *    without GAMBIT_PUBLIC_HTTP).
 */
export interface AccountsConfig {
  enabled: boolean;
  inviteCode: string | null;
  trustProxy: boolean;
  cookieSecure: boolean;
  /** GAMBIT_MAX_ACCOUNTS (default 300): sign-up closes at this many accounts */
  maxAccounts: number;
  /** GAMBIT_ADMIN_LOGINS: the nicknames (comma-separated) that may open the owner's dashboard /admin */
  adminLogins: string[];
  /** GAMBIT_OPEN_REGISTRATION=1: anyone may sign up, no invite code (the proof of work and the limits guard it) */
  openRegistration: boolean;
  /** GAMBIT_POW_BITS (default 16, 0 = off): the zero bits the page's proof of work needs before a sign-up (./accounts/pow.ts) */
  powBits: number;
}

/** the invite code must be at least this long (a short one can be guessed) */
export const INVITE_CODE_MIN = 10;

function parseInviteCode(value: string | undefined, warnings: string[]): string | null {
  const v = nonEmpty(value);
  if (v === null) return null;
  if ([...v].length < INVITE_CODE_MIN || [...v].length > 100) {
    warnings.push(`GAMBIT_INVITE_CODE ignored (it must have ${INVITE_CODE_MIN}–100 characters) — sign-up is closed`);
    return null;
  }
  return v;
}

/**
 * Accounts on (the public site): nothing that costs the owner money or runs a generative model may be reachable by
 * strangers, whatever `.env` / app.env say — no runtime AI, no keys, no codex, no LLM
 * provider but the templates, no recording of new phrases. A setting that had to be dropped is logged once.
 */
export function withAccountsSafety(config: ServerConfig): ServerConfig {
  if (!config.accounts.enabled) return config;
  const dropped: string[] = [];
  if (config.runtimeAi) dropped.push('GAMBIT_RUNTIME_AI');
  if (config.openaiApiKey !== null) dropped.push('OPENAI_API_KEY');
  if (config.openrouterApiKey !== null) dropped.push('OPENROUTER_API_KEY');
  if (config.codexBin !== null) dropped.push('CODEX_BIN');
  if (config.clipGen.enabled) dropped.push('GAMBIT_CLIP_GEN');
  const warnings = [...config.networkWarnings];
  if (dropped.length > 0) warnings.push(`accounts on (the public site): ${dropped.join(', ')} ignored — nothing paid or generative for strangers`);
  if (config.publicHosts.length > 0 && !config.accounts.trustProxy) {
    warnings.push('accounts on behind a proxy without GAMBIT_TRUST_PROXY=1: every visitor has the proxy\'s address, so the sign-in limits act for the whole site');
  }
  return {
    ...config,
    runtimeAi: false,
    llmProvider: 'template',
    voicePreferred: 'clips',
    codexBin: null,
    openaiApiKey: null,
    openrouterApiKey: null,
    clipGen: { ...config.clipGen, enabled: false, bin: null },
    networkWarnings: warnings,
  };
}

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function nonEmpty(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function parseProvider(value: string | undefined): LlmProviderSetting {
  const v = (value ?? 'auto').trim().toLowerCase();
  if (v === 'codex' || v === 'openrouter' || v === 'openai-api' || v === 'template' || v === 'auto') return v;
  if (v === 'openai' || v === 'api') return 'openai-api';
  return 'auto';
}

/** Model / voice ids are passed to CLIs and JSON bodies: a plain identifier, never starting with '-'. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export function isSafeModelId(value: string): boolean {
  return MODEL_ID_RE.test(value);
}

function modelId(value: string | undefined, fallback: string): string {
  const v = nonEmpty(value);
  return v !== null && isSafeModelId(v) ? v : fallback;
}

function parseModelList(value: string | undefined, fallback: string[]): string[] {
  const raw = nonEmpty(value);
  if (raw === null) return fallback;
  if (raw === 'none' || raw === 'off') return [];
  const ids = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => isSafeModelId(item));
  return ids.slice(0, 3);
}

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** A flag that is on unless it is explicitly switched off (`0`, `false`, `no`, `off`). */
function parseFlagDefaultOn(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function parseVoicePreference(value: string | undefined): VoicePreference {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'realtime' || v === 'clips' ? v : 'live';
}

function parseIntInRange(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** An unprivileged TCP port, or the fallback (a typo never lands the server on a surprising port). */
function parsePort(value: string | undefined, fallback: number): number {
  const text = (value ?? '').trim();
  if (!/^\d{4,5}$/.test(text)) return fallback;
  const n = Number(text);
  return n >= 1024 && n <= 65_535 ? n : fallback;
}

// ───────────────────────── behind a proxy (GAMBIT_BIND_HOST, GAMBIT_PUBLIC_HOSTS) ─────────────────────────

export const DEFAULT_BIND_HOST = '127.0.0.1';
/** more names than a family instance needs is a pasted list, not a setting: the rest is ignored (and logged) */
export const PUBLIC_HOSTS_MAX = 5;

/** a rejected value as it appears in the log: clipped and JSON-quoted (no newline can forge a log line) */
function logValue(value: string): string {
  return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value);
}

/**
 * GAMBIT_BIND_HOST: `0.0.0.0` (a container reached by its proxy) or another IP literal, else 127.0.0.1. A host NAME is
 * refused on purpose: it could resolve to a public interface the owner did not mean to open.
 */
export function parseBindHost(value: string | undefined): { hostname: string; warning: string | null } {
  const v = nonEmpty(value);
  if (v === null) return { hostname: DEFAULT_BIND_HOST, warning: null };
  if (isIP(v) !== 0) return { hostname: v, warning: null };
  return { hostname: DEFAULT_BIND_HOST, warning: `GAMBIT_BIND_HOST ${logValue(v)} ignored (not 0.0.0.0 or an IP address) — listening on ${DEFAULT_BIND_HOST}` };
}

/** DNS labels, lowercase; the last one starts with a letter (so an IPv4 address is not a "name"), optional `:port` */
const PUBLIC_HOST_RE = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::([1-9]\d{0,4}))?$/;

function isPublicHost(entry: string): boolean {
  const m = PUBLIC_HOST_RE.exec(entry);
  if (m === null) return false;
  const name = m[1] as string;
  return name.length <= 253 && (m[2] === undefined || Number(m[2]) <= 65_535);
}

/**
 * GAMBIT_PUBLIC_HOSTS: the names the server is reached by through its proxy. Strict: every entry must be a lowercase DNS
 * name with an optional port — no scheme, path, wildcard, IP or upper case (a Host header is matched exactly). A bad
 * entry is skipped with a warning, the good ones still count; at most PUBLIC_HOSTS_MAX.
 */
export function parsePublicHosts(value: string | undefined): { hosts: string[]; warnings: string[] } {
  const raw = nonEmpty(value);
  const hosts: string[] = [];
  const warnings: string[] = [];
  if (raw === null) return { hosts, warnings };
  for (const item of raw.split(',')) {
    const entry = item.trim();
    if (entry === '' || hosts.includes(entry)) continue;
    if (!isPublicHost(entry)) warnings.push(`GAMBIT_PUBLIC_HOSTS: ${logValue(entry)} ignored (not a lowercase host name with an optional :port)`);
    else if (hosts.length >= PUBLIC_HOSTS_MAX) warnings.push(`GAMBIT_PUBLIC_HOSTS: ${logValue(entry)} ignored (at most ${PUBLIC_HOSTS_MAX} names)`);
    else hosts.push(entry);
  }
  return { hosts, warnings };
}

/** GAMBIT_BUILD_SHA: a commit (7–40 hex digits) → its 7-digit short form, as `readGitSha` reports it; else null */
function parseBuildSha(value: string | undefined): string | null {
  const v = (nonEmpty(value) ?? '').toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(v) ? v.slice(0, 7) : null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates the official codex CLI: `CODEX_BIN` (absolute path; the values `off`/`none` disable
 * the provider), then PATH, then the usual Homebrew locations. Only fixed binaries are ever
 * spawned, never through a shell.
 */
export function findCodexBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = nonEmpty(env.CODEX_BIN);
  if (explicit !== null) {
    if (explicit === 'off' || explicit === 'none') return null;
    return isAbsolute(explicit) && isExecutable(explicit) ? explicit : null;
  }
  const dirs = [...(env.PATH ?? '').split(delimiter).filter((d) => d !== ''), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    const candidate = join(dir, 'codex');
    if (isAbsolute(candidate) && isExecutable(candidate)) return candidate;
  }
  return null;
}

// ───────────────────────── «Дозапись голоса» (GAMBIT_CLIP_GEN, docs/voice-clips/ONDEMAND.md) ─────────────────────────

/** vitest sets VITEST in the environment of every test file (checked on the given env AND on the process's own). */
function isUnderTest(env: NodeJS.ProcessEnv): boolean {
  return nonEmpty(env.VITEST) !== null || nonEmpty(process.env.VITEST) !== null;
}

/** Credits as a decimal («3», «0.75», «2,5») → milli-credits; null unless a positive finite number. */
function parseCreditsMilli(value: string | undefined): number | null {
  const text = (value ?? '').trim().replace(',', '.');
  if (!/^\d{1,6}(?:\.\d{1,3})?$/.test(text)) return null;
  const milli = Math.round(Number(text) * 1000);
  return Number.isFinite(milli) && milli > 0 ? milli : null;
}

/**
 * Locates the Higgsfield CLI: HIGGSFIELD_BIN (absolute path; `off` / `none` disable it), then PATH, $HOME/.local/bin,
 * /opt/homebrew/bin and /usr/local/bin. NEVER looked up under vitest: the signed-in CLI lives in ~/.local/bin and a
 * test that found it could spend (docs/voice-clips/ONDEMAND.md) — an explicit absolute path (a test's fake script) still works there.
 */
export function findHiggsfieldBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = nonEmpty(env.HIGGSFIELD_BIN);
  if (explicit !== null) {
    if (explicit === 'off' || explicit === 'none') return null;
    return isAbsolute(explicit) && isExecutable(explicit) ? explicit : null;
  }
  if (isUnderTest(env)) return null;
  const home = nonEmpty(env.HOME) ?? homedir();
  const dirs = [...(env.PATH ?? '').split(delimiter).filter((d) => d !== ''), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    const candidate = join(dir, 'higgsfield');
    if (isAbsolute(candidate) && isExecutable(candidate)) return candidate;
  }
  return null;
}

/** ~/Library/Application Support/Gambitik/voice-overlay — one folder per Mac, outside every checkout (docs/voice-clips/ONDEMAND.md). */
export function defaultOverlayDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(nonEmpty(env.HOME) ?? homedir(), 'Library', 'Application Support', 'Gambitik', 'voice-overlay');
}

/**
 * Why a folder cannot be the overlay: not absolute; inside (or around) a git checkout — `git clean -fdx` would delete
 * paid audio and every worktree would get its own budget (S3); inside (or around) DATA_DIR — the child's data; inside
 * (or around) the served SPA build. null = fine. Symlinks are resolved first (/tmp → /private/tmp). ONE implementation
 * with the owner's tools (tools/voice-clips/placement.ts, through the bridge): they refuse exactly what the server
 * would never serve.
 */
export { overlayDirProblem };

/**
 * CLIP_GEN_DAILY_MAX in milli-credits: unset or unreadable = the default; anything below the floor — `0` included,
 * the owner's way to stop daily spending — is the floor (0.15 credits, one job), never the 3-credit default.
 */
function parseDailyMaxMilli(value: string | undefined): number {
  const text = (value ?? '').trim().replace(',', '.');
  if (!/^\d{1,6}(?:\.\d{1,3})?$/.test(text)) return CLIP_GEN_DAILY_DEFAULT_MILLI;
  const milli = Math.round(Number(text) * 1000);
  if (!Number.isFinite(milli)) return CLIP_GEN_DAILY_DEFAULT_MILLI;
  return Math.min(CLIP_GEN_DAILY_MAX_MILLI, Math.max(CLIP_GEN_DAILY_MIN_MILLI, milli));
}

/** GAMBIT_CLIP_GEN, CLIP_GEN_BUDGET, CLIP_GEN_DAILY_MAX, CLIP_GEN_DATA_DIR, HIGGSFIELD_BIN, VOICE_OVERLAY_DIR. */
export function parseClipGenConfig(env: NodeJS.ProcessEnv, places: { repoRoot: string; dataDir: string; webDistDir: string }): ClipGenConfig {
  const enabled = parseFlag(env.GAMBIT_CLIP_GEN);
  const budget = parseCreditsMilli(env.CLIP_GEN_BUDGET);
  const pin = nonEmpty(env.CLIP_GEN_DATA_DIR);
  const overlayEnv = nonEmpty(env.VOICE_OVERLAY_DIR);
  // under vitest the default overlay is off: a test never reads or writes the owner's recorded phrases or his ledger
  const overlayWanted = overlayEnv === 'off' || overlayEnv === 'none' ? null : (overlayEnv ?? (isUnderTest(env) ? null : defaultOverlayDir(env)));
  const overlayProblem = overlayWanted === null ? null : overlayDirProblem(overlayWanted, places);
  return {
    enabled,
    budgetMilli: budget === null ? 0 : Math.min(budget, CLIP_GEN_BUDGET_MAX_MILLI),
    dailyMaxMilli: parseDailyMaxMilli(env.CLIP_GEN_DAILY_MAX),
    dataDirPin: pin !== null && isAbsolute(pin) ? resolve(pin) : null,
    // like codex without runtime AI: with the flag off the CLI is not even looked for
    bin: enabled ? findHiggsfieldBinary(env) : null,
    overlayDir: overlayWanted !== null && overlayProblem === null ? resolve(overlayWanted) : null,
    overlayProblem,
  };
}

/** The real DATA_DIR is the pinned CLIP_GEN_DATA_DIR (both resolved through symlinks). */
export function dataDirPinned(clipGen: Pick<ClipGenConfig, 'dataDirPin'>, dataDir: string): boolean {
  return clipGen.dataDirPin !== null && realish(clipGen.dataDirPin) === realish(dataDir);
}

/**
 * GAMBIT_RUNTIME_AI off: the template for every text, the recorded voice, no codex. Applied to the MERGED config, so
 * neither an .env line (LLM_PROVIDER=auto, VOICE_PREFERRED=live — an .env copied from an older example)
 * nor an override can switch a generative model back on without the flag itself.
 */
export function withRuntimeAi(config: ServerConfig): ServerConfig {
  return config.runtimeAi ? config : { ...config, llmProvider: 'template', voicePreferred: 'clips', codexBin: null };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const repoRoot = overrides.repoRoot ?? REPO_ROOT;
  const dataDirEnv = nonEmpty(env.DATA_DIR);
  const dataDir = overrides.dataDir ?? (dataDirEnv !== null ? resolve(repoRoot, dataDirEnv) : join(repoRoot, 'data'));
  const runtimeAi = overrides.runtimeAi ?? parseFlag(env.GAMBIT_RUNTIME_AI);
  // GAMBIT_WEB_DIST: serve another build of the web app (a smoke test builds into a temp folder so the owner's running
  // server, which serves apps/web/dist from disk, keeps its files); unset = apps/web/dist
  const webDistDir = overrides.webDistDir ?? (nonEmpty(env.GAMBIT_WEB_DIST) !== null ? resolve(repoRoot, nonEmpty(env.GAMBIT_WEB_DIST) as string) : join(repoRoot, 'apps', 'web', 'dist'));
  const bind = parseBindHost(env.GAMBIT_BIND_HOST);
  const publicHosts = parsePublicHosts(env.GAMBIT_PUBLIC_HOSTS);
  const accountWarnings: string[] = [];
  const base: ServerConfig = {
    runtimeAi,
    hostname: bind.hostname,
    publicHosts: publicHosts.hosts,
    publicHttp: parseFlag(env.GAMBIT_PUBLIC_HTTP),
    buildSha: parseBuildSha(env.GAMBIT_BUILD_SHA),
    networkWarnings: [...(bind.warning !== null ? [bind.warning] : []), ...publicHosts.warnings],
    // GAMBIT_API_PORT / GAMBIT_WEB_PORT: alternative ports for a second stack (e2e or a smoke test while the owner's
    // server keeps 8787); unset = the contract's ports
    port: parsePort(env.GAMBIT_API_PORT, SERVER_PORT),
    webDevPort: parsePort(env.GAMBIT_WEB_PORT, WEB_DEV_PORT),
    repoRoot,
    dataDir,
    webDistDir,
    puzzlesDbPath: join(dataDir, 'build', 'puzzles.sqlite'),
    starterPuzzlesPath: join(repoRoot, 'kb', 'puzzles-starter.json'),
    production: (env.NODE_ENV ?? '').trim() === 'production',
    openaiApiKey: nonEmpty(env.OPENAI_API_KEY),
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiTextModel: modelId(env.OPENAI_TEXT_MODEL, 'gpt-5.6-luna'),
    openrouterApiKey: nonEmpty(env.OPENROUTER_API_KEY),
    openrouterBaseUrl: 'https://openrouter.ai/api/v1',
    openrouterReviewModel: modelId(env.OPENROUTER_REVIEW_MODEL, 'openai/gpt-5.6-terra'),
    openrouterFallbackModels: parseModelList(env.OPENROUTER_FALLBACK_MODELS, ['openai/gpt-5.6-luna']),
    voiceModel: modelId(env.VOICE_MODEL, 'gpt-realtime-2.1'),
    voiceName: modelId(env.VOICE_NAME, 'marin'),
    voiceTranscribeModel: modelId(env.VOICE_TRANSCRIBE_MODEL, 'gpt-live-transcribe'),
    voiceSecretTtlSeconds: parseIntInRange(env.VOICE_SECRET_TTL_S, 120, 10, 7200),
    voiceLiveModel: modelId(env.VOICE_LIVE_MODEL, 'gpt-live-1'),
    voiceLiveVoice: modelId(env.VOICE_LIVE_VOICE, 'marin'),
    voicePreferred: parseVoicePreference(env.VOICE_PREFERRED),
    reviewIncludeChildSpeech: parseFlag(env.REVIEW_INCLUDE_CHILD_SPEECH),
    llmProvider: parseProvider(env.LLM_PROVIDER),
    // a value starting with '-' could be parsed as a flag after `codex exec -m`
    codexModel: modelId(env.CODEX_MODEL, 'gpt-5.6-luna'),
    codexStrategyModel: modelId(env.CODEX_STRATEGY_MODEL, 'gpt-5.6-sol'),
    openrouterStrategyModel: modelId(env.OPENROUTER_STRATEGY_MODEL, 'openai/gpt-5.6-sol'),
    openaiStrategyModel: modelId(env.OPENAI_STRATEGY_MODEL, 'gpt-5.6-sol'),
    strategyCodexFirst: parseFlagDefaultOn(env.STRATEGY_CODEX_FIRST),
    // the game's first line waits ≤ 8.5 s and the strategist's whole budget is 8 s: codex never gets more than 7.8 s
    strategyCodexMs: parseIntInRange(env.STRATEGY_CODEX_MS, 7_500, 3_000, 7_800),
    // runtime AI off: codex is not even looked for
    codexBin: 'codexBin' in overrides ? (overrides.codexBin ?? null) : runtimeAi ? findCodexBinary(env) : null,
    llmTimeoutMs: parseIntInRange(env.LLM_TIMEOUT_MS, 90_000, 1_000, 600_000),
    autoReview: true,
    log: true,
    // independent of GAMBIT_RUNTIME_AI: fixed pre-written words read aloud are not generative AI in the words
    clipGen: overrides.clipGen ?? parseClipGenConfig(env, { repoRoot, dataDir, webDistDir }),
    accounts: {
      enabled: parseFlag(env.GAMBIT_ACCOUNTS),
      inviteCode: parseInviteCode(env.GAMBIT_INVITE_CODE, accountWarnings),
      trustProxy: parseFlag(env.GAMBIT_TRUST_PROXY),
      cookieSecure: publicHosts.hosts.length > 0 && !parseFlag(env.GAMBIT_PUBLIC_HTTP),
      maxAccounts: parseIntInRange(env.GAMBIT_MAX_ACCOUNTS, 300, 1, 100_000),
      adminLogins: (env.GAMBIT_ADMIN_LOGINS ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''),
      openRegistration: parseFlag(env.GAMBIT_OPEN_REGISTRATION),
      powBits: parseIntInRange(env.GAMBIT_POW_BITS, 16, 0, 24),
    },
  };
  base.networkWarnings.push(...accountWarnings);
  return withAccountsSafety(withRuntimeAi({ ...base, ...overrides }));
}

/** What the allow-lists read; the public names are optional so a hand-built config keeps the local-only lists. */
export type AllowListConfig = Pick<ServerConfig, 'port' | 'webDevPort' | 'production'> & Partial<Pick<ServerConfig, 'publicHosts' | 'publicHttp'>>;

/** The loopback hosts: the server's port, and the Vite dev port outside production. */
function localHosts(config: AllowListConfig): Set<string> {
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  if (!config.production) {
    hosts.add(`127.0.0.1:${config.webDevPort}`);
    hosts.add(`localhost:${config.webDevPort}`);
  }
  return hosts;
}

/**
 * Hosts the server answers to (DNS-rebinding protection). The Vite dev port (5173 is Vite's default,
 * so ANY other project may be served there) is trusted only outside production.
 * GAMBIT_PUBLIC_HOSTS come last, exactly as configured (the proxy passes the browser's Host on).
 */
export function allowedHosts(config: AllowListConfig): Set<string> {
  const hosts = localHosts(config);
  for (const host of config.publicHosts ?? []) hosts.add(host);
  return hosts;
}

/**
 * Origins allowed on state-changing requests (CSRF protection): the loopback hosts over http, the public names over
 * https (the proxy terminates TLS) — over http as well only with GAMBIT_PUBLIC_HTTP=1.
 */
export function allowedOrigins(config: AllowListConfig): Set<string> {
  const origins = new Set([...localHosts(config)].map((host) => `http://${host}`));
  for (const host of config.publicHosts ?? []) {
    origins.add(`https://${host}`);
    if (config.publicHttp === true) origins.add(`http://${host}`);
  }
  return origins;
}

/** The start-up line of where the server listens and, behind a proxy, the public addresses it answers to. */
export function listenLine(config: Pick<ServerConfig, 'hostname' | 'publicHosts' | 'publicHttp'>, port: number): string {
  const local = `http://${config.hostname.includes(':') ? `[${config.hostname}]` : config.hostname}:${port}`;
  if (config.publicHosts.length === 0) return local;
  const schemes = config.publicHttp ? ['https', 'http'] : ['https'];
  return `${local} · public: ${config.publicHosts.flatMap((host) => schemes.map((scheme) => `${scheme}://${host}`)).join(', ')}`;
}
