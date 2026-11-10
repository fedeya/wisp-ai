import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { SecretVault } from './secret-vault.ts';
import { accountModel, type AccountModel, type AccountModelInput } from './chat-model.ts';

const ISSUER = 'https://auth.openai.com',
  RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const tokenSet = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  idToken: z.string().min(1),
  expiresAt: z.number().finite(),
  scopes: z.array(z.string()),
});
const profileSchema = z.object({
  id: z.string().regex(/^oaiapp_[A-Za-z0-9_-]+$/),
  subject: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  tokens: tokenSet.optional(),
  frozen: z.boolean().optional(),
});
const savedSchema = z.object({
  activeId: z.string().optional(),
  profiles: z.array(profileSchema).max(12),
});
type Saved = z.infer<typeof savedSchema>;
type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
};
type Pending = {
  id: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  profileId?: string;
  controller: AbortController;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  consumed: boolean;
  work?: Promise<void>;
};
export class ChatGPTAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatGPTAuthError';
  }
}
export class ChatGPTAuth {
  runtime: string;
  vault: SecretVault;
  fetcher: typeof fetch;
  now: () => number;
  saved: Saved = { profiles: [] };
  private persisted: Saved = { profiles: [] };
  hostId = '';
  pending?: Pending;
  revision = 0;
  message = '';
  signingOut = false;
  private discovery?: Promise<Discovery>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private refreshes = new Map<string, Promise<string>>();
  private modelsCache?: {
    id: string;
    models: AccountModel[];
    at: number;
  };
  constructor(
    runtime: string,
    vault: SecretVault,
    options: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.runtime = runtime;
    this.vault = vault;
    this.fetcher = options.fetch || fetch;
    this.now = options.now || Date.now;
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(path.join(this.runtime, 'chatgpt-host.json'), 'utf8'));
      if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(data.hostId)) {
        throw Error('Invalid host identifier');
      }
      this.hostId = data.hostId;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
      this.hostId = 'urn:uuid:' + randomUUID();
      const f = path.join(this.runtime, 'chatgpt-host.json');
      await writeFile(f + '.tmp', JSON.stringify({ hostId: this.hostId }), { mode: 0o600 });
      await rename(f + '.tmp', f);
    }
    const raw = await this.vault.read('chatgpt:accounts');
    if (raw) {
      this.saved = savedSchema.parse(JSON.parse(raw));
    }
    this.persisted = structuredClone(this.saved);
  }
  private exclusive<T>(work: () => Promise<T>) {
    return this.vault.exclusive ? this.vault.exclusive('models', work) : work();
  }
  async reloadAccounts() {
    const raw = await this.vault.read('chatgpt:accounts');
    const next: Saved = raw ? savedSchema.parse(JSON.parse(raw)) : { profiles: [] };
    if (!isDeepStrictEqual(this.saved, next)) {
      this.modelsCache = undefined;
      this.revision++;
    }
    this.saved = next;
    this.persisted = structuredClone(this.saved);
  }
  private async persist() {
    await this.exclusive(async () => {
      if (this.vault.exclusive) {
        const raw = await this.vault.read('chatgpt:accounts');
        const current: Saved = raw ? savedSchema.parse(JSON.parse(raw)) : { profiles: [] };
        const previous = new Map(this.persisted.profiles.map((p) => [p.id, p]));
        for (const profile of this.saved.profiles) {
          if (!isDeepStrictEqual(profile, previous.get(profile.id))) {
            current.profiles = [...current.profiles.filter((p) => p.id !== profile.id), profile];
          }
        }
        if (this.saved.activeId !== this.persisted.activeId) {
          current.activeId = this.saved.activeId;
        }
        this.saved = current;
      }
      await this.vault.write('chatgpt:accounts', JSON.stringify(this.saved));
      this.persisted = structuredClone(this.saved);
    });
    this.revision++;
    this.modelsCache = undefined;
  }
  private current() {
    return this.saved.profiles.find((p) => p.id === this.saved.activeId);
  }
  state() {
    const profile = this.current();
    let status = 'signed_out';
    if (profile?.tokens) {
      status = profile.frozen
        ? 'reauth_required'
        : !profile.tokens.scopes.includes('chatgpt.tokens.use.direct')
          ? 'plan_permission_required'
          : 'connected';
      if (!profile.tokens.refreshToken && profile.tokens.expiresAt <= this.now()) {
        status = 'reauth_required';
      }
    }
    if (this.pending) {
      status = 'authorizing';
    }
    if (this.signingOut) {
      status = 'disconnecting';
    }
    return {
      status,
      revision: this.revision,
      activeId: this.saved.activeId || null,
      account: profile?.email || profile?.name || null,
      message: this.message,
      profiles: this.saved.profiles.map((p, index) => ({
        id: p.id,
        label: (p.email || p.name || 'ChatGPT account') + ' - Connection ' + (index + 1),
        connected: !!p.tokens && !p.frozen && p.tokens.scopes.includes('chatgpt.tokens.use.direct'),
      })),
    };
  }
  private async metadata() {
    if (!this.discovery) {
      this.discovery = (async () => {
        const response = await this.fetcher(ISSUER + '/.well-known/openid-configuration', {
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        if (!response.ok) {
          throw new ChatGPTAuthError(
            'Cannot reach ChatGPT sign-in. Check your connection and retry.',
          );
        }
        const data = (await response.json()) as Discovery;
        if (data.issuer !== ISSUER) {
          throw new ChatGPTAuthError('ChatGPT returned an unexpected issuer.');
        }
        for (const key of [
          'authorization_endpoint',
          'token_endpoint',
          'jwks_uri',
          'revocation_endpoint',
        ] as const) {
          const value = data[key];
          if (!value && key === 'revocation_endpoint') {
            continue;
          }
          const url = new URL(value || '');
          if (url.origin !== ISSUER || url.username || url.password) {
            throw new ChatGPTAuthError('ChatGPT returned an unexpected authentication endpoint.');
          }
        }
        return data;
      })().catch((error) => {
        this.discovery = undefined;
        throw error;
      });
    }
    return this.discovery;
  }
  async beginSignIn(profileId?: string, newAccount = false) {
    if (this.signingOut) {
      throw new ChatGPTAuthError('Wait for disconnection to finish.');
    }
    await this.cancel();
    if (newAccount && this.saved.profiles.length >= 12) {
      throw new ChatGPTAuthError('Use an existing saved account.');
    }
    const chosen = newAccount
      ? undefined
      : this.saved.profiles.find((p) => p.id === (profileId || this.saved.activeId)) ||
        (!profileId ? this.saved.profiles.at(-1) : undefined);
    if (profileId && !chosen) {
      throw new ChatGPTAuthError('Saved ChatGPT account not found.');
    }
    const metadata = await this.metadata(),
      state = randomBytes(32).toString('base64url'),
      nonce = randomBytes(32).toString('base64url'),
      verifier = randomBytes(32).toString('base64url');
    const controller = new AbortController(),
      id = randomUUID();
    const server = createServer((req, res) => {
      void (async () => {
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('referrer-policy', 'no-referrer');
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const current = this.pending;
        if (req.method !== 'GET' || url.pathname !== '/auth/callback') {
          res.writeHead(404).end('Not found');
          return;
        }
        const supplied = Buffer.from(url.searchParams.get('state') || ''),
          expected = Buffer.from(state);
        if (
          !current ||
          current.id !== id ||
          current.consumed ||
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        ) {
          res.writeHead(400).end('This sign-in attempt is invalid or expired. Return to Wisp.');
          return;
        }
        current.consumed = true;
        let settled = () => {};
        current.work = new Promise<void>((resolve) => {
          settled = resolve;
        });
        try {
          if (url.searchParams.has('error')) {
            throw new ChatGPTAuthError('ChatGPT sign-in was declined. You can try again.');
          }
          const code = url.searchParams.get('code');
          if (!code || code.length > 10000) {
            throw new ChatGPTAuthError('ChatGPT did not return an authorization code.');
          }
          const clientId = url.searchParams.get('client_id') || chosen?.id;
          if (
            !clientId ||
            !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) ||
            (chosen && clientId !== chosen.id)
          ) {
            throw new ChatGPTAuthError('ChatGPT returned a different account registration.');
          }
          if (!chosen) {
            if (this.saved.profiles.some((p) => p.id === clientId)) {
              throw new ChatGPTAuthError('This registration is already saved. Choose it in Wisp.');
            }
            this.saved.profiles.push({ id: clientId });
            await this.persist();
          }
          current.controller.signal.throwIfAborted();
          const data = await this.exchange(
            {
              grant_type: 'authorization_code',
              client_id: clientId,
              code,
              code_verifier: verifier,
              redirect_uri: current.redirectUri,
              resource: RESOURCE,
            },
            current.controller.signal,
          );
          const identity = await this.identity(data.id_token, clientId, nonce);
          if (chosen?.subject && chosen.subject !== identity.sub) {
            throw new ChatGPTAuthError(
              'This sign-in belongs to a different ChatGPT account. Use Add account instead.',
            );
          }
          const tokens = this.tokens(data);
          current.controller.signal.throwIfAborted();
          const previous = structuredClone(this.saved),
            entry = this.saved.profiles.find((p) => p.id === clientId)!;
          Object.assign(entry, {
            subject: identity.sub,
            email: typeof identity.email === 'string' ? identity.email : undefined,
            name: typeof identity.name === 'string' ? identity.name : undefined,
            tokens,
            frozen: false,
          });
          this.saved.activeId = clientId;
          await this.persist();
          if (current.controller.signal.aborted) {
            this.saved = previous;
            await this.persist();
            throw new ChatGPTAuthError('Sign-in cancelled.');
          }
          this.message = tokens.scopes.includes('chatgpt.tokens.use.direct')
            ? ''
            : 'Connected account, but ChatGPT plan use was not granted. Continue with ChatGPT to authorize plan use.';
          res.end('Wisp is connected. You can close this tab and return to the app.');
        } catch (error) {
          this.message =
            error instanceof ChatGPTAuthError
              ? error.message
              : current.controller.signal.aborted
                ? 'Sign-in cancelled.'
                : 'Sign-in could not be completed. Return to Wisp and try again.';
          res.writeHead(400).end(this.message);
        } finally {
          if (this.pending?.id === id) {
            this.pending = undefined;
            clearTimeout(current.timer);
            this.revision++;
          }
          settled();
          setTimeout(() => {
            server.closeAllConnections();
            server.close();
          }, 100).unref();
        }
      })().catch(() => {
        res.writeHead(400).end('Sign-in failed. Return to Wisp.');
        void this.cancel();
      });
    });
    server.maxConnections = 10;
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port,
      redirectUri = 'http://127.0.0.1:' + port + '/auth/callback';
    const timer = setTimeout(() => {
      if (this.pending?.id === id) {
        this.message = 'Sign-in timed out. Please try again.';
        void this.cancel(false);
      }
    }, 300000);
    timer.unref();
    this.pending = {
      id,
      state,
      nonce,
      verifier,
      redirectUri,
      profileId: chosen?.id,
      controller,
      server,
      timer,
      consumed: false,
    };
    this.message = 'Complete sign-in in your browser.';
    this.revision++;
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: chosen?.id || 'dynamic_agent_client',
      ...(chosen ? {} : { agent_name_hint: 'Wisp AI' }),
      ext_agent_host_id: this.hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      ...(chosen?.tokens?.idToken ? { id_token_hint: chosen.tokens.idToken } : {}),
      ...(chosen?.email ? { login_hint: chosen.email } : {}),
    }).toString();
    return { authorizationUrl: url.toString() };
  }
  async cancel(message = true) {
    const attempt = this.pending;
    if (!attempt) {
      return;
    }
    this.pending = undefined;
    attempt.controller.abort();
    clearTimeout(attempt.timer);
    attempt.server.closeAllConnections();
    await new Promise<void>((r) => attempt.server.close(() => r()));
    await attempt.work;
    if (message) {
      this.message = 'Sign-in cancelled.';
    }
    this.revision++;
  }
  private async exchange(parameters: Record<string, string>, signal?: AbortSignal) {
    const meta = await this.metadata();
    const response = await this.fetcher(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(parameters),
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new ChatGPTAuthError(
        response.status === 400 || response.status === 401
          ? 'The ChatGPT session needs a new sign-in.'
          : 'ChatGPT could not complete authentication. Please try again.',
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }
  private tokens(data: Record<string, unknown>, previous?: z.infer<typeof tokenSet>) {
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.token_type !== 'Bearer'
    ) {
      throw new ChatGPTAuthError('ChatGPT returned an invalid token response.');
    }
    const scopes =
      typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
    if (!scopes) {
      throw new ChatGPTAuthError('ChatGPT did not confirm the granted permissions.');
    }
    const idToken = typeof data.id_token === 'string' ? data.id_token : previous?.idToken;
    if (!idToken) {
      throw new ChatGPTAuthError('ChatGPT did not return a verifiable identity.');
    }
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      idToken,
      expiresAt: this.now() + data.expires_in * 1000,
      scopes,
    };
  }
  private async identity(token: unknown, clientId: string, nonce?: string) {
    if (typeof token !== 'string') {
      throw new ChatGPTAuthError('ChatGPT did not return a verifiable identity.');
    }
    const meta = await this.metadata();
    this.jwks ??= createRemoteJWKSet(new URL(meta.jwks_uri), { [customFetch]: this.fetcher });
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: ISSUER,
      audience: clientId,
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
      currentDate: new Date(this.now()),
    });
    if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) {
      throw new ChatGPTAuthError('ChatGPT identity validation failed.');
    }
    return payload;
  }
  async select(id: string) {
    if (this.pending || this.signingOut) {
      throw new ChatGPTAuthError('Finish the current account operation first.');
    }
    if (!this.saved.profiles.some((p) => p.id === id)) {
      throw new ChatGPTAuthError('Saved account not found.');
    }
    this.saved.activeId = id;
    this.message = '';
    await this.persist();
    return this.state();
  }
  async accessToken(rejectedToken?: string): Promise<string> {
    if (!this.vault.exclusive) {
      return this.currentAccessToken(rejectedToken);
    }
    return this.exclusive(async () => {
      await this.reloadAccounts();
      return this.currentAccessToken(rejectedToken);
    });
  }
  private async currentAccessToken(rejectedToken?: string): Promise<string> {
    if (this.signingOut) {
      throw new ChatGPTAuthError('Wisp is disconnecting.');
    }
    const profile = this.current();
    if (!profile?.tokens || profile.frozen) {
      throw new ChatGPTAuthError('Sign in with ChatGPT in Wisp desktop.');
    }
    if (!profile.tokens.scopes.includes('chatgpt.tokens.use.direct')) {
      throw new ChatGPTAuthError('Allow Wisp to use your ChatGPT plan in the sign-in screen.');
    }
    const tokens = profile.tokens;
    if (
      (!rejectedToken || rejectedToken !== tokens.accessToken) &&
      tokens.expiresAt - this.now() > 60000
    ) {
      return tokens.accessToken;
    }
    const previous = this.refreshes.get(profile.id);
    if (previous) {
      return previous;
    }
    const work = (async () => {
      try {
        if (!tokens.refreshToken) {
          throw new ChatGPTAuthError('Sign in with ChatGPT again to renew access.');
        }
        const data = await this.exchange({
          grant_type: 'refresh_token',
          client_id: profile.id,
          refresh_token: tokens.refreshToken,
          resource: RESOURCE,
        });
        const renewed = this.tokens(data, tokens);
        if (!renewed.refreshToken) {
          throw new ChatGPTAuthError(
            'ChatGPT did not return a replacement refresh token. Sign in again.',
          );
        }
        if (data.id_token) {
          const identity = await this.identity(data.id_token, profile.id);
          if (identity.sub !== profile.subject) {
            throw new ChatGPTAuthError('ChatGPT account changed during renewal.');
          }
        }
        profile.tokens = renewed;
        profile.frozen = false;
        await this.persist();
        return renewed.accessToken;
      } catch {
        profile.frozen = true;
        this.message =
          'ChatGPT needs a new sign-in. The previous refresh token will not be retried.';
        await this.persist();
        throw new ChatGPTAuthError(this.message);
      } finally {
        this.refreshes.delete(profile.id);
      }
    })();
    this.refreshes.set(profile.id, work);
    return work;
  }
  async disconnect() {
    await this.cancel();
    return this.exclusive(async () => {
      if (this.vault.exclusive) {
        await this.reloadAccounts();
      }
      return this.disconnectCurrent();
    });
  }
  private async disconnectCurrent() {
    this.signingOut = true;
    const profile = this.current();
    let confirmed = true;
    try {
      if (profile) {
        await this.refreshes.get(profile.id)?.catch(() => {});
        const token = profile.tokens?.refreshToken;
        if (token) {
          confirmed = false;
          try {
            const meta = await this.metadata();
            if (meta.revocation_endpoint) {
              for (let attempt = 0; attempt < 2; attempt++) {
                const r = await this.fetcher(meta.revocation_endpoint, {
                  method: 'POST',
                  headers: { 'content-type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams({
                    token,
                    token_type_hint: 'refresh_token',
                    client_id: profile.id,
                  }),
                  redirect: 'error',
                  signal: AbortSignal.timeout(8000),
                });
                if (r.status === 200) {
                  confirmed = true;
                  break;
                }
                if (r.status < 500) {
                  break;
                }
                await new Promise((r) => setTimeout(r, 500));
              }
            }
          } catch {}
        }
        profile.tokens = undefined;
        profile.frozen = false;
        await this.persist();
      }
      this.message = confirmed
        ? 'Wisp disconnected. Your other apps stay signed in.'
        : 'Disconnected locally. Remote revocation could not be confirmed; review Wisp in ChatGPT Settings.';
    } finally {
      this.signingOut = false;
      this.revision++;
    }
    return this.state();
  }
  async models() {
    const id = this.current()?.id,
      cache = this.modelsCache;
    if (cache && cache.id === id && this.now() - cache.at < 300000) {
      return cache.models;
    }
    const response = await this.authorized(RESOURCE + '/models', {
      method: 'GET',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new ChatGPTAuthError('Could not load models for this ChatGPT account.');
    }
    const data = (await response.json()) as {
      models?: (AccountModelInput & {
        visibility?: string;
      })[];
    };
    if (!Array.isArray(data.models)) {
      throw new ChatGPTAuthError('ChatGPT returned an unexpected model catalog.');
    }
    const models = data.models
      .filter(
        (m) =>
          m.visibility === 'list' &&
          typeof m.slug === 'string' &&
          /^[A-Za-z0-9_.:-]{1,100}$/.test(m.slug),
      )
      .map((m) => accountModel(m));
    this.modelsCache = { id: id!, models, at: this.now() };
    return models;
  }
  async authorized(url: string, init: RequestInit) {
    if (![RESOURCE + '/responses', RESOURCE + '/models'].includes(url)) {
      throw new ChatGPTAuthError('Unsupported ChatGPT endpoint.');
    }
    const token = await this.accessToken(),
      headers = new Headers(init.headers);
    headers.set('authorization', 'Bearer ' + token);
    let response = await this.fetcher(url, { ...init, headers, redirect: 'error' });
    if (response.status === 401) {
      await response.body?.cancel();
      const replacement = await this.accessToken(token);
      headers.set('authorization', 'Bearer ' + replacement);
      response = await this.fetcher(url, { ...init, headers, redirect: 'error' });
      if (response.status === 401) {
        const p = this.current();
        if (p) {
          p.frozen = true;
          await this.persist();
        }
        this.message = 'ChatGPT rejected this session. Please sign in again.';
      }
    }
    return response;
  }
}
