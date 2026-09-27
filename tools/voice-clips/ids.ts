/**
 * Stable ids of the clip library (SPEC §4.2): identical in Node and in the browser, no dependencies.
 *
 *  - clip id  = `c` + 13 hex of cyrb53(voiceKey + '\n' + prompt + '\n' + cutIndex [+ '\n' + take when take > 1])
 *  - job key  = `j` + 13 hex of cyrb53(voiceKey + '\n' + prompt + '\n#' + take)
 *
 * «13 hex» = the low 52 bits of the 53-bit hash, zero-padded, so every id has the same length and passes the
 * `voiceDiag` hex filter. The take joins the clip hash only from take 2 on: two takes of the same prompt are two paid
 * recordings and must not collide, while take-1 ids stay exactly the SPEC formula.
 */

/** cyrb53 (public domain, bryc): a fast 53-bit string hash over UTF-16 code units. */
export function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const LOW_52 = 2 ** 52;

/** 13 lowercase hex characters (the low 52 bits of cyrb53). */
export function hash13(text: string): string {
  return (cyrb53(text) % LOW_52).toString(16).padStart(13, '0');
}

export function clipId(voiceKey: string, prompt: string, cutIndex: number, take = 1): string {
  const base = `${voiceKey}\n${prompt}\n${cutIndex}`;
  return `c${hash13(take > 1 ? `${base}\n${take}` : base)}`;
}

export function jobKey(voiceKey: string, prompt: string, take: number): string {
  return `j${hash13(`${voiceKey}\n${prompt}\n#${take}`)}`;
}

/** `c3f0a91b2c4d5` → `3f/c3f0a91b2c4d5.mp3`: 256 folders by the two hex digits after the `c` (SPEC §4.1 `<id[1..2]>`). */
export function clipFile(id: string): string {
  return `${id.slice(1, 3)}/${id}.mp3`;
}

export const CLIP_ID_RE = /^c[0-9a-f]{13}$/;
