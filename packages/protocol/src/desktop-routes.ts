import { z } from 'zod';
import { connectionSetup, connectionDiscovery, discoveredConnectionModel } from './providers.js';
import { searchSetup, searchState } from './search.js';
import { authStateSchema, modelSchema, statusSchema } from './desktop.js';
import { mcpSetup } from './mcp-setup.js';
import { featureName } from './features.js';
// The contract between the desktop webview and the bridge's desktop server.
// The bridge validates every input and type-checks every output against it;
// the desktop client derives its typed Hono client from it and parses each
// response with the output schema.
const id = z.string().min(1).max(200);
const ok = z.object({ ok: z.literal(true) });
const mcpTested = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
  count: z.number().int().nonnegative(),
});
const get = <O extends z.ZodType>(output: O) => ({ method: 'get' as const, output });
const post = <O extends z.ZodType>(output: O) => ({ method: 'post' as const, output });
const postWith = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({
  method: 'post' as const,
  input,
  output,
});
export const desktopRoutes = {
  '/status': get(statusSchema),
  '/auth/models': get(z.object({ models: z.array(modelSchema) })),
  '/auth/start': postWith(
    z.object({ profileId: id.optional(), newAccount: z.boolean().optional() }),
    z.object({ authorizationUrl: z.string().url() }),
  ),
  '/auth/cancel': post(authStateSchema),
  '/auth/disconnect': post(authStateSchema),
  '/auth/select': postWith(z.object({ profileId: id }), authStateSchema),
  '/auth/model': postWith(
    z.object({ model: z.string().min(1).max(300) }),
    z.object({ ok: z.literal(true), model: z.string() }),
  ),
  '/connections/save': postWith(connectionSetup, z.object({ id: z.string() })),
  '/connections/test': postWith(connectionSetup, ok),
  '/connections/discover': postWith(
    connectionDiscovery,
    z.object({ models: z.array(discoveredConnectionModel) }),
  ),
  '/connections/remove': postWith(z.object({ id: z.string().uuid() }), ok),
  '/search/save': postWith(searchSetup, searchState),
  '/search/test': postWith(searchSetup, ok),
  '/search/remove-exa': postWith(z.strictObject({}), searchState),
  '/integrations/set': postWith(z.object({ id, enabled: z.boolean() }), ok),
  '/mcps/test': postWith(mcpSetup, mcpTested),
  '/mcps/save': postWith(mcpSetup, mcpTested),
  '/mcps/remove': postWith(z.object({ name: id }), ok),
  '/panels/action': postWith(
    z.object({
      characterKey: z.string().min(1),
      id,
      action: z.enum(['remove', 'show', 'hide']),
    }),
    ok,
  ),
  '/routines/action': postWith(
    z.object({
      characterKey: z.string().min(1),
      id,
      operation: z.enum(['pause', 'resume', 'remove']),
    }),
    ok,
  ),
  '/routines/open': postWith(z.object({ id }), ok),
  '/simulator/character': post(z.unknown()),
  /** The app update the desktop found, or null when it has none to offer. */
  '/app-update': postWith(z.object({ version: z.string().min(1).max(64).nullable() }), ok),
  /** Save the user's choice for a feature flag; null returns it to the channel default. */
  '/features/set': postWith(z.object({ id: featureName, enabled: z.boolean().nullable() }), ok),
};
export type DesktopRoutes = typeof desktopRoutes;
export type DesktopRoute = keyof DesktopRoutes;
export type DesktopRouteInput<P extends DesktopRoute> = DesktopRoutes[P] extends {
  input: infer I extends z.ZodType;
}
  ? z.input<I>
  : undefined;
/** What the bridge must return: the output schema's input side. */
export type DesktopRouteReply<P extends DesktopRoute> = z.input<DesktopRoutes[P]['output']>;
/** What the desktop receives after parsing. */
export type DesktopRouteOutput<P extends DesktopRoute> = z.output<DesktopRoutes[P]['output']>;
