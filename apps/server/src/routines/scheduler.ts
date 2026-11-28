// @effect-migrated allow=effectPromises: RoutineStore answers with Promises until the SQL repositories migrate
import { Clock, Duration, Effect, FiberHandle, Schedule, Schema } from 'effect';
import { CapabilitySettings } from '#/capabilities';
import { SessionState } from '#/session';
import type { RoutinePresence } from '#/session';
import { TurnRunner } from '#/turns';
import { newChat } from '../chat/chat-lifecycle.ts';
import { errorMessage } from '../errors.ts';
import { createRoutineGate, routineFingerprint } from './routine-gate.ts';
import type { RoutineStore } from './routine-store.ts';

/** How often the scheduler looks for a routine that is due. */
const TICK_INTERVAL = Duration.seconds(3);

/** How long the addon's routine presence counts as current. */
const PRESENCE_TTL_MS = 45_000;

/** The routine store failed with `cause`. */
class RoutineStoreFailed extends Schema.TaggedError<RoutineStoreFailed>()('RoutineStoreFailed', {
  cause: Schema.Defect(),
}) {}

const stored = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (cause) => new RoutineStoreFailed({ cause }) });

const logDispatchFailure = (error: unknown) =>
  Effect.logError('Routine dispatch failed').pipe(
    Effect.annotateLogs({ event: 'routine.dispatch_failed', error: errorMessage(error) }),
  );

/**
 * Runs the routines that are due as read-only turns, one at a time, while
 * the character the addon reports is ready for them. A tick every 3 seconds,
 * on the windows a `setInterval` would fire in, looks for one; while a
 * routine runs no tick starts another. Closing the scope stops the ticks
 * after the routine that is running has finished.
 */
export const start = Effect.fn('RoutineScheduler.start')(function* (routineStore: RoutineStore) {
  const session = yield* SessionState;
  const capabilities = yield* CapabilitySettings;
  const turns = yield* TurnRunner;
  const gate = createRoutineGate();

  const dispatch = Effect.fnUntraced(function* (presence: RoutinePresence) {
    const claimedAt = yield* Clock.currentTimeMillis;
    const claimed = yield* stored(() => routineStore.claim(presence.identity, claimedAt));
    if (!claimed) {
      return;
    }
    if (!(yield* turns.accepting)) {
      yield* stored(() => routineStore.defer(claimed.run.id, claimed.event));
      return;
    }
    const fingerprint = routineFingerprint(presence.context, (yield* session.get).questRevision);
    const quietKey = JSON.stringify([
      presence.identity,
      claimed.routine.id,
      claimed.routine.updatedAt,
    ]);
    if (
      gate.unchanged(quietKey, claimed.event.event, fingerprint, yield* Clock.currentTimeMillis)
    ) {
      yield* stored(() => routineStore.skip(claimed.run.id));
      return;
    }
    const chat = newChat(
      claimed.run.id,
      (yield* session.get).activeTransport,
      yield* Clock.currentTimeMillis,
    );
    // Staged: the turn that runs it tells the subscribers as it begins.
    yield* session.stage((state) => ({ ...state, chats: [...state.chats, chat] }));
    chat.routineId = claimed.routine.id;
    chat.proactive = true;
    chat.titleGenerated = true;
    chat.title = claimed.routine.title + ' · ' + new Date(claimed.run.startedAt).toLocaleString();
    const current = yield* session.get;
    const due =
      presence.session === current.activeTransport &&
      !current.chats.some((c) => c !== chat && c.status === 'working') &&
      !!current.routinePresence?.ready &&
      (yield* capabilities.enabled('tool:manage_routine')) &&
      routineStore
        .list(presence.identity)
        .some(
          (r) =>
            r.id === claimed.routine.id && r.enabled && r.updatedAt === claimed.routine.updatedAt,
        );
    if (!due) {
      yield* session.stage((state) => ({
        ...state,
        chats: state.chats.filter((c) => c !== chat),
      }));
      yield* stored(() => routineStore.defer(chat.id, claimed.event));
      return;
    }
    yield* turns.run({
      chat,
      text:
        'Run this user-requested routine as read-only advice. Verify current state; the event may have been delayed. Routine instruction: ' +
        claimed.routine.instruction +
        '\nTrigger data: ' +
        JSON.stringify(claimed.event) +
        '\nPrevious recommendations (historical, not current state): ' +
        JSON.stringify(claimed.previous),
      context: presence.context,
    });
    const summary = chat.messages
      .filter((m) => m.role === 'assistant' || m.role === 'system')
      .map((m) => m.text)
      .join('\n');
    const status =
      chat.status === 'interrupted'
        ? 'interrupted'
        : chat.status === 'error'
          ? 'error'
          : chat.status === 'cancelled'
            ? 'cancelled'
            : chat.tipSkipped
              ? 'no_tip'
              : 'done';
    const finishedAt = yield* Clock.currentTimeMillis;
    gate.finished(
      quietKey,
      status,
      fingerprint,
      status === 'error' && (yield* turns.endedOnUsageLimit(chat)),
      finishedAt,
    );
    yield* stored(() => routineStore.finish(chat.id, status, summary, finishedAt));
  });

  const tick = Effect.gen(function* () {
    const state = yield* session.get;
    const now = yield* Clock.currentTimeMillis;
    if (
      gate.paused(now) ||
      !(yield* turns.accepting) ||
      !(yield* capabilities.enabled('tool:manage_routine')) ||
      state.chats.some((c) => c.status === 'working')
    ) {
      return;
    }
    const presence = state.routinePresence;
    if (
      !presence?.ready ||
      presence.session !== state.activeTransport ||
      presence.identity !== state.currentCharacterKey ||
      now - presence.at > PRESENCE_TTL_MS
    ) {
      return;
    }
    // A dispatch that started finishes, so its claimed run is never left running.
    yield* dispatch(presence).pipe(
      Effect.catch(logDispatchFailure),
      Effect.catchDefect(logDispatchFailure),
      // The routine's run and its chat changed.
      Effect.ensuring(session.commit),
      Effect.uninterruptible,
    );
  });

  const loop = yield* FiberHandle.make();
  yield* FiberHandle.run(loop, tick.pipe(Effect.schedule(Schedule.windowed(TICK_INTERVAL))));
});
