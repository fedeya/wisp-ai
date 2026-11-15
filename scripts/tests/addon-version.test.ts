import { expect, test } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addonVersionFromToc } from '../../apps/bridge/src/addon-version.ts';
import { addonReleaseVersion, stampAddonReleaseVersion } from '../addon-release-version.ts';

test('release patch counts addon and helper changes from the current base version', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-addon-history-'));
  if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) {
    throw Error('Unsafe fixture directory.');
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', `core.hooksPath=${root}`, ...args], { cwd: root, stdio: 'pipe' });
  async function commit(file: string, content: string) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    git('add', file);
    git('commit', '-m', file);
  }

  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Addon version test');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    await commit('addon/WispAI/Core.lua', 'initial addon');
    await commit('addon/WispAI/WispAI.toc', '## Version: 1.0.0\nCore.lua\n');
    await commit('scripts/addon-release-version.ts', 'start automatic versioning');
    expect(addonReleaseVersion(root)).toBe('1.0.0');

    await commit('apps/desktop/package.json', '{"version":"0.1.3"}');
    await commit('packages/protocol/src/protocol.ts', 'unrelated packet schema');
    expect(addonReleaseVersion(root)).toBe('1.0.0');

    await commit('addon/WispAI/Core.lua', 'updated addon');
    expect(addonReleaseVersion(root)).toBe('1.0.1');

    git('switch', '-c', 'helpers');
    await commit('packages/protocol/src/addon-helpers.ts', 'first helper change');
    await commit('packages/protocol/src/addon-helpers.ts', 'second helper change');
    git('switch', 'main');
    git('merge', '--no-ff', '-m', 'Update addon helpers', 'helpers');
    expect(addonReleaseVersion(root)).toBe('1.0.2');

    git('tag', 'v0.1.4');
    git('switch', '--detach', 'v0.1.4');
    expect(addonReleaseVersion(root)).toBe('1.0.2');

    git('switch', 'main');
    await commit('apps/desktop/package.json', '{"version":"2.0.0"}');
    expect(addonReleaseVersion(root)).toBe('1.0.2');

    await commit('addon/WispAI/WispAI.toc', '## Version: 1.1.0\nCore.lua\n');
    expect(addonReleaseVersion(root)).toBe('1.1.0');
    await commit('addon/WispAI/WispAI.toc', '## Version: 1.1.0\n## Title: Wisp\nCore.lua\n');
    expect(addonReleaseVersion(root)).toBe('1.1.1');

    git('switch', '-c', 'addon-major');
    await commit('addon/WispAI/WispAI.toc', '## Version: 2.0.0\n## Title: Wisp\nCore.lua\n');
    git('switch', 'main');
    git('merge', '--no-ff', '-m', 'Begin addon 2.0', 'addon-major');
    expect(addonReleaseVersion(root)).toBe('2.0.0');
    await commit('packages/protocol/src/addon-helpers.ts', 'helper change for addon 2.0');
    expect(addonReleaseVersion(root)).toBe('2.0.1');

    await commit('addon/WispAI/WispAI.toc', '## Version: 2.0.7\nCore.lua\n');
    expect(() => addonReleaseVersion(root)).toThrow('MAJOR.MINOR.0');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 15000);

test('the packaged addon version is inherited by the installed addon and helpers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-addon-version-'));
  if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) {
    throw Error('Unsafe fixture directory.');
  }
  try {
    const payload = path.join(root, 'payload');
    const addon = path.join(payload, 'addon/WispAI');
    const wow = path.join(root, 'fake WoW');
    const saves = path.join(wow, 'WTF/Account/PLAYER/SavedVariables');
    const installed = path.join(wow, 'Interface/AddOns');
    const toc = '## Interface: 16001\r\n## Version: 2.0.0\r\nCore.lua\r\n';
    await mkdir(addon, { recursive: true });
    await mkdir(saves, { recursive: true });
    await writeFile(path.join(wow, 'Wow.exe'), '');
    await writeFile(path.join(saves, 'WispAI.lua'), 'WispAIDB = { sidebar = false }');
    const stagedToc = path.join(addon, 'WispAI.toc');
    await writeFile(stagedToc, toc);
    await stampAddonReleaseVersion(stagedToc, '2.0.1');

    const config = path.join(root, 'data/config.local.json');
    const savedModel = { model: 'local-model' };
    for (const desktopVersion of ['0.1.3', '0.1.4-nightly.123.2']) {
      const managedByDesktop = desktopVersion.includes('nightly');
      if (managedByDesktop) await writeFile(config, JSON.stringify(savedModel));
      await writeFile(
        path.join(payload, 'package.json'),
        JSON.stringify({ version: desktopVersion }),
      );
      const args = ['apps/bridge/scripts/install.ts', wow];
      if (managedByDesktop) args.push('--skip-config');
      await promisify(execFile)(process.execPath, args, {
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 30000,
        env: {
          ...process.env,
          WISP_RESOURCE_ROOT: payload,
          WISP_DATA_DIR: path.join(root, 'data'),
        },
      });
      expect(JSON.parse(await readFile(config, 'utf8'))).toEqual(
        managedByDesktop ? savedModel : { wow },
      );
      const helpers = (await readdir(installed)).filter((name) => /^WispAI_[BS]\d+$/.test(name));
      expect(helpers).toHaveLength(1152);
      expect(await readFile(path.join(installed, 'WispAI/WispAI.toc'), 'utf8')).toBe(
        toc.replace('2.0.0', '2.0.1'),
      );
      for (const name of helpers) {
        const helper = await readFile(path.join(installed, name, `${name}.toc`), 'utf8');
        expect(addonVersionFromToc(helper)).toBe('2.0.1');
      }
      expect(await readFile(path.join(saves, 'WispAI.lua'), 'utf8')).toBe(
        'WispAIDB = { sidebar = false }',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 45000);
