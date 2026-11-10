import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { needsAppRelease } from '../release-inputs.ts';

const execute = promisify(execFile);

async function checkInputs(directory: string, environment: NodeJS.ProcessEnv) {
  const output = path.join(directory, 'outputs');
  await writeFile(output, '');
  await execute(
    process.execPath,
    [fileURLToPath(new URL('../release-inputs.ts', import.meta.url))],
    {
      cwd: directory,
      windowsHide: true,
      env: { ...process.env, ...environment, GITHUB_OUTPUT: output },
    },
  );
  return readFile(output, 'utf8');
}

const nonAppFiles = [
  'apps/web/src/app/page.tsx',
  'docs/development.md',
  'releases/next.md',
  '.agents/skills/visual-pr/SKILL.md',
  '.github/workflows/check.yml',
  'AGENTS.md',
  'apps/agent/AGENTS.md',
  'README.md',
  'addon/README.md',
  'scripts/revalidate-web.ts',
  'scripts/tests/revalidate-web.test.ts',
];

test.each(nonAppFiles)('%s does not require an app release', (file) => {
  expect(needsAppRelease([file])).toBe(false);
});

test('combined non-app changes and empty pushes skip packaging', () => {
  expect(needsAppRelease(nonAppFiles)).toBe(false);
  expect(needsAppRelease([])).toBe(false);
});

test.each([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'apps/desktop/src-tauri/Cargo.lock',
  'apps/bridge/src/runtime.ts',
  'apps/agent/agent/instructions.md',
  'apps/agent/agent/skills/example/SKILL.md',
  'addon/WispAI/Core.lua',
  'packages/protocol/src/mailbox.ts',
  'scripts/build-engine.ts',
  'simulator/manifest.json',
])('%s still requires packaging, including in a mixed push', (file) => {
  expect(needsAppRelease([file])).toBe(true);
  expect(needsAppRelease([...nonAppFiles, file])).toBe(true);
});

test.each([
  { event: 'workflow_dispatch', ref: 'branch', before: 'unavailable' },
  { event: 'push', ref: 'tag', before: 'unavailable' },
  { event: 'push', ref: 'branch', before: '0'.repeat(40) },
])('$event on $ref with base $before always packages', async ({ event, ref, before }) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-release-inputs-'));
  try {
    // No Git repository: these events must bypass branch-range inspection.
    expect(
      await checkInputs(directory, {
        GITHUB_EVENT_NAME: event,
        GITHUB_REF_TYPE: ref,
        RELEASE_BASE_SHA: before,
      }),
    ).toBe('app=true\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('branch ranges skip docs with spaces but still package an app file moved into docs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-release-range-'));
  const git = async (...args: string[]) =>
    (
      await execute(
        'git',
        [
          '-c',
          'core.hooksPath=' + path.join(directory, 'hooks'),
          '-c',
          'user.name=Wisp Tests',
          '-c',
          'user.email=wisp@example.invalid',
          ...args,
        ],
        { cwd: directory, windowsHide: true },
      )
    ).stdout.trim();
  const commit = async () => {
    await git('add', 'app.ts', 'docs');
    await git('commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  try {
    await git('init', '--quiet');
    await mkdir(path.join(directory, 'docs'));
    await writeFile(path.join(directory, 'app.ts'), 'app fixture');
    const first = await commit();
    await writeFile(path.join(directory, 'docs/notes with spaces.md'), 'docs fixture');
    const docs = await commit();
    const environment = { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'branch' };
    expect(
      await checkInputs(directory, { ...environment, RELEASE_BASE_SHA: first, GITHUB_SHA: docs }),
    ).toBe('app=false\n');
    await rename(path.join(directory, 'app.ts'), path.join(directory, 'docs/archived.ts'));
    const moved = await commit();
    expect(
      await checkInputs(directory, { ...environment, RELEASE_BASE_SHA: docs, GITHUB_SHA: moved }),
    ).toBe('app=true\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
