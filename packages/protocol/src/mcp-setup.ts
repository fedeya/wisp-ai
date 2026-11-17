import { z } from 'zod';
// Shared by the bridge's MCP manager and the desktop routes contract.
export const mcpName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine(
    (s) =>
      ![
        'everloot',
        'everloot_search',
        'everloot_changes',
        'external',
        'wow',
        'questie',
        'thewowdb',
        'wowhead',
        'web',
        'wowsims',
        'wisp',
        'constructor',
        'prototype',
        '__proto__',
      ].includes(s),
  );
export const mcpDefinition = z
  .object({
    name: mcpName,
    description: z.string().max(500).default(''),
    transport: z.enum(['http', 'sse', 'stdio']).default('http'),
    url: z.string().max(2000).optional(),
    command: z.string().min(1).max(1000).optional(),
    args: z.array(z.string().max(2000)).max(50).default([]),
    enabled: z.boolean().default(true),
    tokenEnv: z.string().max(100).optional(),
  })
  .superRefine((s, c) => {
    if (s.transport === 'stdio') {
      if (!s.command) {
        c.addIssue({ code: 'custom', message: 'Command is required' });
      }
    } else {
      try {
        const url = new URL(s.url || '');
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
          throw Error();
        }
      } catch {
        c.addIssue({ code: 'custom', message: 'Use an HTTP(S) URL without embedded credentials' });
      }
    }
  });
export const mcpSetup = z.object({
  server: mcpDefinition,
  token: z.string().max(10000).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(10000)).optional(),
});
