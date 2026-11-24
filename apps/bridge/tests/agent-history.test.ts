import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { databaseScope } from './database-fixture.ts';
import { AgentHistory } from '../src/agent/agent-history.ts';
import { ChatStore } from '../src/chat/chat-store.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';

test('agent history appends turns, replaces compacted history and prunes unreferenced sessions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wisp-agent-history-'));
  const scope = databaseScope();
  try {
    const file = path.join(directory, 'wisp.sqlite');
    const history = new AgentHistory(scope.open(file));
    await history.append('kept', 0, [{ role: 'user', content: 'Question' }]);
    await history.append('kept', 1, [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c',
            toolName: 't',
            output: { type: 'json', value: 1 },
          },
        ],
      },
    ]);
    // A retried turn overwrites what followed its start.
    await history.append('kept', 1, [{ role: 'assistant', content: 'Answer' }]);
    expect(await history.load('kept')).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ]);
    await history.replace('kept', [{ role: 'user', content: 'Summary' }]);
    expect(await new AgentHistory(scope.open(file)).load('kept')).toEqual([
      { role: 'user', content: 'Summary' },
    ]);
    await history.append('orphan', 0, [{ role: 'user', content: 'Deleted chat' }]);
    await history.append('ended', 0, [{ role: 'user', content: 'Ended' }]);
    await history.delete('ended');
    expect(await history.load('ended')).toEqual([]);

    const chats = new ChatStore(scope.open(file), () => {});
    await chats.load();
    await chats.flush([{ ...newChat('chat', 'game'), agentSession: 'kept' }]);
    await chats.close();
    await history.prune();
    expect(await history.load('kept')).toHaveLength(1);
    expect(await history.load('orphan')).toEqual([]);
  } finally {
    await scope.close();
    await rm(directory, { recursive: true, force: true });
  }
});
