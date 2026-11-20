import { z } from 'zod';
import type { CapabilitySettings } from './capabilities.ts';
const addonReport = z.object({
  status: z.enum(['ready', 'partial', 'waiting', 'missing', 'incompatible']),
  version: z.string().max(80).optional(),
});
const reportSchema = z.object({
  syndicator: addonReport.optional(),
  auctionator: addonReport.optional(),
  version: z.string().max(80),
  questie: z.object({
    status: z.enum(['ready', 'partial', 'missing', 'incompatible']),
    version: z.string().max(80).optional(),
    npcs: z.boolean().optional().default(false),
    quests: z.boolean().optional().default(false),
    objects: z.boolean().optional().default(false),
    trainers: z.boolean(),
    services: z.boolean(),
  }),
});
export class IntegrationState {
  lastSeen = 0;
  report?: z.infer<typeof reportSchema>;
  private settings: CapabilitySettings;
  private now: () => number;
  constructor(settings: CapabilitySettings, now = () => Date.now()) {
    this.settings = settings;
    this.now = now;
    this.refresh();
  }
  reset() {
    this.lastSeen = 0;
    this.report = undefined;
    this.refresh();
  }
  receive(value: unknown) {
    const result = reportSchema.safeParse(value);
    if (!result.success) {
      return false;
    }
    this.report = result.data;
    this.lastSeen = this.now();
    this.refresh();
    return true;
  }
  refresh() {
    const live = !!this.report && this.now() - this.lastSeen < 180_000;
    this.settings.availability.set('core:wow', {
      available: live,
      status: live ? 'ready' : 'waiting',
      version: live ? this.report!.version : undefined,
      reason: live ? 'Connected to the game.' : 'Open WoW and load Wisp to connect.',
    });
    const q = live ? this.report!.questie : undefined;
    this.settings.availability.set('integration:questie', {
      available: !!q && ['ready', 'partial'].includes(q.status),
      status: q?.status || 'waiting',
      version: q?.version,
      reason: !q
        ? 'Waiting for WoW.'
        : q.status === 'missing'
          ? 'QuestieDB is not loaded.'
          : q.status === 'incompatible'
            ? 'Update QuestieDB to a compatible Forever version.'
            : q.status === 'partial'
              ? 'Some quest or location data is unavailable. See the tools below.'
              : undefined,
    });

    for (const [id, feature] of [
      ['find_npc_locations', 'npcs'],
      ['get_quest', 'quests'],
      ['get_quest_chain', 'quests'],
      ['find_object_locations', 'objects'],
    ] as const) {
      const available = !!q && ['ready', 'partial'].includes(q.status) && q[feature];
      this.settings.availability.set('tool:' + id, {
        available,
        status: !q ? 'waiting' : available ? 'ready' : 'unavailable',
        reason: available
          ? undefined
          : !q
            ? 'Waiting for WoW.'
            : q.status === 'missing'
              ? 'Install or enable QuestieDB Forever.'
              : q.status === 'incompatible'
                ? 'Update QuestieDB to a compatible Forever version.'
                : 'Your installed QuestieDB does not provide this data.',
      });
    }
    for (const id of ['syndicator', 'auctionator'] as const) {
      const addon = live ? this.report![id] : undefined;
      this.settings.availability.set('integration:' + id, {
        available: !!addon && ['ready', 'partial'].includes(addon.status),
        status: addon?.status || 'waiting',
        version: addon?.version,
        reason: !addon
          ? 'Open WoW and reload Wisp to check this addon.'
          : addon.status === 'missing'
            ? 'The addon is not loaded.'
            : addon.status === 'incompatible'
              ? 'This addon version is not supported.'
              : addon.status === 'waiting'
                ? 'The addon has not finished initializing.'
                : id === 'syndicator'
                  ? 'Saved inventory may be out of date.'
                  : 'Prices reflect the last scan. Their age is shown when available.',
      });
    }
  }
}
