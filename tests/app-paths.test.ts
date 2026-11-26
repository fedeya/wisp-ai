import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, cp, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { appPaths, retireLegacyEngine } from '@wisp/server/app-paths';
import { migrateDesktop } from '@wisp/server/desktop-migration';
import { createHash } from 'node:crypto';

test('startup retires the Eve engine folder of a separate data folder only', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'wisp-engine-retire-'));
  try {
    const root = path.join(temporary, 'resources'),
      data = path.join(temporary, 'user');
    const paths = appPaths(root, data);
    assert.equal(paths.legacyEngine, path.join(data, 'engine'));
    assert.equal(paths.config, path.join(data, 'config.local.json'));
    assert.equal(appPaths(root, '').legacyEngine, undefined);
    await mkdir(path.join(paths.legacyEngine!, '.eve/.workflow-data'), { recursive: true });
    await writeFile(path.join(paths.legacyEngine!, '.eve/.workflow-data/run.json'), '{}');
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(path.join(paths.runtime, 'wisp.sqlite'), 'keep');
    await retireLegacyEngine(paths.legacyEngine);
    await assert.rejects(readFile(path.join(paths.legacyEngine!, '.eve/.workflow-data/run.json')), {
      code: 'ENOENT',
    });
    assert.equal(await readFile(path.join(paths.runtime, 'wisp.sqlite'), 'utf8'), 'keep');
    // Only a folder named engine is ever removed.
    await retireLegacyEngine(paths.runtime);
    assert.equal(await readFile(path.join(paths.runtime, 'wisp.sqlite'), 'utf8'), 'keep');
    await retireLegacyEngine(undefined);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('the installed bridge can import native adapters from node_modules without TypeScript stripping', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'wisp-native-import-'));
  try {
    const source = path.dirname(fileURLToPath(import.meta.resolve('@wisp/agent/package.json')));
    const installed = path.join(temporary, 'node_modules/@wisp/agent');
    await mkdir(installed, { recursive: true });
    await cp(path.join(source, 'dist'), path.join(installed, 'dist'), { recursive: true });
    await cp(path.join(source, 'package.json'), path.join(installed, 'package.json'));
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies)) {
      const link = path.join(temporary, 'node_modules', name);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(
        await realpath(path.join(source, 'node_modules', name)),
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {modelReasoningEfforts} from '@wisp/agent/reasoning';
      import {createProviderModel} from '@wisp/agent/providers';
      const model = createProviderModel('anthropic', 'claude-sonnet-4-6', {apiKey:'unused', baseURL:'http://127.0.0.1:1'});
      console.log(JSON.stringify({version:model.specificationVersion, efforts:modelReasoningEfforts('anthropic','claude-sonnet-4-6')}));
    `,
      ],
      { cwd: temporary, windowsHide: true },
    );
    assert.deepEqual(JSON.parse(stdout), {
      version: 'v4',
      efforts: ['none', 'low', 'medium', 'high'],
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
test('migration imports explicit user data, leaves the old installation intact and refuses to overwrite', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'wisp-migrate-'));
  try {
    const source = path.join(temporary, 'old'),
      destination = path.join(temporary, 'new');
    await mkdir(path.join(source, 'runtime/memory'), { recursive: true });
    await writeFile(
      path.join(source, 'config.local.json'),
      JSON.stringify({ wow: 'test-wow', model: 'luna' }),
    );
    await writeFile(path.join(source, 'runtime/chats.json'), '["existing chat"]');
    await writeFile(path.join(source, 'runtime/desktop.json'), 'private session identity');
    await migrateDesktop(source, destination, '');
    assert.deepEqual(
      JSON.parse(await readFile(path.join(destination, 'runtime/chats.json'), 'utf8')),
      ['existing chat'],
    );
    assert.equal(
      await readFile(path.join(source, 'runtime/chats.json'), 'utf8'),
      '["existing chat"]',
    );
    await assert.rejects(readFile(path.join(destination, 'runtime/desktop.json')), /ENOENT/);
    await assert.rejects(migrateDesktop(source, destination, ''), /already configured/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
test('migration preserves encrypted blobs and detaches old Eve session IDs', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'wisp-credentials-import-'));
  try {
    const source = path.join(temporary, 'old'),
      data = path.join(temporary, 'new'),
      local = path.join(temporary, 'LocalAppData');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const secrets = path.join(local, 'WispAI', 'Secrets', hash(source));
    await mkdir(secrets, { recursive: true });
    await mkdir(path.join(source, 'runtime'), { recursive: true });
    await writeFile(path.join(source, 'config.local.json'), JSON.stringify({ wow: 'test-wow' }));
    await writeFile(
      path.join(source, 'runtime/chats.json'),
      JSON.stringify([
        {
          id: 'chat',
          eveId: 'old-session',
          status: 'working',
          messages: [{ role: 'user', text: 'Keep this' }],
        },
      ]),
    );
    const encrypted = Buffer.from([0, 1, 2, 3, 255, 128]);
    await writeFile(path.join(secrets, hash('auth') + '.bin'), encrypted);
    await migrateDesktop(source, data, local);
    assert.deepEqual(await readFile(path.join(data, 'secrets', hash('auth') + '.bin')), encrypted);
    const chats = JSON.parse(await readFile(path.join(data, 'runtime/chats.json'), 'utf8'));
    assert.equal(chats[0].eveId, undefined);
    assert.equal(chats[0].status, 'interrupted');
    assert.equal(chats[0].messages[0].text, 'Keep this');
    await rm(path.join(data, 'secrets', hash('auth') + '.bin'));
    await assert.rejects(migrateDesktop(source, data, local), /already configured/);
    await assert.rejects(readFile(path.join(data, 'secrets', hash('auth') + '.bin')), /ENOENT/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
