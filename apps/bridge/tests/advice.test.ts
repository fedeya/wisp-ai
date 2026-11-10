import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LegacyReplyStream as ReplyStream } from '../src/legacy-reply.ts';

test('a no-tip response carries no visible content or malformed JSON', () => {
  const reply = new ReplyStream();
  reply.feed('{"type":"no_tip"}\n');
  reply.finish();
  assert.equal(reply.noTip, true);
  assert.equal(reply.view().text, '');
  assert.deepEqual(reply.view().ui, []);
  assert.deepEqual(reply.errors, []);
});
