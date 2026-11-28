import { describe, expect, it } from '@effect/vitest';
import { ConfigProvider, Effect, Option, Redacted } from 'effect';
import { fileURLToPath } from 'node:url';
import * as AgentConfig from '../src/host/agent-config.ts';
import * as Environment from '../src/host/environment.ts';
import { sourceContentRoot } from '../src/wisp/content.ts';

const settingsFrom = (environment: Record<string, string>) =>
  AgentConfig.AgentConfig.pipe(
    Effect.provide(AgentConfig.layer),
    Effect.provide(
      // Empty values reach the agent, so its own rule decides what they mean.
      ConfigProvider.layer(ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true })),
    ),
  );

describe('AgentConfig', () => {
  it.effect('a source checkout reads its own content and no capability file', () =>
    Effect.gen(function* () {
      expect(yield* settingsFrom({})).toEqual({
        contentRoot: fileURLToPath(sourceContentRoot),
        capabilitiesFile: undefined,
        packagedEngine: false,
      });
    }),
  );

  it.effect('the packaged engine names its content, capability file and executable', () =>
    Effect.gen(function* () {
      expect(
        yield* settingsFrom({
          WISP_AGENT_CONTENT: 'engine/agent',
          WOW_CAPABILITIES_FILE: 'capabilities.json',
          WISP_ENGINE_EXECUTABLE: 'wisp-engine.exe',
        }),
      ).toEqual({
        contentRoot: 'engine/agent',
        capabilitiesFile: 'capabilities.json',
        packagedEngine: true,
      });
    }),
  );

  it.effect('an empty variable counts as unset', () =>
    Effect.gen(function* () {
      expect(
        yield* settingsFrom({
          WISP_AGENT_CONTENT: '',
          WOW_CAPABILITIES_FILE: '',
          WISP_ENGINE_EXECUTABLE: '',
        }),
      ).toEqual({
        contentRoot: fileURLToPath(sourceContentRoot),
        capabilitiesFile: undefined,
        packagedEngine: false,
      });
    }),
  );
});

describe('Environment', () => {
  const provided = (environment: Record<string, string>) =>
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: environment, preserveEmptyStrings: true }),
      ),
    );

  it.effect('a secret stays redacted, and an empty one is unset', () =>
    Effect.gen(function* () {
      const token = yield* Environment.secret('MCP_TOKEN').pipe(
        provided({ MCP_TOKEN: 'private-test-token' }),
      );
      expect(Option.map(token, Redacted.isRedacted)).toEqual(Option.some(true));
      expect(Option.map(token, Redacted.value)).toEqual(Option.some('private-test-token'));
      expect(yield* Environment.secret('MCP_TOKEN').pipe(provided({ MCP_TOKEN: '' }))).toEqual(
        Option.none(),
      );
      expect(yield* Environment.secret('MCP_TOKEN').pipe(provided({}))).toEqual(Option.none());
    }),
  );

  it.effect.runIf(process.platform === 'win32')(
    'Windows finds a variable whatever the case it was set with',
    () =>
      Effect.gen(function* () {
        const environment = provided({
          windir: 'C:\\Windows',
          Path: 'C:\\bin',
          Github_Other: 'other',
          github_Token: 'token',
        });
        expect(yield* Environment.variable('WINDIR').pipe(environment)).toEqual(
          Option.some('C:\\Windows'),
        );
        expect(yield* Environment.variable('PATH').pipe(environment)).toEqual(
          Option.some('C:\\bin'),
        );
        // Another variable that starts with the same word spelled differently does not hide it.
        expect(yield* Environment.variable('GITHUB_TOKEN').pipe(environment)).toEqual(
          Option.some('token'),
        );
        expect(yield* Environment.variable('GITHUB_MISSING').pipe(environment)).toEqual(
          Option.none(),
        );
      }),
  );

  it.effect.runIf(process.platform !== 'win32')('elsewhere a name matches exactly', () =>
    Effect.gen(function* () {
      expect(yield* Environment.variable('PATH').pipe(provided({ Path: '/bin' }))).toEqual(
        Option.none(),
      );
    }),
  );
});
