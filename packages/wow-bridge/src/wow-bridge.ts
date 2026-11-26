import { Context, Effect, Layer, type Scope } from 'effect';
import { GameRequests, type GameRequestOptions } from './game-requests.ts';
import type { Packet } from './protocol.ts';
import { DiskTransport, type SlowDownlink } from './transport.ts';

export type Connection = Pick<
  DiskTransport,
  'wow' | 'peerRevision' | 'publish' | 'resetSession' | 'setCursor'
>;

interface ConnectionOptions {
  wow: string;
  receive: (packet: Packet, connection: Connection) => void;
  onError: (error: unknown) => void;
  onHeldOff: (session: string) => void;
  onSlowDownlink: (report: SlowDownlink) => void;
}

export class WowBridge extends Context.Service<
  WowBridge,
  {
    readonly requests: GameRequests;
    readonly open: (options: ConnectionOptions) => Effect.Effect<Connection, unknown, Scope.Scope>;
  }
>()('@wisp/wow-bridge/WowBridge') {}

export const layer = (changed: () => void, options?: GameRequestOptions) =>
  Layer.effect(
    WowBridge,
    Effect.gen(function* () {
      const requests = yield* Effect.acquireRelease(
        Effect.sync(() => new GameRequests(changed, options)),
        (requests) => Effect.sync(() => requests.close()),
      );
      const open = Effect.fn('WowBridge.open')(function* (options: ConnectionOptions) {
        const connection = new DiskTransport(
          options.wow,
          (packet) => options.receive(packet, connection),
          options.onError,
          options.onHeldOff,
          options.onSlowDownlink,
        );
        yield* connection.start();
        return connection;
      });
      return { requests, open };
    }),
  );
