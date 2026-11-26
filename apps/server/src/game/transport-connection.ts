import { existsSync } from 'node:fs';
import path from 'node:path';
import { Effect, Exit, Scope } from 'effect';
import type { Connection, WowBridge } from '@wisp/wow-bridge';
import type { Packet } from '@wisp/wow-bridge/protocol';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import { errorMessage } from '../errors.ts';
import type { IntegrationState } from '../integrations/integration-state.ts';
import type { SessionState } from '../session-state.ts';
import type { SnapshotGate } from './snapshots.ts';
import type { SlowDownlink } from '@wisp/wow-bridge/transport';

export interface TransportConnectionDependencies {
  state: SessionState;
  bridge: WowBridge['Service'];
  integrationState: Pick<IntegrationState, 'reset'>;
  snapshots: Pick<SnapshotGate, 'invalidate'>;
  capabilitySettings: Pick<CapabilitySettings, 'publish'>;
  /** Packets from the current transport only; a replaced one is ignored. */
  receive: (packet: Packet) => void;
  /** Persist a WoW folder the user picked once its transport has started. */
  saveWow: (wow: string) => Promise<void>;
  changed: () => void;
  isStopping: () => boolean;
}

export interface TransportConnection {
  /** The running transport, if WoW is connected. */
  current(): Connection | undefined;
  /**
   * Run `work` after every earlier transport operation has settled, so
   * connects and disconnects never interleave. A failed earlier operation does
   * not block later ones.
   */
  serialize(work: () => Promise<void>): Promise<void>;
  /** Replace the transport with one for `wow`; call inside `serialize`. */
  connect(wow: string | undefined, save?: boolean): Promise<void>;
  /** Stop the transport and forget the game session; call inside `serialize`. */
  disconnect(): Promise<void>;
  /** Whether the addon has acknowledged a snapshot published while the agent was ready. */
  gameConnected(): boolean;
  logError(error: unknown): void;
}

/** Owns the addon's disk transport: connecting, replacing and disconnecting it. */
export const createTransportConnection = Effect.fnUntraced(function* (
  deps: TransportConnectionDependencies,
): Effect.fn.Return<TransportConnection> {
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const { state, bridge, integrationState, snapshots, capabilitySettings, changed } = deps;
  let transport: Connection | undefined;
  let connectionScope: Scope.Closeable | undefined;
  let transportWork = Promise.resolve();

  function logError(error: unknown) {
    runFork(
      Effect.logError('Game transport failed').pipe(
        Effect.annotateLogs({ event: 'transport.failed', error: errorMessage(error) }),
      ),
    );
  }

  // Logged once per waiting window, not on every 60-second heartbeat.
  const heldOff = new Set<string>();
  function logHeldOff(session: string) {
    if (heldOff.has(session) || heldOff.size >= 32) return;
    heldOff.add(session);
    runFork(
      Effect.logInfo(
        'Another game window is connected; its heartbeat did not take the bridge',
      ).pipe(Effect.annotateLogs({ event: 'transport.heartbeat_held_off' })),
    );
  }

  function logSlowDownlink(report: SlowDownlink) {
    runFork(
      Effect.logInfo(
        report.phase === 'stalled'
          ? 'A reply is taking long to reach the game'
          : 'A slow reply reached the game',
      ).pipe(Effect.annotateLogs({ event: `transport.downlink_${report.phase}`, ...report })),
    );
  }

  async function disconnect() {
    const previous = connectionScope;
    connectionScope = undefined;
    transport = undefined;
    state.activeTransport = '';
    state.firstReadyRevision = 0;
    state.currentCharacterKey = undefined;
    state.routinePresence = undefined;
    state.memoryViewRequest = undefined;
    bridge.requests.cancelAll('The connection to WoW changed. Try again after reconnecting.');
    integrationState.reset();
    snapshots.invalidate();
    changed();
    if (previous) await runPromise(Scope.close(previous, Exit.void));
    await capabilitySettings.publish().catch(logError);
  }

  async function connect(wow: string | undefined, save = false) {
    if (deps.isStopping() || transport?.wow === wow) return;
    await disconnect();
    if (!wow || !existsSync(path.join(wow, 'Interface/AddOns/WispAI/WispAI.toc'))) {
      if (save) throw Error('The Wisp addon is missing from the selected WoW folder.');
      return;
    }
    const scope = Scope.makeUnsafe();
    connectionScope = scope;
    try {
      transport = await runPromise(
        Scope.provide(
          bridge.open({
            wow,
            receive: (packet, connection) => {
              if (connectionScope !== scope) return;
              transport = connection;
              deps.receive(packet);
            },
            onError: logError,
            onHeldOff: logHeldOff,
            onSlowDownlink: logSlowDownlink,
          }),
          scope,
        ),
      );
      if (save) await deps.saveWow(wow);
    } catch (error) {
      await disconnect();
      throw error;
    }
  }

  return {
    current: () => transport,
    serialize(work) {
      const operation = transportWork.catch(() => {}).then(work);
      transportWork = operation;
      return operation;
    },
    connect,
    disconnect,
    gameConnected: () =>
      Boolean(
        state.activeTransport &&
        state.firstReadyRevision &&
        transport &&
        transport.peerRevision >= state.firstReadyRevision,
      ),
    logError,
  };
});
