import { Cause, Context, Effect, Exit, Layer, Logger, ManagedRuntime, Queue, Stream } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { v7 as uuidv7 } from 'uuid';
import { EngineConfig, type EngineHost } from './host/engine-config.ts';
import * as Capabilities from './host/capabilities.ts';
import * as Mcp from './integrations/mcp-tools.ts';
import { SessionModels } from './models/session-models.ts';
import { compactHistory } from './execution/compaction.ts';
import {
  CompactionFailed,
  ModelError,
  errorText,
  turnCause,
  type HostError,
  type TurnError,
} from './execution/engine-errors.ts';
import { runTurn } from './execution/turn.ts';
import type { Emit, EngineEvent } from './execution/turn-events.ts';
import type { TurnInput } from './execution/turn-input.ts';
import { SessionHistory, type HistoryError, type HistoryStore } from './session/session-history.ts';
import { TurnToolbox } from './tools/turn-toolbox.ts';
import * as Wisp from './wisp/wisp-agent.ts';

export type { ModelMessage } from 'ai';
export { EngineConfig, type EngineHost } from './host/engine-config.ts';
export { Mcp } from './integrations/mcp-tools.ts';
export { SessionModels, type SelectedModel } from './models/session-models.ts';
export { compactionSplit, estimateTokens } from './execution/compaction.ts';
export {
  CompactionFailed,
  HostError,
  ModelError,
  type TurnError,
} from './execution/engine-errors.ts';
export type { EngineEvent } from './execution/turn-events.ts';
export type { TurnInput } from './execution/turn-input.ts';
export { stepUsage } from './execution/usage.ts';
export type { ReplayTarget } from './session/replay.ts';
export {
  HistoryError,
  SessionHistory,
  type HistoryStore,
  type LoadedHistory,
  type LoggedMessage,
  type SessionStart,
  type StoredRow,
  type TokenUsage,
} from './session/session-history.ts';
export {
  FORMAT as SESSION_FORMAT,
  type Compaction,
  type ContextBlock,
  type Entry,
  type HistoryLine,
  type Message,
  type StoredMessage,
} from './session/session-message.ts';
export { TurnToolbox, type TurnTools } from './tools/turn-toolbox.ts';
export { TOOL_CALL, TOOL_SEARCH, searchTools, type ToolStubOutcome } from './tools/turn-tools.ts';
export { WispAgent } from './wisp/wisp-agent.ts';

export interface EngineResult {
  status: 'completed' | 'failed' | 'cancelled';
  error?: { message?: string };
  /** For a failed model call, how it failed (`ModelError`). */
  reason?: ModelError['reason'];
}

export interface EngineOptions extends EngineHost {
  history: HistoryStore;
  /** Hosts can supply their own Effect logging layer; otherwise the engine is silent. */
  logging?: Layer.Layer<never>;
}

/** A program's events as a stream that ends with it, or fails with its error. */
const eventStream = <E>(program: (emit: Emit) => Effect.Effect<unknown, E>) =>
  Stream.callback<EngineEvent, E>((queue) =>
    Queue.into(queue)(program((event) => Queue.offer(queue, event))),
  );

/** The agent: runs a session's turns and compactions as event streams. */
export class AgentEngine extends Context.Service<
  AgentEngine,
  {
    /** Loads instructions and skills ahead of the first turn. */
    readonly preload: Effect.Effect<void, HostError>;
    readonly send: (
      session: string,
      chatId: string,
      input: TurnInput,
    ) => Stream.Stream<EngineEvent, TurnError>;
    /** Summarizes a session's older history now, as a long one would be before its next turn. */
    readonly compact: (session: string) => Stream.Stream<EngineEvent, TurnError | CompactionFailed>;
    readonly end: (session: string) => Effect.Effect<void, HistoryError>;
  }
>()('@wisp/agent/AgentEngine') {
  static readonly layer = Layer.effect(
    AgentEngine,
    Effect.gen(function* () {
      const { stub } = yield* EngineConfig;
      const history = yield* SessionHistory;
      const wisp = yield* Wisp.WispAgent;
      const models = yield* SessionModels;
      const toolbox = yield* TurnToolbox;
      const turnDependencies = { stub, history, wisp, models, toolbox };

      const compactNow = Effect.fn('AgentEngine.compactNow')(function* (
        session: string,
        emit: Emit,
      ) {
        const selected = yield* models.selected(session);
        const model = models.model(session, selected, false);
        const loaded = yield* history.load(session);
        if (!(yield* compactHistory(history, session, loaded, model, selected.model, emit))) {
          return yield* new CompactionFailed();
        }
      });

      return AgentEngine.of({
        preload: Effect.asVoid(wisp.content),
        send: (session, chatId, input) =>
          eventStream((emit) => runTurn(turnDependencies, session, chatId, input, emit)),
        compact: (session) => eventStream((emit) => compactNow(session, emit)),
        end: (session) => history.delete(session),
      });
    }),
  );
}

/** Completes when `signal` aborts. */
const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const abort = () => resume(Effect.void);
    signal.addEventListener('abort', abort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', abort));
  });

/**
 * The engine for a host that does not run Effect (the bridge, tests and
 * evals): promises, and turns as an event iterable plus a result. Every turn's
 * cancellation enters here, as an AbortSignal that interrupts its stream.
 */
export function createAgentEngine(options: EngineOptions) {
  const { history, logging = Logger.layer([]), ...host } = options;
  const runtime = ManagedRuntime.make(
    AgentEngine.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          SessionHistory.layer(history),
          Wisp.layer,
          SessionModels.layer,
          TurnToolbox.layer.pipe(Layer.provide(Mcp.layer)),
        ),
      ),
      Layer.provide(Capabilities.layerFromFile(host.capabilitiesFile)),
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(Layer.succeed(EngineConfig, EngineConfig.of(host))),
      Layer.provideMerge(logging),
    ),
  );

  function settled(exit: Exit.Exit<unknown, unknown>, signal: AbortSignal): EngineResult {
    if (signal.aborted || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))) {
      return { status: 'cancelled' };
    }
    if (Exit.isSuccess(exit)) {
      return { status: 'completed' };
    }
    const failure = Cause.squash(exit.cause);
    const error = turnCause(failure);
    return {
      status: 'failed',
      error: error instanceof Error ? error : { message: errorText(error) },
      ...(failure instanceof ModelError ? { reason: failure.reason } : {}),
    };
  }

  /** A stream's events until it ends; the result settles with its exit. */
  function run(
    signal: AbortSignal,
    stream: Stream.Stream<EngineEvent, TurnError | CompactionFailed, AgentEngine>,
  ) {
    let settle!: (result: EngineResult) => void;
    const result = new Promise<EngineResult>((resolve) => {
      settle = resolve;
    });
    const settling = stream.pipe(
      Stream.interruptWhen(aborted(signal)),
      Stream.onExit((exit) => {
        const result = settled(exit, signal);
        settle(result);
        return result.status === 'failed'
          ? Effect.logWarning('Agent turn failed').pipe(
              Effect.annotateLogs({
                event: 'agent.turn_failed',
                ...(result.reason ? { reason: result.reason } : {}),
                error: errorText(result.error),
              }),
            )
          : Effect.void;
      }),
      Stream.catchCause(() => Stream.empty),
    );
    async function* events() {
      let context: Context.Context<AgentEngine>;
      try {
        context = await runtime.context();
      } catch (error) {
        settle(settled(Exit.die(error), signal));
        return;
      }
      yield* Stream.toAsyncIterableWith(context)(settling);
    }
    return { events: events(), result };
  }

  return {
    newSessionId: (): string => uuidv7(),
    preload: () => runtime.runPromise(Effect.flatMap(AgentEngine, (engine) => engine.preload)),
    /** Starts a turn; events stream once and the result settles when they end. */
    send: (session: string, input: TurnInput, signal: AbortSignal, chatId: string) =>
      run(
        signal,
        Stream.unwrap(Effect.map(AgentEngine, (engine) => engine.send(session, chatId, input))),
      ),
    compact: (session: string, signal: AbortSignal) =>
      run(signal, Stream.unwrap(Effect.map(AgentEngine, (engine) => engine.compact(session)))),
    end: (session: string) =>
      runtime.runPromise(Effect.flatMap(AgentEngine, (engine) => engine.end(session))),
    /** Closes MCP connections and everything else the engine holds. */
    close: () => runtime.dispose(),
  };
}
