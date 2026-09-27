/**
 * «Записи» — the demo replay screen (docs/voice-clips/SPEC.md §9, docs/voice-clips/demo-format.md). DEV server only,
 * opened from Settings (behind the parental lock) or with `?clipsDemo=<seed>`.
 *
 * It replays a harvested game — the moves and the coach events the real builders produced — through its OWN coach
 * controller with the real clips layer (never a paid or a robot voice), its own Гамбитик, a small board and the child's
 * clock, which stands exactly while he is heard. The parent watches and listens; the log shows what each phrase became
 * (as written, split move, generic line …). `sample` is a built-in four-move game for a check before any harvest.
 * Under automation the layer is the silent one (or, with `gambit.e2eClips`, the clips layer into a muted output).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { HealthInfo } from '@gambit/shared';
import { automationSilenced } from '../../automation.ts';
import { createCoachController } from '../coachController.ts';
import type { CoachController } from '../coachController.ts';
import { createCoachStore } from '../coachStore.ts';
import { MascotDock } from '../MascotDock.tsx';
import { SETTINGS_STORAGE_KEY } from '../settings.ts';
import type { SettingsStorage } from '../settings.ts';
import { createSilentVoice } from '../silentVoice.ts';
import type { ClipPlanInfo } from '../voiceTypes.ts';
import { e2eClipsOptIn } from './clipFlags.ts';
import { createDemoReplay, parseClipsDemo, sampleClipsDemo } from './clipsDemo.ts';
import type { ClipsDemoFile, DemoReplay, DemoState } from './clipsDemo.ts';
import { createBrowserClipVoice } from './clipVoice.ts';
import styles from './ClipsDemo.module.css';

export interface ClipsDemoProps {
  seed: string;
  onClose: () => void;
}

/** one line of the log: what the game wanted to say, and what the recordings made of it (null = not planned yet / silent layer) */
interface DemoLogEntry {
  eventId: string;
  kind: string;
  text: string;
  plan: ClipPlanInfo | null;
}

function tagOf(entry: DemoLogEntry): string {
  const p = entry.plan;
  if (!p) return 'без звука';
  if (p.src === 'none') return 'тишина';
  return p.level === 1 ? 'как написано' : p.level === 2 ? 'ход по частям' : p.level === 3 ? 'без хвоста' : p.level === 4 ? 'фраза выпала' : 'общая фраза';
}

const GLYPHS: Readonly<Record<string, string>> = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';

function squaresOf(fen: string): { square: string; piece: string | null }[] {
  const rows = (fen.split(' ')[0] ?? '').split('/');
  const out: { square: string; piece: string | null }[] = [];
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let k = 0; k < Number(ch); k++) out.push({ square: `${FILES[f++]}${8 - r}`, piece: null });
      } else out.push({ square: `${FILES[f++]}${8 - r}`, piece: ch });
    }
  });
  return out;
}

function clockText(ms: number | null): string {
  if (ms === null) return 'без часов';
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function memoryStorage(): SettingsStorage {
  const data = new Map<string, string>([[SETTINGS_STORAGE_KEY, JSON.stringify({ voice: 'clips', talkativeness: 'chatty' })]]);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

async function loadDemo(seed: string): Promise<{ demo: ClipsDemoFile | null; problems: string[] }> {
  if (seed === 'sample') return parseClipsDemo(JSON.parse(JSON.stringify(sampleClipsDemo())) as unknown);
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  try {
    const res = await fetch(`${base}voice/demo/${seed}.json`, { cache: 'no-cache' });
    if (!res.ok) return { demo: null, problems: [`voice/demo/${seed}.json: ${res.status}`] };
    return parseClipsDemo(JSON.parse(await res.text()) as unknown);
  } catch {
    return { demo: null, problems: [`voice/demo/${seed}.json не найден (его пишет harvest инструмента voice-clips)`] };
  }
}

export function ClipsDemo({ seed, onClose }: ClipsDemoProps): ReactElement {
  const store = useMemo(() => createCoachStore(), []);
  const entries = useRef<DemoLogEntry[]>([]);
  const [log, setLog] = useState<DemoLogEntry[]>([]);
  const [loaded, setLoaded] = useState<{ demo: ClipsDemoFile | null; problems: string[] } | null>(null);
  const [state, setState] = useState<DemoState | null>(null);
  const [speed, setSpeed] = useState(1);
  const replay = useRef<DemoReplay | null>(null);

  // its own coach: the clips layer only (silent under automation, muted clips with the e2e opt-in). Created in the
  // effect, so a StrictMode re-mount (dev) gets a fresh controller instead of the disposed one.
  const [coach, setCoach] = useState<CoachController | null>(null);
  useEffect(() => {
    const created = createCoachController({
      store,
      getHealth: () => Promise.reject(new Error('demo: no server health needed')) as Promise<HealthInfo>,
      getStorage: memoryStorage,
      isSilenced: () => automationSilenced(),
      clipsWhenSilenced: () => e2eClipsOptIn(),
      createVoice: (kind) => {
        if (kind !== 'clips') return createSilentVoice();
        const voice = createBrowserClipVoice({ muted: automationSilenced() });
        voice.onPlan((info) => {
          const index = entries.current.findLastIndex((e) => e.eventId === info.eventId);
          if (index < 0) return;
          entries.current = entries.current.map((e, i) => (i === index ? { ...e, plan: info } : e));
          setLog(entries.current);
        });
        return voice;
      },
    });
    void created.init();
    setCoach(created);
    return () => {
      replay.current?.stop();
      replay.current = null;
      created.dispose();
    };
  }, [store]);

  useEffect(() => {
    let alive = true;
    void loadDemo(seed).then((result) => {
      if (alive) setLoaded(result);
    });
    return () => {
      alive = false;
    };
  }, [seed]);

  const start = (): void => {
    const demo = loaded?.demo;
    if (!demo || !coach) return;
    coach.unlockAudio();
    replay.current?.stop();
    entries.current = [];
    setLog([]);
    coach.onGameStart({ timeControlId: demo.timeControlId, ...(demo.coachStyle ? { coachStyle: demo.coachStyle } : {}) });
    replay.current = createDemoReplay({
      demo,
      speed,
      say: (event) => {
        entries.current = [...entries.current, { eventId: event.id, kind: event.kind, text: event.text, plan: null }].slice(-60);
        setLog(entries.current);
        return coach.say(event);
      },
      stopSpeaking: (opts) => coach.stopSpeaking(opts),
      speaking: () => store.getState().speaking,
      onState: (s) => {
        setState(s);
        if (s.status === 'done' || s.status === 'stopped') coach.onGameEnd();
      },
    });
    replay.current.start();
  };

  const annotations = store((s) => s.annotations);
  const voiceKind = store((s) => s.voiceKind);
  const library = store((s) => s.clipLibrary);
  const demo = loaded?.demo ?? null;
  const fen = state?.fen ?? demo?.startFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const marked = new Set<string>([...(annotations?.highlights ?? []).map((h) => h.square), ...(annotations?.arrows ?? []).flatMap((a) => [a.from, a.to])]);
  const squares = squaresOf(fen);
  const ordered = demo?.childColor === 'b' ? [...squares].reverse() : squares;

  return (
    <div className={styles.overlay} role="dialog" aria-label="Демо записанного голоса">
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>Демо «Записи»: {demo?.title ?? seed}</h2>
          <p className={styles.sub}>
            Голос: {voiceKind === 'clips' ? `записанный${library ? ` (${library.phrases} фраз, версия ${library.libraryVersion})` : ''}` : 'без звука — библиотеки записей нет'} · ход{' '}
            {state?.ply ?? 0} из {demo?.plies.length ?? 0}
          </p>
        </div>
        <div className={styles.controls}>
          {state?.status === 'playing' ? (
            <button type="button" onClick={() => replay.current?.pause()}>
              Пауза
            </button>
          ) : state?.status === 'paused' ? (
            <button type="button" onClick={() => replay.current?.resume()}>
              Дальше
            </button>
          ) : (
            <button type="button" disabled={!demo || !coach} onClick={start}>
              {state ? 'Сначала' : 'Старт'}
            </button>
          )}
          <label>
            Паузы между ходами{' '}
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={state?.status === 'playing'}>
              <option value={1}>как в партии</option>
              <option value={0.5}>в 2 раза короче</option>
            </select>
          </label>
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </header>

      {loaded && loaded.problems.length > 0 ? (
        <p className={styles.problems} role="status">
          {loaded.problems.join(' · ')}
        </p>
      ) : null}

      <div className={styles.body}>
        <div className={styles.side}>
          <div className={styles.board} aria-label="Доска">
            {ordered.map(({ square, piece }) => {
              const file = FILES.indexOf(square[0] as string);
              const rank = Number(square[1]);
              const dark = (file + rank) % 2 === 1;
              const last = state?.lastMove && (state.lastMove.from === square || state.lastMove.to === square);
              return (
                <div key={square} className={styles.square} data-dark={dark ? 'true' : 'false'} data-last={last ? 'true' : 'false'} data-mark={marked.has(square) ? 'true' : 'false'}>
                  {piece ? GLYPHS[piece] : ''}
                </div>
              );
            })}
          </div>
          <p className={styles.clock} data-held={state?.held ? 'true' : 'false'}>
            Часы ребёнка: {clockText(state?.childMs ?? demo?.clockMs ?? null)} {state?.held ? '· стоят, пока Гамбитик говорит' : ''}
          </p>
          <p className={styles.sub}>Мягких остановок (ребёнок сходил во время фразы): {state?.graceStops ?? 0}</p>
        </div>
        <ol className={styles.log} aria-label="Что прозвучало">
          {log.map((entry, i) => (
            <li key={`${entry.eventId}-${i}`} data-src={entry.plan?.src ?? 'none'}>
              <span className={styles.tag}>
                {entry.kind} · {tagOf(entry)}
              </span>{' '}
              {entry.plan?.heard || entry.text}
              {entry.plan && entry.plan.heard !== '' && entry.plan.heard !== entry.text ? <span className={styles.tag}> (в тексте: {entry.text})</span> : null}
            </li>
          ))}
        </ol>
      </div>
      {coach ? (
        <div className={styles.dock}>
          <MascotDock coach={coach} store={store} size={140} />
        </div>
      ) : null}
    </div>
  );
}
