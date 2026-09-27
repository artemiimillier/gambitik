/**
 * Why a request to OpenAI never got an HTTP answer — as a short, log-safe code.
 *
 * Node's fetch (undici) rejects every network failure with the same `TypeError('fetch failed')`; the real reason sits in
 * `error.cause`: a DNS error (`ENOTFOUND`, `EAI_AGAIN` — Wi-Fi off, the Mac just woke up), a refused / reset connection
 * (`ECONNREFUSED`, `ECONNRESET`), a keep-alive socket the far side closed right when it was reused (`UND_ERR_SOCKET`
 * «other side closed» — undici does not retry a POST), a TLS problem (`CERT_…`, a proxy / antivirus in the middle).
 * A bare «OpenAI Live is unreachable» cannot be traced back to one of them, so the code travels to the server log, the
 * browser (502 `reason`) and the voice black box.
 *
 * Only identifiers pass (`^[A-Z][A-Z0-9_]{1,39}$` codes, `^[A-Za-z]{1,40}$` class names): never an error message,
 * which may carry a URL, a header or anything else the caller put in.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const NAME_RE = /^[A-Za-z]{1,40}$/;

function nameOf(value: unknown): string {
  return isRecord(value) && typeof value.name === 'string' ? value.name : '';
}

/** true = the request was aborted by our own time budget (AbortSignal.timeout) */
export function isTimeoutError(error: unknown): boolean {
  const names = [nameOf(error), nameOf(isRecord(error) ? error.cause : undefined)];
  return names.some((name) => name === 'TimeoutError' || name === 'AbortError');
}

/**
 * 'timeout' | the system / undici error code ('ENOTFOUND', 'UND_ERR_SOCKET', …) | the error class ('SocketError') |
 * 'unknown'. Pure, never throws.
 */
export function networkFailureCode(error: unknown): string {
  if (isTimeoutError(error)) return 'timeout';
  const cause = isRecord(error) ? error.cause : undefined;
  // happy eyeballs: an AggregateError of the IPv6 and the IPv4 attempt — the first one speaks for both
  const nested = isRecord(cause) && Array.isArray(cause.errors) ? (cause.errors as unknown[])[0] : undefined;
  for (const candidate of [cause, nested, error]) {
    if (isRecord(candidate) && typeof candidate.code === 'string' && CODE_RE.test(candidate.code)) return candidate.code;
  }
  for (const candidate of [cause, error]) {
    const name = nameOf(candidate);
    if (NAME_RE.test(name) && name !== 'Error' && name !== 'TypeError') return name;
  }
  return 'unknown';
}

/** Upstream statuses worth one more try: the service hiccuped, the request itself was fine. */
export function isTransientStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}
