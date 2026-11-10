import { test, expect } from 'vitest';
import { projectChats } from '../src/chat-projection.ts';
import { newChat, openChat } from '../src/chat-lifecycle.ts';
import { createSessionState } from '../src/session-state.ts';
import { chatSchema } from '../src/chat.ts';

test('routine conversations hide generated input while preserving answers and follow-up messages', () => {
  const state = createSessionState();
  const chat = newChat('run', 'session');
  chat.routineId = 'review';
  chat.proactive = true;
  chat.status = 'done';
  chat.messages = [
    { role: 'user', text: 'Run this routine. Trigger data: {"level":24}' },
    { role: 'assistant', text: 'Review your new spells.' },
  ];
  // Persisted runs without any new visibility metadata behave the same way.
  const restored = chatSchema.parse(JSON.parse(JSON.stringify(chat)));
  state.chats.push(restored);
  expect(projectChats(state).chats[0].messages?.map((m) => m.text)).toEqual([
    'Review your new spells.',
  ]);
  openChat(restored);
  state.activeChat = restored.id;
  restored.messages.push(
    { role: 'user', text: 'Which spell should I use?' },
    { role: 'assistant', text: 'Use Frostbolt.' },
  );
  const messages = projectChats(state).chats[0].messages!;
  expect(messages.map((m) => m.text)).toEqual([
    'Review your new spells.',
    'Which spell should I use?',
    'Use Frostbolt.',
  ]);
  expect(messages[0].id).toBe('run-message-1');
  expect(restored.messages).toHaveLength(4);
  expect(restored.messages[0].text).toContain('Trigger data:');
});

test('ordinary chats retain their initial user message', () => {
  const state = createSessionState();
  const chat = newChat('chat', 'session');
  chat.messages.push({ role: 'user', text: 'Help me with my rotation.' });
  state.chats.push(chat);
  state.activeChat = chat.id;
  expect(projectChats(state).chats[0].messages?.[0].text).toBe('Help me with my rotation.');
});

test('rendering derives a reply from its original source and ignores an obsolete cached view', () => {
  const chat = newChat('raw', 'game');
  const raw =
    '{"type":"text_delta","text":"Original: \\n\\n| Pieza | Estado |\\n|---|---|\\n| Toga | Equipada |"}';
  chat.messages.push({
    role: 'assistant',
    text: 'Old cached interpretation',
    rawReply: raw,
    streaming: false,
  });
  const state = createSessionState([chat]);
  state.activeChat = chat.id;
  const before = JSON.stringify(chat);
  const first = projectChats(state).chats[0].messages![0];
  expect(first.text).toContain('Original:');
  expect(first.text).not.toContain('Old cached');
  expect(first.ui?.[0].kind).toBe('table');
  expect(first).not.toHaveProperty('rawReply');
  expect(projectChats(state).chats[0].messages![0]).toEqual(first);
  expect(JSON.stringify(chat)).toBe(before);
});

test('routine traffic cannot displace ordinary chats and silent runs stay hidden', () => {
  const state = createSessionState();
  const ordinary = newChat('ordinary', 'session', 1);
  state.chats.push(ordinary);
  for (let i = 0; i < 60; i++) {
    const run = newChat('run-' + i, 'session', 100 + i);
    run.routineId = 'review';
    run.proactive = true;
    run.status = 'done';
    state.chats.push(run);
    const quiet = { ...run, id: 'quiet-' + i, tipSkipped: true };
    state.chats.push(quiet);
  }
  const chats = projectChats(state).chats;
  expect(chats.some((c) => c.id === ordinary.id)).toBe(true);
  expect(chats.filter((c) => c.routineId)).toHaveLength(40);
  expect(chats.some((c) => c.id.startsWith('quiet-'))).toBe(false);
  expect(state.chats).toHaveLength(121);
});
