import type { SessionState } from '../session-state.ts';
import type { Chat } from '../chat/events.ts';
import type { RoutineStore } from './routine-store.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import { newChat } from '../chat/chat-lifecycle.ts';
import { errorMessage } from '../errors.ts';
import { endedOnUsageLimit } from '../agent/turn-runner.ts';
import { createRoutineGate, routineFingerprint } from './routine-gate.ts';
import { bridgeRuntime, type Logger } from '../logger.ts';
import { Effect, Fiber } from 'effect';

/** How often the scheduler checks for a due routine. */
const CHECK_INTERVAL = '3 seconds';
interface SchedulerDependencies {
  state: SessionState;
  routineStore: RoutineStore;
  capabilitySettings: CapabilitySettings;
  isStopping: () => boolean;
  isReady: () => boolean;
  run: (chat: Chat, text: string, messageId?: string, context?: unknown) => Promise<void>;
  changed: () => void;
  logger: Pick<Logger, 'error'>;
  /** Whether a finished routine chat failed on a usage limit; tests replace it. */
  usageLimited?: (chat: Chat) => boolean;
}
export function startRoutineScheduler(deps: SchedulerDependencies) {
  const { state, routineStore, capabilitySettings, isStopping, isReady, run, changed, logger } =
    deps;
  const createChat = (id: string) => {
    const chat = newChat(id, state.activeTransport);
    state.chats.push(chat);
    return chat;
  };
  const gate = createRoutineGate();
  // The routine that is due now, if the player is present and nothing else runs.
  const due = () => {
    if (
      gate.paused() ||
      isStopping() ||
      !isReady() ||
      !capabilitySettings.enabled('tool:manage_routine') ||
      state.chats.some((c) => c.status === 'working')
    ) {
      return;
    }
    const presence = state.routinePresence;
    if (
      !presence?.ready ||
      presence.session !== state.activeTransport ||
      presence.identity !== state.currentCharacterKey ||
      Date.now() - presence.at > 45000
    ) {
      return;
    }
    return presence;
  };
  const dispatch = async (presence: NonNullable<ReturnType<typeof due>>) => {
    const claimed = await routineStore.claim(presence.identity);
    if (!claimed) {
      return;
    }
    if (isStopping()) {
      await routineStore.defer(claimed.run.id, claimed.event);
      return;
    }
    const fingerprint = routineFingerprint(presence.context, state.questRevision);
    const quietKey = JSON.stringify([
      presence.identity,
      claimed.routine.id,
      claimed.routine.updatedAt,
    ]);
    if (gate.unchanged(quietKey, claimed.event.event, fingerprint)) {
      await routineStore.skip(claimed.run.id);
      return;
    }
    const chat = createChat(claimed.run.id);
    chat.routineId = claimed.routine.id;
    chat.proactive = true;
    chat.titleGenerated = true;
    chat.title = claimed.routine.title + ' · ' + new Date(claimed.run.startedAt).toLocaleString();
    if (
      presence.session !== state.activeTransport ||
      state.chats.some((c) => c !== chat && c.status === 'working') ||
      !state.routinePresence?.ready ||
      !capabilitySettings.enabled('tool:manage_routine') ||
      !routineStore
        .list(presence.identity)
        .some(
          (r) =>
            r.id === claimed.routine.id && r.enabled && r.updatedAt === claimed.routine.updatedAt,
        )
    ) {
      state.chats = state.chats.filter((c) => c !== chat);
      await routineStore.defer(chat.id, claimed.event);
      return;
    }
    await run(
      chat,
      'Run this user-requested routine as read-only advice. Verify current state; the event may have been delayed. Routine instruction: ' +
        claimed.routine.instruction +
        '\nTrigger data: ' +
        JSON.stringify(claimed.event) +
        '\nPrevious recommendations (historical, not current state): ' +
        JSON.stringify(claimed.previous),
      undefined,
      presence.context,
    );
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
    gate.finished(
      quietKey,
      status,
      fingerprint,
      status === 'error' && (deps.usageLimited ?? endedOnUsageLimit)(chat),
    );
    await routineStore.finish(chat.id, status, summary);
  };
  // A dispatch runs to the end before the next check, and stopping waits for
  // it instead of interrupting a routine turn.
  const check = Effect.suspend(() => {
    const presence = due();
    return presence
      ? Effect.promise(() =>
          dispatch(presence).catch((error) =>
            logger.error(
              { event: 'routine.dispatch_failed', error: errorMessage(error) },
              'Routine dispatch failed',
            ),
          ),
        ).pipe(Effect.ensuring(Effect.sync(changed)), Effect.uninterruptible)
      : Effect.void;
  });
  // The next check comes one interval after the previous one, or after the
  // routine it dispatched finished.
  const fiber = bridgeRuntime.runFork(
    Effect.forever(Effect.sleep(CHECK_INTERVAL).pipe(Effect.andThen(check))),
  );
  return async () => {
    await bridgeRuntime.runPromise(Fiber.interrupt(fiber));
  };
}
