import { expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import { projectChats } from '../src/chat/chat-projection.ts';
import { createSessionState } from '../src/session-state.ts';
import { ReplyProjection } from '../src/reply/reply-stream.ts';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatsAt, testDirectory, TestDirectory } from './storage-fixture.ts';
import { applyEvent } from '../src/chat/events.ts';

const withFixture = <A, E, R>(
  work: (f: {
    file: string;
    legacy: string;
    store: () => ReturnType<typeof chatsAt>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const { root, file } = yield* TestDirectory;
    return yield* work({ file, legacy: path.join(root, 'chats.json'), store: () => chatsAt(file) });
  }).pipe(Effect.scoped, Effect.provide(testDirectory));

it.live(
  'old Markdown tables reach the addon without rewriting canonical history or the legacy JSON backup',
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const chat = newChat('tables', 'game');
        const text =
          'Antes.\n\n| Hueco | Lo que llevás | Qué buscar | Qué ganarías |\n|---|---|---|---|\n| Guantes | [[ref:gloves]] | Guantes de lana | +2 Intelecto |\n\nDespués.';
        chat.messages.push({
          id: 'saved-reply',
          role: 'assistant',
          text,
          streaming: false,
          references: { gloves: { kind: 'item', id: 100, label: 'Guantes' } },
          ui: [],
          parts: [{ type: 'text', text }],
        });
        const original = JSON.stringify([chat]);
        yield* Effect.promise(async () => writeFile(f.legacy, original));
        const store = yield* f.store(),
          restored = yield* store.load();
        const state = createSessionState(restored);
        state.activeChat = chat.id;
        const reply = projectChats(state).chats[0].messages![0];
        expect(reply.ui).toEqual([]);
        expect(reply.text).toBe(text);
        expect(reply.references).toEqual(chat.messages[0].references);
        expect(reply.parts).toEqual([{ type: 'text', text }]);
        expect(restored[0].messages[0]).toEqual(chat.messages[0]);
        yield* store.flush(restored);
        const again = yield* (yield* f.store()).load(),
          stateAgain = createSessionState(again);
        stateAgain.activeChat = chat.id;
        expect(projectChats(stateAgain).chats[0].messages![0]).toEqual(reply);
        expect(again[0].messages[0].ui).toEqual([]);
        expect(yield* Effect.promise(async () => readFile(f.legacy, 'utf8'))).toBe(original);
      }),
    ),
);

it.live(
  'transport preserves Markdown source and legacy native components for every message role',
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const chat = newChat('legacy', 'game');
        const text = '| Pieza | Estado |\n|---|---|\n| Toga | Equipada |\n';
        chat.messages.push(
          { role: 'user', text },
          { role: 'tool', text },
          { role: 'assistant', text, streaming: true },
          {
            role: 'assistant',
            text,
            ui: [{ id: 'existing', kind: 'stat', label: 'DPS', value: '1' }],
          },
        );
        yield* Effect.promise(async () => writeFile(f.legacy, JSON.stringify([chat])));
        const restored = yield* (yield* f.store()).load(),
          state = createSessionState(restored);
        state.activeChat = chat.id;
        expect(restored[0].messages.slice(0, 3)).toEqual(chat.messages.slice(0, 3));
        const reply = projectChats(state).chats[0].messages![3];
        expect(reply).toMatchObject(chat.messages[3]);
        expect(reply.ui?.map((node) => node.kind)).toEqual(['stat']);
        expect(reply.parts).toBeUndefined();
      }),
    ),
);

it.live(
  'SQLite preserves exact reply source on a display failure; only the view contains the error',
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const store = yield* f.store();
        yield* store.load();
        const chat = newChat('raw', 'game'),
          raw = '{"type":"text_delta","text":"unfinished source 🧙';
        chat.messages.push({ role: 'assistant', text: '', rawReply: raw });
        expect(chat.messages[0].rawReply).toBe(raw);
        expect(chat.messages[0].role).toBe('assistant');
        expect(chat.messages[0].text).toBe('');
        yield* store.flush([chat]);
        const restored = yield* (yield* f.store()).load(),
          before = JSON.stringify(restored);
        const state = createSessionState(restored);
        state.activeChat = chat.id;
        const display = projectChats(state);
        expect(display.chats[0].messages?.[0].role).toBe('system');
        expect(display.chats[0].messages?.[0].text).toContain('could not be displayed');
        expect(JSON.stringify(display)).not.toContain('rawReply');
        expect(JSON.stringify(display)).not.toContain('unfinished source');
        expect(JSON.stringify(restored)).toBe(before);
        const db = new DatabaseSync(f.file, { readOnly: true });
        try {
          const row = db.prepare('SELECT role,text,extras FROM messages').get()!;
          expect(row.role).toBe('assistant');
          expect(row.text).toBe('');
          expect(JSON.parse(String(row.extras)).rawReply).toBe(raw);
        } finally {
          db.close();
        }
      }),
    ),
);

it.live(
  'SQLite preserves interleaved panels and interrupted plain text without presentation tool rows',
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const store = yield* f.store();
        yield* store.load();
        const chat = newChat('interleaved', 'game');
        chat.status = 'working';
        const projection = new ReplyProjection();
        const emit = (type: string, data: Record<string, unknown>) =>
          applyEvent(chat, { type, data }, projection);
        emit('content.completed', { partId: 'before', kind: 'text', value: 'Antes.\n\n' });
        emit('call.requested', {
          callId: 'panel',
          capability: { kind: 'tool', name: 'wisp__present_ui' },
        });
        emit('call.settled', {
          callId: 'panel',
          outcome: 'completed',
          output: {
            nodes: [{ id: 'dps', kind: 'stat', label: 'DPS', value: '20' }],
            references: {},
          },
        });
        emit('content.delta', {
          partId: 'after',
          kind: 'text',
          delta: '\n\nDespués, todavía escribiendo.',
        });
        yield* store.flush([chat]);
        const restored = yield* (yield* f.store()).load();
        expect(restored[0].status).toBe('interrupted');
        expect(restored[0].messages).toHaveLength(1);
        expect(restored[0].messages[0]).toMatchObject({
          role: 'assistant',
          replyFormat: 'text',
          streaming: false,
          parts: [
            { type: 'text', text: 'Antes.\n\n' },
            { type: 'ui', id: 'dps' },
            { type: 'text', text: '\n\nDespués, todavía escribiendo.' },
          ],
        });
        expect(restored[0].activity).toEqual([]);
        const state = createSessionState(restored);
        state.activeChat = chat.id;
        expect(projectChats(state).chats[0].messages![0].parts).toEqual(
          restored[0].messages[0].parts,
        );
        expect(projectChats(state).chats[0].messages![0]).not.toHaveProperty('replyFormat');
      }),
    ),
);

it.live(
  'SQLite retains source beyond display limits, including interrupted and authoritative final output',
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const store = yield* f.store();
        yield* store.load();
        const chat = newChat('raw', 'game'),
          projection = new ReplyProjection();
        const raw = 'Texto '.repeat(5000) + 'fin 😀';
        applyEvent(
          chat,
          {
            type: 'content.delta',
            data: { partId: 'answer', kind: 'text', delta: raw.slice(0, 15000) },
          },
          projection,
        );
        expect(chat.messages[0].text).toBe(raw.slice(0, 15000));
        yield* store.flush([chat]);
        const interrupted = yield* (yield* f.store()).load();
        expect(interrupted[0].messages[0].text).toBe(raw.slice(0, 15000));
        expect(interrupted[0].messages[0].streaming).toBe(false);
        applyEvent(
          chat,
          { type: 'content.completed', data: { partId: 'answer', kind: 'text', value: raw } },
          projection,
        );
        yield* store.flush([chat]);
        const restored = yield* (yield* f.store()).load(),
          state = createSessionState(restored);
        state.activeChat = chat.id;
        expect(restored[0].messages[0].text).toBe(raw);
        expect(projectChats(state).chats[0].messages?.[0].text.length).toBeLessThanOrEqual(20000);
        expect(chat.messages).toHaveLength(1);
      }),
    ),
);
