import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dynamicEvaluate } from '../node_modules/eve/dist/src/dynamic/definition.js';
import { featureEnabled } from '../src/capabilities.ts';
import { enabledTool } from '../src/enabled-tool.ts';

let directory = '';
afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function capabilities(content: unknown) {
  directory = await mkdtemp(path.join(tmpdir(), 'wisp-agent-features-'));
  const file = path.join(directory, 'agent-capabilities.json');
  await writeFile(file, JSON.stringify(content));
  vi.stubEnv('WOW_CAPABILITIES_FILE', file);
  return file;
}
// The registry may be empty; these tests use flags the bridge could publish.
const flag = (name: string) => name as never;

test('feature flags come from the file the bridge publishes', async () => {
  await capabilities({ enabled: {}, features: { new_panel: true, dev_only: false } });
  expect(await featureEnabled(flag('new_panel'))).toBe(true);
  expect(await featureEnabled(flag('dev_only'))).toBe(false);
  expect(await featureEnabled(flag('missing'))).toBe(false);
});

test('every flag is off without a published file or features', async () => {
  vi.stubEnv('WOW_CAPABILITIES_FILE', '');
  expect(await featureEnabled(flag('new_panel'))).toBe(false);
  await capabilities({ enabled: {} });
  expect(await featureEnabled(flag('new_panel'))).toBe(false);
});

test('a tool behind a feature flag is offered only while the flag is on', async () => {
  const file = await capabilities({ enabled: {}, features: { new_panel: false } });
  const tool = enabledTool('web_fetch', { name: 'definition' }, { feature: flag('new_panel') });
  expect(await dynamicEvaluate(tool)({} as never)).toBeNull();
  await writeFile(file, JSON.stringify({ enabled: {}, features: { new_panel: true } }));
  expect(await dynamicEvaluate(tool)({} as never)).toEqual({ name: 'definition' });
  await writeFile(
    file,
    JSON.stringify({ enabled: { 'tool:web_fetch': false }, features: { new_panel: true } }),
  );
  expect(await dynamicEvaluate(tool)({} as never)).toBeNull();
});
