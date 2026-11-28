import { assert, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Path,
  Redacted,
  References,
  Schedule,
  Schema,
} from 'effect';
import { Digest, Signature } from 'effect/crypto';
import { Base64Url } from 'effect/encoding';
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from 'effect/http';
import { Jwk, Jwt } from 'effect/jose';
import { TestClock } from 'effect/testing';
import * as ChatGPTAuth from '../../src/auth/index.ts';
import { thrownFailureKind } from '../../src/models/model-failures.ts';
import { SecretVault } from '../../src/platform/secret-vault.ts';
import { promiseChatGPTAuth } from '../../src/runtime.ts';

const HostFile = Schema.fromJsonString(Schema.Struct({ hostId: Schema.String }));

const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

const IdClaims = Schema.Struct({
  sub: Schema.String,
  iss: Schema.String,
  aud: Schema.String,
  iat: Schema.Finite,
  exp: Schema.Finite,
  nonce: Schema.String,
  email: Schema.String,
});

/** What the fake OpenAI answers, and what it was sent. */
interface Issuer {
  nonce: string;
  subject: string;
  audience: string;
  scopes: string;
  tokenError: boolean;
  refreshError: boolean;
  /** How many model requests to answer with 401. */
  rejected: number;
  revocation: 'confirmed' | 'unavailable' | 'unreachable';
  /** The model endpoints fail in transit, or never answer. */
  api: 'ok' | 'unreachable' | 'stalled';
  readonly calls: { readonly url: string; readonly body: URLSearchParams }[];
  tokens: number;
  refreshes: number;
}

const transportError = (request: HttpClientRequest.HttpClientRequest, cause: unknown) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause }),
  });

/** A fake OpenAI behind an `HttpClient`, signing id tokens with its own key. */
const fakeOpenAI = Effect.gen(function* () {
  const signature = yield* Signature.Signature;
  const pair = yield* Jwk.generateKeyPair({ algorithm: 'RS256', kid: 'test' });
  const key = yield* Jwk.importPrivate(pair.privateKey, 'RS256');
  const issuer: Issuer = {
    nonce: '',
    subject: 'player-one',
    audience: 'oaiapp_one',
    scopes: SCOPES,
    tokenError: false,
    refreshError: false,
    rejected: 0,
    revocation: 'confirmed',
    api: 'ok',
    calls: [],
    tokens: 0,
    refreshes: 0,
  };
  const idToken = Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const token = yield* Jwt.sign(
      IdClaims,
      {
        sub: issuer.subject,
        iss: 'https://auth.openai.com',
        aud: issuer.audience,
        iat: now,
        exp: now + 3600,
        nonce: issuer.nonce,
        email: 'player@example.test',
      },
      key,
    );
    return Redacted.value(token);
  }).pipe(Effect.provideService(Signature.Signature, signature), Effect.orDie);

  const answer = (url: URL, body: URLSearchParams, request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      switch (url.pathname) {
        case '/.well-known/openid-configuration':
          return Response.json({
            issuer: 'https://auth.openai.com',
            authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
            token_endpoint: 'https://auth.openai.com/token',
            jwks_uri: 'https://auth.openai.com/jwks',
            revocation_endpoint: 'https://auth.openai.com/revoke',
          });
        case '/jwks':
          return Response.json({ keys: [pair.publicKey] });
        case '/token':
          issuer.tokens++;
          if (body.get('grant_type') === 'refresh_token') {
            issuer.refreshes++;
            if (issuer.refreshError) {
              return yield* transportError(request, new Error('Ambiguous network failure'));
            }
            return Response.json({
              access_token: 'access-renewed',
              refresh_token: 'refresh-renewed',
              token_type: 'Bearer',
              expires_in: 3600,
              scope: issuer.scopes,
            });
          }
          if (issuer.tokenError) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          return Response.json({
            access_token: 'access-private',
            refresh_token: 'refresh-private',
            id_token: yield* idToken,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: issuer.scopes,
          });
        case '/revoke':
          if (issuer.revocation === 'unreachable') {
            return yield* transportError(request, new Error('network down'));
          }
          return new Response('', { status: issuer.revocation === 'confirmed' ? 200 : 503 });
        case '/v1/models':
        case '/v1/responses':
          if (issuer.api === 'unreachable') {
            return yield* transportError(request, new TypeError('fetch failed'));
          }
          if (issuer.api === 'stalled') {
            return yield* Effect.never;
          }
          if (issuer.rejected-- > 0) {
            return new Response('', { status: 401 });
          }
          if (url.pathname === '/v1/responses') {
            return Response.json({ answered: request.headers['authorization'] });
          }
          return Response.json({
            models: [
              { slug: 'gpt-test', display_name: 'Test model', visibility: 'list' },
              { slug: 'hidden', visibility: 'hide' },
            ],
          });
      }
      return yield* Effect.die(new Error('Unexpected endpoint ' + url.href));
    });

  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const body = new URLSearchParams(
        request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : '',
      );
      issuer.calls.push({ url: url.href, body });
      return HttpClientResponse.fromWeb(request, yield* answer(url, body, request));
    }),
  );
  return { issuer, client };
});

/** Secrets in memory. With `hold`, a write of the signed-in tokens waits for `release`. */
interface Vault {
  readonly values: Map<string, string>;
  hold?: { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> };
}

const vaultLayer = (vault: Vault) =>
  Layer.succeed(
    SecretVault,
    SecretVault.of({
      read: (key) => Effect.sync(() => Redacted.make(vault.values.get(key) ?? '')),
      write: (key, value) =>
        Effect.gen(function* () {
          const text = Redacted.value(value);
          if (vault.hold && text.includes('access-private')) {
            yield* Deferred.succeed(vault.hold.entered, undefined);
            yield* Deferred.await(vault.hold.release);
          }
          vault.values.set(key, text);
        }),
    }),
  );

/** A ChatGPTAuth on the fake OpenAI and vault, keeping its files in `directory`. */
const buildAuth = (directory: string, vault: Vault, client: HttpClient.HttpClient) =>
  Layer.build(
    ChatGPTAuth.layerAt(directory).pipe(
      Layer.provide([
        vaultLayer(vault),
        Layer.succeed(HttpClient.HttpClient, client),
        NodeCrypto.layerDigest,
        NodeCrypto.layerSecureRandom,
        NodeCrypto.layerSignature,
        NodeServices.layer,
      ]),
    ),
  ).pipe(Effect.map(Context.get(ChatGPTAuth.ChatGPTAuth)));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-auth-' });
  const vault: Vault = { values: new Map() };
  const { issuer, client } = yield* fakeOpenAI;
  const auth = yield* buildAuth(directory, vault, client);
  // The player's browser, which follows the redirect to the callback server.
  const browser = yield* HttpClient.HttpClient;

  const start = (options?: { profileId?: string; newAccount?: boolean }) =>
    Effect.gen(function* () {
      const url = new URL((yield* auth.beginSignIn(options)).authorizationUrl);
      issuer.nonce = url.searchParams.get('nonce') ?? '';
      return url;
    });
  const redirect = (url: URL, overrides: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
      callback.search = new URLSearchParams({
        code: 'test-code',
        state: url.searchParams.get('state') ?? '',
        client_id: issuer.audience,
        ...overrides,
      }).toString();
      const response = yield* browser.get(callback);
      return { status: response.status, headers: response.headers, html: yield* response.text };
    });
  const status = auth.state.pipe(Effect.map((state) => state.status));
  const accounts = () => vault.values.get('chatgpt:accounts') ?? '';
  return { directory, vault, issuer, client, auth, start, redirect, status, accounts };
});

/** Waits in real time, as the callback server's I/O does, until `check` holds. */
const eventually = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  TestClock.withLive(
    check.pipe(Effect.repeat({ until: (done) => done, schedule: Schedule.spaced('10 millis') })),
  );

/** A controller standing in for an unmigrated caller's signal, such as the model proxy's. */
const stopper = () => new AbortController();

/** Settles a Promise from the adapter into a value or the rejection it carried. */
const run = <A>(promise: () => Promise<A>) =>
  Effect.promise(() =>
    promise().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  );

layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerSignature, FetchHttpClient.layer))(
  'ChatGPTAuth',
  (it) => {
    it.effect('signs in with PKCE and a verified identity; only safe state is public', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const url = yield* f.start();
        assert.strictEqual(
          url.origin + url.pathname,
          'https://auth.openai.com/api/accounts/authorize',
        );
        assert.strictEqual(url.searchParams.get('client_id'), 'dynamic_agent_client');
        assert.strictEqual(url.searchParams.get('agent_name_hint'), 'Wisp AI');
        assert.strictEqual(url.searchParams.get('resource'), 'https://api.openai.com/v1');
        assert.strictEqual(url.searchParams.get('scope'), SCOPES);
        assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
        assert.match(url.searchParams.get('ext_agent_host_id') ?? '', /^urn:uuid:[0-9a-f-]{36}$/);
        const redirectUri = new URL(url.searchParams.get('redirect_uri') ?? '');
        assert.strictEqual(redirectUri.hostname, '127.0.0.1');
        assert.strictEqual(redirectUri.pathname, '/auth/callback');
        assert.strictEqual((yield* f.auth.state).message, 'Complete sign-in in your browser.');

        const expired = yield* f.redirect(url, { state: 'incorrect' });
        assert.strictEqual(expired.status, 400);
        assert.match(expired.html, /<h1[^>]*>ChatGPT sign-in failed<\/h1>/);
        assert.match(expired.html, /This sign-in attempt is invalid or expired/);
        assert.strictEqual(yield* f.status, 'authorizing');

        const connected = yield* f.redirect(url);
        assert.strictEqual(connected.status, 200);
        assert.strictEqual(connected.headers['content-type'], 'text/html; charset=utf-8');
        assert.strictEqual(connected.headers['cache-control'], 'no-store');
        assert.strictEqual(connected.headers['referrer-policy'], 'no-referrer');
        assert.strictEqual(connected.headers['x-content-type-options'], 'nosniff');
        assert.match(connected.html, /<h1[^>]*>ChatGPT connected<\/h1>/);
        assert.match(connected.html, /Return to Wisp/);
        assert.notMatch(
          connected.html,
          /test-code|player@example\.test|access-private|refresh-private/,
        );
        const state = yield* f.auth.state;
        assert.strictEqual(state.status, 'connected');
        assert.strictEqual(state.account, 'player@example.test');
        assert.strictEqual(state.activeId, 'oaiapp_one');
        assert.deepStrictEqual(state.profiles, [
          { id: 'oaiapp_one', label: 'player@example.test - Connection 1', connected: true },
        ]);
        assert.notMatch(JSON.stringify(state), /access-private|refresh-private|eyJ/);

        const exchange = f.issuer.calls.find(
          (call) => call.body.get('grant_type') === 'authorization_code',
        )?.body;
        assert.strictEqual(exchange?.get('client_id'), 'oaiapp_one');
        assert.strictEqual(exchange?.get('code'), 'test-code');
        assert.strictEqual(exchange?.get('redirect_uri'), redirectUri.href);
        assert.strictEqual(exchange?.get('resource'), 'https://api.openai.com/v1');
        assert.isFalse(exchange?.has('client_secret'));
        const digest = yield* Digest.Digest;
        const challenge = yield* digest.digest(
          Digest.sha256,
          new TextEncoder().encode(exchange?.get('code_verifier') ?? ''),
        );
        assert.strictEqual(Base64Url.encode(challenge), url.searchParams.get('code_challenge'));

        // The callback page is the only request the server answers.
        const other = yield* (yield* HttpClient.HttpClient).get(new URL('/other', redirectUri));
        assert.strictEqual(other.status, 404);
        assert.strictEqual(yield* other.text, 'Not found');

        // A second instance restores the accounts and the host identifier.
        const restored = yield* buildAuth(f.directory, f.vault, f.client);
        assert.strictEqual((yield* restored.state).status, 'connected');
        const path = yield* Path.Path;
        const host = yield* (yield* FileSystem.FileSystem).readFileString(
          path.join(f.directory, 'chatgpt-host.json'),
        );
        const { hostId } = yield* Schema.decodeEffect(HostFile)(host);
        assert.strictEqual(hostId, url.searchParams.get('ext_agent_host_id'));
        assert.notMatch(host, /access-private|refresh-private/);
        const again = new URL((yield* restored.beginSignIn()).authorizationUrl);
        assert.strictEqual(
          again.searchParams.get('ext_agent_host_id'),
          url.searchParams.get('ext_agent_host_id'),
        );
        assert.strictEqual(again.searchParams.get('client_id'), 'oaiapp_one');
        assert.strictEqual(again.searchParams.get('login_hint'), 'player@example.test');
        assert.match(again.searchParams.get('id_token_hint') ?? '', /^eyJ/);
      }).pipe(Effect.provide(NodeCrypto.layerDigest)),
    );

    it.effect('rejects an invalid nonce, audience, identity change and registration mismatch', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let url = yield* f.start();
        f.issuer.nonce = 'wrong';
        const wrongNonce = yield* f.redirect(url);
        assert.strictEqual(wrongNonce.status, 400);
        assert.match(wrongNonce.html, /ChatGPT identity validation failed/);
        assert.strictEqual(yield* f.status, 'signed_out');

        url = yield* f.start();
        assert.strictEqual(url.searchParams.get('client_id'), 'oaiapp_one');
        f.issuer.audience = 'oaiapp_wrong';
        assert.strictEqual((yield* f.redirect(url, { client_id: 'oaiapp_one' })).status, 400);
        f.issuer.audience = 'oaiapp_one';

        url = yield* f.start();
        assert.strictEqual((yield* f.redirect(url)).status, 200);
        url = yield* f.start();
        const mismatch = yield* f.redirect(url, { client_id: 'oaiapp_wrong' });
        assert.strictEqual(mismatch.status, 400);
        assert.match(mismatch.html, /ChatGPT returned a different account registration/);
        assert.strictEqual(yield* f.status, 'connected');

        url = yield* f.start();
        f.issuer.subject = 'different-player';
        const changed = yield* f.redirect(url);
        assert.strictEqual(changed.status, 400);
        assert.match(changed.html, /belongs to a different ChatGPT account/);
        assert.strictEqual(yield* f.status, 'connected');
      }),
    );

    it.effect(
      'keeps the issued registration after a failed exchange, and cancel closes the listener',
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const url = yield* f.start();
          f.issuer.tokenError = true;
          const failed = yield* f.redirect(url);
          assert.strictEqual(failed.status, 400);
          assert.match(failed.html, /The ChatGPT session needs a new sign-in/);
          const retry = yield* f.start();
          assert.strictEqual(retry.searchParams.get('client_id'), 'oaiapp_one');
          yield* f.auth.cancel;
          const state = yield* f.auth.state;
          assert.strictEqual(state.status, 'signed_out');
          assert.strictEqual(state.message, 'Sign-in cancelled.');
          const closed = yield* Effect.flip(f.redirect(retry));
          assert.strictEqual(closed._tag, 'HttpClientError');
        }),
    );

    it.effect('a sign-in nobody completes times out and closes its listener', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const url = yield* f.start();
        yield* TestClock.adjust('4 minutes');
        assert.strictEqual(yield* f.status, 'authorizing');
        yield* TestClock.adjust('1 minute');
        yield* eventually(f.status.pipe(Effect.map((status) => status === 'signed_out')));
        assert.strictEqual((yield* f.auth.state).message, 'Sign-in timed out. Please try again.');
        const closed = yield* Effect.flip(f.redirect(url));
        assert.strictEqual(closed._tag, 'HttpClientError');
      }),
    );

    it.effect(
      'rotating refresh is single flight and never retries an ambiguous refresh token',
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          assert.strictEqual((yield* f.redirect(yield* f.start())).status, 200);
          assert.strictEqual(Redacted.value(yield* f.auth.accessToken), 'access-private');
          yield* TestClock.adjust('1 hour');
          const tokens = yield* Effect.all(
            [f.auth.accessToken, f.auth.accessToken, f.auth.accessToken],
            {
              concurrency: 'unbounded',
            },
          );
          assert.deepStrictEqual(tokens.map(Redacted.value), [
            'access-renewed',
            'access-renewed',
            'access-renewed',
          ]);
          assert.strictEqual(f.issuer.refreshes, 1);
          assert.match(f.accounts(), /refresh-renewed/);

          yield* TestClock.adjust('1 hour');
          f.issuer.refreshError = true;
          const first = yield* Effect.flip(f.auth.accessToken);
          assert.strictEqual(
            first.message,
            'ChatGPT needs a new sign-in. The previous refresh token will not be retried.',
          );
          const second = yield* Effect.flip(f.auth.accessToken);
          assert.strictEqual(second.message, 'Sign in with ChatGPT in Wisp desktop.');
          assert.strictEqual(f.issuer.refreshes, 2);
          assert.strictEqual(yield* f.status, 'reauth_required');
        }),
    );

    it.effect('missing plan consent cannot invoke inference', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.issuer.scopes = 'openid profile email';
        const pending = yield* f.redirect(yield* f.start());
        assert.strictEqual(pending.status, 200);
        assert.match(pending.html, /<h1[^>]*>One more step<\/h1>/);
        assert.match(pending.html, /Select Continue with ChatGPT to grant access/);
        assert.strictEqual(yield* f.status, 'plan_permission_required');
        assert.match((yield* f.auth.state).message, /ChatGPT plan use was not granted/);
        const error = yield* Effect.flip(f.auth.accessToken);
        assert.match(error.message, /Allow Wisp/);
      }),
    );

    it.effect('models are scoped to the active grant and a 401 renews once', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.strictEqual((yield* f.redirect(yield* f.start())).status, 200);
        f.issuer.rejected = 1;
        const models = yield* f.auth.models;
        assert.deepStrictEqual(models, [
          {
            slug: 'gpt-test',
            displayName: 'Test model',
            efforts: [],
            defaultEffort: undefined,
            contextWindow: undefined,
          },
        ]);
        assert.strictEqual(f.issuer.refreshes, 1);
        // Cached for five minutes.
        yield* f.auth.models;
        assert.lengthOf(
          f.issuer.calls.filter((call) => call.url.endsWith('/models')),
          2,
        );
        const unsupported = yield* Effect.flip(
          Effect.scoped(
            f.auth.authorized(HttpClientRequest.get('https://chatgpt.com/backend-api/responses')),
          ),
        );
        assert.match(unsupported.message, /Unsupported/);
      }),
    );

    it.effect('two rejections freeze the session', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.strictEqual((yield* f.redirect(yield* f.start())).status, 200);
        f.issuer.rejected = 2;
        const error = yield* Effect.flip(f.auth.models);
        assert.strictEqual(error.message, 'Could not load models for this ChatGPT account.');
        const state = yield* f.auth.state;
        assert.strictEqual(state.status, 'reauth_required');
        assert.strictEqual(state.message, 'ChatGPT rejected this session. Please sign in again.');
      }),
    );

    it.effect('disconnect revokes only this registration and keeps the reusable mapping', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.strictEqual((yield* f.redirect(yield* f.start())).status, 200);
        const state = yield* f.auth.disconnect;
        const revoke = f.issuer.calls.find((call) => call.url.endsWith('/revoke'))?.body;
        assert.strictEqual(revoke?.get('token'), 'refresh-private');
        assert.strictEqual(revoke?.get('token_type_hint'), 'refresh_token');
        assert.strictEqual(revoke?.get('client_id'), 'oaiapp_one');
        assert.strictEqual(state.status, 'signed_out');
        assert.strictEqual(state.message, 'Wisp disconnected. Your other apps stay signed in.');
        assert.notMatch(f.accounts(), /refresh-private|access-private|idToken/);
        const url = yield* f.start();
        assert.strictEqual(url.searchParams.get('client_id'), 'oaiapp_one');
        assert.isFalse(url.searchParams.has('id_token_hint'));
      }),
    );

    it.effect(
      'unconfirmed revocation still clears local credentials and explains the outcome',
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.redirect(yield* f.start());
          f.issuer.revocation = 'unavailable';
          const disconnect = yield* f.auth.disconnect.pipe(Effect.forkChild);
          yield* eventually(
            Effect.sync(() => f.issuer.calls.some((call) => call.url.endsWith('/revoke'))),
          );
          assert.strictEqual(yield* f.status, 'disconnecting');
          yield* TestClock.adjust('500 millis');
          const state = yield* Fiber.join(disconnect);
          assert.strictEqual(state.status, 'signed_out');
          assert.match(state.message, /could not be confirmed/);
          assert.notMatch(f.accounts(), /refresh-private/);
          // A server error is retried once.
          assert.lengthOf(
            f.issuer.calls.filter((call) => call.url.endsWith('/revoke')),
            2,
          );
        }),
    );

    it.effect('a failed revocation request is logged without the token', () => {
      const logs: { message: unknown; annotations: Readonly<Record<string, unknown>> }[] = [];
      const capture = Logger.make((options) => {
        logs.push({
          message: options.message,
          annotations: options.fiber.getRef(References.CurrentLogAnnotations),
        });
      });
      return Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.redirect(yield* f.start());
        f.issuer.revocation = 'unreachable';
        const state = yield* f.auth.disconnect;
        assert.match(state.message, /could not be confirmed/);
        const warning = logs.find((log) => log.annotations['event'] === 'auth.revoke_failed');
        assert.strictEqual(warning?.annotations['error'], 'network down');
        assert.notMatch(JSON.stringify(logs), /refresh-private/);
      }).pipe(Effect.provide(Logger.layer([capture])));
    });

    it.effect(
      'cancelling during a credential write waits for the rollback before another sign-in',
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const url = yield* f.start();
          const hold = {
            entered: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          f.vault.hold = hold;
          const redirect = yield* f.redirect(url).pipe(Effect.ignore, Effect.forkChild);
          yield* Deferred.await(hold.entered);
          const cancelled = yield* Deferred.make<void>();
          const cancel = yield* f.auth.cancel.pipe(
            Effect.andThen(Deferred.succeed(cancelled, undefined)),
            Effect.forkChild,
          );
          yield* TestClock.withLive(Effect.sleep('20 millis'));
          assert.isFalse(yield* Deferred.isDone(cancelled));
          f.vault.hold = undefined;
          yield* Deferred.succeed(hold.release, undefined);
          yield* Fiber.join(cancel);
          yield* Fiber.join(redirect);
          assert.strictEqual(yield* f.status, 'signed_out');
          assert.notMatch(f.accounts(), /access-private|refresh-private/);
          const next = yield* f.start();
          assert.strictEqual(next.searchParams.get('client_id'), 'oaiapp_one');
        }),
    );

    it.effect('the Promise adapter rejects with what the unmigrated consumers check', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const auth = promiseChatGPTAuth(f.auth, yield* Effect.context<never>());
        assert.isFalse(auth.pending);
        const signedOut = yield* run(() => auth.accessToken());
        assert.isFalse(signedOut.ok);
        const error = signedOut.ok ? undefined : signedOut.error;
        assert.instanceOf(error, ChatGPTAuth.ChatGPTAuthError);
        assert.instanceOf(error, Error);
        assert.strictEqual(error instanceof Error ? error.name : undefined, 'ChatGPTAuthError');
        assert.strictEqual(
          error instanceof ChatGPTAuth.ChatGPTAuthError ? error._tag : undefined,
          'ChatGPTAuthError',
        );
        assert.strictEqual(
          error instanceof Error ? error.message : undefined,
          'Sign in with ChatGPT in Wisp desktop.',
        );
        assert.strictEqual(thrownFailureKind(error), 'auth');

        const { authorizationUrl } = yield* Effect.promise(() => auth.beginSignIn());
        f.issuer.nonce = new URL(authorizationUrl).searchParams.get('nonce') ?? '';
        assert.isTrue(auth.pending);
        yield* f.redirect(new URL(authorizationUrl));
        assert.strictEqual(auth.state().status, 'connected');
        assert.strictEqual(yield* Effect.promise(() => auth.accessToken()), 'access-private');

        const answered = yield* Effect.promise(() =>
          auth
            .authorized('https://api.openai.com/v1/responses', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
            .then((response) => response.text()),
        );
        assert.strictEqual(answered, JSON.stringify({ answered: 'Bearer access-private' }));

        f.issuer.api = 'unreachable';
        const offline = yield* run(() => auth.models());
        const failure = offline.ok ? undefined : offline.error;
        assert.instanceOf(failure, TypeError);
        assert.strictEqual(failure instanceof Error ? failure.message : undefined, 'fetch failed');
        assert.strictEqual(thrownFailureKind(failure), 'network');

        f.issuer.api = 'stalled';
        const controller = stopper();
        const reason = new DOMException('The operation timed out.', 'TimeoutError');
        const stalled = yield* run(() =>
          auth.authorized('https://api.openai.com/v1/responses', {
            method: 'POST',
            body: '{}',
            signal: controller.signal,
          }),
        ).pipe(Effect.forkChild);
        yield* TestClock.withLive(Effect.sleep('20 millis'));
        controller.abort(reason);
        const aborted = yield* Fiber.join(stalled);
        assert.strictEqual(aborted.ok ? undefined : aborted.error, reason);
        assert.strictEqual(thrownFailureKind(aborted.ok ? undefined : aborted.error), 'timeout');
      }),
    );
  },
);
