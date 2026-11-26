import { test, expect } from 'vitest';
import { modelTiming } from '../src/models/model-timing.ts';
import { captureLogs, runBridgeEffect } from './capture-logs.ts';

test('model observation forwards bytes immediately and logs only timings and cache metadata', async () => {
  const logs = captureLogs();
  const tap = runBridgeEffect(
    modelTiming(
      { model: 'test', instructions: 'private instructions', tools: [] },
      performance.now(),
    ),
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
  expect(logs()).toHaveLength(1);
  const record = logs()[0]!;
  expect(JSON.stringify(record)).not.toContain('private');
  expect(record.event).toBe('model.timing');
  expect(record.cachedTokens).toBe(2048);
  expect(record.inputTokens).toBe(3000);
  expect(record.firstTextMs).toBeGreaterThanOrEqual(0);
});

async function observe(body: Record<string, unknown>) {
  const tap = runBridgeEffect(modelTiming(body, performance.now()));
  tap.resume();
  tap.end(
    Buffer.from('data: ' + JSON.stringify({ type: 'response.completed', response: {} }) + '\n\n'),
  );
  await new Promise<void>((resolve) => tap.on('finish', resolve));
}

test('model timing reports where a conversation rewrote earlier history, without content', async () => {
  const user = { role: 'user', content: 'private question' };
  const call = { type: 'function_call', name: 'wow__query_character', arguments: '{}' };
  const output = { type: 'function_call_output', output: 'private reading' };
  const base = { model: 'test', instructions: 'same', tools: [], prompt_cache_key: 'conv-a' };
  const logs = captureLogs();
  const observeLog = async (body: Record<string, unknown>) => {
    await observe(body);
    return logs('model.timing').at(-1)!;
  };

  const first = await observeLog({ ...base, input: [user] });
  expect(first).toMatchObject({ promptCacheKey: true, inputItems: 1 });
  expect(first.historyStable).toBeUndefined();

  const appended = await observeLog({ ...base, input: [user, call, output] });
  expect(appended).toMatchObject({
    inputItems: 3,
    previousItems: 1,
    historyStable: true,
    prefixChanged: false,
  });

  const rewritten = await observeLog({
    ...base,
    input: [user, { ...call, arguments: '{"sections":["gear"]}' }, output],
  });
  expect(rewritten).toMatchObject({
    historyStable: false,
    divergedAt: 1,
    divergedType: 'function_call',
  });
  expect(JSON.stringify(rewritten)).not.toContain('private');

  const other = await observeLog({ ...base, prompt_cache_key: 'conv-b', input: [user] });
  expect(other.previousItems).toBeUndefined();
});
