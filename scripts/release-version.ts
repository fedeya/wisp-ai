import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseChannel } from '@wisp/releases';

export async function syncVersion(version: string, root = process.cwd()) {
  releaseChannel(version);
  const paths = ['package.json'];
  for (const group of ['apps', 'packages']) {
    for (const entry of await readdir(resolve(root, group), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        paths.push(`${group}/${entry.name}/package.json`);
      }
    }
  }
  paths.push(
    'scripts/package.json',
    'tests/package.json',
    'addon/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
  );
  for (const path of paths) {
    const file = resolve(root, path);
    const content = await readFile(file, 'utf8');
    await writeFile(file, content.replace(/("version"\s*:\s*")[^"]+"/, `$1${version}"`));
  }
  const cargo = resolve(root, 'apps/desktop/src-tauri/Cargo.toml');
  await writeFile(
    cargo,
    (await readFile(cargo, 'utf8')).replace(/^(version = ")[^"]+"/m, `$1${version}"`),
  );
  const lock = resolve(root, 'apps/desktop/src-tauri/Cargo.lock');
  await writeFile(
    lock,
    (await readFile(lock, 'utf8')).replace(
      /(\[\[package\]\]\r?\nname = "wisp"\r?\nversion = ")[^"]+"/,
      `$1${version}"`,
    ),
  );
}
export function nightlyBuildVersion(stable: string, run: string, attempt: string) {
  if (!/^\d+\.\d+\.\d+$/.test(stable) || !/^\d+$/.test(run) || !/^\d+$/.test(attempt)) {
    throw Error('Invalid nightly build identity.');
  }
  const [major, minor, patch] = stable.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}-nightly.${run}.${attempt}`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await syncVersion(process.argv[2]);
}
