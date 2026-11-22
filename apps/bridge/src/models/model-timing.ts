import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';

// Forward original chunks immediately; observe metadata without logging content.
export function modelTiming(
  body: Record<string, unknown>,
  started: number,
  logger: Pick<Logger, 'info'>,
) {
  const decoder = new StringDecoder('utf8');
  let buffer = '',
    firstTextMs: number | undefined;
  const instructions =
    typeof body.instructions === 'string'
      ? body.instructions
      : Array.isArray(body.input)
        ? JSON.stringify(
            body.input.filter(
              (message) =>
                message &&
                typeof message === 'object' &&
                (message.role === 'system' || message.role === 'developer'),
            ),
          )
        : '';
  const prefixHash = createHash('sha256')
    .update(JSON.stringify({ model: body.model, instructions, tools: body.tools }))
    .digest('hex')
    .slice(0, 16);
  const history = historyChange(
    typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : prefixHash,
    prefixHash,
    Array.isArray(body.input) ? body.input : [],
  );
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      this.push(chunk);
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line.startsWith('data:')) {
          continue;
        }
        try {
          const event = JSON.parse(line.slice(5));
          if (
            event.type === 'response.output_text.delta' &&
            typeof event.delta === 'string' &&
            event.delta &&
            firstTextMs === undefined
          ) {
            firstTextMs = Math.round(performance.now() - started);
          }
          if (event.type === 'response.completed') {
            logger.info(
              {
                event: 'model.timing',
                model: body.model,
                prefixHash,
                tools: Array.isArray(body.tools) ? body.tools.length : 0,
                instructionsChars: instructions.length,
                firstTextMs,
                totalMs: Math.round(performance.now() - started),
                inputTokens: event.response?.usage?.input_tokens,
                cachedTokens: event.response?.usage?.input_tokens_details?.cached_tokens,
                promptCacheKey: typeof body.prompt_cache_key === 'string',
                ...history,
              },
              'Model timing',
            );
          }
        } catch {
          /* Observability must never interrupt a response. */
        }
      }
      if (buffer.length > 1024 * 1024) {
        buffer = '';
      }
      done();
    },
  });
}

// A prompt cache can only hit when a request starts with the previous request
// of the same conversation. Remember per-item hashes (never content) so the log
// shows whether earlier history was rewritten, and where.
const recent = new Map<string, { prefixHash: string; items: string[] }>();
function historyChange(key: string, prefixHash: string, input: unknown[]) {
  const items = input.map((item) =>
    createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 12),
  );
  const previous = recent.get(key);
  recent.delete(key);
  recent.set(key, { prefixHash, items });
  if (recent.size > 64) {
    recent.delete(recent.keys().next().value!);
  }
  if (!previous) {
    return { inputItems: items.length };
  }
  const diverged = previous.items.findIndex((hash, index) => items[index] !== hash);
  const item = diverged >= 0 ? (input[diverged] as Record<string, unknown> | undefined) : undefined;
  return {
    inputItems: items.length,
    previousItems: previous.items.length,
    prefixChanged: previous.prefixHash !== prefixHash,
    historyStable: diverged < 0,
    divergedAt: diverged >= 0 ? diverged : undefined,
    divergedType:
      item && typeof item === 'object'
        ? String(item.type ?? item.role ?? 'unknown').slice(0, 40)
        : diverged >= 0
          ? 'removed'
          : undefined,
  };
}
