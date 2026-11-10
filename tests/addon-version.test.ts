import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stampAddonVersions } from '../scripts/addon-version.ts';

test.each(['0.0.8', '0.0.8-nightly.123.2'])(
  'staged and installed addon/helpers identify build %s',
  async (version) => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-addon-version-'));
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) {
      throw Error('Unsafe fixture directory.');
    }
    try {
      const source = path.join(root, 'source/WispAI');
      const payload = path.join(root, 'payload');
      const addon = path.join(payload, 'addon/WispAI');
      const wow = path.join(root, 'fake WoW');
      await mkdir(source, { recursive: true });
      const authored = '## Interface: 16001\r\n## Version: development\r\nCore.lua\r\n';
      await writeFile(path.join(source, 'WispAI.toc'), authored);
      await writeFile(path.join(source, 'VersionedHelper.toc'), '## Version: old\n');
      await writeFile(path.join(source, 'UnversionedHelper.toc'), '## Title: Helper\n');
      await cp(source, addon, { recursive: true });
      await stampAddonVersions(path.join(payload, 'addon'), version);
      expect(await readFile(path.join(source, 'WispAI.toc'), 'utf8')).toBe(authored);
      expect(await readFile(path.join(addon, 'WispAI.toc'), 'utf8')).toBe(
        authored.replace('development', version),
      );
      expect(await readFile(path.join(addon, 'VersionedHelper.toc'), 'utf8')).toBe(
        `## Version: ${version}\n`,
      );
      expect(await readFile(path.join(addon, 'UnversionedHelper.toc'), 'utf8')).toBe(
        '## Title: Helper\n',
      );
      await expect(
        stampAddonVersions(path.join(payload, 'addon'), 'bad\nversion'),
      ).rejects.toThrow();
      await mkdir(wow);
      await writeFile(path.join(wow, 'Wow.exe'), '');
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
      const installed = path.join(wow, 'Interface/AddOns');
      const directories = await readdir(installed);
      const helpers = directories.filter((name) => /^WispAI_[BS]\d+$/.test(name));
      expect(helpers).toHaveLength(1152);
      for (const name of ['WispAI', ...helpers]) {
        const toc = await readFile(path.join(installed, name, `${name}.toc`), 'utf8');
        expect(toc.match(/^## Version: ([^\r\n]+)/m)?.[1]).toBe(version);
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  45000,
);
