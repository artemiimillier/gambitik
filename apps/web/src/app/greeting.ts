/**
 * The spoken hello of Гамбитик. Browsers block audio until the first click or key press, and the
 * coach drops phrases that waited too long behind that lock — so the shell itself waits until the
 * coach is ready AND sound is unlocked, and only then says the greeting (once per app start).
 *
 * The check runs inside the store subscription, i.e. synchronously within the unlocking click,
 * so the greeting is queued before anything else that click may trigger.
 */
import type { CoachEvent } from '@gambit/shared';
import { withShellTwin } from '../coach/clips/shellTwin.ts';
import type { ShellLine } from '../coach/clips/shellTwin.ts';

export interface GreetingCoachState {
  ready: boolean;
  needsUserGesture: boolean;
}

export interface GreetingStore {
  getState(): GreetingCoachState;
  subscribe(listener: (state: GreetingCoachState) => void): () => void;
}

export interface ScheduleGreetingDeps {
  store: GreetingStore;
  say(event: CoachEvent): Promise<void> | void;
  /** built lazily so the hour and the nickname are those of the moment he actually speaks */
  buildEvent(): CoachEvent;
}

/** Returns a cancel function (no-op once the greeting was said). */
export function scheduleGreeting(deps: ScheduleGreetingDeps): () => void {
  let done = false;
  let unsubscribe: (() => void) | null = null;

  const finish = (): void => {
    done = true;
    unsubscribe?.();
    unsubscribe = null;
  };

  const attempt = (state: GreetingCoachState): void => {
    if (done || !state.ready || state.needsUserGesture) return;
    finish();
    void deps.say(deps.buildEvent());
  };

  unsubscribe = deps.store.subscribe(attempt);
  if (done) finish(); // said synchronously by a subscribe-time callback
  attempt(deps.store.getState());

  return finish;
}

let shellEventCounter = 0;

/**
 * A short ready-made phrase of the shell (wizard chatter, onboarding questions). `text` must carry no Latin letters.
 * `lines`: the catalogue's `shell.*` lines that say exactly `text`, one per sentence — its clip twin, so «Записи» can
 * say it and record it on first use (../coach/clips/shellTwin.ts); without them the text is compiled (planned by fragments).
 */
export function shellCoachEvent(init: Pick<CoachEvent, 'kind' | 'priority' | 'pose' | 'text'> & { bubbleText?: string; lines?: readonly (string | ShellLine)[] }): CoachEvent {
  shellEventCounter += 1;
  const event: CoachEvent = {
    id: `shell-${Date.now().toString(36)}-${shellEventCounter}`,
    kind: init.kind,
    priority: init.priority,
    text: init.text,
    bubbleText: init.bubbleText ?? init.text,
    pose: init.pose,
    pauseClock: false,
  };
  return init.lines ? withShellTwin(event, init.lines) : event;
}
