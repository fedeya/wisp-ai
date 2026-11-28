// @effect-migrated
import { Schema } from 'effect';
import { connectionSetup, connectionDiscovery, discoveredConnectionModel } from './providers.js';
import { searchSetup, searchState } from './search.js';
import { authStateSchema, modelSchema, statusSchema } from './desktop.js';
import { mcpSetup } from './mcp-setup.js';
import { featureName } from './features.js';
import { UrlString } from './checks.js';
// The contract between the desktop webview and the bridge's desktop server.
// The bridge validates every input and type-checks every output against it;
// the desktop client derives its typed Hono client from it and decodes each
// response with the output schema.
const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const ok = Schema.Struct({ ok: Schema.Literal(true) });
const mcpTested = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) }),
  ),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
/** A schema the desktop and the bridge decode without services. */
type Contract = Schema.Codec<unknown, unknown>;
const get = <O extends Contract>(output: O) => ({ method: 'get' as const, output });
const post = <O extends Contract>(output: O) => ({ method: 'post' as const, output });
const postWith = <I extends Contract, O extends Contract>(input: I, output: O) => ({
  method: 'post' as const,
  input,
  output,
});
export const desktopRoutes = {
  '/status': get(statusSchema),
  '/auth/models': get(Schema.Struct({ models: Schema.Array(modelSchema) })),
  '/auth/start': postWith(
    Schema.Struct({ profileId: Schema.optional(id), newAccount: Schema.optional(Schema.Boolean) }),
    Schema.Struct({ authorizationUrl: UrlString }),
  ),
  '/auth/cancel': post(authStateSchema),
  '/auth/disconnect': post(authStateSchema),
  '/auth/select': postWith(Schema.Struct({ profileId: id }), authStateSchema),
  '/auth/model': postWith(
    Schema.Struct({ model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)) }),
    Schema.Struct({ ok: Schema.Literal(true), model: Schema.String }),
  ),
  '/connections/save': postWith(connectionSetup, Schema.Struct({ id: Schema.String })),
  '/connections/test': postWith(connectionSetup, ok),
  '/connections/discover': postWith(
    connectionDiscovery,
    Schema.Struct({ models: Schema.Array(discoveredConnectionModel) }),
  ),
  '/connections/remove': postWith(Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }), ok),
  '/search/save': postWith(searchSetup, searchState),
  '/search/test': postWith(searchSetup, ok),
  // An empty object and nothing else.
  '/search/remove-exa': postWith(Schema.Record(Schema.String, Schema.Never), searchState),
  '/integrations/set': postWith(Schema.Struct({ id, enabled: Schema.Boolean }), ok),
  '/mcps/test': postWith(mcpSetup, mcpTested),
  '/mcps/save': postWith(mcpSetup, mcpTested),
  '/mcps/remove': postWith(Schema.Struct({ name: id }), ok),
  '/panels/action': postWith(
    Schema.Struct({
      characterKey: Schema.String.check(Schema.isMinLength(1)),
      id,
      action: Schema.Literals(['remove', 'show', 'hide']),
    }),
    ok,
  ),
  '/routines/action': postWith(
    Schema.Struct({
      characterKey: Schema.String.check(Schema.isMinLength(1)),
      id,
      operation: Schema.Literals(['pause', 'resume', 'remove']),
    }),
    ok,
  ),
  '/routines/open': postWith(Schema.Struct({ id }), ok),
  '/simulator/character': post(Schema.Unknown),
  /** The app update the desktop found, or null when it has none to offer. */
  '/app-update': postWith(
    Schema.Struct({
      version: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
    }),
    ok,
  ),
  /** Save the user's choice for a feature flag; null returns it to the channel default. */
  '/features/set': postWith(
    Schema.Struct({ id: featureName, enabled: Schema.NullOr(Schema.Boolean) }),
    ok,
  ),
};
export type DesktopRoutes = typeof desktopRoutes;
export type DesktopRoute = keyof DesktopRoutes;
export type DesktopRouteInput<P extends DesktopRoute> = DesktopRoutes[P] extends {
  input: infer I extends Contract;
}
  ? I['Encoded']
  : undefined;
/** What the bridge must return: the output schema's encoded side. */
export type DesktopRouteReply<P extends DesktopRoute> = DesktopRoutes[P]['output']['Encoded'];
/** What the desktop receives after decoding. */
export type DesktopRouteOutput<P extends DesktopRoute> = DesktopRoutes[P]['output']['Type'];
