import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { AgentCapabilities } from '../src/host/capabilities.ts';

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
const featureEnabled = (name: string) =>
  Effect.runPromise(
    Effect.flatMap(AgentCapabilities, (settings) => settings.featureEnabled(flag(name))).pipe(
      Effect.provide(AgentCapabilities.layer()),
      Effect.provide(NodeFileSystem.layer),
    ),
  );

test('feature flags come from the file the bridge publishes', async () => {
  await capabilities({ enabled: {}, features: { new_panel: true, dev_only: false } });
  expect(await featureEnabled('new_panel')).toBe(true);
  expect(await featureEnabled('dev_only')).toBe(false);
  expect(await featureEnabled('missing')).toBe(false);
});

test('every flag is off without a published file or features', async () => {
  vi.stubEnv('WOW_CAPABILITIES_FILE', '');
  expect(await featureEnabled('new_panel')).toBe(false);
  await capabilities({ enabled: {} });
  expect(await featureEnabled('new_panel')).toBe(false);
});
