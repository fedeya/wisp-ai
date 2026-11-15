import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const versioningStart = 'scripts/addon-release-version.ts';
const addonInputs = ['addon/WispAI', 'packages/protocol/src/addon-helpers.ts'];

export function addonReleaseVersion(root: string): string {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('rev-parse', '--is-shallow-repository') === 'true') {
    throw Error('Addon release version requires a full Git checkout. Fetch the complete history.');
  }
  const start = git(
    'log',
    '--first-parent',
    '--diff-filter=A',
    '-1',
    '--format=%H',
    '--',
    versioningStart,
  );
  if (!start) {
    throw Error('Addon release version requires a commit that includes the versioning script.');
  }
  const patch = git(
    'rev-list',
    '--first-parent',
    '--count',
    `${start}..HEAD`,
    '--',
    ...addonInputs,
  );
  return `1.0.${patch}`;
}

export async function stampAddonReleaseVersion(toc: string, version: string): Promise<void> {
  const source = await readFile(toc, 'utf8');
  const header = /^(##[\t ]*Version:[\t ]*)[^\r\n]*/m;
  if (!header.test(source)) {
    throw Error('Missing Version header in bundled WispAI.toc.');
  }
  await writeFile(
    toc,
    source.replace(header, (_match, prefix: string) => prefix + version),
  );
}
