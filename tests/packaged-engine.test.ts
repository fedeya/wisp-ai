import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { savedRoutine } from '@wisp/protocol/routines';
import { migrationsFolder } from '@wisp/bridge/db/migrate';
import { newChat } from '@wisp/bridge/chat-lifecycle';

const exec = promisify(execFile);
test.runIf(Boolean(process.env.WISP_TEST_ENGINE_EXECUTABLE))(
  'packaged engine supports SQLite and imports committed database history',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-packaged-sqlite-'));
    const previous = path.join(root, 'previous');
    const destination = path.join(root, 'imported');
    await mkdir(path.join(previous, 'runtime'), { recursive: true });
    const source = new DatabaseSync(path.join(previous, 'runtime/chats.sqlite'));
    try {
      source.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
      source.exec(
        await readFile(
          path.join(migrationsFolder, '20261109234044_initial-chat-schema/migration.sql'),
          'utf8',
        ),
      );
      const chat = {
        ...newChat('history', 'game'),
        eveId: 'old-session',
        messages: [{ role: 'user' as const, text: 'History survives packaging 🧙' }],
      };
      const { messages, ...metadata } = chat;
      source
        .prepare('INSERT INTO chats VALUES(?,?,?,?,?,?)')
        .run(chat.id, 0, null, 0, 0, JSON.stringify(metadata));
      source
        .prepare('INSERT INTO messages VALUES(?,?,?)')
        .run(chat.id, 0, JSON.stringify(messages[0]));
      source.exec("INSERT INTO metadata VALUES('initialized','1'); PRAGMA user_version=1");
      const routine = savedRoutine.parse({
        id: 'review',
        title: 'Review',
        instruction: 'Review spells',
        triggers: [{ kind: 'interval', seconds: 60 }],
        characterKey: 'mage',
        enabled: true,
        updatedAt: 1,
        nextAt: 100,
      });
      const productSources = {
        'routines.json': JSON.stringify({
          routines: [routine],
          runs: [
            {
              id: 'run',
              routineId: 'removed',
              characterKey: 'mage',
              title: 'Old routine',
              startedAt: 1,
              status: 'done',
              event: 'interval',
              summary: 'Keep history',
            },
          ],
        }),
        'panels.json': JSON.stringify([
          {
            id: 'goal',
            title: 'Goal',
            characterKey: 'mage',
            updatedAt: 1,
            ui: [{ id: 'card', kind: 'card', title: 'Goal' }],
          },
        ]),
      };
      for (const [name, content] of Object.entries(productSources)) {
        await writeFile(path.join(previous, 'runtime', name), content);
      }
      await mkdir(path.join(previous, 'runtime/memory'));
      const memoryName =
        createHash('sha256')
          .update(JSON.stringify(['character', 'mage']))
          .digest('hex') + '.json';
      await writeFile(
        path.join(previous, 'runtime/memory', memoryName),
        JSON.stringify({
          slot: 'character',
          owner: 'mage',
          entries: [{ key: 'goal', text: 'Keep plan', updatedAt: '2026-11-09' }],
        }),
      );
      await writeFile(
        path.join(previous, 'config.local.json'),
        JSON.stringify({ wow: 'fixture-wow' }),
      );
      const executable = process.env.WISP_TEST_ENGINE_EXECUTABLE!;
      const env = {
        ...process.env,
        WISP_DATA_DIR: destination,
        LOCALAPPDATA: path.join(root, 'local'),
      };
      const selfTest = await exec(executable, ['--self-test'], {
        env,
        windowsHide: true,
        timeout: 30000,
      });
      expect(JSON.parse(selfTest.stdout).sqlite).toBe(true);
      await exec(executable, ['scripts/migrate-desktop.ts', previous], {
        env,
        windowsHide: true,
        timeout: 30000,
      });
      const db = new DatabaseSync(path.join(destination, 'runtime/wisp.sqlite'), {
        readOnly: true,
      });
      try {
        expect(db.prepare('SELECT count(*) AS n FROM wisp_migrations').get()!.n).toBe(3);
        expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
        expect(db.prepare('SELECT text FROM messages').get()!.text).toBe(chat.messages[0].text);
        expect(db.prepare('SELECT eve_id FROM chat_instance_state').get()!.eve_id).toBeNull();
        expect(db.prepare('SELECT title FROM routines').get()!.title).toBe('Review');
        expect(db.prepare('SELECT summary FROM routine_runs').get()!.summary).toBe('Keep history');
        expect(db.prepare('SELECT title FROM panels').get()!.title).toBe('Goal');
        expect(db.prepare('SELECT text FROM memory_entries').get()!.text).toBe('Keep plan');
        for (const [name, content] of Object.entries(productSources)) {
          expect(await readFile(path.join(previous, 'runtime', name), 'utf8')).toBe(content);
          const digest = createHash('sha256').update(content).digest('hex');
          expect(
            await readFile(
              path.join(
                destination,
                'runtime',
                name.replace(/\.json$/, `.pre-sqlite-${digest}.json`),
              ),
              'utf8',
            ),
          ).toBe(content);
        }
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(
          JSON.parse(String(source.prepare('SELECT metadata FROM chats').get()!.metadata)).eveId,
        ).toBe('old-session');
      } finally {
        db.close();
      }
    } finally {
      source.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
test.runIf(Boolean(process.env.WISP_TEST_ENGINE_EXECUTABLE))(
  'packaged install and migration forward their positional folder arguments',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-cli-args-'));
    try {
      const engine = path.join(root, 'wisp-engine.exe');
      await copyFile(process.env.WISP_TEST_ENGINE_EXECUTABLE!, engine);
      const wow = path.join(root, 'fake WoW client');
      const data = path.join(root, 'installed data');
      const addon = path.join(root, 'addon/WispAI');
      await mkdir(wow);
      await writeFile(path.join(wow, 'Wow.exe'), '');
      await mkdir(addon, { recursive: true });
      await writeFile(path.join(addon, 'WispAI.toc'), '## Title: Installer fixture\n');
      const env = {
        ...process.env,
        WISP_RESOURCE_ROOT: root,
        WISP_DATA_DIR: data,
        LOCALAPPDATA: path.join(root, 'local app data'),
      };
      await exec(engine, ['scripts/install.ts', wow], {
        cwd: root,
        env,
        windowsHide: true,
        timeout: 45_000,
      });
      expect(JSON.parse(await readFile(path.join(data, 'config.local.json'), 'utf8'))).toEqual({
        wow,
      });
      expect(await readFile(path.join(wow, 'Interface/AddOns/WispAI/WispAI.toc'), 'utf8')).toBe(
        '## Title: Installer fixture\n',
      );

      const previous = path.join(root, 'previous installation');
      const imported = path.join(root, 'imported data');
      await mkdir(path.join(previous, 'runtime'), { recursive: true });
      await writeFile(
        path.join(previous, 'config.local.json'),
        JSON.stringify({ wow, model: 'offline-fixture' }),
      );
      const chats = [{ id: 'fixture', eveId: 'old-session', status: 'working', messages: [] }];
      await writeFile(path.join(previous, 'runtime/chats.json'), JSON.stringify(chats));
      await exec(engine, ['scripts/migrate-desktop.ts', previous], {
        cwd: root,
        env: { ...env, WISP_DATA_DIR: imported },
        windowsHide: true,
        timeout: 15_000,
      });
      expect(JSON.parse(await readFile(path.join(imported, 'config.local.json'), 'utf8'))).toEqual({
        wow,
        model: 'offline-fixture',
      });
      expect(JSON.parse(await readFile(path.join(imported, 'runtime/chats.json'), 'utf8'))).toEqual(
        [{ id: 'fixture', status: 'interrupted', messages: [] }],
      );
      expect(JSON.parse(await readFile(path.join(previous, 'runtime/chats.json'), 'utf8'))).toEqual(
        chats,
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
test.runIf(Boolean(process.env.WISP_TEST_ENGINE_EXECUTABLE))(
  'packaged npm runs a local MCP executable without installing Node or extracting npm',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-npx-test-'));
    try {
      const engine = path.join(root, 'wisp-engine.exe');
      await copyFile(process.env.WISP_TEST_ENGINE_EXECUTABLE!, engine);
      await mkdir(path.join(root, 'runtime'));
      await copyFile(process.execPath, path.join(root, 'runtime/node.exe'));
      const fixture = path.join(root, 'fixture');
      await mkdir(fixture);
      await writeFile(
        path.join(fixture, 'package.json'),
        JSON.stringify({
          name: 'wisp-mcp-fixture',
          version: '1.0.0',
          bin: { 'wisp-mcp-fixture': 'index.cjs' },
        }),
      );
      await writeFile(
        path.join(fixture, 'index.cjs'),
        '#!/usr/bin/env node\nconsole.log("wisp-mcp-fixture-ok")\n',
      );
      const env = {
        ...process.env,
        WISP_RESOURCE_ROOT: root,
        npm_config_cache: path.join(root, 'npm-cache'),
        npm_config_offline: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        PATH:
          path.join(root, 'runtime') +
          path.delimiter +
          path.join(process.env.WINDIR || 'C:/Windows', 'System32'),
      };
      const result = await exec(
        engine,
        ['--npx', '--offline', '--yes', '--package', fixture, 'wisp-mcp-fixture'],
        { cwd: root, env, windowsHide: true, timeout: 45_000 },
      );
      expect(result.stdout).toContain('wisp-mcp-fixture-ok');
      const nodeCompatibility = await exec(engine, ['-e', 'console.log("wisp-node-shim-ok")'], {
        cwd: root,
        env,
        windowsHide: true,
        timeout: 10_000,
      });
      expect(nodeCompatibility.stdout).toContain('wisp-node-shim-ok');
      expect(await readdir(path.join(root, 'runtime'))).toEqual(['node.exe']);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
