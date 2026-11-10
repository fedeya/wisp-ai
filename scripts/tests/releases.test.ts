import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nightlyBuildVersion, syncVersion } from '../release-version.ts';
import { prepareNotes, validateNotes } from '../release-notes.ts';

test('nightly builds have unique ordered identities without changing stable versions', () => {
  expect(nightlyBuildVersion('0.1.9', '123', '2')).toBe('0.1.10-nightly.123.2');
  expect(() => nightlyBuildVersion('0.1.9-nightly.1', '123', '1')).toThrow();
});
test('stable preparation consumes user notes once and synchronizes all app versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wisp-release-'));
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
    await writeFile(join(root, path), '{"version":"0.0.7"}\n');
  }
  await writeFile(
    join(root, 'apps/desktop/src-tauri/Cargo.toml'),
    '[package]\nname = "wisp"\nversion = "0.0.7"\n',
  );
  await writeFile(
    join(root, 'apps/desktop/src-tauri/Cargo.lock'),
    '[[package]]\nname = "other"\nversion = "1.2.3"\n\n[[package]]\nname = "wisp"\nversion = "0.0.7"\n',
  );
  await writeFile(
    join(root, 'releases/next.md'),
    '# Better adventures\n\n## Fixed\n\n- Reconnect without restarting.\n<!-- internal -->',
  );
  await prepareNotes('0.0.8', root);
  await syncVersion('0.0.8', root);
  expect(await readFile(join(root, 'releases/0.0.8.md'), 'utf8')).not.toContain('internal');
  expect(JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version).toBe(
    '0.0.8',
  );
  const lock = await readFile(join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
  expect(lock).toContain('name = "wisp"\nversion = "0.0.8"');
  expect(lock).toContain('name = "other"\nversion = "1.2.3"');
  expect(() => validateNotes('# Next\n<!-- unfinished -->')).toThrow('user-facing');
  await expect(prepareNotes('0.0.8', root)).rejects.toThrow();
});
