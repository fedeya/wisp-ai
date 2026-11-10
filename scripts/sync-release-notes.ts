import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseChannel } from '@wisp/releases';
import { validateNotes } from './release-notes.ts';

type Manifest = { version: string; notes?: string; [key: string]: unknown };
type Release = { body: string; isDraft: boolean; isPrerelease: boolean };
export interface NotesStore {
  release(tag: string): Release;
  manifest(tag: string): Manifest;
  writeBody(tag: string, body: string): Promise<void>;
  writeManifest(tag: string, manifest: Manifest): Promise<void>;
}

export async function syncReleaseNotes(
  tag: string,
  content: string,
  store: NotesStore,
  apply = false,
) {
  const version = tag.replace(/^v/, '');
  const channel = releaseChannel(version);
  if (tag !== `v${version}`) {
    throw Error('Use a versioned release tag, such as v0.0.7.');
  }
  const notes = validateNotes(content);
  const release = store.release(tag);
  if (release.isPrerelease !== (channel === 'nightly')) {
    throw Error('Release channel does not match its version.');
  }
  const manifest = store.manifest(tag);
  if (manifest.version !== version) {
    throw Error('Release manifest version does not match its tag.');
  }
  const manifests = [{ tag, original: manifest }];
  if (channel === 'nightly' && !release.isDraft) {
    // Only change the moving feed when it still points at this build.
    const moving = store.manifest('nightly');
    if (moving.version === version) {
      manifests.push({ tag: 'nightly', original: moving });
    }
  }
  const targets = manifests.map((entry) => entry.tag);
  if (!apply) {
    return { applied: false, targets, notes };
  }

  const rollback: Array<() => Promise<void>> = [];
  try {
    for (const entry of manifests) {
      rollback.push(() => store.writeManifest(entry.tag, entry.original));
      await store.writeManifest(entry.tag, { ...entry.original, notes });
    }
    rollback.push(() => store.writeBody(tag, release.body));
    await store.writeBody(tag, notes);
    if (store.release(tag).body !== notes) {
      throw Error('Release body verification failed.');
    }
    for (const entry of manifests) {
      if (
        JSON.stringify(store.manifest(entry.tag)) !== JSON.stringify({ ...entry.original, notes })
      ) {
        throw Error(`Manifest verification failed for ${entry.tag}.`);
      }
    }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const undo of rollback.reverse()) {
      try {
        await undo();
      } catch (failure) {
        failures.push(failure);
      }
    }
    throw new AggregateError(
      failures,
      failures.length > 1
        ? 'Notes sync failed; rollback was incomplete. Inspect the release before retrying.'
        : 'Notes sync failed; previous notes were restored.',
    );
  }
  return { applied: true, targets, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, file, ...flags] = process.argv.slice(2);
  if (!tag || !file || flags.some((flag) => flag !== '--apply')) {
    throw Error('Usage: pnpm release:notes vX.Y.Z path/to/notes.md [--apply]');
  }
  const directory = await mkdtemp(join(tmpdir(), 'wisp-notes-'));
  if (!directory.startsWith(resolve(tmpdir()) + sep)) {
    throw Error('Unsafe temporary directory.');
  }
  const gh = (args: string[]) =>
    execFileSync('gh', [...args, '--repo', 'fedeya/wisp-ai'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  try {
    const result = await syncReleaseNotes(
      tag,
      await readFile(file, 'utf8'),
      {
        release: (target) =>
          JSON.parse(gh(['release', 'view', target, '--json', 'body,isDraft,isPrerelease'])),
        manifest: (target) =>
          JSON.parse(
            gh(['release', 'download', target, '--pattern', 'latest.json', '--output', '-']),
          ),
        async writeBody(target, body) {
          const filename = join(directory, 'notes.md');
          await writeFile(filename, body);
          gh(['release', 'edit', target, '--notes-file', filename]);
        },
        async writeManifest(target, manifest) {
          const filename = join(directory, 'latest.json');
          await writeFile(filename, JSON.stringify(manifest, null, 2) + '\n');
          gh(['release', 'upload', target, filename, '--clobber']);
        },
      },
      flags.includes('--apply'),
    );
    console.log(
      `${result.applied ? 'Updated' : 'Preview only:'} ${result.targets.join(', ')}\n\n${result.notes}`,
    );
    if (!result.applied) {
      console.log('Run again with --apply to synchronize the release body and updater notes.');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
