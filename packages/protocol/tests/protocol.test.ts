import { test } from 'vitest';
import assert from 'node:assert/strict';
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
    assert.equal(result.type, type);
    assert.deepEqual(result.transport, {});
  }
  const delivery = { messageId: 'msg', ms: 1200 };
  assert.deepEqual(packetSchema.parse({ ...message, transport: { delivery } }).transport, {
    delivery,
  });
  assert.equal(packetSchema.safeParse({ ...message, transport: ['invalid'] }).success, false);
});
test('packet operations validate their required fields before reaching the bridge', () => {
  assert.equal(packetSchema.safeParse({ ...message, type: 'unknown_operation' }).success, false);
  assert.equal(packetSchema.safeParse({ ...message, chat: undefined }).success, false);
  assert.equal(
    packetSchema.safeParse({
      ...message,
      type: 'capability_set',
      key: 'tool:query_character',
      enabled: 'false',
    }).success,
    false,
  );
  assert.equal(
    packetSchema.safeParse({ ...message, type: 'state_result', requestId: 'request', data: {} })
      .success,
    true,
  );
});
test('payload strings cannot terminate the Lua long string', () => {
  const payload = luaJson(JSON.stringify({ text: ']=] ]] ]==] print("bad")' }));
  assert.ok(payload.startsWith('WispAI_Receive([===['));
});
test('inline questions accept a bounded addon attachment and say packets ignore it', () => {
  const attachment = { source: 'MyMeter', label: 'Last fight', text: 'Damage | 1200' };
  const inline = { ...message, type: 'inline_say' };
  const parsed = packetSchema.parse({ ...inline, attachment });
  assert.equal(parsed.type === 'inline_say' && parsed.attachment?.text, 'Damage | 1200');
  for (const invalid of [
    { ...attachment, source: '' },
    { ...attachment, source: 'a'.repeat(41) },
    { ...attachment, label: 'a'.repeat(61) },
    { ...attachment, text: 'a'.repeat(4001) },
    { ...attachment, extra: true },
  ]) {
    assert.equal(packetSchema.safeParse({ ...inline, attachment: invalid }).success, false);
  }
  assert.equal('attachment' in packetSchema.parse({ ...message, attachment }), false);
});
