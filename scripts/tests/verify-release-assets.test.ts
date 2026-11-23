import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { updateManifest } from '../update-manifest.ts';
import { verifyReleaseAssets, verifyUpdaterSignature } from '../verify-release-assets.ts';

const version = '0.3.3-nightly.217.1';
const name = `WispAI-${version}-windows-x64-setup.exe`;
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true })));
});

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

async function releaseFolder() {
  const folder = await mkdtemp(path.join(tmpdir(), 'wisp-release-assets-'));
  folders.push(folder);
  const key = minisignKey();
  const installer = Buffer.from('installer payload '.repeat(1000));
  const signature = tauriSignature(installer, key.privateKey, key.keyId);
  const file = path.join(folder, name);
  await writeFile(file, installer);
  await writeFile(file + '.sig', signature);
  await writeFile(
    file + '.sha256',
    `${createHash('sha256').update(installer).digest('hex')}  ${name}\n`,
  );
  await writeFile(
    path.join(folder, 'latest.json'),
    JSON.stringify(updateManifest(version, signature, '', 'nightly')),
  );
  return { folder, file, installer, signature, key };
}

test('complete, signed release assets pass', async () => {
  const { folder, key } = await releaseFolder();
  await expect(verifyReleaseAssets(folder, version, key.publicKey)).resolves.toBeUndefined();
});

test('a truncated installer is rejected before it is published', async () => {
  const { folder, file, installer, key } = await releaseFolder();
  await writeFile(file, installer.subarray(0, installer.length / 4));
  await expect(verifyReleaseAssets(folder, version, key.publicKey)).rejects.toThrow('SHA-256');
});

test('missing signature or checksum files are rejected', async () => {
  const { folder, file, key } = await releaseFolder();
  await unlink(file + '.sig');
  await expect(verifyReleaseAssets(folder, version, key.publicKey)).rejects.toThrow(
    `Missing release asset ${name}.sig`,
  );
  await unlink(file + '.sha256');
  await expect(verifyReleaseAssets(folder, version, key.publicKey)).rejects.toThrow(
    `Missing release asset ${name}.sha256`,
  );
});

test('an installer signed by another key is rejected', async () => {
  const { installer, signature } = await releaseFolder();
  const other = minisignKey();
  expect(() => verifyUpdaterSignature(installer, signature, other.publicKey)).toThrow(
    'does not match',
  );
  const otherId = minisignKey(Buffer.from('0102030405060708', 'hex'));
  expect(() => verifyUpdaterSignature(installer, signature, otherId.publicKey)).toThrow(
    'different key',
  );
});

test('an installer whose checksum was rewritten still fails its signature', async () => {
  const { folder, file, installer, key } = await releaseFolder();
  const changed = Buffer.concat([installer, Buffer.from('x')]);
  await writeFile(file, changed);
  await writeFile(
    file + '.sha256',
    `${createHash('sha256').update(changed).digest('hex')}  ${name}\n`,
  );
  await expect(verifyReleaseAssets(folder, version, key.publicKey)).rejects.toThrow(
    'updater signature',
  );
});

test('a manifest with another signature or version is rejected', async () => {
  const { folder, key, signature } = await releaseFolder();
  const manifest = path.join(folder, 'latest.json');
  await writeFile(
    manifest,
    JSON.stringify(updateManifest(version, signature + 'x', '', 'nightly')),
  );
  await expect(verifyReleaseAssets(folder, version, key.publicKey)).rejects.toThrow(
    'different signature',
  );
  await writeFile(
    manifest,
    JSON.stringify(updateManifest('0.3.3-nightly.218.1', signature, '', 'nightly')),
  );
  await expect(verifyReleaseAssets(folder, version, key.publicKey)).rejects.toThrow(
    'different version',
  );
});
