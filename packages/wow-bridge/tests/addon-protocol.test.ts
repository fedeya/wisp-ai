import { expect, test } from 'vitest';
import { luaJson, packetSchema } from '../src/protocol.ts';
const message = {
  type: 'say',
  chat: 'chat',
  session: 'test-ui',
  seq: 3,
  at: 1234,
  text: '¿Qué hago ahora? Frost Nova ❄',
};

test('WoW empty-table telemetry does not prevent hello, poll or user packets from reaching the bridge', () => {
  for (const type of ['hello', 'poll', 'say'] as const) {
    const result = packetSchema.parse({ ...message, type, transport: [] });
    expect(result.type).toBe(type);
    expect(result.transport).toStrictEqual({});
  }
  const delivery = { messageId: 'msg', ms: 1200 };
  expect(packetSchema.parse({ ...message, transport: { delivery } }).transport).toStrictEqual({
    delivery,
  });
  expect(packetSchema.safeParse({ ...message, transport: ['invalid'] }).success).toBe(false);
});
test('packet operations validate their required fields before reaching the bridge', () => {
  expect(packetSchema.safeParse({ ...message, type: 'unknown_operation' }).success).toBe(false);
  expect(packetSchema.safeParse({ ...message, chat: undefined }).success).toBe(false);
  expect(
    packetSchema.safeParse({
      ...message,
      type: 'capability_set',
      key: 'tool:query_character',
      enabled: 'false',
    }).success,
  ).toBe(false);
  expect(
    packetSchema.safeParse({ ...message, type: 'state_result', requestId: 'request', data: {} })
      .success,
  ).toBe(true);
});
test('payload strings cannot terminate the Lua long string', () => {
  const payload = luaJson(JSON.stringify({ text: ']=] ]] ]==] print("bad")' }));
  expect(payload.startsWith('WispAI_Receive([===[')).toBeTruthy();
});
