// @effect-migrated
import { Effect, FileSystem, Path, Schema } from 'effect';
import { SecureRandom } from 'effect/crypto';

/** A ChatGPT app registration Wisp signs in with. */
export const ClientId = Schema.String.check(Schema.isPattern(/^oaiapp_[A-Za-z0-9_-]+$/));

const Token = Schema.RedactedFromValue(Schema.NonEmptyString);

export const TokenSet = Schema.Struct({
  accessToken: Token,
  refreshToken: Schema.optional(Token),
  idToken: Token,
  /** Epoch milliseconds. */
  expiresAt: Schema.Finite,
  scopes: Schema.Array(Schema.String),
});
export type TokenSet = typeof TokenSet.Type;

export const Profile = Schema.Struct({
  id: ClientId,
  subject: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  tokens: Schema.optional(TokenSet),
  frozen: Schema.optional(Schema.Boolean),
});
export type Profile = typeof Profile.Type;

/** How many accounts Wisp keeps. */
export const MAX_PROFILES = 12;

/** The saved accounts, kept as JSON in the vault under `chatgpt:accounts`. */
const Saved = Schema.Struct({
  activeId: Schema.optional(Schema.String),
  profiles: Schema.Array(Profile).check(Schema.isMaxLength(MAX_PROFILES)),
});
export type Saved = typeof Saved.Type;
export const SavedJson = Schema.fromJsonString(Saved);

const HostFile = Schema.fromJsonString(
  Schema.Struct({ hostId: Schema.String.check(Schema.isPattern(/^urn:uuid:[0-9a-f-]{36}$/i)) }),
);

/**
 * The identifier ChatGPT knows this Wisp install by, from `chatgpt-host.json`
 * in `directory`. A missing file gets a new identifier, written owner-only.
 */
export const readHostId = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, 'chatgpt-host.json');
  const saved = yield* fs.readFileString(file).pipe(
    Effect.flatMap((text) => Schema.decodeEffect(HostFile)(text)),
    Effect.map(({ hostId }) => hostId),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.undefined),
  );
  if (saved !== undefined) {
    return saved;
  }
  const hostId = 'urn:uuid:' + (yield* (yield* SecureRandom.SecureRandom).uuidV4());
  yield* fs.writeFileString(file + '.tmp', yield* Schema.encodeEffect(HostFile)({ hostId }), {
    mode: 0o600,
  });
  yield* fs.rename(file + '.tmp', file);
  return hostId;
});
