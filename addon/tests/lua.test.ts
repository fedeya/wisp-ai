import { readdirSync } from 'node:fs';
import { test } from 'vitest';
import { runLuaSpecs } from '../scripts/test-lua.ts';

// Keep the workspace test/watch commands, while Busted owns Lua test discovery,
// assertions, isolation and source locations. No Lua test code lives in TS strings.
for (const file of readdirSync('addon/tests').filter((name) => name.endsWith('_spec.lua'))) {
  test(file, () => runLuaSpecs(['addon/tests/' + file]));
}
