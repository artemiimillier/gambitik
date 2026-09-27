/**
 * Dev-only harness for the mascot and the coach (the shell may mount it under `#/playground`).
 * Shows every pose, a mouth slider, and lets you make Гамбитик speak through the real
 * `coach` singleton with different priorities. Not linked from any child-facing screen.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { CoachEvent, CoachToolHost, HintLevel, MascotPose } from '@gambit/shared';
import { coach } from './coachController.ts';
import { useCoachStore } from './coachStore.ts';
import { Mascot } from './Mascot.tsx';
import { MascotDock } from './MascotDock.tsx';
import type { VoicePreference } from './settings.ts';

const POSES: readonly MascotPose[] = ['idle', 'wave', 'talk', 'think', 'cheer', 'oops', 'sleep', 'listen'];

const SAMPLE_PHRASES: readonly { label: string; event: Omit<CoachEvent, 'id'> }[] = [
  {
    label: 'Приветствие (1)',
    event: { kind: 'greeting', priority: 1, pose: 'wave', pauseClock: false, text: 'Привет-привет! Я Гамбитик. Сыграем?', bubbleText: 'Привет-привет! Я Гамбитик. Сыграем?' },
  },
  {
    label: 'Стоп, верни ход (2)',
    event: {
      kind: 'takebackOffer',
      priority: 2,
      pose: 'oops',
      pauseClock: true,
      text: 'Стоп-стоп-стоп! Подожди. Давай вернём ход и подумаем ещё разок? Посмотри, что сейчас под боем.',
      bubbleText: 'Стоп-стоп-стоп! Давай вернём ход и подумаем ещё разок? Посмотри, что под боем.',
      board: { arrows: [{ from: 'd8', to: 'h4', color: 'red' }], highlights: [{ square: 'e1', color: 'red' }] },
    },
  },
  {
    label: 'Похвала (0)',
    event: { kind: 'praise', priority: 0, pose: 'cheer', pauseClock: false, text: 'Вилка! Одним прыжком на двоих!', bubbleText: 'Вилка! Одним прыжком на двоих!' },
  },
  {
    label: 'Подсказка (1)',
    event: {
      kind: 'hint',
      priority: 1,
      pose: 'think',
      pauseClock: true,
      hintLevel: 1,
      text: 'Так-так-так… А что хочет соперник? Посмотри на своего коня. Он защищён? Какие у тебя есть шахи, взятия и угрозы? Не спеши, у нас полно времени.',
      bubbleText: 'Так-так-так… А что хочет соперник? Посмотри на своего коня. Он защищён? Какие есть шахи, взятия и угрозы? Не спеши.',
    },
  },
];

let phraseCounter = 0;
function withId(event: Omit<CoachEvent, 'id'>): CoachEvent {
  phraseCounter += 1;
  return { ...event, id: `playground-${phraseCounter}` };
}

/** A fake game so the «Подсказка» button and realtime tools can be tried without a board. */
function createDemoToolHost(): CoachToolHost {
  const hint = (level: HintLevel): CoachEvent =>
    withId({
      kind: 'hint',
      priority: 1,
      pose: level === 4 ? 'talk' : 'think',
      pauseClock: true,
      hintLevel: level,
      text: ['Что сейчас под боем?', 'Посмотри на центр доски.', 'Подумай, куда может прыгнуть конь.', 'Конь на эф три! Он защищает пешку и смотрит в центр.'][level - 1] ?? '',
      bubbleText: ['Что сейчас под боем?', 'Посмотри на центр доски.', 'Подумай, куда может прыгнуть конь.', 'Кf3! Он защищает пешку и смотрит в центр.'][level - 1] ?? '',
      ...(level === 4 ? { board: { arrows: [{ from: 'g1', to: 'f3', color: 'green' as const }], highlights: [] } } : {}),
    });
  return {
    getPositionSummary: () => Promise.resolve('Ходят белые. Фигур поровну. Под боем ничего нет. Король белых ещё не сделал рокировку.'),
    getHint: (level) => Promise.resolve(hint(level)),
    explainLastMove: () => Promise.resolve(null),
    showOnBoard: (annotations) => coach.showAnnotations(annotations),
    takeBackMove: () => false,
  };
}

const card: CSSProperties = { background: '#fff', borderRadius: 20, padding: 16, boxShadow: '0 2px 0 rgba(29,53,64,.06)' };
const button: CSSProperties = { font: 'inherit', fontWeight: 800, padding: '10px 16px', borderRadius: 14, border: '2px solid #1d3540', background: '#fff', cursor: 'pointer' };

export function MascotPlayground(): ReactElement {
  const state = useCoachStore();
  const [mouth, setMouth] = useState(0);
  const [text, setText] = useState('Помни наш секрет: сначала смотрим — потом ходим!');
  const [pose, setPose] = useState<MascotPose>('talk');
  const [priority, setPriority] = useState<0 | 1 | 2>(1);
  const [withHost, setWithHost] = useState(false);
  const demoHost = useMemo(createDemoToolHost, []);

  useEffect(() => {
    void coach.init();
  }, []);

  useEffect(() => {
    coach.setToolHost(withHost ? demoHost : null);
    return () => coach.setToolHost(null);
  }, [withHost, demoHost]);

  const speak = (): void => {
    void coach.say(withId({ kind: 'answer', priority, pose, pauseClock: false, text, bubbleText: text }));
  };

  return (
    <main style={{ padding: '24px 24px 280px', maxWidth: 1100, margin: '0 auto', fontFamily: "'Nunito Variable', system-ui, sans-serif", color: '#1d3540' }}>
      <h1 style={{ margin: '0 0 4px' }}>Гамбитик — playground</h1>
      <p style={{ margin: '0 0 20px', opacity: 0.75 }}>Dev harness: poses, lip-sync and the coach queue. The live dock is in the corner.</p>

      <section style={{ ...card, marginBottom: 20 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 12, fontWeight: 800 }}>
          mouthLevel {mouth.toFixed(2)}
          <input type="range" min={0} max={1} step={0.01} value={mouth} onChange={(e) => setMouth(Number(e.target.value))} style={{ flex: 1 }} />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12, marginTop: 28 }}>
          {POSES.map((p) => (
            <figure key={p} style={{ margin: 0, paddingTop: 24, textAlign: 'center' }}>
              <Mascot pose={p} mouthLevel={mouth} size={170} label={`Гамбитик: ${p}`} />
              <figcaption style={{ fontWeight: 800, marginTop: 4 }}>{p}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section style={{ ...card, marginBottom: 20, display: 'grid', gap: 12 }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} style={{ font: 'inherit', padding: 12, borderRadius: 14, border: '2px solid #b9a98a' }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <select value={pose} onChange={(e) => setPose(e.target.value as MascotPose)} style={button}>
            {POSES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select value={priority} onChange={(e) => setPriority(Number(e.target.value) as 0 | 1 | 2)} style={button}>
            <option value={0}>priority 0</option>
            <option value={1}>priority 1</option>
            <option value={2}>priority 2</option>
          </select>
          <button type="button" style={{ ...button, background: '#ffb938' }} onClick={speak}>
            Сказать
          </button>
          <button type="button" style={button} onClick={() => coach.stopSpeaking()}>
            stopSpeaking()
          </button>
          {SAMPLE_PHRASES.map((sample) => (
            <button key={sample.label} type="button" style={button} onClick={() => void coach.say(withId(sample.event))}>
              {sample.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <label style={{ fontWeight: 800 }}>
            voice:{' '}
            <select value={state.voicePreference} onChange={(e) => void coach.setVoicePreference(e.target.value as VoicePreference)} style={button}>
              <option value="auto">auto</option>
              <option value="live">live (full duplex)</option>
              <option value="realtime">realtime</option>
              <option value="browser">browser</option>
              <option value="off">off</option>
            </select>
          </label>
          <label style={{ fontWeight: 800 }}>
            mic:{' '}
            <select value={state.micMode} onChange={(e) => coach.setMicMode(e.target.value === 'push' ? 'push' : 'open')} style={button}>
              <option value="open">open</option>
              <option value="push">push</option>
            </select>
          </label>
          <label style={{ fontWeight: 800 }}>
            <input type="checkbox" checked={withHost} onChange={(e) => setWithHost(e.target.checked)} /> demo tool host (кнопка «Подсказка»)
          </label>
        </div>
      </section>

      <section style={card}>
        <strong>useCoachStore</strong>
        <pre style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', fontSize: 14 }}>{JSON.stringify(state, null, 2)}</pre>
      </section>

      <MascotDock />
    </main>
  );
}
