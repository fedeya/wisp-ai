import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CapabilitySettings } from '../src/integrations/capabilities.ts';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('the agent file carries the resolved feature flags next to the capability switches', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'wisp-capabilities-'));
  const settings = new CapabilitySettings(path.join(directory, 'capabilities.json'), [
    { id: 'tool:query_character', name: 'Character', group: 'integrations', description: '' },
  ]);
  settings.agentFile = path.join(directory, 'agent-capabilities.json');
  settings.features = { new_panel: true };
  await settings.publish();
  expect(JSON.parse(await readFile(settings.agentFile, 'utf8'))).toEqual({
    enabled: { 'tool:query_character': true },
    features: { new_panel: true },
  });
  settings.features = { new_panel: false };
  await settings.publish();
  expect(JSON.parse(await readFile(settings.agentFile, 'utf8')).features).toEqual({
    new_panel: false,
  });
});

test('a tool behind a feature flag that is off is left out everywhere', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'wisp-capabilities-'));
  const settings = new CapabilitySettings(
    path.join(directory, 'capabilities.json'),
    [
      { id: 'tool:query_character', name: 'Character', group: 'integrations', description: '' },
      { id: 'tool:coach', name: 'Coach', group: 'integrations', description: '' },
    ],
    { coach: 'combat_coach' },
  );
  settings.agentFile = path.join(directory, 'agent-capabilities.json');
  settings.features = { combat_coach: false };
  expect(settings.snapshot().map((entry) => entry.id)).toEqual(['tool:query_character']);
  expect(settings.enabled('tool:coach')).toBe(false);
  await expect(settings.set('tool:coach', true)).rejects.toThrow('Unknown capability');
  await settings.publish();
  expect(JSON.parse(await readFile(settings.agentFile, 'utf8')).enabled['tool:coach']).toBe(false);

  settings.features = { combat_coach: true };
  expect(settings.snapshot().map((entry) => entry.id)).toEqual([
    'tool:query_character',
    'tool:coach',
  ]);
  expect(settings.enabled('tool:coach')).toBe(true);
  await settings.publish();
  expect(JSON.parse(await readFile(settings.agentFile, 'utf8')).enabled['tool:coach']).toBe(true);
});
