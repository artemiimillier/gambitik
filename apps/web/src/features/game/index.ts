/**
 * Public API of the live game module (ARCHITECTURE §3 «apps/web/src/features/game»).
 *
 *   shell  — `GameScreen` (lazy), `flushUnsavedGames` at app start,
 *            `hasResumableGame()` / `resumableGameInfo()` / `clearResumableGame()` for a «Продолжить партию?»
 *            tile on Home. The three resume helpers also live at the STABLE light-weight path
 *            `features/game/resume.ts` (no engines, no React) — prefer `import('../features/game/resume.ts')`
 *            when only they are needed, so the game bundle is not pulled into the Home screen.
 *   wizard — `prefetchStrategyFor(choice)` («Учитель» as White: the strategy request starts at the colour tap); the
 *            light path is `features/game/strategy.ts` (the wizard imports it directly).
 */
export { GameScreen } from './GameScreen.tsx';
export type { GameScreenProps } from './GameScreen.tsx';
export { RESUME_GAME_KEY, clearResumableGame, hasResumableGame, resumableGame, resumableGameInfo } from './resume.ts';
export type { ResumableGame, ResumableGameInfo } from './resume.ts';
export { UNSAVED_GAMES_KEY, flushUnsavedGames, readUnsavedGames } from './unsavedGames.ts';
export type { GameCoachStyle, GameConfig, GameState, GameStrategist } from './gameTypes.ts';
// «Учитель»: the smart strategist — the wizard prefetches the strategy (light module: no engines, no React)
export { createBrowserStrategist, prefetchStrategyFor, strategyPrefetch } from './strategy.ts';
