import { streamText } from 'ai';
import { Cause, Deferred, Effect, Exit, Stream, type Scope } from 'effect';
import { COMPACTION_THRESHOLD } from '../contract/context-usage.ts';
import type { EngineConfig } from '../host/engine-config.ts';
import type { SessionModels } from '../models/session-models.ts';
import type { ReplayTarget } from '../session/replay.ts';
import type { HistoryError, SessionHistory } from '../session/session-history.ts';
import type { Message } from '../session/session-message.ts';
import { StepDraft, stepMessage } from '../session/session-step.ts';
import type { TurnToolbox } from '../tools/turn-toolbox.ts';
import { assembleTools, turnOptions } from '../tools/turn-tools.ts';
import type { WispAgent } from '../wisp/wisp-agent.ts';
import { compactHistory, estimateTokens } from './compaction.ts';
import { errorText, modelError, turnCause, type TurnError } from './engine-errors.ts';
import { TurnEvents, type Emit } from './turn-events.ts';
import { turnEntries, turnPrompt, type TurnInput } from './turn-input.ts';
import { logTokens, recordUsage, stepUsage } from './usage.ts';

interface TurnDependencies {
  stub: EngineConfig['Service']['stub'];
  calls: EngineConfig['Service']['calls'];
  history: SessionHistory['Service'];
  wisp: WispAgent['Service'];
  models: SessionModels['Service'];
  toolbox: TurnToolbox['Service'];
}

/**
 * A signal that aborts when the current scope closes, for work that outlives
 * one promise: the model stream and the tools it runs.
 */
const scopeSignal = Effect.acquireRelease(
  Effect.sync(() => new AbortController()),
  (controller) => Effect.sync(() => controller.abort()),
).pipe(Effect.map((controller) => controller.signal));

// One turn: prepare, maybe compact, then the AI SDK tool loop until the model
// stops calling tools, a tool ends the turn, or the step budget runs out.
export const runTurn = Effect.fn('AgentEngine.turn')(function* (
  { stub, calls, history, wisp, models, toolbox }: TurnDependencies,
  session: string,
  chatId: string,
  input: TurnInput,
  emit: Emit,
): Effect.fn.Return<void, TurnError, Scope.Scope> {
  const content = yield* wisp.content;
  const selected = yield* models.selected(session);
  yield* history.begin(session, { chatId, model: selected.model });
  const tools = yield* toolbox.tools(session);
  const model = models.model(session, selected, true);
  yield* emit({ type: 'turn.started', data: {} });
  // The player's input, as replayable history consumes it (rebuildHistory).
  yield* emit({
    type: 'delivery.consumed',
    data: { parts: [{ kind: 'text', text: input.text }] },
  });

  const target: ReplayTarget = {
    model: selected.model,
    provider: selected.provider,
    modelId: selected.modelId,
  };
  const stored = (messages: readonly Message[]) =>
    messages.map((message) => ({ message, model: selected.model }));
  let loaded = yield* history.load(session);
  if (
    selected.contextWindow &&
    estimateTokens(turnPrompt(loaded, target, stored(turnEntries(input, tools.memory, loaded)))) >
      selected.contextWindow * COMPACTION_THRESHOLD
  ) {
    yield* compactHistory(history, session, loaded, model, selected.model, emit);
    loaded = yield* history.load(session);
  }
  const entries = turnEntries(input, tools.memory, loaded);
  yield* history.append(session, entries, selected.model);

  // The model stream and its tools stop when the turn's scope closes.
  const signal = yield* scopeSignal;
  const assembled = assembleTools({
    session,
    signal,
    calls,
    direct: tools.direct,
    deferred: tools.deferred,
    skills: content.skills,
    stub,
  });
  // Each step is logged when it ends (the loop waits for it), so a cancelled
  // or failed turn keeps the tool calls that already ran. A failed write
  // ends the stream with that error. The step in progress is drafted from
  // the same chunks, in the same order, for a turn that stops mid-step.
  const logFailed = yield* Deferred.make<never, HistoryError>();
  const runStep = Effect.runPromiseWith(yield* Effect.context<never>());
  const draft = new StepDraft();
  const result = streamText({
    model,
    instructions: content.system,
    messages: turnPrompt(loaded, target, stored(entries)),
    tools: assembled.tools,
    abortSignal: signal,
    ...turnOptions(tools.direct, selected),
    onStepStart: () => draft.start(Date.now()),
    onChunk: ({ chunk }) => draft.read(chunk),
    onStepEnd: (step) => {
      const message = stepMessage(step.response.messages, {
        finish: step.finishReason,
        tokens: logTokens(stepUsage(step.usage)),
        created: draft.startedAt,
        completed: Date.now(),
      });
      draft.start(Date.now());
      return runStep(
        history.append(session, [message], selected.model).pipe(
          Effect.catch((error) => Deferred.fail(logFailed, error)),
          Effect.asVoid,
        ),
      );
    },
  });
  // A turn that stops mid-step logs what that step had: its text, and its
  // tools as running when they had not finished.
  const logStopped = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> => {
    if (Exit.isSuccess(exit)) return Effect.void;
    const interrupted = Cause.hasInterruptsOnly(exit.cause);
    const stopped = draft.stopped({
      finish: interrupted ? 'interrupted' : 'error',
      ...(interrupted ? {} : { error: errorText(turnCause(Cause.squash(exit.cause))) }),
      completed: Date.now(),
    });
    return stopped
      ? history.append(session, [stopped], selected.model).pipe(
          Effect.catch((error) =>
            Effect.logWarning('The stopped step could not be logged').pipe(
              Effect.annotateLogs({
                event: 'agent.stopped_step_unlogged',
                error: errorText(error.cause),
              }),
            ),
          ),
        )
      : Effect.void;
  };
  const events = new TurnEvents(assembled);
  yield* Stream.fromAsyncIterable(result.fullStream, modelError).pipe(
    Stream.interruptWhen(Deferred.await(logFailed)),
    Stream.runForEach((part): Effect.Effect<void, TurnError> =>
      part.type === 'error'
        ? Effect.fail(modelError(part.error))
        : Effect.andThen(
            part.type === 'finish-step'
              ? recordUsage(history, session, stepUsage(part.usage))
              : Effect.void,
            Effect.forEach(events.read(part), emit, { discard: true }),
          ),
    ),
    Effect.onExit((exit) => logStopped(exit)),
  );
}, Effect.scoped);
