import { z } from 'zod';
export const databaseKind = z.enum(['item', 'spell', 'quest', 'npc', 'zone']);
export const databaseSearch = z.strictObject({
  kind: databaseKind,
  query: z.string().trim().min(1).max(64),
  page: z.number().int().min(1).max(200).default(1),
  limit: z.number().int().min(1).max(20).default(10),
});
export const databaseEntity = z.strictObject({
  kind: databaseKind,
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const databaseRequest = z.discriminatedUnion('operation', [
  databaseSearch.extend({ operation: z.literal('search') }),
  databaseEntity.extend({ operation: z.literal('get') }),
]);
