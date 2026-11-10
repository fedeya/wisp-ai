import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nonAppInputs = [
  /^(?:apps\/web|docs|releases|\.agents|\.github)\//,
  /(?:^|\/)AGENTS\.md$/,
  /(?:^|\/)README\.[^/]*$/,
  /^scripts\/(?:revalidate-web\.ts|tests\/revalidate-web\.test\.ts)$/,
];

export function needsAppRelease(files: readonly string[]): boolean {
  return files.some((file) => !nonAppInputs.some((pattern) => pattern.test(file)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const before = process.env.RELEASE_BASE_SHA;
  // Tags, manual builds and the first push have no previous branch range to filter.
  const branchPush =
    process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF_TYPE === 'branch';
  const files =
    branchPush && before && !/^0+$/.test(before)
      ? execFileSync(
          'git',
          ['diff', '--name-only', '--no-renames', '-z', before, process.env.GITHUB_SHA!],
          {
            encoding: 'utf8',
          },
        )
          .split('\0')
          .filter(Boolean)
      : undefined;
  const app = files === undefined || needsAppRelease(files);
  console.log('Build app release: ' + app);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `app=${app}\n`);
  }
}
