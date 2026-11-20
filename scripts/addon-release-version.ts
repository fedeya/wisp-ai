import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { addonVersionFromToc } from '../apps/bridge/src/addon/addon-version.ts';

const versioningStart = 'scripts/addon-release-version.ts';
const addonToc = 'addon/WispAI/WispAI.toc';
const addonInputs = ['addon/WispAI', 'packages/protocol/src/addon-helpers.ts'];

export function addonReleaseVersion(root: string, ref = 'HEAD'): string {
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
    ref,
    '--',
    versioningStart,
  );
  if (!start) {
    throw Error('Addon release version requires a commit that includes the versioning script.');
  }
  const baseAt = (commit: string) => addonVersionFromToc(git('show', `${commit}:${addonToc}`));
  const base = baseAt(ref);
  const versionLine = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/.exec(base ?? '');
  if (!versionLine) {
    throw Error(`Set the addon base version in ${addonToc} to MAJOR.MINOR.0.`);
  }

  const tocChanges = git(
    'log',
    '--first-parent',
    '--diff-filter=AM',
    '--format=%H',
    `${start}..${ref}`,
    '--',
    addonToc,
  )
    .split(/\r?\n/)
    .filter(Boolean);
  // Find the start of the current base without resetting on unrelated TOC edits.
  let baseCommit = start;
  for (const commit of [...tocChanges, start]) {
    if (baseAt(commit) !== base) break;
    baseCommit = commit;
  }

  const patch = git(
    'rev-list',
    '--first-parent',
    '--count',
    `${baseCommit}..${ref}`,
    '--',
    ...addonInputs,
  );
  return `${versionLine[1]}.${versionLine[2]}.${patch}`;
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
