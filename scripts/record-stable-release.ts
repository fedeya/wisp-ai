import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stableVersion } from '@wisp/releases';
import { validateNotes } from './release-notes.ts';
import { newerStable, syncVersion } from './release-version.ts';

// Runs on main after a Stable release is published: archives its published notes,
// removes the Changie fragments that release shipped (fragments merged after the
// promoted Nightly stay for the next one) and moves main's version forward.
export async function recordStableRelease(tag: string, body: string, root = process.cwd()) {
  const version = tag.slice(1);
  if (!tag.startsWith('v') || !stableVersion.test(version)) {
    throw Error(`Not a stable tag: ${tag}`);
  }
  await writeFile(
    resolve(root, `releases/${version}.md`),
    validateNotes(body.replace(/\r\n/g, '\n')),
  );
  const shipped = execFileSync(
    'git',
    ['ls-tree', '--name-only', `${tag}^{commit}`, 'releases/unreleased/'],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  )
    .split('\n')
    .filter((path) => path.endsWith('.yaml'));
  for (const path of shipped) {
    await rm(resolve(root, path), { force: true });
  }
  const committed = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
  if (newerStable(version, committed)) {
    await syncVersion(version, root);
  }
  return shipped;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const shipped = await recordStableRelease(process.env.RELEASE_TAG!, process.env.RELEASE_BODY!);
  console.log(`Archived ${process.env.RELEASE_TAG} and ${shipped.length} shipped notes.`);
}
