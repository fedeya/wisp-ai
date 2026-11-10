import { test, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { ChatGPTAuth } from '../src/chatgpt-auth.ts';

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
    revocationOK = true;
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
  async function callback(u: URL, overrides: Record<string, string> = {}) {
    const callback = new URL(u.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      code: 'test-code',
      state: u.searchParams.get('state')!,
      client_id: audience,
      ...overrides,
    }).toString();
    const r = await fetch(callback);
    await r.text();
    return r.status;
  }
  return {
    auth,
    root,
    vault,
    values,
    calls,
    start,
    callback,
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
  assert.equal(await f.callback(u, { state: 'incorrect' }), 400);
  assert.equal(f.auth.state().status, 'authorizing');
  assert.equal(await f.callback(u), 200);
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
  assert.equal(await f.callback(await f.start()), 200);
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
