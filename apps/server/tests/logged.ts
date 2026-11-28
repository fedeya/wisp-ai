import { Effect, Schema } from 'effect';
import { TestConsole } from 'effect/testing';

const decodeLog = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * The JSON logs with `event` that `bridgeLogging` wrote to the `TestConsole`
 * of an `it.effect` test, in order.
 */
export const logged = (event: string) =>
  Effect.map(TestConsole.logLines, (lines) =>
    lines
      .flatMap((line) => (typeof line === 'string' ? [decodeLog(line)] : []))
      .filter((log) => log.event === event),
  );
