import { test, expect, vi } from 'vitest';
import { modelTiming } from '../src/models/model-timing.ts';

test('model observation forwards bytes immediately and logs only timings and cache metadata', async () => {
  const logger = { info: vi.fn() };
  const tap = modelTiming(
    { model: 'test', instructions: 'private instructions', tools: [] },
    performance.now(),
    logger,
  );
  const chunks: Buffer[] = [];
  tap.on('data', (chunk: Buffer) => chunks.push(chunk));
  const delta = Buffer.from(
    'data: ' +
      JSON.stringify({ type: 'response.output_text.delta', delta: 'private ñ text' }) +
      '\n\n',
  );
  for (const byte of delta) {
    tap.write(Buffer.from([byte]));
  }
  expect(Buffer.concat(chunks)).toEqual(delta); // No waiting for completion or a complete SSE record.
  const complete = Buffer.from(
    'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 3000, input_tokens_details: { cached_tokens: 2048 } } },
      }) +
      '\n\n',
  );
  tap.end(complete);
  await new Promise<void>((resolve) => tap.on('finish', resolve));
  expect(Buffer.concat(chunks)).toEqual(Buffer.concat([delta, complete]));
  expect(logger.info).toHaveBeenCalledTimes(1);
  const [record] = logger.info.mock.calls[0]!;
  expect(JSON.stringify(record)).not.toContain('private');
  expect(record.event).toBe('model.timing');
  expect(record.cachedTokens).toBe(2048);
  expect(record.inputTokens).toBe(3000);
  expect(record.firstTextMs).toBeGreaterThanOrEqual(0);
});

async function observe(body: Record<string, unknown>) {
  const logger = { info: vi.fn() };
  const tap = modelTiming(body, performance.now(), logger);
  tap.resume();
  tap.end(
    Buffer.from('data: ' + JSON.stringify({ type: 'response.completed', response: {} }) + '\n\n'),
  );
  await new Promise<void>((resolve) => tap.on('finish', resolve));
  return logger.info.mock.calls[0]![0];
}

test('model timing reports where a conversation rewrote earlier history, without content', async () => {
  const user = { role: 'user', content: 'private question' };
  const call = { type: 'function_call', name: 'wow__query_character', arguments: '{}' };
  const output = { type: 'function_call_output', output: 'private reading' };
  const base = { model: 'test', instructions: 'same', tools: [], prompt_cache_key: 'conv-a' };

  const first = await observe({ ...base, input: [user] });
  expect(first).toMatchObject({ promptCacheKey: true, inputItems: 1 });
  expect(first.historyStable).toBeUndefined();

  const appended = await observe({ ...base, input: [user, call, output] });
  expect(appended).toMatchObject({
    inputItems: 3,
    previousItems: 1,
    historyStable: true,
    prefixChanged: false,
  });

  const rewritten = await observe({
    ...base,
    input: [user, { ...call, arguments: '{"sections":["gear"]}' }, output],
  });
  expect(rewritten).toMatchObject({
    historyStable: false,
    divergedAt: 1,
    divergedType: 'function_call',
  });
  expect(JSON.stringify(rewritten)).not.toContain('private');

  const other = await observe({ ...base, prompt_cache_key: 'conv-b', input: [user] });
  expect(other.previousItems).toBeUndefined();
});
