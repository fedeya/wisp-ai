import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resumeChat } from '../src/sessions.ts';
test('automatic login/resume never selects an inline conversation', () => {
  const main = {
    id: 'main',
    owner: 'game',
    title: 'Main',
    status: 'done' as const,
    messages: [{ role: 'user' as const, text: 'Hi' }],
    activity: [],
    lastUsedAt: 1,
  };
  const inline = { ...main, id: 'inline', inline: true, lastUsedAt: 100 };
  assert.equal(resumeChat([main, inline], 'inline')?.id, 'main');
  assert.equal(resumeChat([inline]), undefined);
});
