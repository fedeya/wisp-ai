import { test, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  developmentLayout,
  claimDevelopmentTarget,
  seedDevelopmentProfile,
} from '../scripts/dev-profile.ts';
import { ApplicationDatabase } from '@wisp/bridge/db/application-database';
import { sharedLock } from '@wisp/bridge/shared-lock';
import { SharedModelVault, type SecretVault } from '@wisp/bridge/secret-vault';
import { ChatGPTAuth } from '@wisp/bridge/chatgpt-auth';
import { ModelConnections } from '@wisp/bridge/model-connections';
import { RoutineStore } from '@wisp/bridge/routines';
import { WorkspaceChats } from '@wisp/bridge/workspace-chats';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import { routineDefinition } from '@wisp/protocol/routines';

function memoryVault(): SecretVault {
  const entries = new Map<string, string>();
  return {
    read: async (key) => entries.get(key) ?? '',
    write: async (key, value) => {
      entries.set(key, value);
    },
  };
}

test('info works in a new checkout without node_modules or generated protocol files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-unbuilt-info-'));
  const run = promisify(execFile);
  try {
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    for (const name of ['dev-instance.ts', 'dev-profile.ts']) {
      await copyFile(
        new URL('../scripts/' + name, import.meta.url),
        path.join(root, 'scripts', name),
      );
    }
    await run('git', ['init', '--quiet', root], { windowsHide: true });
    const { stdout } = await run(
      process.execPath,
      [path.join(root, 'scripts', 'dev-instance.ts'), 'info'],
      { cwd: root, windowsHide: true },
    );
    const info = JSON.parse(stdout);
    expect(info.data).toBe(path.join(root, 'runtime', 'dev-instance'));
    expect(info.shared).toBe(path.join(root, '.git', 'wisp-dev', 'shared'));
    expect(await readdir(root)).not.toContain('runtime');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-dev-isolation-'));
  const file = path.join(root, 'runtime', 'wisp.sqlite');
  const a = new ApplicationDatabase(file),
    b = new ApplicationDatabase(file);
  await a.initialize();
  await b.initialize();
  return {
    root,
    a,
    b,
    close: async () => {
      await a.close();
      await b.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('worktree layouts share one profile and separate all runtime/build/addon destinations', () => {
  const a = developmentLayout('/project/task-a', '/project/.git');
  const b = developmentLayout('/project/task-b', '/project/.git');
  expect(a.shared).toBe(b.shared);
  for (const key of ['id', 'data', 'wow', 'native'] as const) {
    expect(a[key]).not.toBe(b[key]);
  }
});

test('addon targets reject another worktree and an existing production addon', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-addon-owner-'));
  try {
    await writeFile(path.join(root, 'Wow.exe'), 'fixture');
    await claimDevelopmentTarget(root, 'a');
    await expect(claimDevelopmentTarget(root, 'b')).rejects.toThrow('another development instance');
    await rm(path.join(root, '.wisp-dev-owner'));
    await mkdir(path.join(root, 'Interface', 'AddOns', 'WispAI'), { recursive: true });
    await expect(claimDevelopmentTarget(root, 'a')).rejects.toThrow('production addon');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('LLM credentials are shared, unrelated secrets remain private, and concurrent saves retain both connections', async () => {
  const f = await fixture();
  try {
    const common = memoryVault(),
      localA = memoryVault(),
      localB = memoryVault();
    const a = new SharedModelVault(localA, common, sharedLock(f.a));
    const b = new SharedModelVault(localB, common, sharedLock(f.b));
    await a.write('chatgpt:accounts', 'account');
    expect(await b.read('chatgpt:accounts')).toBe('account');
    await a.write('mcp:private', 'private');
    expect(await b.read('mcp:private')).toBe('');
    await a.write('chatgpt:accounts', '');
    const auth = { state: () => ({ status: 'signed_out' }) } as ChatGPTAuth;
    const file = path.join(f.root, 'runtime', 'connections.json');
    const first = new ModelConnections(file, a, auth),
      second = new ModelConnections(file, b, auth);
    await first.load();
    await second.load();
    const setup = {
      provider: 'anthropic',
      name: 'test',
      apiKey: 'test-key',
      models: [{ id: 'test', contextWindow: 200000 }],
    };
    const ids = await Promise.all([first.save(setup), second.save({ ...setup, name: 'second' })]);
    await first.load();
    expect(first.list()).toHaveLength(2);
    expect(first.list().every((c) => c.hasKey)).toBe(true);
    expect(await b.read('ai-connection:' + ids[0].id)).toBe('test-key');
    expect(await readFile(file, 'utf8')).not.toContain('test-key');
    await Promise.all([first.remove(ids[0].id), second.save({ ...setup, name: 'third' })]);
    await first.load();
    expect(first.list()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('two ChatGPT clients renew a shared rotating refresh token only once', async () => {
  const f = await fixture();
  try {
    const common = memoryVault();
    await common.write(
      'chatgpt:accounts',
      JSON.stringify({
        activeId: 'oaiapp_test',
        profiles: [
          {
            id: 'oaiapp_test',
            tokens: {
              accessToken: 'old',
              refreshToken: 'rotate-once',
              idToken: 'id',
              expiresAt: 0,
              scopes: ['chatgpt.tokens.use.direct'],
            },
          },
        ],
      }),
    );
    let refreshes = 0;
    const fetcher = (async (url: unknown) => {
      if (String(url).endsWith('openid-configuration')) {
        return Response.json({
          issuer: 'https://auth.openai.com',
          authorization_endpoint: 'https://auth.openai.com/authorize',
          token_endpoint: 'https://auth.openai.com/token',
          jwks_uri: 'https://auth.openai.com/jwks',
        });
      }
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({
        access_token: 'renewed',
        refresh_token: 'rotated',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }) as typeof fetch;
    const va = new SharedModelVault(memoryVault(), common, sharedLock(f.a));
    const vb = new SharedModelVault(memoryVault(), common, sharedLock(f.b));
    const a = new ChatGPTAuth(path.join(f.root, 'runtime'), va, { fetch: fetcher });
    const b = new ChatGPTAuth(path.join(f.root, 'runtime'), vb, { fetch: fetcher });
    await va.exclusive('models', () => a.load());
    await vb.exclusive('models', () => b.load());
    expect(await Promise.all([a.accessToken(), b.accessToken()])).toEqual(['renewed', 'renewed']);
    expect(refreshes).toBe(1);
    expect(JSON.parse(await common.read('chatgpt:accounts')).profiles[0].tokens.refreshToken).toBe(
      'rotated',
    );
  } finally {
    await f.close();
  }
});

test('routine definitions are shared but events, runs, cooldown and startup recovery belong to each instance', async () => {
  const f = await fixture();
  try {
    const a = new RoutineStore(f.a, 'a'),
      b = new RoutineStore(f.b, 'b');
    await a.load();
    await b.load();
    const routine = routineDefinition.parse({
      id: 'routine',
      title: 'Review',
      instruction: 'Read only',
      cooldownSeconds: 60,
      once: true,
      triggers: [{ kind: 'event', event: 'level_up', filters: [] }],
    });
    await a.mutate('mage', { operation: 'save', routine }, undefined, 1000000);
    expect(b.list('mage')[0].title).toBe('Review');
    await a.observe('mage', { event: 'level_up', values: { level: 20 } }, 1000001);
    expect(await b.claim('mage', 1000002)).toBeNull();
    const claimA = (await a.claim('mage', 1000002))!;
    expect(claimA).not.toBeNull();
    await b.load();
    expect(a.getRun(claimA.run.id)?.status).toBe('running');
    expect(b.getRun(claimA.run.id)).toBeUndefined();
    await b.observe('mage', { event: 'level_up', values: { level: 22 } }, 1000003);
    const claimB = (await b.claim('mage', 1000004))!;
    expect(claimB.run.id).not.toBe(claimA.run.id);
    await a.finish(claimA.run.id, 'done', 'A', 1000005);
    expect(a.list('mage')[0].enabled).toBe(false);
    expect(b.list('mage')[0].enabled).toBe(true);
    await new RoutineStore(f.b, 'b').load();
    expect(b.getRun(claimB.run.id)?.status).toBe('interrupted');
    expect(a.history()).toHaveLength(1);
    expect(a.history()[0].status).toBe('done');
  } finally {
    await f.close();
  }
});

test('seeding preserves source bytes, imports history once and copies only encrypted LLM credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-dev-seed-'));
  const source = path.join(root, 'source'),
    shared = path.join(root, 'shared');
  await mkdir(path.join(source, 'runtime'), { recursive: true });
  await mkdir(path.join(source, 'secrets'));
  const bytes = JSON.stringify([
    {
      ...newChat('old', 'game'),
      eveId: 'private-session',
      messages: [{ role: 'user', text: 'Keep me' }],
    },
  ]);
  await writeFile(
    path.join(source, 'config.local.json'),
    JSON.stringify({ wow: 'untouched', model: 'model' }),
  );
  await writeFile(path.join(source, 'runtime', 'chats.json'), bytes);
  await writeFile(
    path.join(source, 'runtime', 'connections.json'),
    JSON.stringify([{ id: 'example' }]),
  );
  const secretName = (key: string) => createHash('sha256').update(key).digest('hex') + '.bin';
  for (const key of ['chatgpt:accounts', 'ai-connection:example', 'mcp:private']) {
    await writeFile(path.join(source, 'secrets', secretName(key)), 'encrypted-fixture');
  }
  const db = new ApplicationDatabase(path.join(shared, 'runtime', 'wisp.sqlite'));
  try {
    await seedDevelopmentProfile(source, shared);
    expect(await readFile(path.join(source, 'runtime', 'chats.json'), 'utf8')).toBe(bytes);
    expect(await readdir(path.join(source, 'runtime'))).not.toContain('wisp.sqlite');
    const store = new WorkspaceChats(db, 'a', () => {});
    const chats = await store.load();
    expect(chats[0].messages[0].text).toBe('Keep me');
    expect(chats[0].eveId).toBeUndefined();
    if (process.platform === 'win32') {
      expect(await readdir(path.join(shared, 'secrets'))).toEqual([
        secretName('ai-connection:example'),
      ]);
    }
    await expect(seedDevelopmentProfile(source, shared)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(chats).toHaveLength(1);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
