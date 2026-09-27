/**
 * Which voice Гамбитик speaks with — the parent's choice (Settings, behind the parental lock), kept on the server.
 *
 * Гамбитик is a boy foal, so a young, childlike voice suits him better than the .env default (VOICE_NAME /
 * VOICE_LIVE_VOICE, `marin` — an adult female voice). The parent picks one of the built-in voices; the choice is stored
 * in the kv table (`voice.choice` = `{ voice }`) and used for every new session. Nothing is picked by default: without
 * a choice the .env voices apply.
 *
 * The lists are the documented built-in voices (docs/research/03-openai-realtime-voice.md §3.6 and §4.3, checked
 * against developers.openai.com) — never fetched from the API. gpt-live-1 knows all 22; gpt-realtime-2.x
 * only the first 10. A Live-only choice keeps the .env voice when the fallback model (Realtime) has to speak.
 * None of them is Russian or a child's voice (research 03 §3.6): only listening tells which one suits Гамбитик.
 */
import type { Db } from '../storage/db.ts';
import { kvGetJson, kvSetJson } from '../storage/db.ts';

/** gpt-realtime-2.x (and gpt-live-1) */
export const REALTIME_VOICES: readonly string[] = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
/** gpt-live-1 only (12 more, research 03 §3.6) */
export const LIVE_ONLY_VOICES: readonly string[] = ['beacon', 'bossa', 'cinder', 'delta', 'gleam', 'meridian', 'quartz', 'ripple', 'stone', 'tempo', 'vesper', 'willow'];
export const LIVE_VOICES: readonly string[] = [...REALTIME_VOICES, ...LIVE_ONLY_VOICES];

export const KV_VOICE_CHOICE = 'voice.choice';

export type VoiceApi = 'live' | 'realtime';

export function isVoiceFor(api: VoiceApi, voice: unknown): voice is string {
  return typeof voice === 'string' && (api === 'live' ? LIVE_VOICES : REALTIME_VOICES).includes(voice);
}

export function isKnownVoice(voice: unknown): voice is string {
  return isVoiceFor('live', voice);
}

/** One entry of the picker. */
export interface VoiceOption {
  id: string;
  live: boolean;
  realtime: boolean;
}

/**
 * Answer of `GET /api/voice/voices` (and of the PUT): local extension, not in contracts.ts (see routes/voice.ts).
 * `live` / `realtime` = the voice the NEXT session of that API will use.
 */
export interface VoiceChoiceInfo {
  /** the parent's pick; null = none yet (the .env voices apply) */
  selected: string | null;
  live: string;
  realtime: string;
  defaults: { live: string; realtime: string };
  voices: VoiceOption[];
}

/** The voice a new session of `api` speaks with: the parent's pick when that API has it, else the .env default. */
export function resolveVoice(api: VoiceApi, selected: string | null, fallback: string): string {
  return selected !== null && isVoiceFor(api, selected) ? selected : fallback;
}

export class VoiceChoiceStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** the stored pick, or null (none / unreadable / a voice that is no longer on the list) */
  get(): string | null {
    let raw: unknown;
    try {
      raw = kvGetJson(this.db, KV_VOICE_CHOICE);
    } catch {
      return null;
    }
    const voice = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).voice : undefined;
    return isKnownVoice(voice) ? voice : null;
  }

  /** null = back to the .env voices */
  set(voice: string | null): void {
    if (voice !== null && !isKnownVoice(voice)) throw new Error('unknown voice');
    kvSetJson(this.db, KV_VOICE_CHOICE, { voice });
  }

  info(defaults: { live: string; realtime: string }): VoiceChoiceInfo {
    const selected = this.get();
    return {
      selected,
      live: resolveVoice('live', selected, defaults.live),
      realtime: resolveVoice('realtime', selected, defaults.realtime),
      defaults: { ...defaults },
      voices: LIVE_VOICES.map((id) => ({ id, live: true, realtime: REALTIME_VOICES.includes(id) })),
    };
  }
}
