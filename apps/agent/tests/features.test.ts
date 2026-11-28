import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigProvider, Effect, Layer } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as AgentConfig from '../src/host/agent-config.ts';
import { setAgentHost } from '../src/host/agent-host.ts';
import * as Capabilities from '../src/host/capabilities.ts';

let directory = '';
afterEach(async () => {
  setAgentHost(undefined);
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

async function capabilities(content: unknown, name = 'agent-capabilities.json') {
  directory ||= await mkdtemp(path.join(tmpdir(), 'wisp-agent-features-'));
  const file = path.join(directory, name);
  await writeFile(file, JSON.stringify(content));
  return file;
}
// The registry may be empty; these tests use flags the bridge could publish.
const flag = (name: string) => name as never;
/** A flag as the agent reads it with `WOW_CAPABILITIES_FILE` set to `file`. */
const featureEnabled = (name: string, file?: string) =>
  Effect.runPromise(
    Effect.flatMap(Capabilities.Service, (settings) => settings.featureEnabled(flag(name))).pipe(
      Effect.provide(Capabilities.layer),
      Effect.provide(AgentConfig.layer),
      Effect.provide(
        Layer.merge(
          NodeFileSystem.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown(file === undefined ? {} : { WOW_CAPABILITIES_FILE: file }),
          ),
        ),
      ),
    ),
  );

test('feature flags come from the file the bridge publishes', async () => {
  const file = await capabilities({ enabled: {}, features: { new_panel: true, dev_only: false } });
  expect(await featureEnabled('new_panel', file)).toBe(true);
  expect(await featureEnabled('dev_only', file)).toBe(false);
  expect(await featureEnabled('missing', file)).toBe(false);
});

test('every flag is off without a published file or features', async () => {
  expect(await featureEnabled('new_panel')).toBe(false);
  expect(await featureEnabled('new_panel', '')).toBe(false);
  expect(await featureEnabled('new_panel', await capabilities({ enabled: {} }))).toBe(false);
});

test("the host's capability file takes precedence over the environment's", async () => {
  const environment = await capabilities({ enabled: {}, features: { new_panel: false } });
  const host = await capabilities({ enabled: {}, features: { new_panel: true } }, 'host.json');
  setAgentHost({ origin: 'http://127.0.0.1:1', token: 'test-token', capabilitiesFile: host });
  expect(await featureEnabled('new_panel', environment)).toBe(true);
});
