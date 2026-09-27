/**
 * Upstream-error hygiene (ARCHITECTURE §0.5: secrets are never logged and never
 * sent to the browser).
 *
 * OpenAI / OpenRouter error MESSAGES are attacker-influenced free text and routinely echo a partly
 * masked API key ("Incorrect API key provided: sk-proj-****abcd"). So:
 *  - the browser only ever gets `{ error, status }` — never upstream text;
 *  - logs get the HTTP status plus the short machine-readable `error.type` / `error.code`
 *    identifiers (validated against a strict charset), never `error.message`;
 *  - every log line additionally runs through {@link maskSecrets} as a second line of defence.
 */

/** `sk-…` (OpenAI, OpenRouter `sk-or-v1-…`), ephemeral `ek_…` secrets and Bearer tokens. */
const SK_KEY = /sk-[A-Za-z0-9_*.-]{8,}/g;
const EPHEMERAL_KEY = /ek_[A-Za-z0-9_*.-]{8,}/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/*=-]{8,}/gi;

/** Replaces anything that looks like an API key (even a partly starred one) and the given exact secrets. */
export function maskSecrets(text: string, exactSecrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const secret of exactSecrets) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.replaceAll(secret, '***');
  }
  return out
    .replace(SK_KEY, 'sk-***')
    .replace(EPHEMERAL_KEY, 'ek_***')
    .replace(BEARER, (_match, prefix: string) => `${prefix}***`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A short identifier (`invalid_api_key`, `rate_limit_exceeded`, `402`) or null — never free text. */
function safeToken(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) return null;
  // an identifier never looks like a key
  return /^(sk-|ek_)/.test(value) ? null : value;
}

export interface UpstreamErrorInfo {
  status: number;
  /** `error.type` (OpenAI) */
  type: string | null;
  /** `error.code` */
  code: string | null;
  /** `error.param` (OpenAI: which request field was rejected) */
  param: string | null;
  /** `error.metadata.error_type` (OpenRouter) */
  errorType: string | null;
  /** `error.metadata.limit_source` (OpenRouter 402) */
  limitSource: string | null;
}

/** Pulls the machine-readable identifiers out of an upstream error body; free text is dropped. */
export function upstreamErrorInfo(status: number, body: unknown): UpstreamErrorInfo {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const metadata = isRecord(error.metadata) ? error.metadata : {};
  return {
    status,
    type: safeToken(error.type),
    code: safeToken(error.code),
    param: safeToken(error.param),
    errorType: safeToken(metadata.error_type),
    limitSource: safeToken(metadata.limit_source),
  };
}

/** Log-safe one-liner: `OpenAI answered 401 (type=invalid_request_error, code=invalid_api_key)`. */
export function describeUpstreamError(who: string, info: UpstreamErrorInfo): string {
  const parts: string[] = [];
  if (info.type !== null) parts.push(`type=${info.type}`);
  if (info.code !== null) parts.push(`code=${info.code}`);
  if (info.param !== null) parts.push(`param=${info.param}`);
  if (info.errorType !== null) parts.push(`error_type=${info.errorType}`);
  if (info.limitSource !== null) parts.push(`limit_source=${info.limitSource}`);
  return `${who} answered ${info.status}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
}
