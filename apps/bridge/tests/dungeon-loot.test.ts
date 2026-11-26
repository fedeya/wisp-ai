import { describe, expect, it } from 'vitest';
import { dungeonLootInput } from '@wisp/agent/contract/game-inspection';
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

  it('keeps shared loot when filtering by boss and labels only trash as trash', async () => {
    const zulGurub = {
      key: "Zul'Gurub",
      name: "Zul'Gurub",
      instanceMapId: 309,
      kind: 'raid',
      bosses: [
        { name: 'High Priestess Jeklik', npcIds: [14517], items: [{ id: 19721 }] },
        { name: 'High Priest Venoxis', npcIds: [14507], items: [{ id: 19900 }] },
        { name: 'High Priest Shared loot', extra: true, items: [{ id: 22721 }] },
        { name: 'Trash', extra: true, items: [{ id: 19727 }] },
        { name: 'Jinxed Hoodoo Pile', extra: true, items: [{ id: 19881 }] },
      ],
    };
    const loot = { ...data, data: { instances: [zulGurub] } };
    const unread = async () => ({ status: 'available', data: {} });
    const jeklik = await dungeonLoot({ instanceMapId: 309, boss: 'jeklik' }, unread, loot);
    expect(jeklik.instances![0]!.bosses.map((entry) => [entry.name, entry.source])).toEqual([
      ['High Priestess Jeklik', 'boss'],
      ['High Priest Shared loot', 'shared'],
    ]);
    const all = await dungeonLoot({ instanceMapId: 309 }, unread, loot);
    expect(all.instances![0]!.bosses.map((entry) => entry.source)).toEqual([
      'boss',
      'boss',
      'shared',
      'trash',
      'other',
    ]);
  });

  it('hides gear the class can never use and summarizes upgrades without a boss', async () => {
    const reading = {
      status: 'available',
      data: {
        status: 'available',
        items: [
          {
            id: 1,
            name: 'Bow',
            slot: 18,
            itemLevelGain: 12,
            proficiency: 'trainable',
            trainableAtLevel: 1,
          },
          {
            id: 2,
            name: 'Plate Helm',
            slot: 1,
            itemLevelGain: 20,
            proficiency: 'class_cannot_use',
          },
          {
            id: 3,
            name: 'Cloth Gloves',
            slot: 10,
            itemLevelGain: 4,
            statDelta: { ITEM_MOD_INTELLECT_SHORT: 2 },
            proficiency: 'usable',
          },
          { id: 4, name: 'Old Boots', slot: 8, itemLevelGain: -3, proficiency: 'usable' },
        ],
        other: [{ id: 5, name: 'Recipe' }],
      },
    };
    const loot = {
      ...data,
      data: {
        instances: [
          {
            key: 'Test',
            name: 'Test Keep',
            instanceMapId: 1,
            kind: 'dungeon',
            bosses: [{ name: 'Boss', items: [1, 2, 3, 4, 5].map((id) => ({ id, chance: id })) }],
          },
        ],
      },
    };
    const summary = await dungeonLoot({ instanceMapId: 1 }, async () => reading, loot);
    expect(summary.detail).toBe('summary');
    // Every usable drop in a few fields; the plate helm is only counted.
    expect(summary.instances![0]!.bosses[0]).toEqual({
      name: 'Boss',
      source: 'boss',
      hiddenUnusable: 1,
      upgradeCount: 2,
      items: [
        {
          id: 1,
          name: 'Bow',
          chance: 1,
          itemLevelGain: 12,
          proficiency: 'trainable',
          trainableAtLevel: 1,
        },
        {
          id: 3,
          name: 'Cloth Gloves',
          chance: 3,
          itemLevelGain: 4,
          statDelta: { ITEM_MOD_INTELLECT_SHORT: 2 },
        },
        { id: 4, name: 'Old Boots', chance: 4 },
        { id: 5, name: 'Recipe', chance: 5 },
      ],
    });

    const full = await dungeonLoot(
      { instanceMapId: 1, detail: 'full', includeUnusable: true },
      async () => reading,
      loot,
    );
    expect(full.instances![0]!.bosses[0]!.items!.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
    expect(full.instances![0]!.bosses[0]!.hiddenUnusable).toBeUndefined();
  });

  it('falls back to the summary when full detail is too large', async () => {
    const ids = Array.from({ length: 300 }, (_, index) => index + 1);
    const loot = {
      ...data,
      data: {
        instances: [
          {
            key: 'Big',
            name: 'Big Raid',
            instanceMapId: 2,
            kind: 'raid',
            bosses: [{ name: 'Boss', items: ids.map((id) => ({ id })) }],
          },
        ],
      },
    };
    const result = await dungeonLoot(
      { instanceMapId: 2, detail: 'full' },
      async () => ({
        status: 'available',
        data: {
          items: ids.map((id) => ({
            id,
            name: `Item ${id}`,
            stats: { ITEM_MOD_STAMINA_SHORT: id },
            tooltip: 'x'.repeat(100),
          })),
        },
      }),
      loot,
    );
    expect(result.detail).toBe('summary');
    expect(result.truncated).toContain('boss');
    expect(result.instances![0]!.bosses[0]!.items).toHaveLength(300);
    expect(result.instances![0]!.bosses[0]!.items![0]).toEqual({ id: 1, name: 'Item 1' });
  });

  it('reads the populated table when a name matches only an empty one of the same map', async () => {
    const loot = {
      ...data,
      data: {
        instances: [
          {
            key: 'Onyxia',
            name: 'Onyxia',
            instanceMapId: 249,
            kind: 'raid',
            bosses: [{ name: 'Onyxia', items: [{ id: 17078 }] }],
          },
          {
            key: 'OnyxiasLairNew',
            name: 'Onyxias Lair',
            instanceMapId: 249,
            kind: 'raid',
            bosses: [],
          },
        ],
      },
    };
    const result = await dungeonLoot(
      { dungeon: "Onyxia's Lair", boss: 'onyxia' },
      async () => ({ status: 'available', data: {} }),
      loot,
    );
    expect(result.instances!.map((instance) => instance.name)).toEqual(['Onyxia', 'Onyxias Lair']);
    expect(result.instances![0]!.bosses[0]!.items!.map((item) => item.id)).toEqual([17078]);
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
