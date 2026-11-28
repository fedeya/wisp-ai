// @effect-migrated
// The publish job downloads the build from another runner. A download that stops
// early can leave a truncated installer, so check every asset before uploading it.
//   node scripts/verify-release-assets.ts   checks dist/ against package.json and the app's updater key
import { createHash, createPublicKey, verify } from 'node:crypto';
import { Console, Effect, FileSystem, Path, Schema } from 'effect';
import { Command } from 'effect/cli';
import { runScript } from './run-script.ts';

export class ReleaseAssetInvalid extends Schema.TaggedError<ReleaseAssetInvalid>()(
  'ReleaseAssetInvalid',
  { message: Schema.String },
) {}

const invalid = (message: string) => new ReleaseAssetInvalid({ message });

const ed25519Spki = Buffer.from('302a300506032b6570032100', 'hex');

/** The lines of a minisign file, and its base64 payload on the line after the untrusted comment. */
const minisignLines = Effect.fnUntraced(function* (encoded: string, what: string) {
  const lines = Buffer.from(encoded.trim(), 'base64').toString('utf8').split(/\r?\n/);
  const [comment, payload] = lines;
  if (!comment?.startsWith('untrusted comment:') || !payload) {
    return yield* invalid(`The ${what} is not a minisign ${what}.`);
  }
  return { lines, payload };
});

/** Verifies a Tauri updater signature (base64 minisign) of `data` against a Tauri public key. */
export const verifyUpdaterSignature = Effect.fnUntraced(function* (
  data: Uint8Array,
  signature: string,
  publicKey: string,
) {
  const key = Buffer.from((yield* minisignLines(publicKey, 'public key')).payload, 'base64');
  const { lines, payload } = yield* minisignLines(signature, 'signature');
  const sig = Buffer.from(payload, 'base64');
  if (key.length !== 42 || sig.length !== 74 || key.subarray(0, 2).toString() !== 'Ed') {
    return yield* invalid('Unexpected minisign key or signature length.');
  }
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) {
    return yield* invalid('The installer was signed with a different key than the app trusts.');
  }
  const algorithm = sig.subarray(0, 2).toString();
  if (algorithm !== 'ED' && algorithm !== 'Ed') {
    return yield* invalid('Unknown minisign signature algorithm.');
  }
  const publicKeyObject = createPublicKey({
    key: Buffer.concat([ed25519Spki, key.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, publicKeyObject, sig.subarray(10))) {
    return yield* invalid('The installer does not match its updater signature.');
  }
  const trusted = lines[2]?.replace(/^trusted comment: /, '');
  const global = lines[3] && Buffer.from(lines[3], 'base64');
  if (
    trusted === undefined ||
    !global ||
    !verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), publicKeyObject, global)
  ) {
    return yield* invalid('The updater signature comment is not signed.');
  }
});

/** The part of latest.json that names the installer it was signed for. */
const UpdateManifest = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    platforms: Schema.optionalKey(
      Schema.Struct({
        'windows-x86_64': Schema.optionalKey(
          Schema.Struct({
            signature: Schema.optionalKey(Schema.String),
            url: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  }),
);

/** Fails unless `folder` holds `version`'s installer, its checksum, signature and update manifest, all matching. */
export const verifyReleaseAssets = Effect.fnUntraced(function* (
  folder: string,
  version: string,
  publicKey: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const name = `WispAI-${version}-windows-x64-setup.exe`;
  const installer = path.join(folder, name);
  const read = (file: string) =>
    fs
      .readFile(file)
      .pipe(
        Effect.mapError((error) =>
          error.reason._tag === 'NotFound'
            ? invalid(`Missing release asset ${path.basename(file)}.`)
            : error,
        ),
      );
  // Decoded as Buffer#toString does, so a byte order mark stays in the text.
  const text = (file: string) =>
    Effect.map(read(file), (bytes) => Buffer.from(bytes).toString('utf8'));
  const data = yield* read(installer);
  const checksum = (yield* text(installer + '.sha256')).trim().split(/\s+/);
  if (checksum[1] !== name) {
    return yield* invalid('The checksum file names a different installer.');
  }
  if (createHash('sha256').update(data).digest('hex') !== checksum[0]) {
    return yield* invalid('The installer does not match its SHA-256 checksum.');
  }
  const signature = (yield* text(installer + '.sig')).trim();
  yield* verifyUpdaterSignature(data, signature, publicKey);
  const manifest = yield* Schema.decodeEffect(UpdateManifest)(
    yield* text(path.join(folder, 'latest.json')),
  ).pipe(Effect.mapError(() => invalid('The update manifest is not an updater manifest.')));
  const platform = manifest.platforms?.['windows-x86_64'];
  if (manifest.version !== version) {
    return yield* invalid('The update manifest names a different version.');
  }
  if (platform?.signature !== signature) {
    return yield* invalid('The update manifest carries a different signature than the installer.');
  }
  if (!platform.url?.endsWith(`/v${version}/${name}`)) {
    return yield* invalid('The update manifest points at a different installer.');
  }
});

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const TauriConfig = Schema.fromJsonString(
  Schema.Struct({
    plugins: Schema.Struct({ updater: Schema.Struct({ pubkey: Schema.String }) }),
  }),
);

if (import.meta.main) {
  Command.make(
    'verify-release-assets',
    {},
    Effect.fn(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { version } = yield* Schema.decodeEffect(PackageJson)(
        yield* fs.readFileString('package.json'),
      );
      const config = yield* Schema.decodeEffect(TauriConfig)(
        yield* fs.readFileString('apps/desktop/src-tauri/tauri.conf.json'),
      );
      yield* verifyReleaseAssets('dist', version, config.plugins.updater.pubkey);
      yield* Console.log(`Release assets for ${version} are complete and signed.`);
    }),
  ).pipe(
    Command.withDescription('Check the downloaded release assets before they are published'),
    Command.run({ version: '1.0.0' }),
    runScript,
  );
}
