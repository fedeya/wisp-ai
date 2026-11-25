import { test, vi, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { ChatGPTAuth } from '../src/auth/chatgpt-auth.ts';
import { createAccountOperations } from '../src/account-operations.ts';
import { createModelCatalogRefresh } from '../src/models/model-catalog.ts';
import { ModelConnections } from '../src/models/model-connections.ts';
import { bridgeLogger } from '../src/logger.ts';

async function selectionFixture(t: Pick<TestContext, 'onTestFinished'>) {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-auth-select-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  let now = 1800000000000;
  const values = new Map([
    [
      'chatgpt:accounts',
      JSON.stringify({
        activeId: 'oaiapp_one',
        profiles: ['one', 'two'].map((id) => ({
          id: 'oaiapp_' + id,
          email: id + '@example.test',
          tokens: {
            accessToken: 'synthetic-access-' + id,
            refreshToken: 'synthetic-refresh-' + id,
            idToken: 'synthetic-id-' + id,
            expiresAt: now + (id === 'one' ? 3600000 : 7200000),
            scopes: ['chatgpt.tokens.use.direct'],
          },
        })),
      }),
    ],
  ]);
  const vault = {
    read: async (key: string) => values.get(key) || '',
    write: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const authorizations: string[] = [];
  const mock = (async (input, init) => {
    assert.equal(String(input), 'https://api.openai.com/v1/models');
    const authorization = new Headers(init?.headers).get('authorization')!;
    authorizations.push(authorization);
    return Response.json({
      models: [
        {
          slug: authorization.endsWith('-one') ? 'model-one' : 'model-two',
          visibility: 'list',
        },
      ],
    });
  }) as typeof fetch;
  const auth = new ChatGPTAuth(root, vault, { fetch: mock, now: () => now });
  await auth.load();
  auth.message = 'Existing account message';
  let catalog = Promise.resolve([] as Awaited<ReturnType<ChatGPTAuth['models']>>);
  const afterOperation = vi.fn(() => {
    catalog = auth.models();
  });
  const operations = createAccountOperations({
    isStopping: () => false,
    hasActiveTurn: () => false,
    afterOperation,
  });
  return {
    auth,
    vault,
    values,
    authorizations,
    operations,
    afterOperation,
    catalog: () => catalog,
    advance: () => {
      now += 3600000;
    },
  };
}

for (const rejectSelection of [false, true]) {
  test(`background renewal preserves durable identity after ${rejectSelection ? 'rejected' : 'accepted'} selection`, async (t) => {
    const f = await selectionFixture(t);
    await f.auth.models();
    f.advance();
    const fetchModels = f.auth.fetcher;
    const tokenExchange = vi.fn(async (init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('client_id'), 'oaiapp_one');
      assert.equal(body.get('refresh_token'), 'synthetic-refresh-one');
      return Response.json({
        access_token: 'synthetic-renewed-one',
        refresh_token: 'synthetic-rotated-one',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    });
    f.auth.fetcher = (async (input, init) => {
      if (String(input) === 'https://auth.openai.com/.well-known/openid-configuration') {
        return Response.json({
          issuer: 'https://auth.openai.com',
          authorization_endpoint: 'https://auth.openai.com/authorize',
          token_endpoint: 'https://auth.openai.com/token',
          jwks_uri: 'https://auth.openai.com/jwks',
        });
      }
      if (String(input) === 'https://auth.openai.com/token') {
        return tokenExchange(init);
      }
      return fetchModels(input, init);
    }) as typeof fetch;
    const gates = [0, 1].map(() => {
      let release!: () => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<void>((resolve, rejectWrite) => {
        release = resolve;
        reject = rejectWrite;
      });
      return { promise, release, reject };
    });
    let notifyWriting!: () => void;
    const writing = new Promise<void>((resolve) => {
      notifyWriting = resolve;
    });
    const write = f.vault.write.getMockImplementation()!;
    let writes = 0;
    const committed: string[] = [];
    f.vault.write.mockImplementation(async (key, value) => {
      const index = writes++;
      if (index === 0) {
        notifyWriting();
      }
      await gates[index]?.promise;
      await write(key, value);
      committed.push(JSON.parse(value).activeId);
    });
    const state = {
      modelCatalog: [] as Awaited<ReturnType<ChatGPTAuth['models']>>,
      modelCatalogError: undefined as string | undefined,
    };
    const refreshCatalog = createModelCatalogRefresh({
      state,
      connections: new ModelConnections(
        path.join(f.auth.runtime, 'connections.json'),
        f.vault,
        f.auth,
      ),
      changed: () => {},
    });
    const selection = f.operations.run(() => f.auth.select('oaiapp_two'));
    const settled = rejectSelection
      ? assert.rejects(selection, /Synthetic queued rejection/)
      : selection;
    let background: Promise<void> | undefined;
    try {
      await writing;
      background = refreshCatalog();
      // Flush the mock exchange and its persistence attempt without releasing selection.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(tokenExchange.mock.calls.length, 1);
      assert.equal(f.operations.busy(), true);
      assert.equal(f.auth.state().activeId, 'oaiapp_one');
      if (rejectSelection) {
        gates[0]!.reject(Error('Synthetic queued rejection'));
      } else {
        gates[0]!.release();
      }
      await settled;
      const expectedId = rejectSelection ? 'oaiapp_one' : 'oaiapp_two';
      if (!rejectSelection) {
        assert.equal((await selection).activeId, 'oaiapp_two');
      }
      assert.equal(JSON.parse(f.values.get('chatgpt:accounts')!).activeId, expectedId);
      gates[1]!.release();
      await background;
      await f.catalog();
      assert.equal(state.modelCatalogError, undefined);
      assert.equal(f.auth.state().activeId, expectedId);
      assert.equal(JSON.parse(f.values.get('chatgpt:accounts')!).activeId, expectedId);
      assert.deepEqual(committed, rejectSelection ? ['oaiapp_one'] : ['oaiapp_two', 'oaiapp_two']);
      if (rejectSelection) {
        // Both the already-queued renewal and a later selection must survive the rejection.
        await f.operations.run(() => f.auth.select('oaiapp_two'));
        await f.catalog();
        assert.equal(f.auth.state().activeId, 'oaiapp_two');
        assert.equal(JSON.parse(f.values.get('chatgpt:accounts')!).activeId, 'oaiapp_two');
      }
      const restored = new ChatGPTAuth(f.auth.runtime, f.vault);
      await restored.load();
      assert.equal(restored.state().activeId, 'oaiapp_two');
      assert.equal(f.auth.saved.profiles[0]?.tokens?.refreshToken, 'synthetic-rotated-one');
      assert.equal(
        JSON.parse(f.values.get('chatgpt:accounts')!).profiles[0].tokens.refreshToken,
        'synthetic-rotated-one',
      );
      assert.equal(tokenExchange.mock.calls.length, 1);
      assert.equal(writes, rejectSelection ? 3 : 2);
    } finally {
      for (const gate of gates) {
        gate.release();
      }
      await Promise.allSettled([settled, background]);
      await f.catalog();
    }
  });
}

test('rejected account selection preserves the active identity and permits a successful retry', async (t) => {
  const f = await selectionFixture(t);
  const cached = await f.auth.models();
  const before = f.auth.state();
  const durable = f.values.get('chatgpt:accounts');
  const write = f.vault.write.getMockImplementation()!;
  f.vault.write.mockRejectedValueOnce(Error('Synthetic vault rejection'));

  await assert.rejects(
    f.operations.run(() => f.auth.select('oaiapp_two')),
    /Synthetic vault rejection/,
  );
  const catalog = await f.catalog();
  await f.auth.authorized('https://api.openai.com/v1/models', { method: 'GET' });
  assert.deepEqual(
    {
      activeId: f.auth.state().activeId,
      authorization: f.authorizations.at(-1),
      durableActiveId: JSON.parse(f.values.get('chatgpt:accounts')!).activeId,
    },
    {
      activeId: 'oaiapp_one',
      authorization: 'Bearer synthetic-access-one',
      durableActiveId: 'oaiapp_one',
    },
  );
  assert.deepEqual(f.auth.state(), before);
  assert.equal(f.values.get('chatgpt:accounts'), durable);
  assert.equal(catalog, cached);
  assert.equal(f.authorizations.length, 2);
  assert.equal(f.operations.busy(), false);
  assert.equal(f.afterOperation.mock.calls.length, 1);

  f.vault.write.mockImplementation(write);
  await f.operations.run(() => f.auth.select('oaiapp_two'));
  const selected = await f.catalog();
  assert.equal(f.auth.state().activeId, 'oaiapp_two');
  assert.equal(JSON.parse(f.values.get('chatgpt:accounts')!).activeId, 'oaiapp_two');
  assert.equal(f.auth.state().message, '');
  assert.equal(f.auth.state().revision, before.revision + 1);
  assert.equal(f.vault.write.mock.calls.length, 2);
  assert.equal(f.afterOperation.mock.calls.length, 2);
  assert.equal(f.authorizations.length, 3);
  assert.equal(f.authorizations.at(-1), 'Bearer synthetic-access-two');
  assert.equal(selected[0]?.slug, 'model-two');
  assert.equal(await f.auth.models(), selected);
  assert.equal(f.authorizations.length, 3);
});

for (const rejectWrite of [false, true]) {
  test(`account selection stays unchanged during a deferred ${rejectWrite ? 'rejected' : 'successful'} write`, async (t) => {
    const f = await selectionFixture(t);
    const cached = await f.auth.models();
    const before = f.auth.state();
    const durable = f.values.get('chatgpt:accounts');
    let release!: () => void;
    let reject!: (reason: Error) => void;
    let notifyEntered!: () => void;
    const gate = new Promise<void>((resolve, rejectGate) => {
      release = resolve;
      reject = rejectGate;
    });
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const write = f.vault.write.getMockImplementation()!;
    f.vault.write.mockImplementationOnce(async (key, value) => {
      notifyEntered();
      await gate;
      await write(key, value);
    });
    const selection = f.operations.run(() => f.auth.select('oaiapp_two'));
    const settled = rejectWrite
      ? assert.rejects(selection, /Synthetic deferred rejection/)
      : selection;
    try {
      await entered;
      assert.equal(f.operations.busy(), true);
      assert.deepEqual(f.auth.state(), before);
      assert.equal(f.values.get('chatgpt:accounts'), durable);
      assert.equal(await f.auth.models(), cached);
      await f.auth.authorized('https://api.openai.com/v1/models', { method: 'GET' });
      assert.equal(f.authorizations.at(-1), 'Bearer synthetic-access-one');
      assert.equal(f.afterOperation.mock.calls.length, 0);
    } finally {
      if (rejectWrite) {
        reject(Error('Synthetic deferred rejection'));
      } else {
        release();
      }
      await settled;
      await f.catalog();
    }
    assert.equal(f.operations.busy(), false);
    assert.equal(f.afterOperation.mock.calls.length, 1);
    assert.equal(f.auth.state().activeId, rejectWrite ? 'oaiapp_one' : 'oaiapp_two');
    assert.equal(JSON.parse(f.values.get('chatgpt:accounts')!).activeId, f.auth.state().activeId);
    assert.equal(f.auth.state().revision, before.revision + (rejectWrite ? 0 : 1));
    if (rejectWrite) {
      assert.deepEqual(f.auth.state(), before);
      assert.equal(await f.auth.models(), cached);
    } else {
      assert.equal(f.auth.state().message, '');
      assert.equal(f.authorizations.at(-1), 'Bearer synthetic-access-two');
    }
  });
}

async function fixture(t: Pick<TestContext, 'onTestFinished'>) {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-auth-')),
    values = new Map<string, string>();
  const vault = {
    read: async (k: string) => values.get(k) || '',
    write: async (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const key = await generateKeyPair('RS256'),
    jwk = { ...(await exportJWK(key.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  let now = Date.now(),
    nonce = '',
    subject = 'player-one',
    audience = 'oaiapp_one',
    scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  let tokenError = false,
    refreshError = false,
    refreshCount = 0,
    tokenCount = 0,
    rejected = 0,
    revocationOK = true,
    revocationThrows = false;
  const calls: { url: string; body: URLSearchParams }[] = [];
  const sign = () =>
    new SignJWT({ nonce, email: 'player@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject(subject)
      .setIssuer('https://auth.openai.com')
      .setAudience(audience)
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + 3600)
      .sign(key.privateKey);
  const mock = (async (input, init) => {
    const url = String(input),
      body = new URLSearchParams(String(init?.body || ''));
    calls.push({ url, body });
    if (url.endsWith('openid-configuration')) {
      return Response.json({
        issuer: 'https://auth.openai.com',
        authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
        token_endpoint: 'https://auth.openai.com/token',
        jwks_uri: 'https://auth.openai.com/jwks',
        revocation_endpoint: 'https://auth.openai.com/revoke',
      });
    }
    if (url.endsWith('/jwks')) {
      return Response.json({ keys: [jwk] });
    }
    if (url.endsWith('/token')) {
      tokenCount++;
      if (body.get('grant_type') === 'refresh_token') {
        refreshCount++;
        if (refreshError) {
          throw Error('Ambiguous network failure');
        }
        return Response.json({
          access_token: 'access-renewed',
          refresh_token: 'refresh-renewed',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: scopes,
        });
      }
      if (tokenError) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({
        access_token: 'access-private',
        refresh_token: 'refresh-private',
        id_token: await sign(),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: scopes,
      });
    }
    if (url.endsWith('/revoke')) {
      if (revocationThrows) {
        throw new Error('network down');
      }
      return new Response('', { status: revocationOK ? 200 : 503 });
    }
    if (url.endsWith('/models')) {
      if (rejected-- > 0) {
        return new Response('', { status: 401 });
      }
      return Response.json({
        models: [
          { slug: 'gpt-test', display_name: 'Test model', visibility: 'list' },
          { slug: 'hidden', visibility: 'hide' },
        ],
      });
    }
    throw Error('Unexpected endpoint ' + url);
  }) as typeof fetch;
  const auth = new ChatGPTAuth(root, vault, { fetch: mock, now: () => now });
  await auth.load();
  t.onTestFinished(async () => {
    await auth.cancel();
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  async function start(id?: string, add = false) {
    const u = new URL((await auth.beginSignIn(id, add)).authorizationUrl);
    nonce = u.searchParams.get('nonce')!;
    return u;
  }
  async function callbackResponse(u: URL, overrides: Record<string, string> = {}) {
    const callback = new URL(u.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      code: 'test-code',
      state: u.searchParams.get('state')!,
      client_id: audience,
      ...overrides,
    }).toString();
    const response = await fetch(callback);
    return { status: response.status, headers: response.headers, html: await response.text() };
  }
  async function callback(u: URL, overrides: Record<string, string> = {}) {
    return (await callbackResponse(u, overrides)).status;
  }
  return {
    auth,
    root,
    vault,
    values,
    calls,
    start,
    callback,
    callbackResponse,
    setNonce: (v: string) => {
      nonce = v;
    },
    setAudience: (v: string) => {
      audience = v;
    },
    setSubject: (v: string) => {
      subject = v;
    },
    setScopes: (v: string) => {
      scopes = v;
    },
    setTokenError: (v: boolean) => {
      tokenError = v;
    },
    setRefreshError: () => {
      refreshError = true;
    },
    setRejected: (v: number) => {
      rejected = v;
    },
    setRevocationError: () => {
      revocationOK = false;
    },
    setRevocationThrows: () => {
      revocationThrows = true;
    },
    advance: () => {
      now += 3600000;
    },
    counts: () => ({ tokenCount, refreshCount }),
  };
}
test('independent OAuth uses PKCE and verified identity; only safe state is public', async (t) => {
  const f = await fixture(t),
    u = await f.start();
  assert.equal(u.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(u.searchParams.get('agent_name_hint'), 'Wisp AI');
  assert.equal(u.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.match(u.searchParams.get('scope')!, /chatgpt.tokens.use.direct/);
  assert.equal(new URL(u.searchParams.get('redirect_uri')!).hostname, '127.0.0.1');
  const expired = await f.callbackResponse(u, { state: 'incorrect' });
  assert.equal(expired.status, 400);
  assert.match(expired.html, /<h1[^>]*>ChatGPT sign-in failed<\/h1>/);
  assert.match(expired.html, /This sign-in attempt is invalid or expired/);
  assert.equal(f.auth.state().status, 'authorizing');
  const connected = await f.callbackResponse(u);
  assert.equal(connected.status, 200);
  assert.equal(connected.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(connected.headers.get('cache-control'), 'no-store');
  assert.equal(connected.headers.get('referrer-policy'), 'no-referrer');
  assert.match(connected.html, /<h1[^>]*>ChatGPT connected<\/h1>/);
  assert.match(connected.html, /Return to Wisp/);
  assert.doesNotMatch(
    connected.html,
    /test-code|player@example\.test|access-private|refresh-private/,
  );
  assert.equal(f.auth.state().status, 'connected');
  assert.equal(f.auth.state().account, 'player@example.test');
  const exchange = f.calls.find((c) => c.body.get('grant_type') === 'authorization_code')!.body;
  assert.equal(exchange.get('client_id'), 'oaiapp_one');
  assert.equal(
    createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'),
    u.searchParams.get('code_challenge'),
  );
  assert.equal(exchange.has('client_secret'), false);
  assert.doesNotMatch(JSON.stringify(f.auth.state()), /access-private|refresh-private|eyJ/);
  const restored = new ChatGPTAuth(f.root, f.vault);
  await restored.load();
  assert.equal(restored.hostId, f.auth.hostId);
  assert.equal(restored.state().status, 'connected');
  assert.doesNotMatch(
    await readFile(path.join(f.root, 'chatgpt-host.json'), 'utf8'),
    /access-private|refresh-private/,
  );
});
test('rejects an invalid nonce, audience, identity change and registration mismatch', async (t) => {
  const f = await fixture(t);
  let u = await f.start();
  f.setNonce('wrong');
  assert.equal(await f.callback(u), 400);
  assert.equal(f.auth.state().status, 'signed_out');
  u = await f.start();
  assert.equal(u.searchParams.get('client_id'), 'oaiapp_one');
  f.setAudience('oaiapp_wrong');
  assert.equal(await f.callback(u, { client_id: 'oaiapp_one' }), 400);
  f.setAudience('oaiapp_one');
  u = await f.start();
  assert.equal(await f.callback(u), 200);
  u = await f.start();
  assert.equal(await f.callback(u, { client_id: 'oaiapp_wrong' }), 400);
  assert.equal(f.auth.state().status, 'connected');
  u = await f.start();
  f.setSubject('different-player');
  assert.equal(await f.callback(u), 400);
  assert.equal(f.auth.state().status, 'connected');
});
test('retains issued registration on failed exchange and cancels listeners', async (t) => {
  const f = await fixture(t),
    u = await f.start();
  f.setTokenError(true);
  assert.equal(await f.callback(u), 400);
  const retry = await f.start();
  assert.equal(retry.searchParams.get('client_id'), 'oaiapp_one');
  await f.auth.cancel();
  assert.equal(f.auth.state().status, 'signed_out');
  await assert.rejects(() => fetch(retry.searchParams.get('redirect_uri')!));
});
test('rotating refresh is single flight and never retries ambiguous refresh tokens', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.callback(await f.start()), 200);
  f.advance();
  assert.deepEqual(
    await Promise.all([f.auth.accessToken(), f.auth.accessToken(), f.auth.accessToken()]),
    ['access-renewed', 'access-renewed', 'access-renewed'],
  );
  assert.equal(f.counts().refreshCount, 1);
  f.advance();
  f.setRefreshError();
  await assert.rejects(() => f.auth.accessToken());
  await assert.rejects(() => f.auth.accessToken());
  assert.equal(f.counts().refreshCount, 2);
  assert.equal(f.auth.state().status, 'reauth_required');
});
test('missing plan consent cannot invoke inference', async (t) => {
  const f = await fixture(t);
  f.setScopes('openid profile email');
  const pending = await f.callbackResponse(await f.start());
  assert.equal(pending.status, 200);
  assert.match(pending.html, /<h1[^>]*>One more step<\/h1>/);
  assert.match(pending.html, /Select Continue with ChatGPT to grant access/);
  assert.equal(f.auth.state().status, 'plan_permission_required');
  await assert.rejects(() => f.auth.accessToken(), /Allow Wisp/);
});
test('models are scoped to the active grant and a 401 renews once', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.callback(await f.start()), 200);
  f.setRejected(1);
  assert.deepEqual(await f.auth.models(), [
    {
      slug: 'gpt-test',
      displayName: 'Test model',
      efforts: [],
      defaultEffort: undefined,
      contextWindow: undefined,
    },
  ]);
  assert.equal(f.counts().refreshCount, 1);
  await assert.rejects(
    () => f.auth.authorized('https://chatgpt.com/backend-api/responses', {}),
    /Unsupported/,
  );
});
test('disconnect revokes only this registration and retains the reusable mapping', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.callback(await f.start()), 200);
  const host = f.auth.hostId;
  await f.auth.disconnect();
  const revoke = f.calls.find((c) => c.url.endsWith('/revoke'))!.body;
  assert.equal(revoke.get('token'), 'refresh-private');
  assert.equal(revoke.get('client_id'), 'oaiapp_one');
  assert.equal(f.auth.state().status, 'signed_out');
  assert.equal(f.auth.hostId, host);
  assert.doesNotMatch(f.values.get('chatgpt:accounts')!, /refresh-private|access-private|idToken/);
  const u = await f.start();
  assert.equal(u.searchParams.get('client_id'), 'oaiapp_one');
  assert.equal(u.searchParams.has('id_token_hint'), false);
});
test('unconfirmed revocation still clears local credentials and explains the outcome', async (t) => {
  const f = await fixture(t);
  await f.callback(await f.start());
  f.setRevocationError();
  await f.auth.disconnect();
  assert.equal(f.auth.state().status, 'signed_out');
  assert.match(f.auth.state().message, /could not be confirmed/);
  assert.doesNotMatch(f.values.get('chatgpt:accounts')!, /refresh-private/);
});
test('a failed revocation request is logged without the token', async (t) => {
  const warn = vi.spyOn(bridgeLogger, 'warn').mockImplementation(() => {});
  t.onTestFinished(() => warn.mockRestore());
  const f = await fixture(t);
  await f.callback(await f.start());
  f.setRevocationThrows();
  await f.auth.disconnect();
  assert.match(f.auth.state().message, /could not be confirmed/);
  assert.deepEqual(warn.mock.calls[0], [{ event: 'auth.revoke_failed', error: 'network down' }]);
  assert.doesNotMatch(JSON.stringify(warn.mock.calls), /refresh-private/);
});
test('cancelling during a credential write waits for rollback before another sign-in', async (t) => {
  const f = await fixture(t),
    u = await f.start(),
    write = f.vault.write;
  let entered = () => {},
    release = () => {};
  const writing = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  f.vault.write = async (k, v) => {
    if (v.includes('access-private')) {
      entered();
      await gate;
    }
    await write(k, v);
  };
  const callback = f.callback(u).catch(() => 0);
  await writing;
  let cancelled = false;
  const cancel = f.auth.cancel().then(() => {
    cancelled = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelled, false);
  release();
  await cancel;
  await callback;
  assert.equal(f.auth.state().status, 'signed_out');
  assert.doesNotMatch(f.values.get('chatgpt:accounts')!, /access-private|refresh-private/);
  const next = await f.start();
  assert.equal(next.searchParams.get('client_id'), 'oaiapp_one');
});
