import { describe, expect, it } from 'vitest';
import { dungeonLootInput } from '@wisp/protocol/game-inspection';
import { dungeonLoot } from '../src/integrations/dungeon-loot.ts';
import generated from '../src/integrations/dungeon-loot.json' with { type: 'json' };

const data = {
  generated: { note: 'test data' },
  data: {
    instances: [
      {
        key: 'Ragefire',
        name: 'Ragefire Chasm',
        instanceMapId: 389,
        kind: 'dungeon',
        levels: { min: 10, recommended: 13, max: 18 },
        bosses: [
          {
            name: 'Jergosh the Invoker',
            npcIds: [11518],
            items: [
              { id: 14150, chance: 36.36 },
              { id: 253906, forever: true },
            ],
          },
          { name: 'Bazzalan', npcIds: [11519], items: [{ id: 273003, forever: true }] },
        ],
      },
      {
        key: 'TheAlcazPrison',
        name: 'Alcaz Prison',
        instanceMapId: 2994,
        kind: 'dungeon',
        forever: true,
        bosses: [{ name: 'Zarla Ober', noDropsYet: true, items: [] }],
      },
    ],
  },
};

describe('dungeon loot', () => {
  it('joins each boss drop with the game reading and keeps unread items', async () => {
    const reads: unknown[] = [];
    const result = await dungeonLoot(
      { instanceMapId: 389, boss: 'jergosh' },
      async (inspection) => {
        reads.push(inspection);
        return {
          status: 'available',
          data: {
            status: 'loading',
            items: [{ id: 14150, name: 'Robe of Evocation', itemLevelGain: 4 }],
            other: [],
            loadingIds: [253906],
          },
        };
      },
      data,
    );
    expect(reads).toEqual([
      {
        kind: 'gear_candidates',
        args: {
          itemIds: [14150, 253906],
          minRequiredLevel: 0,
          maxRequiredLevel: 100,
          includeOther: true,
        },
      },
    ]);
    expect(result.status).toBe('loading');
    expect(result.loadingIds).toEqual([253906]);
    const instance = result.instances![0]!;
    expect(instance.bosses.map((boss) => boss.name)).toEqual(['Jergosh the Invoker']);
    expect(instance.bosses[0]!.items).toEqual([
      { id: 14150, name: 'Robe of Evocation', itemLevelGain: 4, chance: 36.36 },
      { id: 253906, addedInForever: true, unread: true },
    ]);
  });

  it('matches English names without accents and reports bosses without known drops', async () => {
    let read = false;
    const result = await dungeonLoot(
      { dungeon: 'alcaz' },
      async () => {
        read = true;
        return {};
      },
      data,
    );
    expect(read).toBe(false);
    const temple = await dungeonLoot(
      { dungeon: "Temple of Atal'Hakkar" },
      async () => ({ status: 'available', data: {} }),
      {
        ...data,
        data: {
          instances: [
            { key: "TheTempleOfAtal'Hakkar", name: 'Sunken Temple', kind: 'dungeon', bosses: [] },
          ],
        },
      },
    );
    expect(temple.instances?.map((instance) => instance.name)).toEqual(['Sunken Temple']);
    expect(result.instances![0]!.bosses[0]).toMatchObject({ name: 'Zarla Ober', noDropsYet: true });
    expect((await dungeonLoot({ dungeon: 'nowhere' }, async () => ({}), data)).status).toBe(
      'unavailable',
    );
    expect(
      await dungeonLoot(
        { instanceMapId: 389 },
        async () => ({ status: 'unavailable', error: 'Item API is unavailable' }),
        data,
      ),
    ).toMatchObject({ status: 'unavailable', error: 'Item API is unavailable' });
    expect(dungeonLootInput.safeParse({ boss: 'Jergosh' }).success).toBe(false);
  });

  it('ships generated loot for classic and Forever instances', () => {
    const instances = generated.data.instances as {
      name: string;
      instanceMapId?: number;
      bosses: unknown[];
    }[];
    const byMap = new Map(instances.map((instance) => [instance.instanceMapId, instance]));
    expect(byMap.get(389)?.name).toBe('Ragefire Chasm');
    expect(byMap.get(2994)?.name).toBe('Alcaz Prison');
    expect(byMap.get(409)?.name).toBe('Molten Core');
    expect(instances.reduce((sum, instance) => sum + instance.bosses.length, 0)).toBeGreaterThan(
      300,
    );
  });
});
