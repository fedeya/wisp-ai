import { parseConnectionModel } from '@wisp/protocol/providers';
import { ChatGPTAuthError } from '../auth/chatgpt-auth.ts';

/**
 * Why the latest model request of a connection failed, as a fixed category.
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

/** Model requests are keyed by connection; the ChatGPT subscription is one source. */
export function modelSource(model: string) {
  return parseConnectionModel(model)?.connection ?? 'chatgpt';
}

export class ModelFailures {
  private latest = new Map<string, { kind: ModelFailureKind; at: number }>();
  record(source: string, kind: ModelFailureKind | undefined) {
    if (kind) this.latest.set(source, { kind, at: performance.now() });
  }
  /** The latest failure of the source's requests at or after `since` (performance.now()). */
  since(source: string, since: number) {
    const failure = this.latest.get(source);
    return failure && failure.at >= since ? failure.kind : undefined;
  }
}
