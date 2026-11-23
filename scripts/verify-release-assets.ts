import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The publish job downloads the build from another runner. A download that stops
// early can leave a truncated installer, so check every asset before uploading it.

const ed25519Spki = Buffer.from('302a300506032b6570032100', 'hex');

function minisignLines(encoded: string, what: string) {
  const lines = Buffer.from(encoded.trim(), 'base64').toString('utf8').split(/\r?\n/);
  if (!lines[0]?.startsWith('untrusted comment:') || !lines[1]) {
    throw Error(`The ${what} is not a minisign ${what}.`);
  }
  return lines;
}

/** Verifies a Tauri updater signature (base64 minisign) of `data` against a Tauri public key. */
export function verifyUpdaterSignature(data: Buffer, signature: string, publicKey: string) {
  const key = Buffer.from(minisignLines(publicKey, 'public key')[1], 'base64');
  const lines = minisignLines(signature, 'signature');
  const sig = Buffer.from(lines[1], 'base64');
  if (key.length !== 42 || sig.length !== 74 || key.subarray(0, 2).toString() !== 'Ed') {
    throw Error('Unexpected minisign key or signature length.');
  }
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) {
    throw Error('The installer was signed with a different key than the app trusts.');
  }
  const algorithm = sig.subarray(0, 2).toString();
  if (algorithm !== 'ED' && algorithm !== 'Ed') {
    throw Error('Unknown minisign signature algorithm.');
  }
  const publicKeyObject = createPublicKey({
    key: Buffer.concat([ed25519Spki, key.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, publicKeyObject, sig.subarray(10))) {
    throw Error('The installer does not match its updater signature.');
  }
  const trusted = lines[2]?.replace(/^trusted comment: /, '');
  const global = lines[3] && Buffer.from(lines[3], 'base64');
  if (
    trusted === undefined ||
    !global ||
    !verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), publicKeyObject, global)
  ) {
    throw Error('The updater signature comment is not signed.');
  }
}

export async function verifyReleaseAssets(folder: string, version: string, publicKey: string) {
  const name = `WispAI-${version}-windows-x64-setup.exe`;
  const installer = path.join(folder, name);
  const read = (file: string) =>
    readFile(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw Error(`Missing release asset ${path.basename(file)}.`);
      }
      throw error;
    });
  const text = async (file: string) => (await read(file)).toString('utf8');
  const data = await read(installer);
  const checksum = (await text(installer + '.sha256')).trim().split(/\s+/);
  if (checksum[1] !== name) {
    throw Error('The checksum file names a different installer.');
  }
  if (createHash('sha256').update(data).digest('hex') !== checksum[0]) {
    throw Error('The installer does not match its SHA-256 checksum.');
  }
  const signature = (await text(installer + '.sig')).trim();
  verifyUpdaterSignature(data, signature, publicKey);
  const manifest = JSON.parse(await text(path.join(folder, 'latest.json')));
  const platform = manifest.platforms?.['windows-x86_64'];
  if (manifest.version !== version) {
    throw Error('The update manifest names a different version.');
  }
  if (platform?.signature !== signature) {
    throw Error('The update manifest carries a different signature than the installer.');
  }
  if (typeof platform.url !== 'string' || !platform.url.endsWith(`/v${version}/${name}`)) {
    throw Error('The update manifest points at a different installer.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const config = JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
  await verifyReleaseAssets('dist', version, config.plugins.updater.pubkey);
  console.log(`Release assets for ${version} are complete and signed.`);
}
