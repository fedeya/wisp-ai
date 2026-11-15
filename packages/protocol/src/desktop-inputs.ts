import { z } from 'zod';
import { connectionSetup, connectionDiscovery } from './providers.js';
import { searchSetup } from './search.js';
import { parseTemplate, TEMPLATE_BYTES } from './panel-template.js';
const templateText = z
  .string()
  .max(TEMPLATE_BYTES)
  .superRefine((s, ctx) => {
    try {
      parseTemplate(s);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid passive tracker template' });
    }
  });
const id = z.string().min(1).max(200);
export const desktopInputs = {
  '/auth/start': z.object({ profileId: id.optional(), newAccount: z.boolean().optional() }),
  '/auth/select': z.object({ profileId: id }),
  '/auth/model': z.object({ model: z.string().min(1).max(300) }),
  '/connections/save': connectionSetup,
  '/connections/test': connectionSetup,
  '/connections/discover': connectionDiscovery,
  '/connections/remove': z.object({ id: z.string().uuid() }),
  '/search/save': searchSetup,
  '/search/test': searchSetup,
  '/search/remove-exa': z.strictObject({}),
  '/integrations/set': z.object({ id, enabled: z.boolean() }),
  '/mcps/remove': z.object({ name: id }),
  '/panels/export': z.strictObject({ characterKey: id, id }),
  '/panels/import': z.strictObject({
    characterKey: id,
    template: templateText,
    confirmed: z.literal(true),
  }),
  '/panels/action': z.object({
    characterKey: z.string().min(1),
    id,
    action: z.enum(['remove', 'show', 'hide']),
  }),
  '/routines/action': z.object({
    characterKey: z.string().min(1),
    id,
    operation: z.enum(['pause', 'resume', 'remove']),
  }),
  '/routines/open': z.object({ id }),
};
export type DesktopInputs = {
  [K in keyof typeof desktopInputs]: z.input<(typeof desktopInputs)[K]>;
};
