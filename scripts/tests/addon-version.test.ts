import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addonVersionFromToc } from '../../apps/bridge/src/addon-version.ts';

test('an installed addon and its helpers keep the authored version across Desktop builds', async () => {
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
    const toc = '## Interface: 16001\r\n## Version: 1.0.0\r\nCore.lua\r\n';
    await mkdir(addon, { recursive: true });
    await mkdir(saves, { recursive: true });
    await writeFile(path.join(wow, 'Wow.exe'), '');
    await writeFile(path.join(saves, 'WispAI.lua'), 'WispAIDB = { sidebar = false }');
    await writeFile(path.join(addon, 'WispAI.toc'), toc);

    for (const desktopVersion of ['0.1.3', '0.1.4-nightly.123.2']) {
      await writeFile(
        path.join(payload, 'package.json'),
        JSON.stringify({ version: desktopVersion }),
      );
      await promisify(execFile)(process.execPath, ['apps/bridge/scripts/install.ts', wow], {
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 30000,
        env: {
          ...process.env,
          WISP_RESOURCE_ROOT: payload,
          WISP_DATA_DIR: path.join(root, 'data'),
        },
      });
      const helpers = (await readdir(installed)).filter((name) => /^WispAI_[BS]\d+$/.test(name));
      expect(helpers).toHaveLength(1152);
      expect(await readFile(path.join(installed, 'WispAI/WispAI.toc'), 'utf8')).toBe(toc);
      for (const name of helpers) {
        const helper = await readFile(path.join(installed, name, `${name}.toc`), 'utf8');
        expect(addonVersionFromToc(helper)).toBe('1.0.0');
      }
      expect(await readFile(path.join(saves, 'WispAI.lua'), 'utf8')).toBe(
        'WispAIDB = { sidebar = false }',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 45000);
