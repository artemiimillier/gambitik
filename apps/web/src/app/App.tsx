/**
 * App shell: hash router, start-up (coach + profile + health), first-run onboarding, the global
 * mascot dock, the error boundary and the «сервер не отвечает» banner; the parent gate in front of the
 * settings and the soft break suggestion. (The one-time «надень наушники» note of the open microphone
 * lives in the mascot dock itself.)
 *
 * Feature screens are owned by other modules and mounted with exactly the props of
 * ARCHITECTURE §3; they are lazy-loaded so the home screen opens instantly and a problem in one
 * screen never takes the whole app down.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { buildGreeting } from '@gambit/core';
import { saveGame } from '../api/client.ts';
import { MascotDock, coach, useCoachStore } from '../coach/index.ts';
import { flushUnsavedGames } from '../features/game/unsavedGames.ts';
import { Spinner, setSoundDucked } from '../ui/index.ts';
import { appController, startHealthPolling, useAppStore } from './appStore.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { scheduleGreeting } from './greeting.ts';
import { shellCoachEvent } from './greeting.ts';
import { Home } from './Home.tsx';
import { goHome, navigate, useRoute } from './navigation.ts';
import { NewGame } from './NewGame.tsx';
import { Onboarding } from './Onboarding.tsx';
import { needsOnboarding } from './onboarding.ts';
import { ParentGate } from './ParentGate.tsx';
import { getGateStorage, isGateOpen, openGate } from './parentGate.ts';
import { loadResumeTile } from './resumeGame.ts';
import type { ResumeTile } from './resumeGame.ts';
import { formatRoute } from './router.ts';
import type { PlayRoute, Route, RouteName } from './router.ts';
import { ServerBanner } from './ServerBanner.tsx';
import { NUDGE_TICK_MS, createBreakNudge } from './sessionNudge.ts';
import { breakPhrase } from './shellPhrases.ts';
import { Settings } from './Settings.tsx';
import styles from './shell.module.css';
import { getBrowserStorage } from './shellSettings.ts';
import { WARMUP_PUZZLES, loadDayLog, markReviewedToday, notePuzzleDoneToday } from './todayPlan.ts';
import { SHORT_LANDSCAPE_QUERY, STACKED_GAME_QUERY, useMediaQuery } from './useMediaQuery.ts';


const GameScreen = lazy(() => import('../features/game/GameScreen.tsx').then((module) => ({ default: module.GameScreen })));
const ReviewScreen = lazy(() => import('../features/review/ReviewScreen.tsx').then((module) => ({ default: module.ReviewScreen })));
const PuzzlesScreen = lazy(() => import('../features/puzzles/PuzzlesScreen.tsx').then((module) => ({ default: module.PuzzlesScreen })));
const ProgressScreen = lazy(() => import('../features/progress/ProgressScreen.tsx').then((module) => ({ default: module.ProgressScreen })));
const CurriculumScreen = lazy(() => import('../features/curriculum/CurriculumScreen.tsx').then((module) => ({ default: module.CurriculumScreen })));
// Developer showcase (mascot playground + ui gallery): part of the DEV server only. `import.meta.env.DEV` is a build-time
// constant, so the production bundle contains neither the chunk nor the import.
const Playground = import.meta.env.DEV ? lazy(() => import('./Playground.tsx').then((module) => ({ default: module.Playground }))) : null;

const ROUTE_TITLES: Record<RouteName, string> = {
  home: 'Гамбитик — шахматный тренер',
  new: 'Новая партия — Гамбитик',
  play: 'Партия — Гамбитик',
  review: 'Разбор партии — Гамбитик',
  puzzles: 'Задачи — Гамбитик',
  progress: 'Мои успехи — Гамбитик',
  path: 'Путь пешки — Гамбитик',
  settings: 'Настройки — Гамбитик',
  playground: 'Витрина — Гамбитик',
};

/** Гамбитик is the host of the home screen, a quiet helper on the parent pages. */
function dockSizeFor(route: Route, onboarding: boolean, roomyWindow: boolean, wideWindow: boolean): number {
  if (onboarding) return 200;
  // below 1240 px the home's doors stand 2 × 2 and the page needs the width — see Home.module.css (--mascot-dock-size: 276px)
  if (route.name === 'home') return wideWindow ? 200 : 160;
  if (route.name === 'progress' || route.name === 'settings') return 120;
  // in a game the panel above him needs the height: move list, «Подсказка», the take-back choice
  if (route.name === 'play') return 150;
  // iPad-like windows (< 1280 px): the review board needs the width — see ReviewScreen.module.css (--mascot-dock-size: 276px)
  if (route.name === 'review' && !roomyWindow) return 140;
  return 180;
}

/** From 1240 px on the game panel is wider than the free strip of the other screens: his bubble may use it. */
function bubbleWidthFor(route: Route, onboarding: boolean, wideWindow: boolean, roomyWindow: boolean): number | undefined {
  if (onboarding) return undefined;
  if (wideWindow && route.name === 'play') return 340;
  // the home keeps only a 276 px strip free on windows below 1240 px: the bubble must fit into it
  if (route.name === 'home' && !wideWindow) return 256;
  // the review keeps only a 276 px strip free on windows below 1280 px: the bubble must fit into it
  if (route.name === 'review' && !roomyWindow) return 256;
  return undefined;
}

/** The parked-games queue also removes entries, so it needs the whole Storage (the shell's own type is read/write only). */
function fullBrowserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The game's settings from a #/play route (ARCHITECTURE §3 GameScreen props + `coachStyle`, TEACHER-MODE §6.4).
 * `examMode` stays derived (`coachStyle === 'exam'`) for the game's code paths that read it. A route always carries a concrete
 * style (never 'auto'), so the wizard's choice — «Подсказчик» included — reaches the game as is.
 */
function gameSettingsProps(route: PlayRoute): Pick<PlayRoute, 'personaId' | 'timeControlId' | 'childColor' | 'coachStyle' | 'examMode'> {
  return { personaId: route.personaId, timeControlId: route.timeControlId, childColor: route.childColor, coachStyle: route.coachStyle, examMode: route.examMode };
}

/** The window's width in CSS px (the bar's bubble takes what the buttons and Гамбитик leave). */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 390 : window.innerWidth));
  useEffect(() => {
    const update = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

function LoadingScreen() {
  return (
    <div className={styles.loading}>
      <Spinner size={72} showLabel />
    </div>
  );
}

export function App() {
  const route = useRoute();
  const phase = useAppStore((s) => s.phase);
  const profile = useAppStore((s) => s.profile);
  const health = useAppStore((s) => s.health);
  const serverOnline = useAppStore((s) => s.serverOnline);
  const games = useAppStore((s) => s.games);
  const onboarded = useAppStore((s) => s.onboarded);

  /** null = not decided yet (still loading); decided ONCE so a saved nickname does not close the welcome step */
  const [onboardingActive, setOnboardingActive] = useState<boolean | null>(null);
  const [dayLog, setDayLog] = useState(() => loadDayLog(getBrowserStorage(), new Date()));
  const [resume, setResume] = useState<ResumeTile | null>(null);
  const [gateOpen, setGateOpen] = useState(() => isGateOpen(getGateStorage(), Date.now()));
  const wideWindow = useMediaQuery('(min-width: 1240px)');
  const roomyWindow = useMediaQuery('(min-width: 1280px)');
  const stackedWindow = useMediaQuery(STACKED_GAME_QUERY);
  const shortLandscape = useMediaQuery(SHORT_LANDSCAPE_QUERY);
  const tabletWidth = useMediaQuery('(min-width: 600px)');
  const viewportWidth = useViewportWidth();
  const routeNameRef = useRef(route.name);
  routeNameRef.current = route.name;
  const greetingHandled = useRef(false);
  const cancelGreeting = useRef<(() => void) | null>(null);

  // ───── start-up ─────
  useEffect(() => {
    void coach.init();
    void appController.bootstrap();
    const stopPolling = startHealthPolling();
    // voice first: sound effects duck to 30 % while Гамбитик speaks or listens
    const stopDucking = useCoachStore.subscribe((state, previous) => {
      if (state.speaking !== previous.speaking || state.listening !== previous.listening) setSoundDucked(state.speaking || state.listening);
    });
    return () => {
      stopPolling();
      stopDucking();
      cancelGreeting.current?.();
    };
  }, []);

  useEffect(() => {
    if (phase === 'ready' && onboardingActive === null) setOnboardingActive(needsOnboarding(profile, onboarded));
  }, [phase, profile, onboarded, onboardingActive]);

  // ───── the banner's promise: games finished while the server was down are sent as soon as it is back ─────
  useEffect(() => {
    if (phase !== 'ready' || !serverOnline) return;
    void flushUnsavedGames(fullBrowserStorage(), (record) => saveGame(record))
      .then((sent) => {
        if (sent > 0) void appController.refresh();
      })
      .catch(() => undefined); // still unreachable: the records stay parked for the next try
  }, [phase, serverOnline]);

  // ───── the spoken hello: once per start, only when the app opens on the home screen ─────
  useEffect(() => {
    if (phase !== 'ready' || onboardingActive !== false || greetingHandled.current) return;
    greetingHandled.current = true;
    if (route.name !== 'home') return; // reloaded in the middle of a game or a review: no hello on top of it
    cancelGreeting.current = scheduleGreeting({
      store: useCoachStore,
      say: (event) => coach.say(event),
      buildEvent: () => {
        const state = useAppStore.getState();
        const current = state.profile ?? profile;
        if (current === null) throw new Error('profile is missing after bootstrap');
        return buildGreeting({ profile: current, hour: new Date().getHours(), lastGame: state.games[0] });
      },
    });
  }, [phase, onboardingActive, route.name, profile]);

  // ───── «пора отдохнуть»: once after ~35 minutes of real activity, never in the middle of a game, never blocking ─────
  const breakNudge = useRef<ReturnType<typeof createBreakNudge> | null>(null);
  useEffect(() => {
    const nudge = createBreakNudge(Date.now());
    breakNudge.current = nudge;
    const onActivity = (): void => nudge.noteActivity(Date.now());
    window.addEventListener('pointerdown', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity, { passive: true });
    const timer = setInterval(() => {
      nudge.tick(Date.now());
      if (!nudge.due() || routeNameRef.current === 'play' || routeNameRef.current === 'settings') return;
      const state = useCoachStore.getState();
      if (!state.ready || state.speaking || state.listening) return; // wait for a quiet moment, try again in 30 s
      nudge.markNudged();
      void coach.say(shellCoachEvent(breakPhrase()));
    }, NUDGE_TICK_MS);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
      breakNudge.current = null;
    };
  }, []);

  // ───── per-route side effects ─────
  const routeKey = formatRoute(route);
  useEffect(() => {
    document.title = ROUTE_TITLES[route.name];
    window.scrollTo(0, 0);
    coach.noteActivity();
    breakNudge.current?.noteActivity(Date.now());
    // the day log may have changed on the screen the child comes from (puzzles), or the day itself
    setDayLog(loadDayLog(getBrowserStorage(), new Date()));
    if (route.name === 'settings') setGateOpen(isGateOpen(getGateStorage(), Date.now()));
    // an interrupted game (closed tab, reload) is offered on the home screen; the game module owns the snapshot
    if (route.name === 'home') void loadResumeTile().then(setResume);
    // keep the address bar canonical (a broken #/play link becomes #/new, junk becomes #/)
    if (window.location.hash !== routeKey && window.location.hash !== '') navigate(route, { replace: true });
    if (route.name === 'play') cancelGreeting.current?.(); // the game has its own opening phrase
    if (route.name === 'review') setDayLog(markReviewedToday(getBrowserStorage(), route.gameId, new Date()));
    if (route.name === 'home' || route.name === 'new' || route.name === 'settings') void appController.refresh();
    // `route` is a stable object per `routeKey` (see useRoute), so the key alone is the dependency
  }, [routeKey]);

  const exitHome = useCallback(() => goHome(), []);
  const saveStudent = useCallback((patch: Parameters<typeof appController.saveStudent>[0]) => appController.saveStudent(patch), []);

  const finishOnboarding = useCallback(() => {
    appController.completeOnboarding();
    greetingHandled.current = true; // Гамбитик has just greeted on the welcome step
    setOnboardingActive(false);
    goHome({ replace: true });
  }, []);

  const showOnboarding = onboardingActive === true && route.name !== 'playground';

  // ───── «Дозапись голоса» outside a game: the child's own screens only ─────
  // A phrase said without its recording there is recorded on first use (the local server, ids only). Never on the
  // parent's page behind the gate (its «Послушать» and the dev demo go through the real coach) nor on the showcase;
  // the gate itself is the child's screen. A live game records whatever this says (never an exam — the coach's rule).
  const recordingScope = showOnboarding || (route.name !== 'playground' && (route.name !== 'settings' || !gateOpen));
  useEffect(() => {
    coach.setRecordingScope(recordingScope);
  }, [recordingScope]);

  const passGate = useCallback(() => {
    openGate(getGateStorage(), Date.now());
    setGateOpen(true);
  }, []);

  const notePuzzleDone = useCallback(() => setDayLog(notePuzzleDoneToday(getBrowserStorage(), new Date())), []);

  let screen: ReactNode;
  if (phase !== 'ready' || onboardingActive === null || profile === null) {
    screen = <LoadingScreen />;
  } else if (showOnboarding) {
    screen = <Onboarding profile={profile} saveStudent={saveStudent} onDone={finishOnboarding} />;
  } else {
    const homeScreen = <Home profile={profile} games={games} reviewedToday={dayLog.reviewed} puzzlesToday={dayLog.puzzles} resume={resume} onNavigate={navigate} />;
    switch (route.name) {
      case 'home':
        screen = homeScreen;
        break;
      case 'new':
        screen = <NewGame profile={profile} onStart={navigate} onExit={exitHome} />;
        break;
      case 'play':
        screen = (
          <GameScreen
            key={routeKey}
            {...gameSettingsProps(route)}
            onExit={(gameId) => {
              // replace: «Back» from the review must never restart the finished game
              if (gameId) navigate({ name: 'review', gameId }, { replace: true });
              else goHome({ replace: true });
              void appController.refresh();
            }}
          />
        );
        break;
      case 'review':
        screen = <ReviewScreen key={route.gameId} gameId={route.gameId} onExit={exitHome} onStartPuzzles={(theme) => navigate({ name: 'puzzles', theme })} />;
        break;
      case 'puzzles':
        screen = (
          <PuzzlesScreen
            key={`${route.theme ?? ''}:${route.warmup === true ? 'warmup' : ''}`}
            theme={route.theme}
            sessionSize={route.warmup === true ? WARMUP_PUZZLES : undefined}
            onPuzzleDone={notePuzzleDone}
            onExit={() => {
              goHome();
              void appController.refresh();
            }}
          />
        );
        break;
      case 'progress':
        screen = <ProgressScreen onExit={exitHome} onOpenGame={(gameId) => navigate({ name: 'review', gameId })} />;
        break;
      case 'path':
        screen = <CurriculumScreen onExit={exitHome} onStartPuzzles={(theme) => navigate({ name: 'puzzles', theme })} />;
        break;
      case 'settings':
        // «Страница для взрослых»: a child must not switch the paid voice on or move the stage by accident
        screen = !gateOpen ? (
          <ParentGate onPass={passGate} onExit={exitHome} />
        ) : (
          <Settings
            profile={profile}
            health={health}
            serverOnline={serverOnline}
            saveStudent={saveStudent}
            onExit={exitHome}
            onOpenPlayground={() => navigate({ name: 'playground', tool: 'mascot' })}
          />
        );
        break;
      case 'playground':
        // production has no showcase: the address simply shows the home screen
        screen = Playground ? <Playground tool={route.tool} onSelectTool={(tool) => navigate({ name: 'playground', tool }, { replace: true })} onExit={exitHome} /> : homeScreen;
        break;
    }
  }

  // a phone held upright: Гамбитик in a bar across the bottom — the game keeps that strip free itself, every other
  // page gets room under its content (html[data-dock-bar='page'], ui/global.css), so his words never cover anything
  // a phone on its side: the same bar, in the right-hand column only (MascotDock.css)
  const dockBar = (stackedWindow || shortLandscape) && !showOnboarding && route.name !== 'playground';
  // a 320–379 px phone gives the words the room: a smaller Гамбитик
  useEffect(() => {
    const root = document.documentElement;
    if (dockBar && route.name !== 'play') root.dataset.dockBar = 'page';
    else delete root.dataset.dockBar;
  }, [dockBar, route.name]);
  const barMascot = shortLandscape ? 64 : tabletWidth ? 112 : viewportWidth < 380 ? 64 : 84;
  const barWidth = shortLandscape ? Math.round(viewportWidth * 0.42) : viewportWidth;
  // the mascot playground brings its own live dock — never show two Гамбитиks
  const showDock = !(Playground !== null && route.name === 'playground' && route.tool === 'mascot');

  return (
    <ErrorBoundary>
      <ErrorBoundary inline resetKey={routeKey} onGoHome={exitHome}>
        <Suspense fallback={<LoadingScreen />}>{screen}</Suspense>
      </ErrorBoundary>
      <ServerBanner online={serverOnline} onRetry={() => appController.refresh()} compact={route.name === 'play'} />
      {showDock ? (
        dockBar ? (
          <MascotDock layout="bar" size={barMascot} bubbleWidth={Math.max(150, barWidth - 16 - 48 - barMascot - 2 * 8)} />
        ) : (
          <MascotDock
            size={dockSizeFor(route, showOnboarding, roomyWindow, wideWindow)}
            bubbleWidth={bubbleWidthFor(route, showOnboarding, wideWindow, roomyWindow)}
            compactOnLowWindow={!showOnboarding && route.name === 'play'}
          />
        )
      ) : null}
    </ErrorBoundary>
  );
}

export default App;
