import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { updateManifest } from '../update-manifest.ts';
import { verifyReleaseAssets, verifyUpdaterSignature } from '../verify-release-assets.ts';
import { temporaryDirectory } from './fixtures.ts';

const version = '0.3.3-nightly.217.1';
const name = `WispAI-${version}-windows-x64-setup.exe`;

const nightlyManifest = (manifestVersion: string, signature: string) =>
  Effect.map(updateManifest(manifestVersion, signature, '', 'nightly'), (manifest) =>
    JSON.stringify(manifest),
  );

function minisignKey(keyId = Buffer.from('0862f6324cc0450a', 'hex')) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const encoded = Buffer.from(
    `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`,
  ).toString('base64');
  return { publicKey: encoded, privateKey, keyId };
}

// Signs like `tauri signer`: a prehashed (BLAKE2b-512) minisign signature, base64-encoded.
function tauriSignature(data: Buffer, privateKey: KeyObject, keyId: Buffer) {
  const signature = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
  const trusted = `timestamp:1795419910\tfile:Wisp AI_${version}_x64-setup.exe`;
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
  return Buffer.from(
    [
      'untrusted comment: signature from tauri secret key',
      Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64'),
      `trusted comment: ${trusted}`,
      global.toString('base64'),
      '',
    ].join('\n'),
  ).toString('base64');
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const releaseFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const folder = yield* temporaryDirectory('wisp-release-assets-');
  const key = minisignKey();
  const installer = Buffer.from('installer payload '.repeat(1000));
  const signature = tauriSignature(installer, key.privateKey, key.keyId);
  const file = `${folder}/${name}`;
  yield* fs.writeFile(file, installer);
  yield* fs.writeFileString(file + '.sig', signature);
  yield* fs.writeFileString(file + '.sha256', `${sha256(installer)}  ${name}\n`);
  yield* fs.writeFileString(`${folder}/latest.json`, yield* nightlyManifest(version, signature));
  return { folder, file, installer, signature, key };
});

const failure = <R>(effect: Effect.Effect<unknown, { readonly message: string }, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.message);

layer(NodeServices.layer)((it) => {
  it.effect('complete, signed release assets pass', () =>
    Effect.gen(function* () {
      const { folder, key } = yield* releaseFolder;
      yield* verifyReleaseAssets(folder, version, key.publicKey);
    }),
  );

  it.effect('a truncated installer is rejected before it is published', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { folder, file, installer, key } = yield* releaseFolder;
      yield* fs.writeFile(file, installer.subarray(0, installer.length / 4));
      expect(yield* failure(verifyReleaseAssets(folder, version, key.publicKey))).toContain(
        'SHA-256',
      );
    }),
  );

  it.effect('missing signature or checksum files are rejected', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { folder, file, key } = yield* releaseFolder;
      yield* fs.remove(file + '.sig');
      expect(yield* failure(verifyReleaseAssets(folder, version, key.publicKey))).toBe(
        `Missing release asset ${name}.sig.`,
      );
      yield* fs.remove(file + '.sha256');
      expect(yield* failure(verifyReleaseAssets(folder, version, key.publicKey))).toBe(
        `Missing release asset ${name}.sha256.`,
      );
    }),
  );

  it.effect('an installer signed by another key is rejected', () =>
    Effect.gen(function* () {
      const { installer, signature } = yield* releaseFolder;
      const other = minisignKey();
      expect(
        yield* failure(verifyUpdaterSignature(installer, signature, other.publicKey)),
      ).toContain('does not match');
      const otherId = minisignKey(Buffer.from('0102030405060708', 'hex'));
      expect(
        yield* failure(verifyUpdaterSignature(installer, signature, otherId.publicKey)),
      ).toContain('different key');
    }),
  );

  it.effect('an installer whose checksum was rewritten still fails its signature', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { folder, file, installer, key } = yield* releaseFolder;
      const changed = Buffer.concat([installer, Buffer.from('x')]);
      yield* fs.writeFile(file, changed);
      yield* fs.writeFileString(file + '.sha256', `${sha256(changed)}  ${name}\n`);
      expect(yield* failure(verifyReleaseAssets(folder, version, key.publicKey))).toContain(
        'updater signature',
      );
    }),
  );

  it.effect('a manifest with another signature or version is rejected', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { folder, key, signature } = yield* releaseFolder;
      const manifest = `${folder}/latest.json`;
      yield* fs.writeFileString(manifest, yield* nightlyManifest(version, signature + 'x'));
      expect(yield* failure(verifyReleaseAssets(folder, version, key.publicKey))).toContain(
        'different signature',
      );
      yield* fs.writeFileString(manifest, yield* nightlyManifest('0.3.3-nightly.218.1', signature));
      expect(yield* failure(verifyReleaseAssets(folder, version, key.publicKey))).toContain(
        'different version',
      );
    }),
  );
});
