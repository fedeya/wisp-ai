import { Cause, Clock, Context, Effect, FileSystem, Layer, Path, Queue, Ref, Stream } from 'effect';
import type { Scope } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { GameRequests, type GameRequest, type GameTimeout } from './game-requests.ts';
import type { Packet } from './protocol.ts';
import { SnapshotGate } from './snapshots.ts';
import { DiskTransport } from './transport.ts';
import type { SlowDownlink } from './outbound-mailbox.ts';

export type { SlowDownlink } from './outbound-mailbox.ts';

type WireFields =
  | 'nextSlot'
  | 'receivedRev'
  | 'transportVersion'
  | 'mailboxVersion'
  | 'compactAck'
  | 'bulkAvailable';
type ApplicationPacket = Exclude<Packet, { type: 'state_result' }>;
type WithoutWire<P> = P extends Packet ? Omit<P, WireFields> : never;
export type GameEvent = WithoutWire<ApplicationPacket>;

export type GameOperation =
  | { readonly kind: 'read'; readonly sections: string[] }
  | { readonly kind: 'inspect'; readonly inspection: unknown }
  | { readonly kind: 'act'; readonly action: unknown };

export interface GameCall {
  readonly session: string;
  readonly chat: string;
  readonly operation: GameOperation;
  /** Agent requests fail fast while the addon is unresponsive. */
  readonly agent?: boolean;
}

export interface GameView {
  readonly session: string;
  readonly connected: boolean;
  readonly acks: number[];
}

export interface Connection {
  /** An ordered, single-consumer stream of application events from the addon. */
  readonly events: Stream.Stream<GameEvent>;
  readonly request: (call: GameCall) => Effect.Effect<unknown, Error>;
  /** Replace the view for the current game session; intermediate views may be skipped. */
  readonly publish: (view: GameView) => Effect.Effect<void>;
  readonly status: () => {
    readonly session?: string;
    readonly readyPublished: boolean;
    readonly ready: boolean;
  };
}

interface ConnectionOptions {
  readonly onError: (error: unknown) => void;
  readonly onHeldOff: (session: string) => void;
  readonly onSlowDownlink: (report: SlowDownlink) => void;
  readonly onTimeout: (timeout: GameTimeout) => void;
}

export class WowBridge extends Context.Service<
  WowBridge,
  {
    readonly open: (
      wowDirectory: string,
      options: ConnectionOptions,
    ) => Effect.Effect<Connection, PlatformError, Scope.Scope>;
  }
>()('@wisp/wow-bridge/WowBridge') {}

const openConnection = Effect.fn('WowBridge.open')(function* (
  wowDirectory: string,
  options: ConnectionOptions,
) {
  const clock = yield* Clock.Clock;
  const events = yield* Effect.acquireRelease(Queue.bounded<GameEvent>(64), Queue.shutdown);
  const updates = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
  const latestView = yield* Ref.make<GameView | undefined>(undefined);
  const snapshots = new SnapshotGate(clock.currentTimeMillisUnsafe());
  const notify = () => Queue.offerUnsafe(updates, undefined);
  const requests = yield* GameRequests.make(notify, { onTimeout: options.onTimeout });
  let session: string | undefined;
  let closed = false;
  let firstReadyRevision = 0;
  const resultAcks = new Set<number>();

  const disk: DiskTransport = yield* DiskTransport.make(
    wowDirectory,
    (packet): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (session !== packet.session) {
          session = packet.session;
          firstReadyRevision = 0;
          resultAcks.clear();
          snapshots.invalidate();
          yield* Ref.set(latestView, undefined);
          requests.cancelAll('The addon reloaded or the character changed. Query again.');
        }
        requests.heard();
        const {
          nextSlot,
          receivedRev,
          transportVersion: _transportVersion,
          mailboxVersion: _mailboxVersion,
          compactAck: _compactAck,
          bulkAvailable: _bulkAvailable,
          ...event
        } = packet;
        // An initial hello may carry cursors from the old host, as it did before this API.
        if (nextSlot !== undefined) {
          yield* disk
            .setCursor(nextSlot, receivedRev ?? 0)
            .pipe(Effect.catch((error) => Effect.sync(() => options.onError(error))));
        }
        if (event.type === 'state_result') {
          resultAcks.add(event.seq);
          if (resultAcks.size > 32) {
            const oldest = resultAcks.values().next();
            if (!oldest.done) resultAcks.delete(oldest.value);
          }
          requests.receive(event.requestId, event.session, event.chat, event.data);
          notify();
          return;
        }
        if (event.type === 'delete') requests.cancelChat(event.chat);
        yield* Queue.offer(events, event);
      }),
    options.onError,
    options.onHeldOff,
    options.onSlowDownlink,
  );

  const refresh = Effect.gen(function* () {
    const view = yield* Ref.get(latestView);
    if (!view || view.session !== session) return;
    const acks = [...new Set([...view.acks, ...resultAcks])];
    const snapshot = snapshots.next({ ...view, acks, requests: requests.snapshot() });
    if (!snapshot) return;
    if (view.connected && !firstReadyRevision) firstReadyRevision = snapshot.rev;
    yield* disk.publish(snapshot).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              snapshots.invalidate();
              options.onError(Cause.squash(cause));
              yield* Effect.sleep(400);
              notify();
            }),
      ),
    );
  });
  yield* Effect.andThen(Queue.take(updates), refresh).pipe(
    Effect.forever,
    Effect.forkScoped({ uninterruptible: false }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      session = undefined;
      firstReadyRevision = 0;
      requests.close();
    }),
  );
  yield* disk.start();

  return {
    events: Stream.fromQueue(events),
    request: ({ operation, ...call }) =>
      Effect.suspend(() => {
        if (closed || !session || call.session !== session) {
          return Effect.fail(Error('No active connection for this character'));
        }
        const input: GameRequest = {
          ...call,
          ...(operation.kind === 'read'
            ? { sections: operation.sections }
            : operation.kind === 'inspect'
              ? { inspection: operation.inspection }
              : { action: operation.action }),
        };
        return requests.request(input);
      }),
    publish: (view) =>
      Effect.suspend(() =>
        !closed && view.session === session
          ? Ref.set(latestView, view).pipe(
              Effect.andThen(Queue.offer(updates, undefined)),
              Effect.asVoid,
            )
          : Effect.void,
      ),
    status: () => ({
      session,
      readyPublished: firstReadyRevision !== 0,
      ready: firstReadyRevision !== 0 && disk.peerRevision >= firstReadyRevision,
    }),
  } satisfies Connection;
});

export const layer = Layer.effect(
  WowBridge,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return {
      open: (wowDirectory, options) =>
        openConnection(wowDirectory, options).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
    };
  }),
);
