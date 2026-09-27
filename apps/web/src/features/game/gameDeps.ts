/**
 * Browser wiring of the game controller: real Stockfish workers, the app's coach singleton, the REST client,
 * WebAudio sounds, confetti and localStorage. Everything here is replaceable in tests (see testing/fakes.ts).
 */
import type { StudentProfile } from '@gambit/shared';
import { appendGameThoughts, getStudent, saveGame } from '../../api/client.ts';
import { coach } from '../../coach/index.ts';
import { createBotEngine, createJudgeEngine } from '../../engine/index.ts';
import { celebrate, playSound } from '../../ui/index.ts';
import type { GameDeps, KeyValueStorage, OpeningLookup } from './gameTypes.ts';
import { helloHeardRecently } from './hello.ts';
import { browserStorage } from './storage.ts';
import { createBrowserStrategist } from './strategy.ts';
import { createOpeningNames } from './teacherContent.ts';

/** Last profile the server gave us — keeps the nickname and the verb gender right when the server is down. */
export const STUDENT_CACHE_KEY = 'gambit.studentCache';

export { browserStorage };

/** How long one POST /games may take before the game is treated as not saved. */
export const SAVE_GAME_TIMEOUT_MS = 8_000;

function isProfileLike(value: unknown): value is StudentProfile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StudentProfile>;
  return typeof candidate.nickname === 'string' && (candidate.address === 'm' || candidate.address === 'f') && typeof candidate.stage === 'number';
}

function readCachedProfile(storage: KeyValueStorage | null): StudentProfile | null {
  try {
    const raw = storage?.getItem(STUDENT_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isProfileLike(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Keys of the SHELL's offline state (app/appStore.ts: PROFILE_CACHE_KEY, PENDING_STUDENT_KEY): a nickname /
 * address / stage edited while the server was away lives there as a pending patch — the game coach must see it too,
 * so the offline fallback below reads the shell's cache first and lays the pending patch over whatever profile it found.
 */
const SHELL_PROFILE_CACHE_KEY = 'gambit.profile.cache';
const SHELL_PENDING_STUDENT_KEY = 'gambit.student.pending';

function readJson(storage: KeyValueStorage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function pendingPatch(storage: KeyValueStorage | null): Partial<Pick<StudentProfile, 'nickname' | 'address' | 'stage'>> {
  const raw = readJson(storage, SHELL_PENDING_STUDENT_KEY);
  if (typeof raw !== 'object' || raw === null) return {};
  const candidate = raw as Record<string, unknown>;
  return {
    ...(typeof candidate.nickname === 'string' && candidate.nickname.trim() !== '' ? { nickname: candidate.nickname } : {}),
    ...(candidate.address === 'm' || candidate.address === 'f' ? { address: candidate.address } : {}),
    ...(typeof candidate.stage === 'number' && Number.isInteger(candidate.stage) && candidate.stage >= 1 && candidate.stage <= 10 ? { stage: candidate.stage } : {}),
  };
}

/** Exported for tests: the profile to play with when GET /student failed. */
export function offlineProfile(storage: KeyValueStorage | null): StudentProfile | null {
  const shellCache = readJson(storage, SHELL_PROFILE_CACHE_KEY);
  const base = isProfileLike(shellCache) ? shellCache : readCachedProfile(storage);
  return base ? { ...base, ...pendingPatch(storage) } : null;
}

async function loadProfile(storage: KeyValueStorage | null): Promise<StudentProfile> {
  try {
    const profile = await getStudent();
    try {
      storage?.setItem(STUDENT_CACHE_KEY, JSON.stringify(profile));
    } catch {
      // the cache is a convenience
    }
    return profile;
  } catch (error) {
    const cached = offlineProfile(storage);
    if (cached) return cached;
    throw error;
  }
}

/** The opening book is ~460 kB of JSON: loaded on demand, outside the main bundle. */
async function lookupOpening(fens: readonly string[]): Promise<OpeningLookup | undefined> {
  const book = await import('@gambit/openings');
  return book.openingFromHistory(fens);
}

/** Fresh dependencies for ONE game. The controller owns (and disposes) the two engines. */
export function createBrowserGameDeps(): GameDeps {
  const storage = browserStorage();
  return {
    judge: createJudgeEngine(),
    bot: createBotEngine(),
    coach,
    loadProfile: () => loadProfile(storage),
    // bounded: a server that accepted the connection but never answers must not leave the result card on
    // «Сохраняю…» forever — after the timeout saveRecord() retries once and then parks the game in localStorage
    // (the server ignores a second record with the same id, so a late first answer is harmless)
    saveGame: (record) => saveGame(record, { signal: AbortSignal.timeout(SAVE_GAME_TIMEOUT_MS) }),
    // the child's words after the record went out (bounded like the save: a hanging server parks them for later)
    appendThoughts: (gameId, thoughts) => appendGameThoughts(gameId, thoughts, { signal: AbortSignal.timeout(SAVE_GAME_TIMEOUT_MS) }),
    lookupOpening,
    storage,
    playSound: (name) => {
      playSound(name);
    },
    celebrate: () => {
      void celebrate('win');
    },
    // The app's coach controller runs the long-silence nudge itself (coachController.ts: it hears the child directly
    // and knows when it is muted or busy): the game's own copy stays off so that a thinking child is never nudged twice.
    timings: { silenceNudgeMs: 0 },
    // «Учитель» names a «известный ход» only by the book: the book is loaded in the background right away (the rest of
    // the teacher content — repertoire, main lines, cards — comes with the defaults of teacherContent.ts)
    teacherContent: { openingNameRu: createOpeningNames() },
    // «Учитель»: the strategy of the game (the wizard's prefetch, or a request of its own) and the re-plans — the server
    // runs the smart model (codex «Sol» → OpenRouter → template); an automated browser only ever gets the free template
    strategist: createBrowserStrategist(),
    // the game's first line says «Привет!» when the shell's hello was cut off (the watch is armed by NewGame.tsx)
    helloHeard: helloHeardRecently,
  };
}
