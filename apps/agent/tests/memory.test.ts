import { test, expect } from 'vitest';
import { Effect, FileSystem } from 'effect';
import { asSchema } from 'ai';
import * as Capabilities from '../src/host/capabilities.ts';
import * as Memory from '../src/host/memory.ts';
import { authored, assembleTools } from '../src/tools/turn-tools.ts';
import { localMemory } from '../src/wisp/agent-memory.ts';
import type { MemoryEdit } from '../src/contract/memory.ts';

test('memory uses an injected host and validates Effect Schema tools', async () => {
  let entries = [{ key: 'guide', text: 'Guide A', updatedAt: '2026-11-07' }];
  const edits: MemoryEdit[] = [];
  const memory = localMemory(
    'character',
    Memory.Service.of({
      characterKey: (session) => Effect.succeed(session === 'unknown' ? null : 'mage'),
      read: () => Effect.sync(() => entries),
      update: (session, slot, edit) =>
        Effect.sync(() => {
          expect(session).toBe('new-session');
          expect(slot).toBe('character');
          edits.push(edit);
          if (edit.operation === 'remove') entries = [];
          return entries;
        }),
    }),
    Effect.runPromise,
  );
  const capabilities = await Effect.runPromise(
    Effect.flatMap(Capabilities.Service, (settings) => settings.read).pipe(
      Effect.provide(Capabilities.layerFromFile(() => undefined)),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  );
  expect(await Effect.runPromise(memory.scope('first', capabilities))).toBe('mage');
  expect(await Effect.runPromise(memory.scope('unknown', capabilities))).toBeNull();
  expect(await Effect.runPromise(memory.recall('new-session'))).toContain('Guide A');

  const direct = memory.tools();
  expect(Object.keys(direct)).toEqual(['character__save_memory', 'character__remove_memory']);
  const { character__save_memory: save, character__remove_memory: remove } = direct;
  if (!save || !remove) throw Error('Missing memory tools');
  const signal = new AbortController().signal;
  // Building the direct SDK tools and producing the deferred schema use the same contract.
  const { tools } = assembleTools({
    session: 'new-session',
    signal,
    direct,
    deferred: [],
    skills: [],
  });
  const directSave = tools.character__save_memory?.inputSchema;
  if (!directSave) throw Error('Missing SDK memory tool schema');
  const saveTool = authored('character__save_memory', save);
  expect(saveTool.inputSchema).toMatchObject({
    properties: { key: { pattern: '^[a-zA-Z0-9_-]{1,64}$' }, text: { maxLength: 1000 } },
    required: ['key', 'text'],
  });
  expect(await asSchema(directSave).jsonSchema).toMatchObject({
    properties: { key: { pattern: '^[a-zA-Z0-9_-]{1,64}$' }, text: { maxLength: 1000 } },
  });
  const ctx = { session: 'new-session', signal, callId: 'call' };
  await expect(saveTool.run({ key: '../bad', text: 'Guide B' }, ctx)).rejects.toThrow(
    'Invalid input',
  );
  await saveTool.run({ key: 'guide', text: 'Guide B' }, ctx);
  await authored('character__remove_memory', remove).run({ key: 'guide' }, ctx);
  expect(edits).toEqual([
    { operation: 'save', key: 'guide', text: 'Guide B' },
    { operation: 'remove', key: 'guide' },
  ]);
  expect(await Effect.runPromise(memory.recall('new-session'))).toBeNull();
});
