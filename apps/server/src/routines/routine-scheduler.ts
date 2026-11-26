import { Effect, Schedule } from 'effect';
import type { SessionState } from '../session-state.ts';
import type { Chat } from '../chat/events.ts';
import { RoutineStore, type ClaimedRoutine } from './routine-store.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import { newChat } from '../chat/chat-lifecycle.ts';
import { errorMessage } from '../errors.ts';
import { endedOnUsageLimit } from '../agent/turn-runner.ts';
import { createRoutineGate, routineFingerprint } from './routine-gate.ts';

interface SchedulerDependencies {
  state: SessionState;
  capabilitySettings: CapabilitySettings;
  isStopping: () => boolean;
  isReady: () => boolean;
  run: (chat: Chat, text: string, messageId?: string, context?: unknown) => Promise<void>;
  changed: () => void;
  /** Whether a finished routine chat failed on a usage limit; tests replace it. */
  usageLimited?: (chat: Chat) => boolean;
}

const TICK = '3 seconds';

type Presence = NonNullable<SessionState['routinePresence']>;

const runStatus = (chat: Chat) =>
  chat.status === 'interrupted'
    ? 'interrupted'
    : chat.status === 'error'
      ? 'error'
      : chat.status === 'cancelled'
        ? 'cancelled'
        : chat.tipSkipped
          ? 'no_tip'
          : 'done';

const prompt = ({ routine, event, previous }: ClaimedRoutine) =>
  'Run this user-requested routine as read-only advice. Verify current state; the event may have been delayed. Routine instruction: ' +
  routine.instruction +
  '\nTrigger data: ' +
  JSON.stringify(event) +
  '\nPrevious recommendations (historical, not current state): ' +
  JSON.stringify(previous);

/**
 * Every few seconds, runs the routine that is due for the character in game,
 * one at a time and only while the player is idle in a ready session. Runs in
 * the caller's scope: closing it lets a routine that already started finish.
 */
export const startRoutineScheduler = Effect.fnUntraced(function* (deps: SchedulerDependencies) {
  const routines = yield* RoutineStore;
  const { state, capabilitySettings, isStopping, isReady, changed } = deps;
  const usageLimited = deps.usageLimited ?? endedOnUsageLimit;
  const gate = createRoutineGate();

  const presentPlayer = (): Presence | undefined => {
    if (
      gate.paused() ||
      isStopping() ||
      !isReady() ||
      !capabilitySettings.enabled('tool:manage_routine') ||
      state.chats.some((chat) => chat.status === 'working')
    ) {
      return undefined;
    }
    const presence = state.routinePresence;
    return presence?.ready &&
      presence.session === state.activeTransport &&
      presence.identity === state.currentCharacterKey &&
      Date.now() - presence.at <= 45000
      ? presence
      : undefined;
  };

  // The claimed routine is still the one the player saved, and nothing else runs.
  const stillCurrent = Effect.fnUntraced(function* (
    presence: Presence,
    claimed: ClaimedRoutine,
    chat: Chat,
  ) {
    if (
      presence.session !== state.activeTransport ||
      state.chats.some((other) => other !== chat && other.status === 'working') ||
      !state.routinePresence?.ready ||
      !capabilitySettings.enabled('tool:manage_routine')
    ) {
      return false;
    }
    return (yield* routines.list(presence.identity)).some(
      (routine) =>
        routine.id === claimed.routine.id &&
        routine.enabled &&
        routine.updatedAt === claimed.routine.updatedAt,
    );
  });

  const dispatch = Effect.fn('RoutineScheduler.dispatch')(function* (presence: Presence) {
    const claimed = yield* routines.claim(presence.identity);
    if (!claimed) {
      return;
    }
    if (isStopping()) {
      return yield* routines.defer(claimed.run.id, claimed.event);
    }
    const fingerprint = routineFingerprint(presence.context, state.questRevision);
    const quietKey = JSON.stringify([
      presence.identity,
      claimed.routine.id,
      claimed.routine.updatedAt,
    ]);
    if (gate.unchanged(quietKey, claimed.event.event, fingerprint)) {
      return yield* routines.skip(claimed.run.id);
    }
    const chat = newChat(claimed.run.id, state.activeTransport);
    state.chats.push(chat);
    chat.routineId = claimed.routine.id;
    chat.proactive = true;
    chat.titleGenerated = true;
    chat.title = claimed.routine.title + ' · ' + new Date(claimed.run.startedAt).toLocaleString();
    if (!(yield* stillCurrent(presence, claimed, chat))) {
      state.chats = state.chats.filter((other) => other !== chat);
      return yield* routines.defer(chat.id, claimed.event);
    }
    yield* Effect.tryPromise({
      try: () => deps.run(chat, prompt(claimed), undefined, presence.context),
      catch: (error) => error,
    });
    const summary = chat.messages
      .filter((message) => message.role === 'assistant' || message.role === 'system')
      .map((message) => message.text)
      .join('\n');
    const status = runStatus(chat);
    gate.finished(quietKey, status, fingerprint, status === 'error' && usageLimited(chat));
    yield* routines.finish(chat.id, status, summary);
  });

  const tick = Effect.suspend(() => {
    const presence = presentPlayer();
    return presence
      ? dispatch(presence).pipe(
          Effect.catch((error) =>
            Effect.logError('Routine dispatch failed').pipe(
              Effect.annotateLogs({ event: 'routine.dispatch_failed', error: errorMessage(error) }),
            ),
          ),
          // A routine that started finishes even when the scheduler stops.
          Effect.uninterruptible,
          Effect.ensuring(Effect.sync(changed)),
        )
      : Effect.void;
  });

  // Ticks keep a fixed rhythm; a routine that outlasts one is followed by the next tick at once.
  yield* Effect.sleep(TICK).pipe(
    Effect.andThen(tick.pipe(Effect.repeat(Schedule.fixed(TICK)))),
    Effect.forkScoped,
  );
});
