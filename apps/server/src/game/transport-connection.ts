import { existsSync } from 'node:fs';
import path from 'node:path';
import { Effect } from 'effect';
import type { Packet } from '../wow-bridge/protocol.ts';
import type { CapabilitySettings } from '../integrations/capabilities.ts';
import { errorMessage } from '../errors.ts';
import type { GameRequests } from '../wow-bridge/game-requests.ts';
import type { IntegrationState } from '../integrations/integration-state.ts';
import type { SessionState } from '../session-state.ts';
import type { SnapshotGate } from '../wow-bridge/snapshots.ts';
import { DiskTransport, type SlowDownlink } from '../wow-bridge/transport.ts';

export interface TransportConnectionDependencies {
  state: SessionState;
  pending: Pick<GameRequests, 'cancelAll'>;
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
  current(): DiskTransport | undefined;
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
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const { state, pending, integrationState, snapshots, capabilitySettings, changed } = deps;
  let transport: DiskTransport | undefined;
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
    const previous = transport;
    transport = undefined;
    state.activeTransport = '';
    state.firstReadyRevision = 0;
    state.currentCharacterKey = undefined;
    state.routinePresence = undefined;
    state.memoryViewRequest = undefined;
    pending.cancelAll('The connection to WoW changed. Try again after reconnecting.');
    integrationState.reset();
    snapshots.invalidate();
    changed();
    await previous?.stop();
    await capabilitySettings.publish().catch(logError);
  }

  async function connect(wow: string | undefined, save = false) {
    if (deps.isStopping() || transport?.wow === wow) return;
    await disconnect();
    if (!wow || !existsSync(path.join(wow, 'Interface/AddOns/WispAI/WispAI.toc'))) {
      if (save) throw Error('The Wisp addon is missing from the selected WoW folder.');
      return;
    }
    const next = new DiskTransport(
      wow,
      (packet) => {
        if (transport === next) deps.receive(packet);
      },
      logError,
      logHeldOff,
      logSlowDownlink,
    );
    transport = next;
    try {
      await next.start();
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
