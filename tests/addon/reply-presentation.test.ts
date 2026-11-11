import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import { applyEvent } from '@wisp/bridge/events';
import { ReplyProjection } from '@wisp/bridge/reply-stream';
import { replyContent } from '../../apps/bridge/src/reply-content.ts';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

test('Eve presentation parts reach the shared Lua view with source, order and reference identity intact', async () => {
  const chat = newChat('presentation', 'offline');
  const projection = new ReplyProjection();
  const emit = (type: string, data: Record<string, unknown>) =>
    applyEvent(chat, { type, data }, projection);
  const before =
    '# Antes\n\n~~~text\n[[ref:example]]\n~~~\n\nA|B\n---|---\n' + '[[ref:nova]]|20\n'.repeat(25);
  const after = '**Después** \\[[ref:escaped]]';
  emit('content.completed', { partId: 'before', kind: 'text', value: before });
  emit('call.requested', {
    callId: 'panel',
    capability: { kind: 'tool', name: 'wisp__present_ui' },
  });
  const accepted = await projection.acceptPresentation(
    'panel',
    {
      nodes: [
        {
          id: 'markdown_table_1',
          kind: 'comparison',
          unit: 'DPS',
          items: [
            { id: 'a', label: 'A', value: 10 },
            { id: 'b', label: 'B', value: 20 },
          ],
        },
      ],
      references: { nova: { kind: 'spell', id: 122, label: 'Nova' } },
    },
    new AbortController().signal,
  );
  emit('call.settled', { callId: 'panel', outcome: 'completed', output: accepted });
  emit('content.completed', { partId: 'after', kind: 'text', value: after });
  const message = replyContent(chat.messages[0])!;
  expect(message.text).toBe(before + after);
  expect(message.parts?.map((part) => part.type)).toEqual(['text', 'ui', 'text']);
  expect(chat.activity).toEqual([]);

  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (source: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(source)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  const push = (value: unknown) => {
    if (value === null || value === undefined) {
      lua.lua_pushnil(L);
    } else if (typeof value === 'string') {
      lua.lua_pushstring(L, to_luastring(value));
    } else if (typeof value === 'number') {
      // Match integral ID formatting in WoW's Lua 5.1 numeric model.
      if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
        lua.lua_pushinteger(L, value);
      } else {
        lua.lua_pushnumber(L, value);
      }
    } else if (typeof value === 'boolean') {
      lua.lua_pushboolean(L, value);
    } else if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      value.forEach((entry, index) => {
        push(entry);
        lua.lua_rawseti(L, -2, index + 1);
      });
    } else {
      lua.lua_newtable(L);
      for (const [key, entry] of Object.entries(value as object)) {
        push(entry);
        lua.lua_setfield(L, -2, to_luastring(key));
      }
    }
  };
  try {
    run(readFileSync('addon/tests/wow-ui-stub.lua', 'utf8'));
    run('ns = { db = {} }');
    for (const file of [
      'Namespace',
      'Shared/Text',
      'UI/Widgets',
      'UI/RichUI',
      'UI/EmojiData',
      'UI/Emoji',
      'UI/MessageFormat',
      'Markdown/Syntax',
      'Markdown/Block',
      'Markdown/Parser',
      'Markdown/Cache',
      'Markdown/Links',
      'Markdown/InlineRenderer',
      'Markdown/ReplyView',
    ]) {
      run(
        `assert(load(${JSON.stringify(readFileSync('addon/WispAI/' + file + '.lua', 'utf8'))}))('WispAI', ns)`,
      );
    }
    push(message);
    lua.lua_setglobal(L, to_luastring('message'));
    run(`
      local signature = ns.UI.RichSignature(message)
      local view = ns.Markdown.ReplyView.Project(message)
      for _ = 1, 2000 do
        if not view._markdownPending then break end
        ns.Markdown.Cache.Step()
        view = ns.Markdown.ReplyView.Project(message)
      end
      assert(not view._markdownPending, 'syntax must complete')
      assert(ns.UI.RichSignature(message) == signature, 'canonical reply was mutated')
      assert(view.text == message.text and view.references == message.references)
      assert(#view.parts == 5 and #view.ui == 2)
      assert(view.parts[1].style == 'heading')
      assert(view.parts[2].style == 'code')
      assert(view.parts[2].text:find('[[ref:example]]', 1, true), 'code must remain literal')
      assert(view.parts[3].id == 'markdown_table_2', 'Markdown IDs must avoid native panels')
      assert(view.parts[4].id == 'markdown_table_1')
      assert(view.parts[5].text:find('[[ref:escaped]]', 1, true), 'escaped reference was interpreted')
      assert(view.ui[1] == message.ui[1] and view.ui[1].kind == 'comparison')
      assert(#view.ui[2]._markdownRows == 25, 'rows must reach the Lua paginator')
      assert(view.ui[2].rows[1][1]:find('|Hspell:122|h[Nova]|h', 1, true), 'verified reference changed')
    `);
  } finally {
    lua.lua_close(L);
  }
});
