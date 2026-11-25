import { z } from 'zod';
import type { SecretVault } from './secret-vault.ts';
import { errorMessage } from '../errors.ts';
import { bridgeLogger as logger } from '../logger.ts';

// Public client used by Grok's own browser sign-in. Wisp never sends an API key
// for this session; the bridge keeps the refresh token in the OS vault.
const ISSUER = 'https://auth.x.ai';
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
  'conversations:read',
  'conversations:write',
  'workspaces:read',
  'workspaces:write',
];
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const GROK_PROXY_BASE = 'https://cli-chat-proxy.grok.com/v1';
// The proxy answers HTTP 426 when this is missing or older than 1.0.13
// ("Grok CLI version (none) is outdated"). Keep it on a current stable CLI release.
const GROK_CLIENT_VERSION = '1.0.92';
export { GROK_SUBSCRIPTION_ID } from '@wisp/protocol/providers';
const ALLOWED_HOSTS = new Set(['accounts.x.ai', 'auth.x.ai']);
const tokenSet = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
  scopes: z.array(z.string()),
});
const profileSchema = z.object({
  id: z.string().min(1).max(200),
  email: z.string().max(320).optional(),
  name: z.string().max(200).optional(),
  tokens: tokenSet.optional(),
  frozen: z.boolean().optional(),
});
const savedSchema = z.object({
  activeId: z.string().optional(),
  profiles: z.array(profileSchema).max(4),
});
type Saved = z.infer<typeof savedSchema>;
type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
};
type Pending = { controller: AbortController; userCode: string };
export class GrokAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrokAuthError';
  }
}
export function grokProxyHeaders(token: string, model?: string) {
  const headers = new Headers({
    authorization: 'Bearer ' + token,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-client-identifier': 'wisp',
    'x-grok-client-version': GROK_CLIENT_VERSION,
    accept: 'application/json',
  });
  if (model) {
    headers.set('x-grok-model-override', model.toLowerCase());
  }
  return headers;
}
export class GrokAuth {
  vault: SecretVault;
  fetcher: typeof fetch;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  saved: Saved = { profiles: [] };
  pending?: Pending;
  revision = 0;
  message = '';
  signingOut = false;
  private refreshes = new Map<string, Promise<string>>();
  private pollTask?: Promise<void>;
  private modelsCache?: { id: string; models: { id: string; name: string }[]; at: number };
  // NativeVault runs one helper per write and does not order them. Account
  // transitions share this queue so an older snapshot cannot land last.
  private vaultQueue: Promise<void> = Promise.resolve();
  constructor(
    vault: SecretVault,
    options: {
      fetch?: typeof fetch;
      now?: () => number;
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    } = {},
  ) {
    this.vault = vault;
    this.fetcher = options.fetch || fetch;
    this.now = options.now || Date.now;
    this.sleep =
      options.sleep ||
      ((ms, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }));
  }
  async load() {
    const raw = await this.vault.read('grok:accounts');
    if (raw) {
      this.saved = savedSchema.parse(JSON.parse(raw));
    }
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.vaultQueue.then(action, action);
    this.vaultQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async writeSaved(next: Saved) {
    await this.vault.write('grok:accounts', JSON.stringify(next));
    this.saved = next;
    this.revision++;
    this.modelsCache = undefined;
  }
  private current() {
    return this.saved.profiles.find((profile) => profile.id === this.saved.activeId);
  }
  private sameSession(id: string, tokens: { accessToken: string; refreshToken: string }) {
    const profile = this.saved.profiles.find((entry) => entry.id === id);
    return (
      !!profile?.tokens &&
      !profile.frozen &&
      profile.tokens.accessToken === tokens.accessToken &&
      profile.tokens.refreshToken === tokens.refreshToken
    );
  }
  state() {
    const profile = this.current();
    let status = 'signed_out';
    if (profile?.tokens) {
      const granted =
        profile.tokens.scopes.includes('grok-cli:access') ||
        profile.tokens.scopes.includes('api:access');
      status = profile.frozen
        ? 'reauth_required'
        : granted
          ? 'connected'
          : 'plan_permission_required';
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
      profiles: this.saved.profiles.map((profile) => ({
        id: profile.id,
        label: profile.email || profile.name || 'Grok account',
        connected: !!profile.tokens && !profile.frozen,
      })),
    };
  }
  async beginSignIn() {
    if (this.signingOut) {
      throw new GrokAuthError('Wait for disconnection to finish.');
    }
    await this.cancel(false);
    const device = await this.requestDeviceCode();
    const controller = new AbortController();
    this.pending = { controller, userCode: device.userCode };
    this.message = 'Confirm this code in your browser: ' + device.userCode;
    this.revision++;
    this.pollTask = this.finish(device, controller);
    return { authorizationUrl: device.verificationUri, userCode: device.userCode };
  }
  async cancel(message = true) {
    const attempt = this.pending;
    if (!attempt) {
      return;
    }
    this.pending = undefined;
    attempt.controller.abort();
    await this.pollTask?.catch(() => {});
    if (message) {
      this.message = 'Sign-in cancelled.';
    }
    this.revision++;
  }
  private async finish(device: DeviceCode, attempt: AbortController) {
    try {
      const tokens = await this.poll(device, attempt.signal);
      if (attempt.signal.aborted) {
        return;
      }
      await this.store(tokens, attempt.signal);
      this.message = '';
    } catch (error) {
      if (attempt.signal.aborted) {
        return;
      }
      this.message =
        error instanceof GrokAuthError
          ? error.message
          : 'Sign-in could not be completed. Return to Wisp and try again.';
    } finally {
      if (this.pending?.controller === attempt) {
        this.pending = undefined;
        this.revision++;
      }
    }
  }
  private async requestDeviceCode(): Promise<DeviceCode> {
    const response = await this.fetcher(ISSUER + '/oauth2/device/code', {
      method: 'POST',
      headers: this.oauthHeaders(),
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: SCOPES.join(' '),
        referrer: 'wisp',
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new GrokAuthError('Cannot reach Grok sign-in. Check your connection and retry.');
    }
    const data = (await response.json()) as Record<string, unknown>;
    const userCode = data.user_code;
    const deviceCode = data.device_code;
    const verification = data.verification_uri_complete || data.verification_uri;
    if (
      typeof userCode !== 'string' ||
      !/^[A-Za-z0-9-]{4,32}$/.test(userCode) ||
      typeof deviceCode !== 'string' ||
      !deviceCode ||
      deviceCode.length > 4096 ||
      typeof verification !== 'string'
    ) {
      throw new GrokAuthError('Grok returned an unexpected sign-in response.');
    }
    const url = this.verificationUrl(verification);
    const interval = typeof data.interval === 'number' && data.interval > 0 ? data.interval : 5;
    const expiresIn =
      typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 600;
    return {
      deviceCode,
      userCode,
      verificationUri: url,
      interval: Math.min(Math.max(interval, 1), 60),
      expiresIn,
    };
  }
  private verificationUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new GrokAuthError('Grok returned an unexpected sign-in page.');
    }
    if (
      url.protocol !== 'https:' ||
      !ALLOWED_HOSTS.has(url.hostname) ||
      url.username ||
      url.password ||
      [...value].some((char) => char.charCodeAt(0) < 32)
    ) {
      throw new GrokAuthError('Grok returned an unexpected sign-in page.');
    }
    return url.toString();
  }
  private oauthHeaders() {
    return {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'x-grok-client-surface': 'ui',
      'x-grok-client-identifier': 'wisp',
    };
  }
  private async poll(device: DeviceCode, signal: AbortSignal) {
    let interval = device.interval;
    const deadline = this.now() + Math.max(device.expiresIn, 60) * 1000;
    while (!signal.aborted) {
      await this.sleep(interval * 1000, signal);
      if (this.now() > deadline) {
        throw new GrokAuthError('Sign-in timed out. Please try again.');
      }
      const response = await this.fetcher(ISSUER + '/oauth2/token', {
        method: 'POST',
        headers: this.oauthHeaders(),
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          device_code: device.deviceCode,
          client_id: CLIENT_ID,
        }),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok) {
        return this.tokens(data || {});
      }
      const code = typeof data?.error === 'string' ? data.error : '';
      if (code === 'authorization_pending') {
        continue;
      }
      if (code === 'slow_down') {
        interval = Math.min(interval + 5, 60);
        continue;
      }
      if (code === 'access_denied') {
        throw new GrokAuthError('Grok sign-in was declined. You can try again.');
      }
      if (code === 'expired_token') {
        throw new GrokAuthError('Sign-in timed out. Please try again.');
      }
      throw new GrokAuthError('Grok could not complete authentication. Please try again.');
    }
    throw new GrokAuthError('Sign-in cancelled.');
  }
  private tokens(data: Record<string, unknown>, previous?: z.infer<typeof tokenSet>) {
    if (typeof data.access_token !== 'string' || !data.access_token) {
      throw new GrokAuthError('Grok returned an invalid token response.');
    }
    const expiresIn =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
        ? data.expires_in
        : 3600;
    const refreshToken =
      typeof data.refresh_token === 'string' && data.refresh_token
        ? data.refresh_token
        : previous?.refreshToken;
    if (!refreshToken) {
      throw new GrokAuthError('Grok did not return a refresh token. Sign in again.');
    }
    const scopes =
      typeof data.scope === 'string'
        ? data.scope.split(/\s+/).filter(Boolean)
        : previous?.scopes || SCOPES;
    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: this.now() + expiresIn * 1000,
      scopes,
      identity: this.identity(data),
    };
  }
  private identity(data: Record<string, unknown>) {
    const claims = [data.id_token, data.access_token]
      .filter((token): token is string => typeof token === 'string')
      .map(jwtPayload);
    const claim = claims.find((entry) => typeof entry.sub === 'string' && entry.sub) || {};
    const sub = typeof claim.sub === 'string' ? claim.sub : 'grok-account';
    const email = typeof claim.email === 'string' ? claim.email : undefined;
    const name = typeof claim.name === 'string' ? claim.name : undefined;
    const id = /^[A-Za-z0-9_.:@|-]{1,200}$/.test(sub) ? sub : 'grok-account';
    return { id, email: email?.slice(0, 320), name: name?.slice(0, 200) };
  }
  private async store(tokens: ReturnType<GrokAuth['tokens']>, signal: AbortSignal) {
    const { identity, ...stored } = tokens;
    const profile = {
      id: identity.id,
      email: identity.email,
      name: identity.name,
      tokens: stored,
      frozen: false,
    };
    const next: Saved = { activeId: profile.id, profiles: [profile] };
    // Earlier refresh or rejection writes run first. Snapshot and recheck
    // cancellation only after they publish, so a cancelled login cannot roll
    // back onto a token that rotation has already replaced.
    await this.exclusive(async () => {
      if (signal.aborted) {
        throw new GrokAuthError('Sign-in cancelled.');
      }
      const previous = structuredClone(this.saved);
      await this.writeSaved(next);
      if (signal.aborted) {
        await this.writeSaved(previous);
        throw new GrokAuthError('Sign-in cancelled.');
      }
    });
  }
  async accessToken(rejectedToken?: string) {
    if (this.signingOut) {
      throw new GrokAuthError('Wisp is disconnecting.');
    }
    const profile = this.current();
    if (!profile?.tokens || profile.frozen) {
      throw new GrokAuthError('Sign in with Grok in Wisp desktop.');
    }
    const granted =
      profile.tokens.scopes.includes('grok-cli:access') ||
      profile.tokens.scopes.includes('api:access');
    if (!granted) {
      throw new GrokAuthError('This Grok account did not grant Wisp access. Sign in again.');
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
      let superseded = false;
      try {
        const response = await this.fetcher(ISSUER + '/oauth2/token', {
          method: 'POST',
          headers: this.oauthHeaders(),
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokens.refreshToken,
            client_id: CLIENT_ID,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          throw new GrokAuthError('The Grok session needs a new sign-in.');
        }
        const renewed = this.tokens((await response.json()) as Record<string, unknown>, tokens);
        const stored = await this.exclusive(async () => {
          if (!this.sameSession(profile.id, tokens)) {
            return false;
          }
          const next = structuredClone(this.saved);
          const target = next.profiles.find((entry) => entry.id === profile.id);
          if (!target) {
            return false;
          }
          target.tokens = {
            accessToken: renewed.accessToken,
            refreshToken: renewed.refreshToken,
            expiresAt: renewed.expiresAt,
            scopes: renewed.scopes,
          };
          target.frozen = false;
          await this.writeSaved(next);
          return true;
        });
        if (!stored) {
          superseded = true;
          throw new GrokAuthError('The Grok session changed. Retry.');
        }
        return renewed.accessToken;
      } catch (error) {
        if (superseded) {
          throw error;
        }
        const frozen = await this.exclusive(async () => {
          if (!this.sameSession(profile.id, tokens)) {
            return false;
          }
          const next = structuredClone(this.saved);
          const target = next.profiles.find((entry) => entry.id === profile.id);
          if (!target?.tokens) {
            return false;
          }
          target.frozen = true;
          await this.writeSaved(next);
          this.message =
            'Grok needs a new sign-in. The previous refresh token will not be retried.';
          return true;
        });
        if (!frozen) {
          throw new GrokAuthError('The Grok session changed. Retry.');
        }
        throw error instanceof GrokAuthError ? error : new GrokAuthError(this.message);
      } finally {
        this.refreshes.delete(profile.id);
      }
    })();
    this.refreshes.set(profile.id, work);
    return work;
  }
  /**
   * The token endpoint accepted a refresh, but the proxy still rejected that
   * access token. A background request can observe the 401 after Reconnect
   * stored a different session, so only the rejected token is frozen.
   */
  async rejectSession(rejectedToken: string) {
    await this.exclusive(async () => {
      const profile = this.current();
      if (!profile?.tokens || profile.frozen || profile.tokens.accessToken !== rejectedToken) {
        return;
      }
      const next = structuredClone(this.saved);
      const target = next.profiles.find((entry) => entry.id === profile.id);
      if (!target?.tokens || target.tokens.accessToken !== rejectedToken) {
        return;
      }
      target.frozen = true;
      await this.writeSaved(next);
      this.message = 'Grok rejected this session. Please sign in again.';
    });
  }
  async disconnect() {
    await this.cancel(false);
    this.signingOut = true;
    const profile = this.current();
    let confirmed = true;
    try {
      if (profile) {
        await this.refreshes.get(profile.id)?.catch(() => {});
        const live = this.saved.profiles.find((entry) => entry.id === profile.id) || profile;
        const token = live.tokens?.refreshToken;
        if (token) {
          confirmed = false;
          try {
            const response = await this.fetcher(ISSUER + '/oauth2/revoke', {
              method: 'POST',
              headers: this.oauthHeaders(),
              body: new URLSearchParams({
                token,
                token_type_hint: 'refresh_token',
                client_id: CLIENT_ID,
              }),
              redirect: 'error',
              signal: AbortSignal.timeout(8000),
            });
            confirmed = response.ok;
          } catch (error) {
            logger.warn({ event: 'grok.revoke_failed', error: errorMessage(error) });
          }
        }
        // Clear tokens only in the copy the vault accepts. A rejected write
        // keeps the live profile, so Disconnect stays available. The clear
        // runs on the queue so an older refresh or rejection cannot restore
        // the session after this write.
        await this.exclusive(async () => {
          const next = structuredClone(this.saved);
          const cleared = next.profiles.find((entry) => entry.id === profile.id);
          if (!cleared?.tokens) {
            return;
          }
          cleared.tokens = undefined;
          cleared.frozen = false;
          await this.writeSaved(next);
        });
      }
      this.message = confirmed
        ? 'Wisp disconnected. Your other apps stay signed in.'
        : 'Disconnected locally. Remote revocation could not be confirmed; review Wisp in your xAI account.';
    } finally {
      this.signingOut = false;
      this.revision++;
    }
    return this.state();
  }
  async models() {
    const id = this.current()?.id;
    const cache = this.modelsCache;
    if (cache && cache.id === id && this.now() - cache.at < 300000) {
      return cache.models;
    }
    const token = await this.accessToken();
    const headers = grokProxyHeaders(token);
    let response = await this.fetcher(GROK_PROXY_BASE + '/models-v2', {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      const renewed = await this.accessToken(token);
      headers.set('authorization', 'Bearer ' + renewed);
      response = await this.fetcher(GROK_PROXY_BASE + '/models-v2', {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 401) {
        await this.rejectSession(renewed);
      }
    }
    if (!response.ok) {
      throw new GrokAuthError('Could not load models for this Grok account.');
    }
    const data = (await response.json()) as { models?: unknown; data?: unknown } | unknown[];
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data.models)
        ? data.models
        : Array.isArray(data.data)
          ? data.data
          : null;
    if (!Array.isArray(rows)) {
      throw new GrokAuthError('Grok returned an unexpected model catalog.');
    }
    const models: { id: string; name: string }[] = [];
    for (const row of rows) {
      const id =
        typeof row === 'string'
          ? row
          : row && typeof row === 'object'
            ? ['id', 'model', 'name']
                .map((key) => (row as Record<string, unknown>)[key])
                .find((value): value is string => typeof value === 'string' && value.length > 0)
            : undefined;
      if (!id || models.some((model) => model.id === id)) {
        continue;
      }
      const name =
        row && typeof row === 'object'
          ? ['display_name', 'displayName', 'name']
              .map((key) => (row as Record<string, unknown>)[key])
              .find(
                (value): value is string =>
                  typeof value === 'string' &&
                  value.trim().length > 0 &&
                  value.trim().length <= 200,
              )
          : undefined;
      models.push({ id, name: name?.trim() || id });
    }
    this.modelsCache = { id: id || '', models, at: this.now() };
    return models;
  }
}
function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) {
    return {};
  }
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
