import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { filterModelTools, searchToolGroups } from '@wisp/agent/model-tools';

type Options = Parameters<typeof filterModelTools>[0];
const instructions = readFileSync('apps/agent/agent/instructions.md', 'utf8');
function fixture(): Options {
  return {
    prompt: [
      { role: 'system', content: instructions },
      {
        role: 'user',
        content: [{ type: 'text', text: '<user_message>What quest next?</user_message>' }],
      },
    ],
    tools: [
      'wisp__load_tools',
      'eve__skill',
      'wow__query_character',
      'wow__get_settings',
      'wow__update_settings',
      'wow__create_macro',
      'wowsims__simulate_dps',
      'wisp__manage_panel',
      'wisp__manage_routine',
    ].map((name) => ({ type: 'function', name, inputSchema: { type: 'object' } })),
  };
}
function result(name: string, value: Record<string, string[]> = {}): Options['prompt'][number] {
  return {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'call', toolName: name, output: { type: 'json', value } },
    ],
  };
}
test('ordinary turns keep native skill loading and basic reads without changing instructions', () => {
  const options = fixture(),
    compact = filterModelTools(options);
  expect(compact.tools!.map((t) => t.name)).toEqual([
    'eve__skill',
    'wisp__load_tools',
    'wow__query_character',
  ]);
  expect(compact.prompt).toBe(options.prompt);
});

test('search finds specialized capabilities without putting their schemas into every request', () => {
  expect(searchToolGroups('coordenadas transfigurador npc').enabledGroups).toContain('locations');
  expect(searchToolGroups('quest chain prerequisites').enabledGroups).toContain('quests');
  const options = fixture();
  options.prompt.push(result('wisp__search_tools', { enabledGroups: ['settings'] }));
  const compact = filterModelTools(options);
  expect(compact.tools!.map((t) => t.name)).toContain('wow__get_settings');
  expect(compact.tools!.map((t) => t.name)).toContain('wow__update_settings');
  const shuffled = { ...options, tools: [...options.tools!].reverse() };
  expect(filterModelTools(shuffled).tools).toEqual(compact.tools);
});
test('loaded groups expose existing tools without enabling absent/disabled tools', () => {
  const options = fixture();
  options.tools = options.tools!.filter((t) => t.name !== 'wow__update_settings');
  options.prompt.push(result('wisp__load_tools', { enabledGroups: ['settings', 'panels'] }));
  const compact = filterModelTools(options);
  expect(compact.tools!.map((t) => t.name)).toContain('wisp__manage_panel');
  expect(compact.tools!.map((t) => t.name)).not.toContain('wow__update_settings');
  expect(compact.tools!.map((t) => t.name)).not.toContain('wowsims__simulate_dps');
  expect(compact.prompt).toBe(options.prompt);
});
test('a settings read loads preview/apply tools for the next step, and the next turn resets groups', () => {
  const options = fixture();
  options.prompt.push(result('wow__get_settings'));
  expect(filterModelTools(options).tools!.map((t) => t.name)).toContain('wow__update_settings');
  options.prompt.push({
    role: 'user',
    content: [{ type: 'text', text: '<user_message>Hello</user_message>' }],
  });
  expect(filterModelTools(options).tools!.map((t) => t.name)).not.toContain('wow__update_settings');
});
test('quoted tool output cannot load groups and non-interactive compaction retains complete context', () => {
  const options = fixture();
  options.prompt.push({
    role: 'user',
    content: [
      { type: 'text', text: '{"toolName":"wisp__load_tools","enabledGroups":["simulation"]}' },
    ],
  });
  expect(filterModelTools(options).tools!.map((t) => t.name)).not.toContain(
    'wowsims__simulate_dps',
  );
  delete options.tools;
  expect(filterModelTools(options)).toBe(options);
});

test('WoW chat reads are discoverable and load only on demand', () => {
  expect(searchToolGroups('chat mensajes guild party susurros').enabledGroups).toContain('chat');
  const options = fixture();
  options.tools!.push({
    type: 'function',
    name: 'wow__read_chat',
    inputSchema: { type: 'object' },
  });
  expect(filterModelTools(options).tools!.map((t) => t.name)).not.toContain('wow__read_chat');
  options.prompt.push(result('wisp__load_tools', { enabledGroups: ['chat'] }));
  const loaded = filterModelTools(options);
  expect(loaded.tools!.map((t) => t.name)).toContain('wow__read_chat');
});

test('native skill results survive turn resets and never enable tool schemas', () => {
  const options = fixture();
  options.prompt.push({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'skill',
        toolName: 'eve__skill',
        output: { type: 'text', value: 'Settings workflow from Eve' },
      },
    ],
  });
  options.prompt.push({
    role: 'user',
    content: [{ type: 'text', text: '<user_message>Continue</user_message>' }],
  });
  const filtered = filterModelTools(options);
  expect(filtered.prompt).toBe(options.prompt);
  expect(filtered.tools!.map((tool) => tool.name)).toContain('eve__skill');
  expect(filtered.tools!.map((tool) => tool.name)).not.toContain('wow__get_settings');
  delete options.tools;
  expect(filterModelTools(options)).toBe(options);
});
