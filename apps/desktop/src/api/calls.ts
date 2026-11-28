// @effect-migrated allow=effectPromises: the one adapter from the bridge client's, the native host's and Tauri's Promises to Effect
import { listen } from '@tauri-apps/api/event';
import type { NativeCommand } from '@wisp/protocol/native-commands';
import { Effect, Option, Queue, Schema, Stream } from 'effect';
import { bridge, call, type BridgeResponse } from '.';
import { desktop } from './desktop';

/**
 * A bridge or native call that rejected: with the bridge's or the host's
 * message, or because its reply failed to decode.
 */
export class DesktopCallError extends Schema.TaggedError<DesktopCallError>()('DesktopCallError', {
  /** What the call rejected with, as is: the UI shows it the way it always has. */
  cause: Schema.Defect(),
}) {}

/** What the call rejected with, as text (`Error: …` for an `Error`). */
export const rejectionText = (error: DesktopCallError) => String(error.cause);

/** The rejection's message as the UI shows it, without an `Error: ` prefix. */
export const failureMessage = (error: DesktopCallError) =>
  rejectionText(error).replace(/^Error: /, '');

const attempt = <A>(start: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: start, catch: (cause) => new DesktopCallError({ cause }) });

/** A typed bridge request, such as `bridgeCall((client) => client.status.$get())`. */
export const bridgeCall = <T extends BridgeResponse<unknown>>(
  request: (client: typeof bridge) => Promise<T>,
) => attempt(() => call(request(bridge)));

/** A native host command, with its reply decoded by `desktop`. */
export const nativeCall = <C extends NativeCommand>(...command: Parameters<typeof desktop<C>>) =>
  attempt(() => desktop(...command));

/** A Promise a component hands the store, such as the action it runs while busy. */
export const promised = (action: () => PromiseLike<unknown>) => Effect.asVoid(attempt(action));

/**
 * Listens to a host event for as long as the scope is open and streams its
 * payloads; a payload of another shape is dropped. Closing the scope removes
 * the listener, including one whose registration finishes afterwards.
 */
export const hostEvents = Effect.fnUntraced(function* <A>(
  event: string,
  payload: Schema.Decoder<A>,
) {
  const decode = Schema.decodeUnknownOption(payload);
  const received = yield* Queue.unbounded<A>();
  yield* Effect.acquireRelease(
    attempt(() =>
      listen<unknown>(event, (message) =>
        Option.map(decode(message.payload), (value) => Queue.offerUnsafe(received, value)),
      ),
    ),
    (stop) => Effect.sync(stop),
  );
  return Stream.fromQueue(received);
});
