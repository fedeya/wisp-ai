import { expect, test } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('release-it archives notes, commits synchronized versions and ignores nightly tags and unrelated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wisp-release-it-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  for (const path of [
    'apps/desktop/src-tauri',
    'packages/releases',
    'scripts',
    'tests',
    'addon',
    'releases',
  ]) {
    await mkdir(join(root, path), { recursive: true });
  }
  for (const path of [
    'package.json',
    'apps/desktop/package.json',
    'packages/releases/package.json',
    'scripts/package.json',
    'tests/package.json',
    'addon/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
  ]) {
    await writeFile(
      join(root, path),
      '{"name":"release-fixture","private":true,"version":"0.0.7"}\n',
    );
  }
  await writeFile(
    join(root, 'apps/desktop/src-tauri/Cargo.toml'),
    '[package]\nname = "wisp"\nversion = "0.0.7"\n',
  );
  await writeFile(
    join(root, 'apps/desktop/src-tauri/Cargo.lock'),
    '[[package]]\nname = "wisp"\nversion = "0.0.7"\n',
  );
  await writeFile(
    join(root, 'releases/next.md'),
    '# A better companion\n\n- Reconnect without restarting.\n',
  );
  const config = JSON.parse(await readFile('.release-it.json', 'utf8'));
  config.git.requireUpstream = false;
  config.git.push = false;
  config.git.requireBranch = 'main';
  const command = (file: string) => `"${process.execPath}" "${resolve(file)}"`;
  config.hooks['before:init'] = `${command('scripts/release-notes.ts')} check`;
  config.hooks['after:bump'] = [
    `${command('scripts/release-notes.ts')} \${version}`,
    `${command('scripts/release-version.ts')} \${version}`,
    'git add -- releases/${version}.md',
  ];
  await writeFile(join(root, '.release-it.json'), JSON.stringify(config));
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release-test@example.com');
  git('config', 'core.hooksPath', join(root, 'no-hooks'));
  git('add', '.');
  git('commit', '-m', 'Squashed feature changes (#42)');
  git('tag', 'v0.0.7');
  git('tag', 'v0.0.8-nightly.999.1');
  await writeFile(join(root, 'unrelated.txt'), 'do not commit');
  await promisify(execFile)(
    process.execPath,
    [resolve('node_modules/release-it/bin/release-it.js'), 'patch', '--ci'],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 90000 },
  );
  expect(git('tag', '--list', 'v0.0.8').trim()).toBe('v0.0.8');
  expect(git('show', 'HEAD:releases/0.0.8.md')).toContain('Reconnect without restarting.');
  expect(git('show', 'HEAD:apps/desktop/package.json')).toContain('"version":"0.0.8"');
  expect(git('status', '--porcelain')).toBe('?? unrelated.txt\n');
}, 180000);
