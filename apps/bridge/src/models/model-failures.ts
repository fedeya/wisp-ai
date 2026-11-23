import type { IncomingHttpHeaders } from 'node:http';
import { MODEL_SESSION_HEADER } from '@wisp/protocol/agent-rpc';
import { ChatGPTAuthError } from '../auth/chatgpt-auth.ts';

/**
 * Why a model request failed, as a fixed category.
 * Taken from the provider's HTTP status or the kind of error the proxy threw,
 * never from the provider's message.
 */
export const modelFailureKinds = [
  'bad_request',
  'auth',
  'not_found',
  'rate_limited',
  'provider_error',
  'http_other',
  'network',
  'timeout',
  'wisp_rejected',
] as const;
export type ModelFailureKind = (typeof modelFailureKinds)[number];

export function httpFailureKind(status: number): ModelFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 413 || status === 422) return 'bad_request';
  if (status >= 500) return 'provider_error';
  return 'http_other';
}

/** Undefined when the request was abandoned by Eve rather than failed. */
export function thrownFailureKind(
  error: unknown,
  signal?: AbortSignal,
): ModelFailureKind | undefined {
  if (signal?.aborted) return undefined;
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return undefined;
  if (error instanceof ChatGPTAuthError) return 'auth';
  // fetch rejects with a TypeError when the provider cannot be reached.
  if (error instanceof TypeError) return 'network';
  return 'wisp_rejected';
}

/** The Eve session a proxied model request belongs to, when the agent named it. */
export function requestSession(headers: IncomingHttpHeaders) {
  const value = headers[MODEL_SESSION_HEADER];
  return typeof value === 'string' && /^[\w-]{1,128}$/.test(value) ? value : undefined;
}

const keptSessions = 256;

/**
 * The latest model failure of each Eve session. A chat runs one turn at a time on
 * its own session, so a failure seen since the turn started is that turn's.
 */
export class ModelFailures {
  private latest = new Map<string, { kind: ModelFailureKind; at: number }>();
  record(session: string | undefined, kind: ModelFailureKind | undefined) {
    if (!session || !kind) return;
    this.latest.delete(session);
    this.latest.set(session, { kind, at: performance.now() });
    if (this.latest.size > keptSessions) {
      this.latest.delete(this.latest.keys().next().value!);
    }
  }
  /** The session's latest failure at or after `since` (performance.now()). */
  since(session: string | undefined, since: number) {
    const failure = session ? this.latest.get(session) : undefined;
    return failure && failure.at >= since ? failure.kind : undefined;
  }
}
