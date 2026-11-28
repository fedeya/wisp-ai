// @effect-migrated
import { Clock, Duration, Effect, Exit, Option, Redacted, Schedule, Schema, Scope } from 'effect';
import { Signature } from 'effect/crypto';
import { HttpClient, HttpClientRequest } from 'effect/http';
import type { HttpClientResponse } from 'effect/http';
import { Jwk, Jwks, Jwt } from 'effect/jose';
import { ChatGPTAuthError, requestFailed, withDeadline } from './errors.ts';
import { lenient } from './lenient.ts';
import type { TokenSet } from './profiles.ts';

export const ISSUER = 'https://auth.openai.com';
/** The API the tokens are issued for. */
export const RESOURCE = 'https://api.openai.com/v1';

/** A URL on the issuer itself, without credentials. */
const IssuerUrl = Schema.String.check(
  Schema.makeFilter((value: string) => {
    if (!URL.canParse(value)) {
      return false;
    }
    const url = new URL(value);
    return url.origin === ISSUER && !url.username && !url.password;
  }),
);

const IssuerField = Schema.Struct({ issuer: Schema.Literal(ISSUER) });

/** The OpenID configuration; a missing or empty revocation endpoint means none. */
const Discovery = Schema.Struct({
  authorization_endpoint: IssuerUrl,
  token_endpoint: IssuerUrl,
  jwks_uri: IssuerUrl,
  revocation_endpoint: Schema.optional(Schema.Union([Schema.Literal(''), Schema.Null, IssuerUrl])),
});
type Discovery = typeof Discovery.Type;

/** A token endpoint answer that grants access. */
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  token_type: Schema.Literal('Bearer'),
  scope: lenient(Schema.String),
  id_token: lenient(Schema.String),
  refresh_token: lenient(Schema.String),
});

const IdTokenField = Schema.Struct({ id_token: lenient(Schema.String) });

/**
 * The longest id token Wisp verifies, in characters. effect/jose verifies in
 * memory and leaves the bound to the application; OpenAI's id tokens are a few
 * kilobytes, so 16 KiB (Node's default limit for all of a request's headers)
 * leaves room for more claims while refusing an unreasonable one unparsed.
 */
export const MAX_ID_TOKEN_LENGTH = 16 * 1024;

/** The id token claims Wisp reads. */
const IdentityClaims = Schema.Struct({
  sub: Schema.String,
  nonce: Schema.optional(Schema.Unknown),
  email: lenient(Schema.String),
  name: lenient(Schema.String),
});
export type Identity = typeof IdentityClaims.Type;

/** Revocation answered with a server error; it is worth one more try. */
class RevocationUnavailable extends Schema.TaggedError<RevocationUnavailable>()(
  'RevocationUnavailable',
  {},
) {}

const isOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

/** Caches a success for good and retries a failure on the next call. */
const cachedSuccess = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.cachedWithTTL(effect, (exit: Exit.Exit<A, E>) =>
    Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
  );

/** The id token in a token response, when it has one. */
export const idTokenOf = (data: unknown) =>
  Schema.decodeUnknownOption(IdTokenField)(data).pipe(
    Option.flatMap(({ id_token }) => Option.fromUndefinedOr(id_token)),
  );

/**
 * The tokens in a token response. A renewal may omit the scopes and the id
 * token, which then carry over from `previous`.
 */
export const tokenSet = Effect.fnUntraced(function* (data: unknown, previous?: TokenSet) {
  const response = yield* Schema.decodeUnknownEffect(TokenResponse)(data).pipe(
    Effect.mapError(
      () => new ChatGPTAuthError({ message: 'ChatGPT returned an invalid token response.' }),
    ),
  );
  const scopes =
    response.scope === undefined ? previous?.scopes : response.scope.split(/\s+/).filter(Boolean);
  if (!scopes) {
    return yield* new ChatGPTAuthError({
      message: 'ChatGPT did not confirm the granted permissions.',
    });
  }
  const idToken =
    response.id_token === undefined
      ? previous && Redacted.value(previous.idToken)
      : response.id_token;
  if (!idToken) {
    return yield* new ChatGPTAuthError({
      message: 'ChatGPT did not return a verifiable identity.',
    });
  }
  const now = yield* Clock.currentTimeMillis;
  return {
    accessToken: Redacted.make(response.access_token),
    refreshToken: response.refresh_token ? Redacted.make(response.refresh_token) : undefined,
    idToken: Redacted.make(idToken),
    expiresAt: now + response.expires_in * 1000,
    scopes,
  } satisfies TokenSet;
});

/**
 * OpenAI's sign-in service: its OpenID configuration, token endpoint,
 * revocation and the keys that sign id tokens. The configuration and key set
 * are fetched once and kept; a failed fetch is retried on the next call.
 */
export const makeIssuer = Effect.fnUntraced(function* (client: HttpClient.HttpClient) {
  const signature = yield* Signature.Signature;
  const scope = yield* Effect.scope;

  const discovery = yield* cachedSuccess(
    Effect.gen(function* () {
      const data = yield* Effect.gen(function* () {
        const response = yield* client
          .get(ISSUER + '/.well-known/openid-configuration')
          .pipe(Effect.mapError(requestFailed));
        if (!isOk(response)) {
          return yield* new ChatGPTAuthError({
            message: 'Cannot reach ChatGPT sign-in. Check your connection and retry.',
          });
        }
        return yield* response.json.pipe(Effect.mapError(requestFailed));
      }).pipe(withDeadline('15 seconds'));
      if (!Schema.is(IssuerField)(data)) {
        return yield* new ChatGPTAuthError({ message: 'ChatGPT returned an unexpected issuer.' });
      }
      return yield* Schema.decodeUnknownEffect(Discovery)(data).pipe(
        Effect.mapError(
          () =>
            new ChatGPTAuthError({
              message: 'ChatGPT returned an unexpected authentication endpoint.',
            }),
        ),
      );
    }),
  );

  // Like the key set jose kept before: fetched on first use, cached for ten
  // minutes and refetched at most every 30 seconds for an unknown key.
  const keySet = yield* cachedSuccess(
    discovery.pipe(
      Effect.flatMap(({ jwks_uri }) => Jwks.makeRemote({ url: jwks_uri })),
      Effect.provideService(HttpClient.HttpClient, client),
      Scope.provide(scope),
    ),
  );

  /** Posts a grant to the token endpoint and returns the JSON it answered with. */
  const exchange = Effect.fn('ChatGPTIssuer.exchange')(function* (
    parameters: Record<string, string>,
  ) {
    const { token_endpoint } = yield* discovery;
    return yield* Effect.gen(function* () {
      const response = yield* client
        .execute(
          HttpClientRequest.post(token_endpoint).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyUrlParams(parameters),
          ),
        )
        .pipe(Effect.mapError(requestFailed));
      if (!isOk(response)) {
        return yield* new ChatGPTAuthError({
          message:
            response.status === 400 || response.status === 401
              ? 'The ChatGPT session needs a new sign-in.'
              : 'ChatGPT could not complete authentication. Please try again.',
        });
      }
      return yield* response.json.pipe(Effect.mapError(requestFailed));
    }).pipe(withDeadline('15 seconds'));
  });

  /**
   * Verifies an id token against the issuer's keys and returns its claims.
   * With a `nonce`, the token must carry it. A token longer than
   * MAX_ID_TOKEN_LENGTH fails before it is parsed.
   */
  const identity = Effect.fn('ChatGPTIssuer.identity')(function* (
    token: Option.Option<string>,
    clientId: string,
    nonce?: string,
  ) {
    if (Option.isNone(token)) {
      return yield* new ChatGPTAuthError({
        message: 'ChatGPT did not return a verifiable identity.',
      });
    }
    if (token.value.length > MAX_ID_TOKEN_LENGTH) {
      yield* Effect.logWarning('ChatGPT returned an id token too long to verify').pipe(
        Effect.annotateLogs({ event: 'auth.id_token_too_long', length: token.value.length }),
      );
      return yield* new ChatGPTAuthError({ message: 'ChatGPT identity validation failed.' });
    }
    const jwks = yield* keySet;
    const { claims } = yield* Jwt.verifyWithKeySet(IdentityClaims, token.value, {
      issuer: ISSUER,
      audience: clientId,
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: '5 seconds',
      algorithms: Jwk.AsymmetricAlgorithm.literals,
    }).pipe(
      Effect.provideService(Jwks.Jwks, jwks),
      Effect.provideService(Signature.Signature, signature),
    );
    if (!claims.sub || (nonce !== undefined && claims.nonce !== nonce)) {
      return yield* new ChatGPTAuthError({ message: 'ChatGPT identity validation failed.' });
    }
    return claims;
  });

  /**
   * Revokes a refresh token. True only when the issuer confirmed it; a server
   * error is retried once after half a second.
   */
  const revoke = Effect.fn('ChatGPTIssuer.revoke')(function* (
    token: Redacted.Redacted<string>,
    clientId: string,
  ) {
    const { revocation_endpoint } = yield* discovery;
    if (!revocation_endpoint) {
      return false;
    }
    const attempt = client
      .execute(
        HttpClientRequest.post(revocation_endpoint).pipe(
          HttpClientRequest.bodyUrlParams({
            token: Redacted.value(token),
            token_type_hint: 'refresh_token',
            client_id: clientId,
          }),
        ),
      )
      .pipe(
        Effect.mapError(requestFailed),
        withDeadline('8 seconds'),
        Effect.flatMap((response) =>
          response.status >= 500
            ? Effect.fail(new RevocationUnavailable())
            : Effect.succeed(response.status === 200),
        ),
      );
    return yield* attempt.pipe(
      Effect.retry({
        schedule: Schedule.spaced('500 millis'),
        times: 1,
        while: (error) => error._tag === 'RevocationUnavailable',
      }),
      Effect.catchTag('RevocationUnavailable', () => Effect.succeed(false)),
    );
  });

  return { discovery, exchange, identity, revoke };
});

export type Issuer = Effect.Success<ReturnType<typeof makeIssuer>>;
export type { Discovery };
