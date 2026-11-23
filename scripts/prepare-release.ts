import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { syncVersion, nightlyBuildVersion, newerStable } from './release-version.ts';
import {
  latestStableTag,
  nightlyNotes,
  previousPublishedNightly,
  stableNotes,
} from './release-notes.ts';

// RELEASE_CHANNEL and RELEASE_VERSION come from the release workflow's resolve job.
// The version is stamped into this checkout only; main is updated after publication.
const sha = process.env.GITHUB_SHA!;
const nightly = process.env.RELEASE_CHANNEL !== 'stable';
let version: string;
let notes: string;
if (nightly) {
  // After a stable promotion and before main records it, the tag is ahead.
  const committed = JSON.parse(await readFile('package.json', 'utf8')).version;
  const stable = latestStableTag(sha)?.slice(1);
  const base = stable && newerStable(stable, committed) ? stable : committed;
  version = nightlyBuildVersion(
    base,
    process.env.GITHUB_RUN_NUMBER!,
    process.env.GITHUB_RUN_ATTEMPT!,
  );
  await syncVersion(version);
  const previous = await previousPublishedNightly(version, sha);
  notes = await nightlyNotes(sha, process.cwd(), previous);
} else {
  version = process.env.RELEASE_VERSION!;
  notes = stableNotes(version);
  await syncVersion(version);
}
await mkdir('dist', { recursive: true });
await writeFile('dist/release-notes.md', notes);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `version=${version}\ntag=v${version}\nnightly=${nightly}\n`,
  );
}
