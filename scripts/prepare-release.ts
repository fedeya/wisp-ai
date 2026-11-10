import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { syncVersion, nightlyBuildVersion } from './release-version.ts';
import { nightlyNotes, validateNotes } from './release-notes.ts';

const nightly = process.env.GITHUB_REF === 'refs/heads/main';
let version = JSON.parse(await readFile('package.json', 'utf8')).version;
if (nightly) {
  version = nightlyBuildVersion(
    version,
    process.env.GITHUB_RUN_NUMBER!,
    process.env.GITHUB_RUN_ATTEMPT!,
  );
  await syncVersion(version);
} else if (process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw Error('Release tag must match the app version.');
}
const notes = nightly
  ? await nightlyNotes(process.env.GITHUB_SHA!)
  : validateNotes(await readFile(`releases/${version}.md`, 'utf8'));
await mkdir('dist', { recursive: true });
await writeFile('dist/release-notes.md', notes);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `version=${version}\ntag=v${version}\nnightly=${nightly}\n`,
  );
}
