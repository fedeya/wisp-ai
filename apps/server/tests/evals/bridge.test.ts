import { assert, describe, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { ConfigProvider, Effect, Exit, Fiber, Layer, Ref, Scope } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { TestClock, TestConsole } from 'effect/testing';
import * as ChatGPTAuth from '#/auth';
import * as AppHttpClient from '#/platform/http-client';
import type { AccountModel } from '../../src/chat/chat-model.ts';
import { serve, signIn } from '../../src/evals/bridge.ts';

type Status = ChatGPTAuth.ChatGPTAuthState['status'];

const accountState = (status: Status, message = ''): ChatGPTAuth.ChatGPTAuthState => ({
  status,
  revision: 0,
  activeId: status === 'connected' ? 'account' : null,
  account: status === 'connected' ? 'evals@example.com' : null,
  message,
  profiles: [],
});

const model = (slug: string): AccountModel => ({ slug, displayName: slug, efforts: ['medium'] });

/**
 * ChatGPTAuth whose state reads `states` in turn, staying on the last one.
 * `reads` counts the reads; ChatGPT rejects every model request.
 */
const testAuth = (
  states: readonly [ChatGPTAuth.ChatGPTAuthState, ...ChatGPTAuth.ChatGPTAuthState[]],
  reads: Ref.Ref<number>,
  models: readonly AccountModel[] = [model('gpt-eval'), model('gpt-other')],
) =>
  Layer.succeed(
    ChatGPTAuth.ChatGPTAuth,
    ChatGPTAuth.ChatGPTAuth.of({
      state: Ref.getAndUpdate(reads, (n) => n + 1).pipe(
        Effect.map((n) => states[Math.min(n, states.length - 1)] ?? states[0]),
      ),
      beginSignIn: () => Effect.succeed({ authorizationUrl: 'https://auth.example/sign-in' }),
      cancel: Effect.void,
      select: () => Effect.die('not used by the eval bridge'),
      accessToken: Effect.die('not used by the eval bridge'),
      disconnect: Effect.die('not used by the eval bridge'),
      models: Effect.succeed(models),
      authorized: () =>
        Effect.fail(new ChatGPTAuth.ChatGPTAuthError({ message: 'Sign in to ChatGPT again.' })),
    }),
  );

const config = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerSecureRandom, AppHttpClient.layer))(
  (it) => {
    describe('serve', () => {
      it.effect('answers requests with its token until its scope closes', () =>
        Effect.gen(function* () {
          const reads = yield* Ref.make(0);
          const client = yield* HttpClient.HttpClient;
          const scope = yield* Scope.make();
          const server = yield* serve().pipe(
            Scope.provide(scope),
            Effect.provide([
              testAuth([accountState('connected')], reads),
              config({ WISP_EVAL_MODEL: 'gpt-other', WISP_EVAL_EFFORT: 'high' }),
            ]),
          );
          assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
          assert.match(server.token, /^[0-9a-f]{48}$/);
          assert.strictEqual(server.model, 'gpt-other');
          const send = (request: HttpClientRequest.HttpClientRequest) =>
            client
              .execute(request)
              .pipe(
                Effect.flatMap((response) =>
                  Effect.map(response.text, (text) => [
                    response.status,
                    response.headers['content-type'],
                    text,
                  ]),
                ),
              );
          const authorized = (request: HttpClientRequest.HttpClientRequest) =>
            HttpClientRequest.bearerToken(request, server.token);

          assert.deepStrictEqual(
            yield* send(authorized(HttpClientRequest.get(server.url + '/session-model'))),
            [
              200,
              'application/json',
              JSON.stringify({ model: 'gpt-other', effort: 'high', webSearchAvailable: true }),
            ],
          );
          assert.deepStrictEqual(
            (yield* send(HttpClientRequest.get(server.url + '/session-model'))).slice(0, 1),
            [403],
          );
          assert.deepStrictEqual(
            yield* send(authorized(HttpClientRequest.get(server.url + '/inspect/target'))),
            [503, 'text/plain', 'Not available in evals: stub this tool (/inspect/target).'],
          );
          const failed = yield* client.execute(
            authorized(
              HttpClientRequest.post(server.url + '/model/responses').pipe(
                HttpClientRequest.bodyText('{"input":[]}', 'application/json'),
              ),
            ),
          );
          assert.strictEqual(failed.status, 503);
          assert.strictEqual(failed.headers['x-wisp-model-error'], 'true');
          assert.deepStrictEqual(yield* failed.json, {
            error: { message: 'Invalid model request' },
          });

          yield* Scope.close(scope, Exit.void);
          const closed = yield* Effect.flip(
            client.execute(authorized(HttpClientRequest.get(server.url + '/session-model'))),
          );
          assert.strictEqual(closed.reason._tag, 'TransportError');
        }),
      );

      it.effect('uses the first model and medium effort by default', () =>
        Effect.gen(function* () {
          const server = yield* serve().pipe(
            Effect.provide([testAuth([accountState('connected')], yield* Ref.make(0)), config({})]),
            Effect.scoped,
          );
          assert.strictEqual(server.model, 'gpt-eval');
        }),
      );

      it.effect('refuses to serve before the sign-in or with a model the account lacks', () =>
        Effect.gen(function* () {
          const signedOut = yield* serve().pipe(
            Effect.provide([
              testAuth([accountState('signed_out')], yield* Ref.make(0)),
              config({}),
            ]),
            Effect.scoped,
            Effect.flip,
          );
          assert.strictEqual(
            signedOut.message,
            'Evals are not signed in to ChatGPT. Run: node apps/server/src/evals/eval-bridge.ts sign-in',
          );
          const unknownModel = yield* serve().pipe(
            Effect.provide([
              testAuth([accountState('connected')], yield* Ref.make(0)),
              config({ WISP_EVAL_MODEL: 'gpt-missing' }),
            ]),
            Effect.scoped,
            Effect.flip,
          );
          assert.strictEqual(
            unknownModel.message,
            'Choose an available eval model with WISP_EVAL_MODEL: gpt-eval, gpt-other',
          );
        }),
      );
    });

    describe('signIn', () => {
      it.effect('checks every second, then lets the vault save for 2 seconds', () =>
        Effect.gen(function* () {
          const reads = yield* Ref.make(0);
          const fiber = yield* signIn().pipe(
            Effect.provide(
              testAuth(
                [
                  accountState('signed_out'),
                  accountState('authorizing'),
                  accountState('authorizing'),
                  accountState('connected'),
                ],
                reads,
              ),
            ),
            Effect.forkChild,
          );
          yield* TestClock.adjust('3 seconds');
          assert.strictEqual(yield* Ref.get(reads), 4);
          assert.isUndefined(fiber.pollUnsafe());
          yield* TestClock.adjust('2 seconds');
          yield* Fiber.join(fiber);
          assert.deepStrictEqual(yield* TestConsole.logLines, [
            'Open this link to sign in to ChatGPT for Wisp evals:\n\nhttps://auth.example/sign-in\n',
            'Signed in as evals@example.com. You can run the evals now.',
          ]);
        }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
      );

      it.effect('stops when the sign-in ends without an account', () =>
        Effect.gen(function* () {
          const fiber = yield* signIn().pipe(
            Effect.provide(
              testAuth(
                [accountState('signed_out'), accountState('signed_out', 'Sign-in was cancelled.')],
                yield* Ref.make(0),
              ),
            ),
            Effect.flip,
            Effect.forkChild,
          );
          yield* TestClock.adjust('1 second');
          assert.strictEqual((yield* Fiber.join(fiber)).message, 'Sign-in was cancelled.');
        }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
      );

      it.effect('reports an account that is already signed in', () =>
        Effect.gen(function* () {
          yield* signIn().pipe(
            Effect.provide(testAuth([accountState('connected')], yield* Ref.make(0))),
          );
          assert.deepStrictEqual(yield* TestConsole.logLines, [
            'Evals are already signed in to ChatGPT as evals@example.com.',
          ]);
        }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
      );
    });
  },
);
