// @effect-migrated
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import * as capabilities from '../src/capabilities.ts';
import * as characterKey from '../src/character-key.ts';
import { rejectUnknownKeys } from '../src/checks.ts';
import * as desktop from '../src/desktop.ts';
import { desktopRoutes } from '../src/desktop-routes.ts';
import * as features from '../src/features.ts';
import * as mcpSetup from '../src/mcp-setup.ts';
import * as providers from '../src/providers.ts';
import * as routines from '../src/routines.ts';
import * as search from '../src/search.ts';
import { constraintFixtures } from './constraint-fixtures.ts';

type Contract = Schema.Codec<unknown, unknown>;
const schemas: Record<string, Contract> = {
  'features.featureName': features.featureName,
  'features.featureOverrides': features.featureOverrides,
  'features.featureViewSchema': features.featureViewSchema,
  'features.featuresStateSchema': features.featuresStateSchema,
  'character-key.characterName': characterKey.characterName,
  'capabilities.capabilitySchema': capabilities.capabilitySchema,
  'capabilities.capabilityViewSchema': capabilities.capabilityViewSchema,
  'mcp-setup.mcpName': mcpSetup.mcpName,
  'mcp-setup.mcpDefinition': mcpSetup.mcpDefinition,
  'mcp-setup.mcpSetup': mcpSetup.mcpSetup,
  'providers.providerId': providers.providerId,
  'providers.reasoningEffort': providers.reasoningEffort,
  'providers.connectionModel': providers.connectionModel,
  'providers.discoveredConnectionModel': providers.discoveredConnectionModel,
  'providers.connectionConfig': providers.connectionConfig,
  'providers.connectionSetup': providers.connectionSetup,
  'providers.connectionDiscovery': providers.connectionDiscovery,
  'providers.connectionView': providers.connectionView,
  'routines.routineTrigger': routines.routineTrigger,
  'routines.routineDefinition': routines.routineDefinition,
  'routines.routineInput': routines.routineInput,
  'routines.routineEvent': routines.routineEvent,
  'routines.savedRoutine': routines.savedRoutine,
  'routines.routineRun': routines.routineRun,
  'search.wowheadQuery': search.wowheadQuery,
  'search.searchConfig': search.searchConfig,
  'search.searchSetup': search.searchSetup,
  'search.searchState': search.searchState,
  'desktop.desktopInfoSchema': desktop.desktopInfoSchema,
  'desktop.statusSchema': desktop.statusSchema,
  'desktop-routes./auth/start.output': desktopRoutes['/auth/start'].output,
  'desktop-routes./search/remove-exa.input': desktopRoutes['/search/remove-exa'].input,
  'desktop-routes./app-update.input': desktopRoutes['/app-update'].input,
  'desktop-routes./connections/remove.input': desktopRoutes['/connections/remove'].input,
  'desktop-routes./features/set.input': desktopRoutes['/features/set'].input,
};

it('every fixture names a schema', () => {
  expect(Object.keys(schemas).sort()).toEqual(Object.keys(constraintFixtures).sort());
});

for (const [name, fixture] of Object.entries(constraintFixtures)) {
  const schema = schemas[name];
  if (!schema) continue;
  const decode = Schema.decodeUnknownEffect(schema, fixture.strict ? rejectUnknownKeys : undefined);
  describe(name, () => {
    it.effect.each(fixture.accepts.map(([input, output]) => ({ input, output })))(
      'accepts $input',
      ({ input, output }) =>
        Effect.gen(function* () {
          expect(yield* decode(input)).toStrictEqual(output);
        }),
    );
    it.effect.each(fixture.rejects.map((input) => ({ input })))('rejects $input', ({ input }) =>
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(decode(input)))).toBe(true);
      }),
    );
  });
}
