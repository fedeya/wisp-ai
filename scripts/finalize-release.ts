import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { newerNightly } from '@wisp/releases';

// Publish the manifest last, after the draft contains every referenced artifact.
const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
if (tag !== `v${version}`) {
  throw Error('Release tag does not match the app version.');
}
const release = JSON.parse(
  execFileSync('gh', ['release', 'view', tag, '--json', 'body,isDraft'], {
    encoding: 'utf8',
    windowsHide: true,
  }),
);
if (!release.isDraft) {
  throw Error('Only draft releases can be prepared.');
}
const manifest = JSON.parse(await readFile('dist/latest.json', 'utf8'));
if (manifest.version !== version) {
  throw Error('Update manifest version does not match.');
}
manifest.notes = release.body || manifest.notes;
await writeFile('dist/latest.json', JSON.stringify(manifest, null, 2) + '\n');
execFileSync('gh', ['release', 'upload', tag, 'dist/latest.json', '--clobber'], {
  stdio: 'inherit',
  windowsHide: true,
});
if (process.env.RELEASE_NIGHTLY === 'true') {
  execFileSync('gh', ['release', 'edit', tag, '--draft=false', '--prerelease', '--latest=false'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  // The moving feed is updated last. Installer URLs remain immutable versioned URLs.
  let existing;
  try {
    existing = JSON.parse(
      execFileSync('gh', ['release', 'view', 'nightly', '--json', 'assets'], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
  } catch {
    execFileSync(
      'gh',
      [
        'release',
        'create',
        'nightly',
        '--target',
        process.env.GITHUB_SHA!,
        '--prerelease',
        '--latest=false',
        '--title',
        'Nightly update feed',
        '--notes',
        'Experimental builds from main.',
      ],
      { stdio: 'inherit', windowsHide: true },
    );
  }
  if (existing?.assets.some((asset: { name: string }) => asset.name === 'latest.json')) {
    const previous = JSON.parse(
      execFileSync(
        'gh',
        ['release', 'download', 'nightly', '--pattern', 'latest.json', '--output', '-'],
        { encoding: 'utf8', windowsHide: true },
      ),
    );
    if (!newerNightly(version, previous.version)) {
      console.log('A newer nightly is already available; leaving its feed unchanged.');
      process.exit(0);
    }
  }
  execFileSync('gh', ['release', 'upload', 'nightly', 'dist/latest.json', '--clobber'], {
    stdio: 'inherit',
    windowsHide: true,
  });
}
