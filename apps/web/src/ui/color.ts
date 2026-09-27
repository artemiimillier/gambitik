/** Minimal hex colour helpers for the code-drawn avatars (no dependency needed). */

export type Rgb = readonly [number, number, number];

/** Parses '#abc' or '#aabbcc'. Returns null for anything else (named colours, rgb(), …). */
export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let body = m[1] as string;
  if (body.length === 3) body = [...body].map((ch) => ch + ch).join('');
  const n = Number.parseInt(body, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  const part = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Mixes a colour with black (amount < 0) or white (amount > 0); amount is clamped to -1..1.
 * Unparseable input is returned unchanged so a bad Persona colour can never break rendering.
 */
export function shade(hex: string, amount: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const t = Math.max(-1, Math.min(1, amount));
  const target = t < 0 ? 0 : 255;
  const k = Math.abs(t);
  return toHex([rgb[0] + (target - rgb[0]) * k, rgb[1] + (target - rgb[1]) * k, rgb[2] + (target - rgb[2]) * k]);
}

/** 'rgba(r, g, b, a)' from a hex colour; falls back to the input when it cannot be parsed. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}
