import { Cause, Context, Effect, FileSystem, Layer, Path, Queue, Stream } from 'effect';
import type { Scope } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { GameRequests, type GameRequest } from './game-requests.ts';
import type { Packet } from './wire/protocol.ts';
import { DiskConnection } from './connection.ts';
import { logTransportError } from './logging.ts';

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

export class WowBridge extends Context.Service<
  WowBridge,
  {
    readonly open: (wowDirectory: string) => Effect.Effect<Connection, PlatformError, Scope.Scope>;
  }
>()('@wisp/wow-bridge/WowBridge') {}

const openConnection = Effect.fn('WowBridge.open')(function* (wowDirectory: string) {
  const events = yield* Effect.acquireRelease(Queue.bounded<GameEvent>(64), Queue.shutdown);
  const updates = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
  let latestView: GameView | undefined;
  const notify = () => Queue.offerUnsafe(updates, undefined);
  const requests = yield* GameRequests.make(notify);
  let closed = false;
  const resultAcks = new Set<number>();

  const disk: DiskConnection = yield* DiskConnection.make(
    wowDirectory,
    (packet): Effect.Effect<void> =>
      Effect.gen(function* () {
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
          yield* disk.setCursor(nextSlot, receivedRev ?? 0).pipe(Effect.catch(logTransportError));
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
    () => {
      latestView = undefined;
      resultAcks.clear();
      requests.cancelAll('The addon reloaded or the character changed. Query again.');
    },
  );

  const refresh = Effect.gen(function* () {
    const view = latestView;
    if (!view || view.session !== disk.session) return;
    const acks = [...new Set([...view.acks, ...resultAcks])];
    yield* disk.publishView({ ...view, acks, requests: requests.snapshot() }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              yield* logTransportError(Cause.squash(cause));
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
      requests.close();
    }),
  );
  yield* disk.start();

  return {
    events: Stream.fromQueue(events),
    request: ({ operation, ...call }) =>
      Effect.suspend(() => {
        if (closed || call.session !== disk.session) {
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
        return requests.request(input, undefined, () => call.session === disk.session);
      }),
    publish: (view) =>
      Effect.sync(() => {
        if (closed || view.session !== disk.session) return;
        latestView = view;
        notify();
      }),
    status: () =>
      closed
        ? { session: undefined, readyPublished: false, ready: false }
        : { session: disk.session, ...disk.readiness },
  } satisfies Connection;
});

export const layer = Layer.effect(
  WowBridge,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return {
      open: (wowDirectory) =>
        openConnection(wowDirectory).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
    };
  }),
);
