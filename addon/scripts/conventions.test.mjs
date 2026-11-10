import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConventions } from './conventions.mjs';

test('checks module functions while preserving wire keys, comments and strings', () => {
  const source = `local _, ns = ...
    local function readState() return { kind = "compare_items", text = "C.old_name()" } end
    -- C.old_name() is just a comment.
    ns.draft:SetText("native widget state")
    ns.Character = { ReadState = readState }
    function ns.Character.Inspect() return ns.Character.ReadState() end`;
  assert.deepEqual(checkConventions(source, 'Character/Inspect.lua'), []);
});

test('rejects inconsistent public names, including aliases and table exports', () => {
  const source = `local _, ns = ...
    local module = {}
    function module.read_state() end
    ns.Character = module
    local function inspect() end
    ns.Character = { inspect = inspect }
    ns.Character.read_state()`;
  const errors = checkConventions(source, 'Inspect.lua');
  assert.equal(errors.length, 3);
  assert.ok(errors.every((error) => error.includes('PascalCase')));
});

test('rejects root functions, legacy namespaces and newer Lua syntax', () => {
  assert.ok(
    checkConventions('local _, ns = ...; function ns.Submit() end', 'Chat.lua').some((error) =>
      error.includes('subsystem'),
    ),
  );
  assert.ok(
    checkConventions('local _, C = ...', 'Chat.lua').some((error) =>
      error.includes('instead of C'),
    ),
  );
  assert.ok(checkConventions('local _, ns = ...; local x = 1 & 2', 'Chat.lua').length);
  assert.ok(checkConventions('local _, ns = ...', 'chat_state.lua').length);
});

test('requires the WoW namespace argument and consistent subsystem and helper names', () => {
  assert.ok(checkConventions('local ns = ...', 'Chat.lua').length);
  const errors = checkConventions(
    'local _, ns = ...; local bad_name = function() end; function ns.chat.Submit() end',
    'Chat.lua',
  );
  assert.ok(errors.some((error) => error.includes('lowerCamelCase')));
  assert.ok(errors.some((error) => error.includes('Subsystem names')));
});
