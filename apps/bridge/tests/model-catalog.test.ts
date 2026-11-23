import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountOperations } from '../src/account-operations.ts';
import type { ChatGPTAuth } from '../src/auth/chatgpt-auth.ts';
import type { SecretVault } from '../src/auth/secret-vault.ts';
import { resolveDefaultModel, type AccountModel } from '../src/chat/chat-model.ts';
import { createModelCatalogRefresh } from '../src/models/model-catalog.ts';
import { ModelConnections } from '../src/models/model-connections.ts';
import { connectionModelSlug } from '@wisp/protocol/providers';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

for (const operation of ['save', 'remove'] as const) {
  test(`catalog reflects guarded provider ${operation} committed during startup load`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wisp-catalog-'));
    try {
      const secrets = new Map<string, string>();
      const vault: SecretVault = {
        read: async (key) => secrets.get(key) ?? '',
        write: async (key, value) => {
          secrets.set(key, value);
        },
      };
      const blocked = deferred<AccountModel[]>();
      const started = deferred<void>();
      let calls = 0;
      const chatgpt = {
        state: () => ({ status: 'connected' }),
        models: () => {
          started.resolve();
          return ++calls === 1 ? blocked.promise : Promise.resolve([]);
        },
      } as unknown as ChatGPTAuth;
      const file = join(directory, 'connections.json');
      const connections = new ModelConnections(file, vault, chatgpt, async () => {
        throw Error('Unexpected provider request');
      });
      await connections.load();
      const setup = {
        provider: 'openai',
        apiKey: 'synthetic-only',
        models: [{ id: 'synthetic-model' }],
      };
      const existing = operation === 'remove' ? await connections.save(setup) : undefined;
      const state = {
        modelCatalog: [] as AccountModel[],
        modelCatalogError: undefined as string | undefined,
      };
      const refresh = createModelCatalogRefresh({ state, connections, changed: () => {} });
      let postOperation: Promise<void> | undefined;
      const accounts = createAccountOperations({
        isStopping: () => false,
        hasActiveTurn: () => false,
        afterOperation: () => {
          postOperation = refresh();
        },
      });
      // Runtime starts this outside accounts.run; ChatGPT blocks after the API snapshot.
      assert.equal(connections.hasProvider(), true);
      const startup = refresh();
      await started.promise;
      assert.equal(calls, 1);
      assert.equal(accounts.busy(), false);
      const saved = await accounts.run(async () => {
        if (existing) {
          await connections.remove(existing.id);
          return undefined;
        }
        return connections.save(setup);
      });
      const persisted = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(persisted.length, operation === 'save' ? 1 : 0);
      assert.ok(postOperation);
      assert.equal(calls, 1, 'account refresh is requested while startup remains blocked');
      blocked.resolve([]);
      await Promise.all([startup, postOperation]);
      const expected = saved ? [connectionModelSlug(saved.id, 'synthetic-model')] : [];
      assert.deepEqual(
        state.modelCatalog.map((model) => model.slug),
        expected,
      );
      assert.equal(resolveDefaultModel(undefined, state.modelCatalog), expected[0] ?? '');
      assert.equal(state.modelCatalogError, undefined);
      assert.equal(calls, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('coalesces requests in each pass, including a pending trailing pass, with one loader', async () => {
  const passes = Array.from({ length: 3 }, () => ({
    started: deferred<void>(),
    result: deferred<AccountModel[]>(),
  }));
  const final: AccountModel[] = [{ slug: 'final', displayName: 'Final', efforts: [] }];
  const state = {
    modelCatalog: [] as AccountModel[],
    modelCatalogError: undefined as string | undefined,
  };
  let calls = 0,
    active = 0,
    maximum = 0,
    notifications = 0;
  const refresh = createModelCatalogRefresh({
    state,
    connections: {
      models: async () => {
        const pass = passes[calls++]!;
        maximum = Math.max(maximum, ++active);
        pass.started.resolve();
        try {
          return await pass.result.promise;
        } finally {
          active--;
        }
      },
    },
    changed: () => {
      notifications++;
    },
  });
  const work = refresh();
  let settled = false;
  void work.then(() => {
    settled = true;
  });
  await passes[0]!.started.promise;
  for (let n = 0; n < 20; n++) assert.equal(refresh(), work);
  passes[0]!.result.resolve([]);
  await passes[1]!.started.promise;
  for (let n = 0; n < 20; n++) assert.equal(refresh(), work);
  passes[1]!.result.resolve([]);
  await passes[2]!.started.promise;
  assert.equal(settled, false, 'shared promise includes all requested work');
  passes[2]!.result.resolve(final);
  await work;
  assert.equal(calls, 3);
  assert.equal(maximum, 1);
  assert.equal(notifications, 3);
  assert.deepEqual(state.modelCatalog, final);
});

test('a failed load still drains a requested refresh and later failures remain retryable', async () => {
  const failed = deferred<AccountModel[]>();
  const started = deferred<void>();
  const final: AccountModel[] = [{ slug: 'recovered', displayName: 'Recovered', efforts: [] }];
  const state = { modelCatalog: final, modelCatalogError: undefined as string | undefined };
  const snapshots: { catalog: AccountModel[]; error: string | undefined }[] = [];
  let calls = 0;
  const refresh = createModelCatalogRefresh({
    state,
    connections: {
      models: () => {
        calls++;
        if (calls === 1) {
          started.resolve();
          return failed.promise;
        }
        if (calls === 3) throw Error('Later catalog failure');
        return Promise.resolve(final);
      },
    },
    changed: () => {
      snapshots.push({ catalog: state.modelCatalog, error: state.modelCatalogError });
    },
  });
  const work = refresh();
  await started.promise;
  assert.equal(refresh(), work);
  failed.reject(Error('Synthetic catalog failure'));
  await assert.doesNotReject(work);
  assert.deepEqual(snapshots, [
    { catalog: [], error: 'Synthetic catalog failure' },
    { catalog: final, error: undefined },
  ]);
  await assert.doesNotReject(refresh());
  assert.deepEqual(state.modelCatalog, []);
  assert.equal(state.modelCatalogError, 'Later catalog failure');
  await assert.doesNotReject(refresh());
  assert.equal(calls, 4);
  assert.deepEqual(state.modelCatalog, final);
  assert.equal(state.modelCatalogError, undefined);
});
