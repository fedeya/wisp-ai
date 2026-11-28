// @effect-migrated
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Scope,
  SubscriptionRef,
} from 'effect';
import { Digest, Mac, SecureRandom } from 'effect/crypto';
import { Base64Url } from 'effect/encoding';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerRequest } from 'effect/http';
import type { HttpClientResponse } from 'effect/http';
import { AppConfig } from '#/platform/config';
import { accountModel } from '../chat/chat-model.ts';
import type { AccountModel } from '../chat/chat-model.ts';
import { errorMessage } from '../errors.ts';
import { SecretVault } from '#/platform/secret-vault';
import type { SecretVaultError } from '#/platform/secret-vault';
import { callbackPage } from './callback-page.ts';
import type { CallbackResult } from './callback-page.ts';
import { serveCallback } from './callback-server.ts';
import { ChatGPTAuthError, requestFailed, withDeadline } from './errors.ts';
import type { ChatGPTRequestError } from './errors.ts';
import { RESOURCE, idTokenOf, makeIssuer, tokenSet } from './issuer.ts';
import { lenient } from './lenient.ts';
import { ClientId, MAX_PROFILES, SavedJson, readHostId } from './profiles.ts';
import type { Profile, Saved, TokenSet } from './profiles.ts';

const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
/** The scope that lets Wisp use the player's ChatGPT plan. */
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const ACCOUNTS_KEY = 'chatgpt:accounts';
const SIGN_IN_TIMEOUT = '5 minutes';
/** How long a model catalog is reused, in milliseconds. */
const MODELS_TTL = 300_000;
/** A token this close to expiring, in milliseconds, is renewed before use. */
const RENEW_BEFORE = 60_000;
const ENDPOINTS = new Set([RESOURCE + '/responses', RESOURCE + '/models']);

const isClientId = Schema.is(ClientId);

const ModelCatalog = Schema.Struct({ models: Schema.Array(Schema.Unknown) });

/** A catalog entry Wisp offers: listed, with a slug it can send back. */
const ListedModel = Schema.Struct({
  visibility: Schema.Literal('list'),
  slug: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,100}$/)),
  display_name: lenient(Schema.String),
  supported_reasoning_levels: lenient(
    Schema.mutable(Schema.Array(Schema.Struct({ effort: lenient(Schema.String) }))),
  ),
  default_reasoning_level: lenient(Schema.String),
  context_window: lenient(Schema.Finite),
});
const decodeListedModel = Schema.decodeUnknownOption(ListedModel);

export type ChatGPTAuthStatus =
  | 'signed_out'
  | 'authorizing'
  | 'disconnecting'
  | 'reauth_required'
  | 'plan_permission_required'
  | 'connected';

/** What Wisp shows about the ChatGPT accounts. It never carries tokens. */
export interface ChatGPTAuthState {
  readonly status: ChatGPTAuthStatus;
  /** Rises whenever the accounts or the sign-in change. */
  readonly revision: number;
  readonly activeId: string | null;
  readonly account: string | null;
  readonly message: string;
  readonly profiles: {
    readonly id: string;
    readonly label: string;
    readonly connected: boolean;
  }[];
}

/** A browser sign-in waiting for its redirect. */
interface Attempt {
  readonly id: string;
  readonly redirectUri: string;
  /** Owns the callback server and the sign-in timeout. */
  readonly server: Scope.Closeable;
  /** Done once the sign-in is cancelled. */
  readonly aborted: Deferred.Deferred<void>;
  /** Done once the redirect has been handled, when it arrived. */
  readonly settled: Deferred.Deferred<void>;
  /** The redirect arrived; a second one is refused. */
  readonly consumed: boolean;
}

interface State {
  readonly saved: Saved;
  readonly revision: number;
  readonly message: string;
  readonly signingOut: boolean;
  readonly attempt: Option.Option<Attempt>;
}

/** What the callback page reports. */
interface Outcome {
  readonly result: CallbackResult;
  readonly message?: string;
}

/** The sign-in was cancelled while its redirect was being handled. */
class SignInAborted extends Schema.TaggedError<SignInAborted>()('SignInAborted', {}) {}

const fail = (message: string) => Effect.fail(new ChatGPTAuthError({ message }));

const activeProfile = (state: State) =>
  state.saved.profiles.find((profile) => profile.id === state.saved.activeId);

const updateProfile = (state: State, id: string, f: (profile: Profile) => Profile): State => ({
  ...state,
  saved: {
    ...state.saved,
    profiles: state.saved.profiles.map((profile) => (profile.id === id ? f(profile) : profile)),
  },
});

const hasPlan = (tokens: TokenSet) => tokens.scopes.includes(PLAN_SCOPE);

function view(state: State, now: number): ChatGPTAuthState {
  const profile = activeProfile(state);
  let status: ChatGPTAuthStatus = 'signed_out';
  if (profile?.tokens) {
    status = profile.frozen
      ? 'reauth_required'
      : !hasPlan(profile.tokens)
        ? 'plan_permission_required'
        : 'connected';
    if (!profile.tokens.refreshToken && profile.tokens.expiresAt <= now) {
      status = 'reauth_required';
    }
  }
  if (Option.isSome(state.attempt)) {
    status = 'authorizing';
  }
  if (state.signingOut) {
    status = 'disconnecting';
  }
  return {
    status,
    revision: state.revision,
    activeId: state.saved.activeId || null,
    account: profile?.email || profile?.name || null,
    message: state.message,
    profiles: state.saved.profiles.map((p, index) => ({
      id: p.id,
      label: (p.email || p.name || 'ChatGPT account') + ' - Connection ' + (index + 1),
      connected: !!p.tokens && !p.frozen && hasPlan(p.tokens),
    })),
  };
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * Signs the player in to ChatGPT with OAuth (PKCE, a loopback redirect and a
 * verified id token), keeps the saved accounts in the vault and renews their
 * tokens. Requests to the ChatGPT API go through `authorized`, which adds the
 * active account's token.
 */
export class ChatGPTAuth extends Context.Service<
  ChatGPTAuth,
  {
    readonly state: Effect.Effect<ChatGPTAuthState>;
    /**
     * Starts a browser sign-in and returns the page to open. Without a
     * `profileId` it signs in to the active account, or the last one saved;
     * `newAccount` registers another one.
     */
    readonly beginSignIn: (options?: {
      readonly profileId?: string | undefined;
      readonly newAccount?: boolean | undefined;
    }) => Effect.Effect<
      { readonly authorizationUrl: string },
      ChatGPTAuthError | ChatGPTRequestError
    >;
    /** Cancels the sign-in in progress, after its redirect, if any, has been handled. */
    readonly cancel: Effect.Effect<void>;
    readonly select: (
      id: string,
    ) => Effect.Effect<ChatGPTAuthState, ChatGPTAuthError | SecretVaultError>;
    /** The active account's access token, renewed when it is about to expire. */
    readonly accessToken: Effect.Effect<
      Redacted.Redacted<string>,
      ChatGPTAuthError | SecretVaultError
    >;
    /** Revokes and forgets the active account's tokens; the registration stays saved. */
    readonly disconnect: Effect.Effect<ChatGPTAuthState, SecretVaultError>;
    /** The models the active account may use, cached for five minutes. */
    readonly models: Effect.Effect<
      readonly AccountModel[],
      ChatGPTAuthError | ChatGPTRequestError | SecretVaultError
    >;
    /**
     * Sends a request to the ChatGPT API with the active account's token,
     * renewing it once if ChatGPT rejects it. The response body stays open
     * until the scope closes.
     */
    readonly authorized: (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      ChatGPTAuthError | ChatGPTRequestError | SecretVaultError,
      Scope.Scope
    >;
  }
>()('@wisp/server/auth/ChatGPTAuth') {}

const make = Effect.fnUntraced(function* (directory: string) {
  const vault = yield* SecretVault;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  // As with the fetch calls before, a redirect fails the request.
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
    ),
  );
  const scopedClient = HttpClient.withScope(client);
  const issuer = yield* makeIssuer(client);

  yield* fs.makeDirectory(directory, { recursive: true });
  const hostId = yield* readHostId(directory);
  const raw = Redacted.value(yield* vault.read(ACCOUNTS_KEY));
  const saved: Saved = raw ? yield* Schema.decodeEffect(SavedJson)(raw) : { profiles: [] };

  const ref = yield* SubscriptionRef.make<State>({
    saved,
    revision: 0,
    message: '',
    signingOut: false,
    attempt: Option.none(),
  });
  const modelsCache = yield* Ref.make(
    Option.none<{
      readonly id: string | undefined;
      readonly models: readonly AccountModel[];
      readonly at: number;
    }>(),
  );
  // One renewal per account at a time; callers share it.
  const refreshes = yield* FiberMap.make<
    string,
    Redacted.Redacted<string>,
    ChatGPTAuthError | SecretVaultError
  >();

  const read = SubscriptionRef.get(ref);
  const update = (f: (state: State) => State) => SubscriptionRef.update(ref, f);
  const setMessage = (message: string) => update((state) => ({ ...state, message }));

  const state = Effect.gen(function* () {
    return view(yield* read, yield* Clock.currentTimeMillis);
  });

  /** Saves the accounts as they are now; a new revision and model catalog follow. */
  const persist = Effect.gen(function* () {
    const { saved } = yield* read;
    const json = yield* Schema.encodeEffect(SavedJson)(saved).pipe(Effect.orDie);
    yield* vault.write(ACCOUNTS_KEY, Redacted.make(json));
    yield* update((state) => ({ ...state, revision: state.revision + 1 }));
    yield* Ref.set(modelsCache, Option.none());
  });

  /**
   * Ends the sign-in in progress: stops its server, then waits for a redirect
   * that is being handled, which rolls back what it saved.
   */
  const stopAttempt = (cancelled: boolean) =>
    Effect.gen(function* () {
      const attempt = yield* SubscriptionRef.modify(
        ref,
        (state): [Option.Option<Attempt>, State] => [
          state.attempt,
          { ...state, attempt: Option.none() },
        ],
      );
      if (Option.isNone(attempt)) {
        return;
      }
      yield* Deferred.succeed(attempt.value.aborted, undefined);
      yield* Scope.close(attempt.value.server, Exit.void);
      if (attempt.value.consumed) {
        yield* Deferred.await(attempt.value.settled);
      }
      yield* update((state) => ({
        ...state,
        message: cancelled ? 'Sign-in cancelled.' : state.message,
        revision: state.revision + 1,
      }));
    }).pipe(Effect.uninterruptible);

  const timeOut = (id: string) =>
    Effect.gen(function* () {
      const { attempt } = yield* read;
      if (Option.isSome(attempt) && attempt.value.id === id) {
        yield* setMessage('Sign-in timed out. Please try again.');
        yield* stopAttempt(false);
      }
    });

  interface SignIn {
    readonly id: string;
    readonly state: string;
    readonly nonce: string;
    readonly verifier: string;
    readonly chosen: Profile | undefined;
    readonly server: Scope.Closeable;
    readonly aborted: Deferred.Deferred<void>;
    readonly settled: Deferred.Deferred<void>;
  }

  /** Exchanges the redirect's code and saves the tokens; sets the message the page shows. */
  const completeSignIn = Effect.fnUntraced(function* (
    signIn: SignIn,
    redirectUri: string,
    params: URLSearchParams,
  ) {
    const { chosen, aborted } = signIn;
    const checkAborted = Effect.gen(function* () {
      if (yield* Deferred.isDone(aborted)) {
        return yield* new SignInAborted();
      }
    });
    if (params.has('error')) {
      return yield* fail('ChatGPT sign-in was declined. You can try again.');
    }
    const code = params.get('code');
    if (!code || code.length > 10_000) {
      return yield* fail('ChatGPT did not return an authorization code.');
    }
    const clientId = params.get('client_id') || chosen?.id;
    if (!clientId || !isClientId(clientId) || (chosen && clientId !== chosen.id)) {
      return yield* fail('ChatGPT returned a different account registration.');
    }
    if (!chosen) {
      if ((yield* read).saved.profiles.some((profile) => profile.id === clientId)) {
        return yield* fail('This registration is already saved. Choose it in Wisp.');
      }
      // The registration is kept even if the sign-in fails, so a retry reuses it.
      yield* update((state) => ({
        ...state,
        saved: { ...state.saved, profiles: [...state.saved.profiles, { id: clientId }] },
      }));
      yield* persist;
    }
    yield* checkAborted;
    const data = yield* issuer
      .exchange({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: signIn.verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      })
      .pipe(
        Effect.raceFirst(
          Deferred.await(aborted).pipe(Effect.flatMap(() => Effect.fail(new SignInAborted()))),
        ),
      );
    const identity = yield* issuer.identity(idTokenOf(data), clientId, signIn.nonce);
    if (chosen?.subject && chosen.subject !== identity.sub) {
      return yield* fail(
        'This sign-in belongs to a different ChatGPT account. Use Add account instead.',
      );
    }
    const tokens = yield* tokenSet(data);
    yield* checkAborted;
    const previous = (yield* read).saved;
    yield* update((state) => {
      const signedIn = updateProfile(state, clientId, (profile) => ({
        ...profile,
        subject: identity.sub,
        email: identity.email,
        name: identity.name,
        tokens,
        frozen: false,
      }));
      return { ...signedIn, saved: { ...signedIn.saved, activeId: clientId } };
    });
    yield* persist;
    // Cancelled while saving: put the accounts back as they were.
    if (yield* Deferred.isDone(aborted)) {
      yield* update((state) => ({ ...state, saved: previous }));
      yield* persist;
      return yield* fail('Sign-in cancelled.');
    }
    const result: CallbackResult = hasPlan(tokens) ? 'connected' : 'permission-required';
    yield* setMessage(
      result === 'connected'
        ? ''
        : 'Connected account, but ChatGPT plan use was not granted. Continue with ChatGPT to authorize plan use.',
    );
    return result;
  });

  /** Handles the redirect once; the page reports the outcome without account details. */
  const handleRedirect = Effect.fnUntraced(function* (
    signIn: SignIn,
    redirectUri: string,
    params: URLSearchParams,
  ) {
    const outcome = yield* completeSignIn(signIn, redirectUri, params).pipe(
      Effect.map((result): Outcome => ({ result })),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message =
            error instanceof ChatGPTAuthError
              ? error.message
              : (yield* Deferred.isDone(signIn.aborted))
                ? 'Sign-in cancelled.'
                : 'Sign-in could not be completed. Return to Wisp and try again.';
          yield* setMessage(message);
          return { result: 'error', message } satisfies Outcome;
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* update((state) =>
            Option.isSome(state.attempt) && state.attempt.value.id === signIn.id
              ? { ...state, attempt: Option.none(), revision: state.revision + 1 }
              : state,
          );
          yield* Deferred.succeed(signIn.settled, undefined);
          // Let the page reach the browser before the server closes.
          yield* Effect.sleep('100 millis').pipe(
            Effect.andThen(Scope.close(signIn.server, Exit.void)),
            Effect.forkIn(scope),
          );
        }),
      ),
      // Closing the server must not stop the sign-in halfway, so it runs in the service's scope.
      Effect.forkIn(scope),
      Effect.flatMap(Fiber.await),
    );
    if (Exit.isSuccess(outcome)) {
      return callbackPage(outcome.value.result, outcome.value.message);
    }
    yield* stopAttempt(true).pipe(Effect.forkIn(scope));
    return callbackPage('error');
  });

  const callback = (signIn: SignIn) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = new URL(request.url, 'http://127.0.0.1').searchParams;
      const supplied = utf8(params.get('state') || '');
      const expected = utf8(signIn.state);
      const attempt = yield* SubscriptionRef.modify(
        ref,
        (state): [Option.Option<Attempt>, State] => {
          const current = state.attempt;
          if (
            Option.isNone(current) ||
            current.value.id !== signIn.id ||
            current.value.consumed ||
            !Mac.timingSafeEqual(supplied, expected)
          ) {
            return [Option.none(), state];
          }
          return [
            current,
            { ...state, attempt: Option.some({ ...current.value, consumed: true }) },
          ];
        },
      );
      if (Option.isNone(attempt)) {
        return callbackPage('error', 'This sign-in attempt is invalid or expired.');
      }
      return yield* handleRedirect(signIn, attempt.value.redirectUri, params);
    });

  const randomToken = random.randomBytes(32).pipe(Effect.map(Base64Url.encode));

  const beginSignIn = Effect.fn('ChatGPTAuth.beginSignIn')(function* (
    options: {
      readonly profileId?: string | undefined;
      readonly newAccount?: boolean | undefined;
    } = {},
  ) {
    const { profileId, newAccount = false } = options;
    if ((yield* read).signingOut) {
      return yield* fail('Wait for disconnection to finish.');
    }
    yield* stopAttempt(true);
    const { saved } = yield* read;
    if (newAccount && saved.profiles.length >= MAX_PROFILES) {
      return yield* fail('Use an existing saved account.');
    }
    const chosen = newAccount
      ? undefined
      : saved.profiles.find((profile) => profile.id === (profileId || saved.activeId)) ||
        (!profileId ? saved.profiles.at(-1) : undefined);
    if (profileId && !chosen) {
      return yield* fail('Saved ChatGPT account not found.');
    }
    const { authorization_endpoint } = yield* issuer.discovery;
    const signIn: SignIn = {
      id: yield* random.uuidV4(),
      state: yield* randomToken,
      nonce: yield* randomToken,
      verifier: yield* randomToken,
      chosen,
      server: yield* Scope.fork(scope),
      aborted: yield* Deferred.make<void>(),
      settled: yield* Deferred.make<void>(),
    };
    const port = yield* serveCallback(callback(signIn)).pipe(
      Scope.provide(signIn.server),
      Effect.onError(() => Scope.close(signIn.server, Exit.void)),
      Effect.orDie,
    );
    const redirectUri = 'http://127.0.0.1:' + port + '/auth/callback';
    yield* Effect.sleep(SIGN_IN_TIMEOUT).pipe(
      // The timeout closes the server it runs in, so it ends in the service's scope.
      Effect.andThen(timeOut(signIn.id).pipe(Effect.forkIn(scope))),
      Effect.forkIn(signIn.server),
    );
    yield* update((state) => ({
      ...state,
      attempt: Option.some({
        id: signIn.id,
        redirectUri,
        server: signIn.server,
        aborted: signIn.aborted,
        settled: signIn.settled,
        consumed: false,
      }),
      message: 'Complete sign-in in your browser.',
      revision: state.revision + 1,
    }));
    const challenge = Base64Url.encode(yield* digest.digest(Digest.sha256, utf8(signIn.verifier)));
    const idTokenHint = chosen?.tokens?.idToken;
    const query = new URLSearchParams({ client_id: chosen?.id || 'dynamic_agent_client' });
    if (!chosen) {
      query.set('agent_name_hint', 'Wisp AI');
    }
    for (const [name, value] of Object.entries({
      ext_agent_host_id: hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state: signIn.state,
      nonce: signIn.nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    })) {
      query.set(name, value);
    }
    if (idTokenHint) {
      query.set('id_token_hint', Redacted.value(idTokenHint));
    }
    if (chosen?.email) {
      query.set('login_hint', chosen.email);
    }
    const url = new URL(authorization_endpoint);
    url.search = query.toString();
    return { authorizationUrl: url.toString() };
  });

  const cancel = stopAttempt(true).pipe(Effect.withSpan('ChatGPTAuth.cancel'));

  const select = Effect.fn('ChatGPTAuth.select')(function* (id: string) {
    const current = yield* read;
    if (Option.isSome(current.attempt) || current.signingOut) {
      return yield* fail('Finish the current account operation first.');
    }
    if (!current.saved.profiles.some((profile) => profile.id === id)) {
      return yield* fail('Saved account not found.');
    }
    yield* update((state) => ({ ...state, saved: { ...state.saved, activeId: id }, message: '' }));
    yield* persist;
    return yield* state;
  });

  /**
   * Renews a profile's tokens. Any failure freezes the profile: an ambiguous
   * refresh token is never sent again.
   */
  const refresh = (profile: Profile, tokens: TokenSet) =>
    Effect.gen(function* () {
      if (!tokens.refreshToken) {
        return yield* fail('Sign in with ChatGPT again to renew access.');
      }
      const data = yield* issuer.exchange({
        grant_type: 'refresh_token',
        client_id: profile.id,
        refresh_token: Redacted.value(tokens.refreshToken),
        resource: RESOURCE,
      });
      const renewed = yield* tokenSet(data, tokens);
      if (!renewed.refreshToken) {
        return yield* fail('ChatGPT did not return a replacement refresh token. Sign in again.');
      }
      const idToken = idTokenOf(data).pipe(Option.filter((token) => token !== ''));
      if (Option.isSome(idToken)) {
        const identity = yield* issuer.identity(idToken, profile.id);
        if (identity.sub !== profile.subject) {
          return yield* fail('ChatGPT account changed during renewal.');
        }
      }
      yield* update((state) =>
        updateProfile(state, profile.id, (saved) => ({ ...saved, tokens: renewed, frozen: false })),
      );
      yield* persist;
      return renewed.accessToken;
    }).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          const message =
            'ChatGPT needs a new sign-in. The previous refresh token will not be retried.';
          yield* update((state) => ({
            ...updateProfile(state, profile.id, (saved) => ({ ...saved, frozen: true })),
            message,
          }));
          yield* persist;
          return yield* new ChatGPTAuthError({ message });
        }),
      ),
    );

  /** The active token; renewed when it is about to expire or ChatGPT rejected `rejected`. */
  const token = Effect.fnUntraced(function* (rejected: Option.Option<Redacted.Redacted<string>>) {
    const current = yield* read;
    if (current.signingOut) {
      return yield* fail('Wisp is disconnecting.');
    }
    const profile = activeProfile(current);
    if (!profile?.tokens || profile.frozen) {
      return yield* fail('Sign in with ChatGPT in Wisp desktop.');
    }
    if (!hasPlan(profile.tokens)) {
      return yield* fail('Allow Wisp to use your ChatGPT plan in the sign-in screen.');
    }
    const tokens = profile.tokens;
    const wasRejected =
      Option.isSome(rejected) &&
      Redacted.value(rejected.value) === Redacted.value(tokens.accessToken);
    if (!wasRejected && tokens.expiresAt - (yield* Clock.currentTimeMillis) > RENEW_BEFORE) {
      return tokens.accessToken;
    }
    const inFlight = yield* FiberMap.get(refreshes, profile.id);
    const renewal = Option.isSome(inFlight)
      ? inFlight.value
      : yield* FiberMap.run(refreshes, profile.id, refresh(profile, tokens));
    return yield* Fiber.join(renewal);
  });

  const accessToken = token(Option.none()).pipe(Effect.withSpan('ChatGPTAuth.accessToken'));

  const disconnect = Effect.gen(function* () {
    yield* stopAttempt(true);
    yield* update((state) => ({ ...state, signingOut: true }));
    yield* Effect.gen(function* () {
      const id = activeProfile(yield* read)?.id;
      if (id === undefined) {
        yield* setMessage('Wisp disconnected. Your other apps stay signed in.');
        return;
      }
      const renewal = yield* FiberMap.get(refreshes, id);
      if (Option.isSome(renewal)) {
        yield* Fiber.await(renewal.value);
      }
      const refreshToken = (yield* read).saved.profiles.find((profile) => profile.id === id)?.tokens
        ?.refreshToken;
      const confirmed = refreshToken
        ? yield* issuer.revoke(refreshToken, id).pipe(
            Effect.catch((error) =>
              // The message below already says that revocation was not confirmed.
              Effect.logWarning('Token revocation could not be confirmed').pipe(
                Effect.annotateLogs({ event: 'auth.revoke_failed', error: errorMessage(error) }),
                Effect.as(false),
              ),
            ),
          )
        : true;
      yield* update((state) =>
        updateProfile(state, id, (profile) => ({ ...profile, tokens: undefined, frozen: false })),
      );
      yield* persist;
      yield* setMessage(
        confirmed
          ? 'Wisp disconnected. Your other apps stay signed in.'
          : 'Disconnected locally. Remote revocation could not be confirmed; review Wisp in ChatGPT Settings.',
      );
    }).pipe(
      Effect.ensuring(
        update((state) => ({ ...state, signingOut: false, revision: state.revision + 1 })),
      ),
    );
    return yield* state;
  }).pipe(Effect.withSpan('ChatGPTAuth.disconnect'));

  const authorized = Effect.fn('ChatGPTAuth.authorized')(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    if (!ENDPOINTS.has(request.url)) {
      return yield* fail('Unsupported ChatGPT endpoint.');
    }
    const requestScope = yield* Effect.scope;
    // Each attempt gets its own scope, so a rejected response can be released alone.
    const send = Effect.fnUntraced(function* (accessToken: Redacted.Redacted<string>) {
      const attemptScope = yield* Scope.fork(requestScope);
      const response = yield* scopedClient
        .execute(HttpClientRequest.bearerToken(request, accessToken))
        .pipe(Effect.mapError(requestFailed), Scope.provide(attemptScope));
      return { response, attemptScope };
    });
    const accessToken = yield* token(Option.none());
    const first = yield* send(accessToken);
    if (first.response.status !== 401) {
      return first.response;
    }
    yield* Scope.close(first.attemptScope, Exit.void);
    const second = yield* send(yield* token(Option.some(accessToken)));
    if (second.response.status === 401) {
      const id = activeProfile(yield* read)?.id;
      if (id !== undefined) {
        yield* update((state) =>
          updateProfile(state, id, (profile) => ({ ...profile, frozen: true })),
        );
        yield* persist;
      }
      yield* setMessage('ChatGPT rejected this session. Please sign in again.');
    }
    return second.response;
  });

  const models = Effect.gen(function* () {
    const id = activeProfile(yield* read)?.id;
    const cache = yield* Ref.get(modelsCache);
    if (
      Option.isSome(cache) &&
      cache.value.id === id &&
      (yield* Clock.currentTimeMillis) - cache.value.at < MODELS_TTL
    ) {
      return cache.value.models;
    }
    const data = yield* Effect.gen(function* () {
      const response = yield* authorized(HttpClientRequest.get(RESOURCE + '/models'));
      if (response.status < 200 || response.status >= 300) {
        return yield* fail('Could not load models for this ChatGPT account.');
      }
      return yield* response.json.pipe(Effect.mapError(requestFailed));
    }).pipe(Effect.scoped, withDeadline('15 seconds'));
    const catalog = yield* Schema.decodeUnknownEffect(ModelCatalog)(data).pipe(
      Effect.mapError(
        () => new ChatGPTAuthError({ message: 'ChatGPT returned an unexpected model catalog.' }),
      ),
    );
    const listed = catalog.models.flatMap((entry) =>
      Option.match(decodeListedModel(entry), {
        onNone: () => [],
        onSome: (model) => [accountModel(model)],
      }),
    );
    yield* Ref.set(
      modelsCache,
      Option.some({ id, models: listed, at: yield* Clock.currentTimeMillis }),
    );
    return listed;
  }).pipe(Effect.withSpan('ChatGPTAuth.models'));

  // A sign-in still open when Wisp stops is cancelled first.
  yield* Effect.addFinalizer(() => stopAttempt(true));

  return ChatGPTAuth.of({
    state,
    beginSignIn,
    cancel,
    select,
    accessToken,
    disconnect,
    models,
    authorized,
  });
});

/** ChatGPTAuth keeping its files (the install's host identifier) in `directory`. */
export const layerAt = (directory: string) => Layer.effect(ChatGPTAuth, make(directory));

/** ChatGPTAuth keeping its files in the runtime folder from `AppConfig`. */
export const layer = Layer.effect(
  ChatGPTAuth,
  Effect.gen(function* () {
    const { paths } = yield* AppConfig;
    return yield* make(paths.runtime);
  }),
);

/** What the unmigrated consumers pass to `authorized`. */
export interface ChatGPTRequestInit {
  readonly method: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/**
 * The Promise interface the consumers that are not migrated yet take.
 * `runtime.ts` adapts `ChatGPTAuth` to it; remove it when they migrate.
 * Rejections carry what the consumers checked before: a `ChatGPTAuthError`,
 * or what `fetch` failed with.
 */
export interface PromiseChatGPTAuth {
  state(): ChatGPTAuthState;
  /** True while a browser sign-in is in progress. */
  readonly pending: boolean;
  beginSignIn(profileId?: string, newAccount?: boolean): Promise<{ authorizationUrl: string }>;
  cancel(): Promise<void>;
  select(id: string): Promise<ChatGPTAuthState>;
  accessToken(): Promise<string>;
  disconnect(): Promise<ChatGPTAuthState>;
  models(): Promise<readonly AccountModel[]>;
  authorized(url: string, init: ChatGPTRequestInit): Promise<Response>;
}
