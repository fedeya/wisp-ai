import { Option, Schema } from 'effect';
import { expect, test } from 'vitest';
import { luaJson, packetSchema } from '../src/wire/protocol.ts';
const decodePacket = Schema.decodeUnknownSync(packetSchema);
const tryDecodePacket = Schema.decodeUnknownOption(packetSchema);

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
    const result = decodePacket({ ...message, type, transport: [] });
    expect(result.type).toBe(type);
    expect(result.transport).toStrictEqual({});
  }
  const delivery = { messageId: 'msg', ms: 1200 };
  expect(decodePacket({ ...message, transport: { delivery } }).transport).toStrictEqual({
    delivery,
  });
  expect(Option.isSome(tryDecodePacket({ ...message, transport: ['invalid'] }))).toBe(false);
});
test('packet operations validate their required fields before reaching the bridge', () => {
  expect(Option.isSome(tryDecodePacket({ ...message, type: 'unknown_operation' }))).toBe(false);
  expect(Option.isSome(tryDecodePacket({ ...message, chat: undefined }))).toBe(false);
  expect(Option.isSome(tryDecodePacket({ ...message, type: 'routine_action' }))).toBe(false);
  expect(
    Option.isSome(
      tryDecodePacket({
        ...message,
        type: 'capability_set',
        key: 'tool:query_character',
        enabled: 'false',
      }),
    ),
  ).toBe(false);
  expect(
    Option.isSome(
      tryDecodePacket({ ...message, type: 'state_result', requestId: 'request', data: {} }),
    ),
  ).toBe(true);
});
test('payload strings cannot terminate the Lua long string', () => {
  const payload = luaJson(JSON.stringify({ text: ']=] ]] ]==] print("bad")' }));
  expect(payload.startsWith('WispAI_Receive([===[')).toBeTruthy();
});
