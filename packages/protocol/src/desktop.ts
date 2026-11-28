// @effect-migrated
import { Effect, Schema } from 'effect';
import { capabilityViewSchema } from './capabilities.js';
import { savedRoutine, routineRun } from './routines.js';
import { characterName } from './character-key.js';
import { connectionView } from './providers.js';
import { searchState } from './search.js';
import { featuresStateSchema } from './features.js';
export const desktopInfoSchema = Schema.Struct({
  wow: Schema.optional(Schema.NullOr(Schema.String)),
  configured: Schema.Boolean,
  dataDirectory: Schema.String,
  platform: Schema.String,
  version: Schema.String,
  telemetryEnabled: Schema.optional(Schema.Boolean),
  addonOutdated: Schema.optional(Schema.NullOr(Schema.Boolean)),
  addonUpdateNotice: Schema.optional(Schema.NullOr(Schema.Literals(['reload_required', 'failed']))),
  /** An app update left the addon to update on this launch. */
  addonUpdatePending: Schema.optional(Schema.Boolean),
});
const mcpTool = Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) });
export const modelSchema = Schema.Struct({
  slug: Schema.String,
  displayName: Schema.String,
  efforts: Schema.Array(Schema.String),
  /** Where the model comes from (a connection name or ChatGPT); pickers group by it. */
  group: Schema.optional(Schema.String),
});
export const mcpSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  transport: Schema.Literals(['http', 'sse', 'stdio']),
  url: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  args: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  hasToken: Schema.optional(Schema.Boolean),
  envKeys: Schema.optional(Schema.Array(Schema.String)),
  tools: Schema.optional(Schema.Array(mcpTool)),
});
export const panelSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  character: Schema.String,
  characterKey: Schema.String,
  bindings: Schema.optional(Schema.Array(Schema.Unknown)),
  hidden: Schema.optional(Schema.Boolean),
});
export const authStateSchema = Schema.Struct({
  status: Schema.String,
  activeId: Schema.optional(Schema.NullOr(Schema.String)),
  account: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.String),
  revision: Schema.Finite,
  profiles: Schema.Array(
    Schema.Struct({ id: Schema.String, label: Schema.String, connected: Schema.Boolean }),
  ),
});
export const statusSchema = Schema.Struct({
  ready: Schema.Boolean,
  gameConnected: Schema.Boolean,
  model: Schema.String,
  activeTurns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  auth: authStateSchema,
  connections: Schema.Array(connectionView).pipe(Schema.withDecodingDefault(Effect.sync(() => []))),
  modelConnected: Schema.optional(Schema.Boolean),
  search: Schema.optional(searchState),
  mcps: Schema.Array(mcpSchema),
  integrations: Schema.Array(capabilityViewSchema),
  panels: Schema.Array(panelSchema),
  routines: Schema.Array(savedRoutine),
  routineRuns: Schema.Array(routineRun),
  /** Saved names for GUID character keys, for labels. */
  characters: Schema.Record(Schema.String, characterName).pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
  /** Newer app version the desktop reported to this bridge; the addon announces it. */
  appUpdate: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Experimental features: the channel and each flag's value and source. */
  features: featuresStateSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed({ channel: 'stable' as const, flags: [] })),
  ),
});
export type DesktopInfo = typeof desktopInfoSchema.Type;
export type Model = typeof modelSchema.Type;
export type Mcp = typeof mcpSchema.Type;
export type Panel = typeof panelSchema.Type;
export type Status = typeof statusSchema.Type;
