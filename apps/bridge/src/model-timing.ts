import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import type { BridgeLog } from './logger.ts';

// Forward original chunks immediately; observe metadata without logging content.
export function modelTiming(body: Record<string, unknown>, started: number, log: BridgeLog) {
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
            log('Model timing', {
              event: 'model.timing',
              model: body.model,
              prefixHash,
              tools: Array.isArray(body.tools) ? body.tools.length : 0,
              instructionsChars: instructions.length,
              firstTextMs,
              totalMs: Math.round(performance.now() - started),
              inputTokens: event.response?.usage?.input_tokens,
              cachedTokens: event.response?.usage?.input_tokens_details?.cached_tokens,
            });
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
