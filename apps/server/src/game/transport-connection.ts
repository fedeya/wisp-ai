import { Effect, Exit, FileSystem, Path, Scope, Semaphore, Stream } from 'effect';
import type { Connection, GameCall, GameEvent, WowBridge } from '@wisp/wow-bridge';
import type { CapabilitySettings, IntegrationState } from '#/capabilities';
import { errorMessage } from '../errors.ts';
import { SessionState } from '#/session';

export interface TransportConnectionDependencies {
  bridge: WowBridge['Service'];
  integrationState: Pick<IntegrationState['Service'], 'reset'>;
  capabilitySettings: Pick<CapabilitySettings['Service'], 'publish'>;
  /** Packets from the current transport only; a replaced one is ignored. */
  receive: (event: GameEvent) => Effect.Effect<void>;
  /** Persist a WoW folder the user picked once its transport has started. */
  saveWow: (wow: string) => Promise<void>;
  isStopping: () => boolean;
}

export interface TransportConnection {
  /** The running transport, if WoW is connected. */
  current(): Connection | undefined;
  request(call: GameCall): Effect.Effect<unknown, Error>;
  /**
   * Run `work` after every earlier transport operation has settled, so
   * connects and disconnects never interleave. A failed earlier operation does
   * not block later ones.
   */
  serialize<E>(work: Effect.Effect<void, E>): Effect.Effect<void, E>;
  /** Replace the transport with one for `wow`; call inside `serialize`. */
  connect(wow: string | undefined, save?: boolean): Effect.Effect<void, unknown>;
  /** Stop the transport and forget the game session; call inside `serialize`. */
  disconnect: Effect.Effect<void>;
  /** Whether the addon has acknowledged a snapshot published while the agent was ready. */
  gameConnected: Effect.Effect<boolean>;
  logError(error: unknown): void;
}

/** Owns the addon's disk transport: connecting, replacing and disconnecting it. */
export const createTransportConnection = Effect.fnUntraced(function* (
  deps: TransportConnectionDependencies,
): Effect.fn.Return<TransportConnection, never, FileSystem.FileSystem | Path.Path | SessionState> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const session = yield* SessionState;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const { bridge, integrationState, capabilitySettings } = deps;
  let transport: Connection | undefined;
  let wowDirectory: string | undefined;
  let connectionScope: Scope.Closeable | undefined;
  const transportLock = yield* Semaphore.make(1);

  function logError(error: unknown) {
    runFork(
      Effect.logError('Game transport failed').pipe(
        Effect.annotateLogs({ event: 'transport.failed', error: errorMessage(error) }),
      ),
    );
  }

  const disconnect = Effect.gen(function* () {
    const previous = connectionScope;
    connectionScope = undefined;
    transport = undefined;
    wowDirectory = undefined;
    yield* session.stage((state) => ({
      ...state,
      activeTransport: '',
      currentCharacterKey: undefined,
      routinePresence: undefined,
      memoryViewRequest: undefined,
    }));
    yield* integrationState.reset;
    yield* session.commit;
    if (previous) yield* Scope.close(previous, Exit.void);
    yield* capabilitySettings.publish.pipe(
      Effect.catch((error) => Effect.sync(() => logError(error))),
    );
  });

  const connect = Effect.fnUntraced(function* (wow: string | undefined, save = false) {
    if (deps.isStopping() || wowDirectory === wow) return;
    yield* disconnect;
    if (
      !wow ||
      !(yield* fs
        .exists(path.join(wow, 'Interface', 'AddOns', 'WispAI', 'WispAI.toc'))
        .pipe(Effect.orElseSucceed(() => false)))
    ) {
      if (save) {
        return yield* Effect.fail(Error('The Wisp addon is missing from the selected WoW folder.'));
      }
      return;
    }
    const scope = yield* Scope.make();
    connectionScope = scope;
    yield* Effect.gen(function* () {
      const connection = yield* bridge.open(wow).pipe(Scope.provide(scope));
      transport = connection;
      wowDirectory = wow;
      yield* connection.events.pipe(
        Stream.runForEach((event) =>
          Effect.suspend(() =>
            connectionScope === scope ? deps.receive(event) : Effect.void,
          ).pipe(Effect.catchDefect((error) => Effect.sync(() => logError(error)))),
        ),
        Effect.forkIn(scope, { uninterruptible: false }),
      );
      if (save) yield* Effect.tryPromise({ try: () => deps.saveWow(wow), catch: (error) => error });
    }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? disconnect : Effect.void)));
  });

  return {
    current: () => transport,
    request: (call) =>
      Effect.suspend(
        () =>
          transport?.request(call) ?? Effect.fail(Error('No active connection for this character')),
      ),
    serialize: (work) => transportLock.withPermit(Effect.uninterruptible(work)),
    connect,
    disconnect,
    gameConnected: Effect.map(session.get, (state) => {
      const status = transport?.status();
      return Boolean(status?.ready && status.session === state.activeTransport);
    }),
    logError,
  };
});
