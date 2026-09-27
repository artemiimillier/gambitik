/**
 * Local-only hardening (the server holds an API key and can spawn `codex`):
 *  - Host allowlist → DNS-rebinding protection (a hostile page resolving its own name to 127.0.0.1
 *    still sends its own Host header);
 *  - Origin / Sec-Fetch-Site check on state-changing requests → CSRF protection. CORS is never
 *    enabled: the SPA is same-origin (served by this server, or proxied by Vite in dev);
 *  - every state-changing request must be `Content-Type: application/json` — a type that a
 *    cross-origin page cannot send without a CORS preflight (which this server never answers), so
 *    "simple" form / text/plain posts cannot reach a handler, not even the body-less ones that
 *    mint a paid voice session. ONE exception: `POST /api/voice/usage` also takes
 *    `text/plain` — that is what `navigator.sendBeacon(url, string)` sends when the page closes — but
 *    only with a positive same-origin proof (an allow-listed Origin, or `Sec-Fetch-Site: same-origin`);
 *    the worst a forged report could do is add seconds to the usage log, and it cannot be forged cross-site;
 *  - the Vite dev origin is trusted only outside production (config.allowedHosts);
 *  - behind a TLS proxy (the server instance, deploy/docker-ssh) the names of GAMBIT_PUBLIC_HOSTS are allowed too — as
 *    the Host and as the https:// Origin, nothing wider (config.allowedHosts / allowedOrigins);
 *  - conservative response headers; API answers are never cached.
 */
import type { MiddlewareHandler } from 'hono';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface SecurityOptions {
  allowedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
}

export function hostAllowlist(options: Pick<SecurityOptions, 'allowedHosts'>): MiddlewareHandler {
  return async (c, next) => {
    let host = c.req.header('host');
    if (host === undefined) {
      try {
        host = new URL(c.req.url).host;
      } catch {
        host = '';
      }
    }
    if (!options.allowedHosts.has(host.toLowerCase())) return c.json({ error: 'forbidden-host' }, 403);
    return next();
  };
}

export function originCheck(options: Pick<SecurityOptions, 'allowedOrigins'>): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      if (!options.allowedOrigins.has(origin.toLowerCase())) return c.json({ error: 'forbidden-origin' }, 403);
      return next();
    }
    // No Origin header: browsers always send one on cross-origin state-changing requests, so this is
    // a same-origin navigation or a non-browser client (curl, tests). Fetch metadata, when present,
    // must still say the request is not cross-site.
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return c.json({ error: 'forbidden-origin' }, 403);
    return next();
  };
}

/** Routes a closing page reports to with `navigator.sendBeacon` (a string body = `text/plain;charset=UTF-8`). */
export const BEACON_PATHS: ReadonlySet<string> = new Set(['/api/voice/usage']);

/**
 * A beacon cannot set headers, so its origin must be proven by what the browser adds itself: an Origin from the
 * allow-list, or — when a browser sends no Origin — fetch metadata that says "same origin". No proof, no beacon
 * (a non-browser client can still post JSON).
 */
function provesSameOrigin(origin: string | undefined, site: string | undefined, allowedOrigins: ReadonlySet<string>): boolean {
  if (origin !== undefined) return allowedOrigins.has(origin.toLowerCase());
  return site === 'same-origin';
}

/** State-changing requests must be JSON (see the file header); runs after the Host / Origin checks. */
export function requireJsonContentType(options: { allowedOrigins?: ReadonlySet<string>; beaconPaths?: ReadonlySet<string> } = {}): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type === 'application/json') return next();
    const beacon =
      type === 'text/plain' &&
      c.req.method === 'POST' &&
      options.allowedOrigins !== undefined &&
      (options.beaconPaths ?? BEACON_PATHS).has(new URL(c.req.url).pathname) &&
      provesSameOrigin(c.req.header('origin'), c.req.header('sec-fetch-site'), options.allowedOrigins);
    if (beacon) return next();
    return c.json({ error: 'unsupported-media-type' }, 415);
  };
}

/**
 * Content-Security-Policy of the SPA. Keep in sync with CONTENT_SECURITY_POLICY in
 * apps/web/vite.config.ts (the same list as a build-time <meta>, minus `frame-ancestors`, which a meta tag cannot carry).
 *  - scripts only from this server; 'wasm-unsafe-eval' lets the Stockfish worker compile its .wasm, nothing else is eval-able;
 *  - workers: the engine script ('self') and canvas-confetti's blob worker;
 *  - network: this server plus api.openai.com (the Realtime layer posts its SDP offer there with an ephemeral secret) —
 *    on the family server only: the public site (accounts) never opens a live voice session, so its pages may talk to
 *    this server alone (the build-time <meta> also lists OpenAI, but a page obeys BOTH
 *    policies, so the header's narrower list wins);
 *  - inline styles are needed by the first-paint <style> in index.html and by the chart / board libraries.
 * The header also travels with /engine/*.js, so the worker inherits the same policy.
 */
const cspWith = (connectSrc: string): string =>
  [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src ${connectSrc}`,
    "media-src 'self' blob:",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

/** the family server's policy (live voice through OpenAI Realtime) */
export const CONTENT_SECURITY_POLICY = cspWith("'self' https://api.openai.com wss://api.openai.com");
/** the public site's policy (accounts): nothing but this server */
export const ACCOUNTS_CONTENT_SECURITY_POLICY = cspWith("'self'");

export function securityHeaders(o: { accounts?: boolean } = {}): MiddlewareHandler {
  const policy = o.accounts === true ? ACCOUNTS_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY;
  return async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', policy);
    // API answers are never cached — except a route that marked its answer immutable (a content-addressed file)
    if (new URL(c.req.url).pathname.startsWith('/api/') && !/\bimmutable\b/.test(c.res.headers.get('cache-control') ?? '')) c.header('Cache-Control', 'no-store');
  };
}

/**
 * Requests from an automation-driven browser (the web client sets this header under `navigator.webdriver`).
 * Such traffic must never cost money: template reviews only, no voice session, no LLM rephrase.
 * It is a courtesy flag, not a security boundary — it can only make the server do LESS.
 */
export const AUTOMATION_HEADER = 'x-gambit-automation';

export function isAutomationRequest(headerValue: string | undefined): boolean {
  return headerValue === '1';
}
