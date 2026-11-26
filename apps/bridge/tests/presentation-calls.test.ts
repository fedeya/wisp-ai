import { test, expect, vi } from 'vitest';
import { createAgentCalls } from '../src/agent/agent-calls.ts';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { ReplyProjection } from '../src/reply/reply-stream.ts';

test('presentation calls scope the active character and report bridge acceptance errors', async () => {
  const chat = newChat('presentation', 'addon');
  chat.status = 'working';
  chat.agentSession = 'eve';
  let transport = 'addon';
  const projection = new ReplyProjection();
  const presentReply = vi.fn((_chat, callId, input, signal) =>
    projection.acceptPresentation(callId, input, signal),
  );
  const agent = createAgentCalls({
    getChats: () => [chat],
    currentTransport: () => transport,
    presentReply,
  } as unknown as Parameters<typeof createAgentCalls>[0]);
  const input = {
    nodes: [],
    references: { nova: { kind: 'spell' as const, id: 122, label: 'Nova' } },
  };
  const present = (session = 'eve', callId = 'one', presentation = input) =>
    agent.call(session, 'present', { callId, presentation }, new AbortController().signal);
  try {
    await expect(present('other')).rejects.toThrow('No active connection');
    transport = 'other-addon';
    await expect(present()).rejects.toThrow('No active connection');
    transport = 'addon';
    chat.status = 'done';
    await expect(present()).rejects.toThrow('No active connection');
    chat.status = 'working';
    expect(presentReply).not.toHaveBeenCalled();
    projection.requestPresentation(chat, 'one');
    const accepted = await present();
    expect(accepted).toEqual(input);
    expect(chat.messages[0].references).toEqual({});
    projection.settlePresentation('one', accepted, true);
    projection.requestPresentation(chat, 'two');
    await expect(
      present('eve', 'two', {
        nodes: [],
        references: { nova: { kind: 'spell', id: 116, label: 'Frostbolt' } },
      }),
    ).rejects.toThrow('already identifies something else');
    expect(chat.messages[0].references?.nova).toMatchObject({ id: 122 });
    expect(chat.activity).toEqual([]);
  } finally {
    projection.finish();
  }
});
