/**
 * Public API of the coach module (ARCHITECTURE §3 «apps/web/src/coach»).
 *
 * How the rest of the app uses it:
 *   shell   — render <MascotDock/> once (it calls coach.init() itself; calling it earlier is fine),
 *             Settings: write `gambit.settings` (voice / micMode / headphonesConfirmed / muted — see ./settings.ts) with
 *             saveCoachSettings(getBrowserStorage(), patch) and call `await coach.applySettings()`; or use the shortcuts
 *             coach.setVoicePreference('auto'|'live'|'realtime'|'browser'|'off'), coach.setMicMode('open'|'push'),
 *             coach.confirmHeadphones(), coach.setMuted(b).
 *             useCoachStore: voiceKind ('openai-live' | 'openai-realtime' | 'browser-tts' | 'silent'), voiceConnected,
 *             micMode, headphonesConfirmed, micMuted, childSpeaking
 *   game    — coach.say(event) (await = spoken / interrupted / dropped; a conversational voice says `event.brief` in its
 *             own words, `event.text` is the fallback), coach.stopSpeaking(),
 *             coach.onGameStart({ timeControlId, examMode, coachStyle }) once the game runs (opens the «Поговорить»
 *             conversation by itself unless bullet / automation / autoConversation off; coachStyle 'teacher' renames the
 *             dock's hint button «Совет», 'exam' hides it and drops teacher phrases) and coach.onGameEnd() at the result card,
 *             teacher mode: `teachTurn` / `teachReaction` pass every talkativeness — read coach.talkativeness (or
 *             useCoachStore talkativeness) to pick the LENGTH ('quiet' → 'short'); the model gets the sentence budget of
 *             `event.teach.style` (short 1 / full 4 / concept 5); coach.stopSpeaking({ grace: true }) when the child moves
 *             mid-advice (the sentence he is saying may end, ≤ 2 s; what waits is dropped),
 *             coach.setToolHost(host) on mount and coach.setToolHost(null) on exit (teacher mode: the host's optional
 *             compareMove({ move } | { piece }) answers «а почему не ферзём?» — Live intent 'whyNot', Realtime tool
 *             compare_move — and repeatAdvice() answers «Совет» when nobody subscribed and «а ещё варианты?» with
 *             { more: true }; getHint(level) returns a `teachTurn` whose «Можно назвать» moves the model may say),
 *             coach.onHintRequested(cb) for the «Подсказка» / «Совет» button, coach.noteActivity() on every CHILD move / tap
 *             (keeps him awake; never for the bot's moves — 2 min without the child close the paid session),
 *             coach.clearAnnotations() after a move,
 *             useCoachStore((s) => s.annotations) → arrows / highlights for the board,
 *             coach.onTranscript(cb) → 'childSaid' / 'coachSaid' journal events (conversational voices only),
 *             coach.pushContext(note) → silent Russian facts for the voice model after a move / judgement (never spoken)
 *   dock    — coach.toggleConversation() / startConversation() / endConversation(); useCoachStore: conversationState,
 *             conversationOn, micLevel; settings talkativeness ('quiet'|'normal'|'chatty') / autoConversation via
 *             coach.setTalkativeness(t) / coach.setAutoConversation(b) or `gambit.settings` + coach.applySettings()
 *   dev     — const { MascotPlayground } = await import('./coach/MascotPlayground.tsx')  (#/playground);
 *             it is deliberately NOT re-exported here so it stays out of the main bundle.
 */
export { Mascot, setMascotMouth, MASCOT_VIEWBOX } from './Mascot.tsx';
export type { MascotProps } from './Mascot.tsx';
export { MascotDock } from './MascotDock.tsx';
export type { MascotDockProps } from './MascotDock.tsx';

export { useCoachStore, createCoachStore, INITIAL_COACH_STATE } from './coachStore.ts';
export type { CoachState, CoachStore } from './coachStore.ts';
export {
  coach,
  createCoachController,
  selectVoiceKind,
  selectVoiceChain,
  passesTalkativeness,
  DEFAULT_COACH_TIMINGS,
  CONVERSATION_GOODBYE_RU,
  GAME_SLEEP_BUBBLE_RU,
  VOICE_LIMIT_BUBBLE_RU,
  localDayKey,
} from './coachController.ts';
export type { CoachAsk, CoachController, CoachControllerDeps, CoachGameInfo, CoachPageLifecycle, CoachTimings, StopSpeakingOptions, VoiceChainOptions } from './coachController.ts';
// «Записи» — the pre-recorded voice (docs/voice-clips/SPEC.md, apps/web/src/coach/clips)
export { createBrowserClipVoice, createClipVoice } from './clips/clipVoice.ts';
export type { ClipVoice, ClipVoiceOptions } from './clips/clipVoice.ts';
export { isClipLayer } from './voiceTypes.ts';
export type { ClipExtras, ClipLibraryStatus, ClipPlanInfo, ClipPrewarmHint, ClipSpeakOptions } from './voiceTypes.ts';
export { parseSpokenMove, parsePieceWord, normalizeMoveArgument } from './spokenMove.ts';
export type { SpokenMove } from './spokenMove.ts';
export { CONVERSATION_CAPTIONS, conversationButtonLabel, conversationIsActive, describeVoiceStatus, hintButtonText, VOICE_IDLE_RULE_RU, voiceDailyRuleRu } from './voiceStatus.ts';
export { TEACH_MAX_SENTENCES, teachMaxSentences } from './coachBrief.ts';
export { classifyChildRequest } from './liveProtocol.ts';
export type { ChildRequest } from './liveProtocol.ts';

export { createBrowserTtsVoice, pickRussianVoice, scoreRussianVoice } from './browserTtsVoice.ts';
export type { BrowserTtsOptions, BrowserTtsVoice } from './browserTtsVoice.ts';
export { createOpenAiRealtimeVoice, OPENAI_REALTIME_CALLS_URL } from './realtimeVoice.ts';
export type { OpenAiRealtimeVoice, RealtimeVoiceOptions } from './realtimeVoice.ts';
export { createOpenAiLiveVoice } from './liveVoice.ts';
export type { OpenAiLiveVoice, LiveVoiceOptions } from './liveVoice.ts';
export { createSilentVoice } from './silentVoice.ts';
export type { SilentVoiceOptions } from './silentVoice.ts';
export type { BriefSpeakOptions, CoachVoiceLayer, ConversationalExtras, GestureGated, OpenAiVoiceKind, SayProgress, VoiceKind } from './voiceTypes.ts';

export {
  SETTINGS_STORAGE_KEY,
  DEFAULT_COACH_SETTINGS,
  VOICE_DAILY_LIMIT_CHOICES,
  loadCoachSettings,
  saveCoachSettings,
  getBrowserStorage,
  isTalkativeness,
  isVoiceDailyLimit,
} from './settings.ts';
export type { CoachSettings, SettingsStorage, VoiceDailyLimitMin, VoicePreference } from './settings.ts';
