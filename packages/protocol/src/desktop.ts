import { z } from 'zod';
import { capabilityViewSchema } from './capabilities.js';
import { savedRoutine, routineRun } from './routines.js';
import { connectionView, connectionModel } from './providers.js';
import { searchState } from './search.js';
export const desktopInfoSchema = z.object({
  wow: z.string().nullable().optional(),
  configured: z.boolean(),
  dataDirectory: z.string(),
  platform: z.string(),
  version: z.string(),
  telemetryEnabled: z.boolean().optional(),
  addonOutdated: z.boolean().nullable().optional(),
});
export const modelSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  efforts: z.array(z.string()),
});
export const mcpSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  transport: z.enum(['http', 'sse', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()),
  enabled: z.boolean(),
  hasToken: z.boolean().optional(),
  envKeys: z.array(z.string()).optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
});
export const panelSchema = z.object({
  id: z.string(),
  title: z.string(),
  character: z.string(),
  characterKey: z.string(),
  bindings: z.array(z.unknown()).optional(),
  hidden: z.boolean().optional(),
});
export const authStateSchema = z.object({
  status: z.string(),
  activeId: z.string().nullable().optional(),
  account: z.string().nullable().optional(),
  message: z.string().optional(),
  revision: z.number(),
  profiles: z.array(z.object({ id: z.string(), label: z.string(), connected: z.boolean() })),
});
export const statusSchema = z.object({
  ready: z.boolean(),
  gameConnected: z.boolean(),
  model: z.string(),
  activeTurns: z.number().int().nonnegative(),
  auth: authStateSchema,
  connections: z.array(connectionView).default([]),
  modelConnected: z.boolean().optional(),
  search: searchState.optional(),
  mcps: z.array(mcpSchema),
  integrations: z.array(capabilityViewSchema),
  panels: z.array(panelSchema),
  panelRecipients: z.array(z.object({ characterKey: z.string(), label: z.string() })).optional(),
  routines: z.array(savedRoutine),
  routineRuns: z.array(routineRun),
});
export type DesktopInfo = z.infer<typeof desktopInfoSchema>;
export type Model = z.infer<typeof modelSchema>;
export type Mcp = z.infer<typeof mcpSchema>;
export type Panel = z.infer<typeof panelSchema>;
export type Status = z.infer<typeof statusSchema>;
export const desktopResponses = {
  '/status': statusSchema,
  '/auth/models': z.object({ models: z.array(modelSchema) }),
  '/auth/start': z.object({ authorizationUrl: z.string().url() }).passthrough(),
  '/auth/cancel': authStateSchema,
  '/auth/disconnect': authStateSchema,
  '/connections/discover': z.object({ models: z.array(connectionModel) }),
};
