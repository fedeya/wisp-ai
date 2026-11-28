import { describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { HttpClientRequest, HttpClientResponse } from 'effect/http';
import { ModelConnections } from '../../src/models/connections.ts';
import { ModelConnectionError, ModelRequestError } from '../../src/models/errors.ts';
import { promiseModelConnections } from '../../src/runtime.ts';

type Service = ModelConnections['Service'];

/** A signal no test aborts. */
const signal = new AbortController().signal;

const unused = () => Effect.die('Unused');
const connections = (overrides: Partial<Service>): Service =>
  ModelConnections.of({
    list: Effect.succeed([]),
    hasProvider: Effect.succeed(true),
    connected: () => Effect.succeed(true),
    provider: () => Effect.succeed('chatgpt'),
    selection: () => Effect.succeedNone,
    save: unused,
    remove: unused,
    models: Effect.succeed([]),
    prepare: unused,
    complete: unused,
    test: unused,
    discover: unused,
    forward: unused,
    ...overrides,
  });

const adapt = (overrides: Partial<Service>) =>
  Effect.map(Effect.context<never>(), (context) =>
    promiseModelConnections(connections(overrides), context),
  );

describe('promiseModelConnections', () => {
  it.effect('forward streams the provider response with its status and headers', () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const adapter = yield* adapt({
        forward: (request) =>
          Effect.sync(() => {
            seen.push(request.path, request.headers['anthropic-version'] ?? '');
            return HttpClientResponse.fromWeb(
              HttpClientRequest.post('https://api.example.com/messages'),
              new Response('data: {}\n\n', {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              }),
            );
          }),
      });
      const response = yield* Effect.promise(() =>
        adapter.forward(
          '00000000-0000-4000-8000-000000000001',
          '/messages',
          '{}',
          new Headers({ 'anthropic-version': '2023-06-01' }),
          signal,
        ),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(yield* Effect.promise(() => response.text())).toBe('data: {}\n\n');
      expect(seen).toEqual(['/messages', '2023-06-01']);
    }),
  );

  it.effect('a failed request rejects with what fetch failed with, a refusal as is', () =>
    Effect.gen(function* () {
      const network = new TypeError('fetch failed');
      const offline = yield* adapt({
        forward: () => Effect.fail(new ModelRequestError({ cause: network })),
        complete: () => Effect.fail(new ModelRequestError({ cause: network })),
      });
      const rejection = (promise: () => Promise<unknown>) =>
        Effect.promise(() =>
          promise().then(
            () => undefined,
            (error: unknown) => error,
          ),
        );
      expect(
        yield* rejection(() => offline.forward('id', '/messages', '{}', new Headers(), signal)),
      ).toBe(network);
      expect(yield* rejection(() => offline.complete('model', 'Name it', 'Hola', signal))).toBe(
        network,
      );
      const refused = yield* adapt({
        prepare: () => Effect.fail(new ModelConnectionError({ message: 'Enter an API key.' })),
      });
      expect(yield* rejection(() => refused.prepare('model'))).toEqual(
        new ModelConnectionError({ message: 'Enter an API key.' }),
      );
    }),
  );

  it.effect('an aborted completion rejects with the signal reason', () => {
    // The caller's signal, as the turn runner passes one.
    const abort = new AbortController();
    return Effect.gen(function* () {
      const adapter = yield* adapt({ complete: () => Effect.never });
      const pending = adapter.complete('model', 'Name it', 'Hola', abort.signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      abort.abort(new DOMException('The operation was aborted.', 'AbortError'));
      const error = yield* Effect.promise(() => pending);
      expect(error).toBe(abort.signal.reason);
    });
  });

  it.effect('a selection of ChatGPT is empty, a connection model names its connection', () =>
    Effect.gen(function* () {
      const adapter = yield* adapt({
        selection: (model) =>
          Effect.succeed(
            model === 'chatgpt'
              ? Option.none()
              : Option.some({ connectionId: 'c', provider: 'anthropic' as const, modelId: 'm' }),
          ),
      });
      expect(yield* Effect.promise(() => adapter.selection('chatgpt'))).toEqual({});
      expect(yield* Effect.promise(() => adapter.selection('connection'))).toEqual({
        connectionId: 'c',
        provider: 'anthropic',
        modelId: 'm',
      });
    }),
  );
});
