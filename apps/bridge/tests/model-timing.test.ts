import { test, expect } from 'vitest';
import { modelTiming } from '../src/model-timing.ts';

test('model observation forwards bytes immediately and logs only timings and cache metadata', async () => {
  const logs: string[] = [];
  const tap = modelTiming(
    { model: 'test', instructions: 'private instructions', tools: [] },
    performance.now(),
    (line) => logs.push(line),
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
  expect(logs).toHaveLength(1);
  expect(logs[0]).not.toContain('private');
  const record = JSON.parse(logs[0]!.slice('Model timing: '.length));
  expect(record.cachedTokens).toBe(2048);
  expect(record.inputTokens).toBe(3000);
  expect(record.firstTextMs).toBeGreaterThanOrEqual(0);
});
