import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Simulator } from '../src/simulation.ts';
import { simulationInput, simulationNeedsLiveState } from '@wisp/protocol/simulation';
import type { ClassMetadata } from '../src/simulation/adapters/types.ts';
import { adapters } from '../src/simulation/adapters/index.ts';
const simulator = new Simulator(process.cwd());
const input = { plans: [{ label: 'Frostbolt', priority: [{ spellId: 205 }] }] };

test('hypothetical input removes live dependency and helper gameplay policies', async () => {
  const hypothetical = {
    character: { class: 'MAGE' as const, level: 11, raceToken: 'Human' as const },
    includeCurrentEquipment: false,
    equipmentSets: [{ label: 'Empty', base: 'empty' as const, replacements: [] }],
    durationSeconds: 600,
    iterations: 5000,
    targetDistanceYards: 100,
    plans: Array.from({ length: 5 }, (_, i) => ({
      label: String(i),
      priority: [{ spellId: 2948 }],
      talents: [{ id: 11070, rank: 5 }],
    })),
  };
  assert.equal(simulationNeedsLiveState(hypothetical), false);
  assert.equal(simulationNeedsLiveState({ ...hypothetical, includeCurrentEquipment: true }), true);
  assert.equal(simulationNeedsLiveState({ nativeRequest: { raid: {} } }), false);
  const prepared = await simulator.prepare(undefined, hypothetical, [], 'empty');
  assert.equal(prepared.character.name, 'Hypothetical');
  assert.equal(prepared.scenario.talentPoints, 5);
  assert.deepEqual(prepared.scenario.spellIds, [2948]);
  await assert.rejects(
    simulator.prepare(undefined, { ...hypothetical, includeCurrentEquipment: true }),
  );
});

test(
  'native requests pass through without live state, including helper-unlisted spells and zero DPS',
  { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
  async () => {
    const prepared = await simulator.prepare(mageSnapshot(22), { ...input, iterations: 2 });
    const request = structuredClone(prepared.request);
    request.raid.parties[0].players[0].rotation.priorityList = [
      { action: { castSpell: { spellId: { spellId: 2948 } } } },
    ];
    const original = structuredClone(request);
    const native = await simulator.run(undefined, { nativeRequest: request });
    assert.equal(native.status, 'native', JSON.stringify(native));
    if (native.status === 'native') {
      assert.deepEqual(native.request, original);
      assert.ok(
        native.result.raidMetrics.parties[0].players[0].actions.some(
          (a: any) => a.id?.spellId === 2948,
        ),
      );
    }
    request.raid.parties[0].players[0].rotation.priorityList = [];
    const zero = await simulator.run(undefined, { nativeRequest: request });
    assert.equal(zero.status, 'native', JSON.stringify(zero));
    if (zero.status === 'native') {
      assert.equal(zero.result.raidMetrics.parties[0].players[0].dps.avg ?? 0, 0);
    }
    const invalid = await simulator.run(undefined, {
      nativeRequest: { unsupportedEngineField: true },
    });
    assert.equal(invalid.status, 'unavailable');
    const structuredZero = await simulator.run(mageSnapshot(), {
      iterations: 2,
      plans: [{ label: 'Idle', priority: [] }],
    });
    assert.equal(structuredZero.status, 'available', JSON.stringify(structuredZero));
    if (structuredZero.status === 'available') {
      assert.equal(structuredZero.results[0].dps.average, 0);
      assert.equal(structuredZero.results[0].relativeToFirstPercent, null);
      assert.equal(structuredZero.results[0].equipmentDeltaPercent, null);
    }
  },
);

test(
  'time-budget continuation preserves completed scenarios and resumes their original indices',
  { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
  async () => {
    const instance = new Simulator(process.cwd());
    const original = (instance as any).runSingle.bind(instance);
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const runner = vi
      .spyOn(instance as any, 'runSingle')
      .mockImplementation(async (...args: unknown[]) => {
        const result = await original(...args);
        now += 41000;
        return result;
      });
    const options = {
      iterations: 2,
      plans: Array.from({ length: 4 }, (_, i) => ({ ...input.plans[0], label: 'Plan ' + i })),
    };
    let first;
    try {
      first = await instance.run(mageSnapshot(), options);
    } finally {
      clock.mockRestore();
      runner.mockRestore();
    }
    assert.equal(first.status, 'available', JSON.stringify(first));
    if (first.status !== 'available') {
      return;
    }
    assert.equal(first.nextIndex, 1);
    assert.equal(first.results.length, 1);
    const rest = await instance.run(mageSnapshot(), { ...options, startIndex: first.nextIndex! });
    assert.equal(rest.status, 'available', JSON.stringify(rest));
    if (rest.status === 'available') {
      assert.equal(rest.nextIndex, null);
      assert.deepEqual(
        rest.results.map((r) => r.planIndex),
        [1, 2, 3],
      );
      assert.ok(rest.results.every((r) => r.relativeToFirstPercent === null));
    }
  },
);
export function mageSnapshot(level = 11) {
  return {
    sections: {
      character: {
        status: 'available',
        data: {
          name: 'Test Mage',
          realm: 'Test Realm',
          class: 'MAGE',
          raceToken: 'Human',
          game: 'WoW Forever',
          level,
        },
      },
      spells: {
        status: 'available',
        data: { known: [{ id: 116 }, { id: 205 }, { id: 133 }, { id: 143 }] },
      },
      talents: {
        status: 'available',
        data: { selected: [{ id: 11070, rank: 2 }], hasPendingChanges: false },
      },
      gear: {
        status: 'available',
        data: { items: [] as { slot: number; id: number; link: string }[] },
      },
    },
  };
}
test('level 11 preparation uses exact live state, learned rank and no max-level defaults', async () => {
  const prepared = await simulator.prepare(mageSnapshot(), input);
  const p = prepared.request.raid.parties[0].players[0];
  assert.equal(p.level, 11);
  assert.equal(prepared.scenario.targetLevel, 11);
  assert.deepEqual(prepared.scenario.spellIds, [205]);
  assert.equal(prepared.scenario.talentPoints, 2);
  assert.equal(p.talentsString.split('-')[2][1], '2');
  assert.equal(p.equipment.items.length, 17);
  assert.deepEqual(p.rotation.priorityList, [
    { action: { castSpell: { spellId: { spellId: 205 } } } },
  ]);
  for (const input of [{ level: 60 }, { rotation: 'arbitrary' }, { targetLevel: 63 }]) {
    assert.equal(simulationInput.safeParse(input).success, false);
  }
});

test('rank selection preserves lower and mixed spell IDs without learned-spell restrictions', async () => {
  const snapshot = mageSnapshot(14);
  snapshot.sections.spells.data.known = [{ id: 145 }];
  const prepared = await simulator.prepare(snapshot, {
    plans: [
      { label: 'Mixed Fireball ranks', opener: [{ spellId: 133 }], priority: [{ spellId: 143 }] },
    ],
  });
  assert.deepEqual(prepared.scenario.spellIds, [133, 143]);
});

test(
  'native level-14 downranking executes requested Fireball ranks and keeps cooldowns shared',
  { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
  async () => {
    const snapshot = mageSnapshot(14);
    snapshot.sections.spells.data.known = [{ id: 145 }];
    const original = structuredClone(snapshot);
    const result = await simulator.run(snapshot, {
      iterations: 100,
      plans: [
        { label: 'Rank 1', priority: [{ spellId: 133 }] },
        { label: 'Rank 3', priority: [{ spellId: 145 }] },
        { label: 'Mixed ranks', opener: [{ spellId: 133 }], priority: [{ spellId: 143 }] },
      ],
    });
    assert.equal(result.status, 'available', JSON.stringify(result));
    if (result.status !== 'available') {
      return;
    }
    assert.ok(result.results[0].castsBySpell.some((s) => s.spellId === 133 && s.castsPerFight > 0));
    assert.ok(result.results[1].castsBySpell.some((s) => s.spellId === 145 && s.castsPerFight > 0));
    assert.notEqual(result.results[0].dps.average, result.results[1].dps.average);
    for (const id of [133, 143]) {
      assert.ok(
        result.results[2].castsBySpell.some((s) => s.spellId === id && s.castsPerFight > 0),
      );
    }
    assert.deepEqual(snapshot, original);
    const cooldown = await simulator.run(mageSnapshot(18), {
      iterations: 100,
      plans: [
        {
          label: 'Shared cooldown',
          priority: [{ spellId: 2137 }, { spellId: 2136 }, { spellId: 133 }],
        },
      ],
    });
    assert.equal(cooldown.status, 'available', JSON.stringify(cooldown));
    if (cooldown.status === 'available') {
      assert.ok(cooldown.results[0].unusedSpellIds.includes(2136));
    }
  },
);
test('incomplete, unsupported, changed and mismatched character data cannot produce a DPS result', async () => {
  const cases = [
    (s: any) => {
      s.sections.character.data.class = 'UNKNOWN';
    },
    (s: any) => {
      s.sections.character.data.level = 0;
    },
    (s: any) => {
      s.sections.character.data.game = 'Classic';
    },
    (s: any) => {
      s.sections.talents.data.selected = [{ id: 999999, rank: 1 }];
    },
    (s: any) => {
      s.sections.gear.status = 'unavailable';
    },
    (s: any) => {
      s.sections.gear.data.items = [{ id: 99999999, slot: 1, link: 'item:99999999' }];
    },
  ];
  for (const change of cases) {
    const snapshot = mageSnapshot();
    change(snapshot);
    const result = await simulator.run(snapshot, input);
    assert.equal(result.status, 'unavailable');
    assert.ok(!('dps' in result));
  }
});
test(
  'native pinned WoWSims executes a nonzero level-11 simulation',
  { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
  async () => {
    const result = await simulator.run(mageSnapshot(), { ...input, iterations: 100 });
    assert.equal(result.status, 'available', JSON.stringify(result));
    if (result.status === 'available' && 'results' in result) {
      assert.equal(result.character.level, 11);
      assert.equal(result.results[0].scenario.targetLevel, 11);
      assert.ok(result.results[0].dps.average > 0);
      assert.ok(result.results[0].damageBySpell.some((s: any) => s.spellId === 205));
    }
  },
);

test(
  'native level-11 comparison executes an opener, cooldown, channel and equipped wand',
  { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
  async () => {
    const snapshot = mageSnapshot();
    snapshot.sections.spells.data.known.push(...[2136, 5143, 5019, 122].map((id) => ({ id })));
    snapshot.sections.gear.data.items.push({
      slot: 18,
      id: 11287,
      link: '|Hitem:11287::::::::11:::::::::|h[Wand]|h',
    });
    const result = await simulator.run(snapshot, {
      targetDistanceYards: 5,
      iterations: 100,
      plans: [
        { label: 'Frostbolt', priority: [{ spellId: 205 }] },
        {
          label: 'Opening into wand',
          opener: [{ spellId: 205 }, { spellId: 122 }, { spellId: 2136 }, { spellId: 5143 }],
          priority: [{ spellId: 5019 }],
        },
        {
          label: 'Cooldown priorities',
          priority: [{ spellId: 2136 }, { spellId: 5019, manaBelowPercent: 20 }, { spellId: 205 }],
        },
      ],
    });
    assert.equal(result.status, 'available', JSON.stringify(result));
    if (result.status === 'available') {
      assert.equal(result.results.length, 3);
      const spells = result.results[1].damageBySpell.map((a: any) => a.spellId);
      for (const id of [205, 122, 2136, 5143, 5019]) {
        assert.ok(spells.includes(id), 'requested spell dealt damage: ' + id);
      }
      assert.ok(Number.isFinite(result.results[1].relativeToFirstPercent));
      const blast = (i: number) =>
        result.results[i].damageBySpell.find((a: any) => a.spellId === 2136)?.damagePerFight ?? 0;
      assert.ok(
        blast(2) > blast(1) * 2,
        'priority list reuses Fire Blast as its cooldown becomes ready',
      );
    }
  },
);

const classMetadata = JSON.parse(readFileSync('simulator/classes.json', 'utf8')) as Record<
  string,
  ClassMetadata
>;
const baselineFamilies: Record<string, string> = {
  MAGE: 'Fireball',
  WARRIOR: 'HeroicStrike',
  ROGUE: 'SinisterStrike',
  HUNTER: 'ArcaneShot',
  PALADIN: 'SealOfRighteousness',
  PRIEST: 'Smite',
  SHAMAN: 'LightningBolt',
  WARLOCK: 'ShadowBolt',
  DRUID: 'Wrath',
};
function classFixture(token: string, level: number) {
  const snapshot = mageSnapshot(level);
  snapshot.sections.character.data.class = token;
  snapshot.sections.character.data.raceToken =
    token === 'SHAMAN' ? 'Orc' : token === 'DRUID' ? 'NightElf' : 'Human';
  snapshot.sections.talents.data.selected = [];
  const metadata = classMetadata[token];
  const known = Object.values(metadata.ranks)
    .flat()
    .filter((r) => r.level <= level)
    .map((r) => ({ id: r.id }));
  if (token === 'HUNTER') {
    known.push({ id: 75 });
  }
  snapshot.sections.spells.data.known = known;
  const weapon = token === 'PALADIN' ? 2847 : 2218;
  if (adapters[token].melee) {
    snapshot.sections.gear.data.items.push({ slot: 16, id: weapon, link: 'item:' + weapon });
  }
  if (token === 'HUNTER') {
    snapshot.sections.gear.data.items.push({ slot: 18, id: 2505, link: 'item:2505' });
  }
  const spellId = metadata.ranks[baselineFamilies[token]]
    .filter((r) => r.level <= level)
    .at(-1)!.id;
  const plan = { label: token, priority: [{ spellId }] };
  return { snapshot, input: { plans: [plan], iterations: 100 } };
}
for (const token of Object.keys(adapters)) {
  for (const level of [11, 30, 60]) {
    test(
      `native ${token} damage at level ${level} uses the real adapter`,
      { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
      async () => {
        const fixture = classFixture(token, level);
        const result = await simulator.run(fixture.snapshot, fixture.input);
        assert.equal(result.status, 'available', JSON.stringify(result));
        if (result.status !== 'available') {
          return;
        }
        assert.equal(result.character.class, token);
        assert.ok(result.results[0].dps.average > 0);
        assert.ok(
          result.results[0].damageBySpell.some(
            (s: any) => s.spellId === fixture.input.plans[0].priority[0].spellId,
          ),
        );
      },
    );
  }
}

test(
  'equipment sets compare the same plan and preserve the original snapshot',
  { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
  async () => {
    const snapshot = mageSnapshot();
    const original = structuredClone(snapshot);
    const result = await simulator.run(snapshot, {
      ...input,
      iterations: 100,
      equipmentSets: [{ label: 'Channeling ring', replacements: [{ slot: 11, itemId: 1449 }] }],
    });
    assert.deepEqual(snapshot, original);
    assert.equal(result.status, 'available', JSON.stringify(result));
    if (result.status !== 'available') {
      return;
    }
    assert.equal(result.results.length, 2);
    assert.equal(result.results[1].planIndex, 0);
    assert.equal(result.results[1].equipmentLabel, 'Channeling ring');
    assert.equal(result.results[0].equipmentDeltaDps, 0);
    assert.equal(
      result.results[1].equipmentDeltaDps,
      result.results[1].dps.average - result.results[0].dps.average,
    );
    assert.ok(result.results[1].scenario.equipment.some((i) => i.slot === 11 && i.id === 1449));
  },
);

test('empty equipment sets ignore live items and preserve the character snapshot', async () => {
  const snapshot = mageSnapshot();
  snapshot.sections.gear.data.items = [{ slot: 1, id: 99999999, link: 'item:99999999' }];
  const original = structuredClone(snapshot);
  const prepared = await simulator.prepare(snapshot, input, [{ slot: 11, itemId: 1449 }], 'empty');
  assert.deepEqual(prepared.scenario.equipment, [{ slot: 11, id: 1449 }]);
  assert.equal(prepared.scenario.equipmentBase, 'empty');
  assert.deepEqual(snapshot, original);
  const naked = await simulator.prepare(snapshot, input, [], 'empty');
  assert.equal(naked.scenario.equippedItems, 0);
  assert.equal(
    simulationInput.safeParse({ ...input, includeCurrentEquipment: false }).success,
    false,
  );
});

test(
  'hypothetical-only runs bypass unsupported live gear without inventing current-gear deltas',
  { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
  async () => {
    const snapshot = mageSnapshot();
    snapshot.sections.gear.data.items = [{ slot: 1, id: 99999999, link: 'item:99999999' }];
    const original = structuredClone(snapshot);
    const result = await simulator.run(snapshot, {
      ...input,
      iterations: 100,
      includeCurrentEquipment: false,
      equipmentSets: [
        { label: 'Naked', base: 'empty', replacements: [] },
        { label: 'Unowned ring', base: 'empty', replacements: [{ slot: 11, itemId: 1449 }] },
      ],
    });
    assert.equal(result.status, 'available', JSON.stringify(result));
    if (result.status !== 'available') {
      return;
    }
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].equipmentLabel, 'Naked');
    assert.equal(result.results[0].relativeToFirstPercent, 0);
    assert.ok(result.results[1].dps.average > 0);
    for (const row of result.results) {
      assert.equal(row.equipmentDeltaDps, null);
      assert.equal(row.equipmentDeltaPercent, null);
    }
    assert.deepEqual(snapshot, original);
  },
);

test('hypothetical talents and spells ignore live selection without changing it', async () => {
  const snapshot = mageSnapshot();
  snapshot.sections.talents.data.hasPendingChanges = true;
  snapshot.sections.spells.data.known = [];
  const original = structuredClone(snapshot);
  const prepared = await simulator.prepare(snapshot, {
    plans: [
      { label: 'Hypothetical', talents: [{ id: 11070, rank: 2 }], priority: [{ spellId: 205 }] },
    ],
  });
  assert.equal(prepared.scenario.talentSource, 'hypothetical');
  assert.equal(prepared.scenario.talentPoints, 2);
  assert.deepEqual(snapshot, original);
  const nakedBuild = await simulator.prepare(snapshot, {
    plans: [{ ...input.plans[0], talents: [] }],
  });
  assert.equal(nakedBuild.scenario.talentPoints, 0);
  for (const talents of [
    [{ id: 99999999, rank: 1 }],
    [
      { id: 11070, rank: 1 },
      { id: 11070, rank: 1 },
    ],
  ]) {
    await assert.rejects(simulator.prepare(snapshot, { plans: [{ ...input.plans[0], talents }] }));
  }
});

test('simulator catalog exposes requirements and hypothetical identity selects level-specific spells', async () => {
  const catalog = await simulator.run(mageSnapshot(), { catalogOnly: true });
  assert.equal(catalog.status, 'catalog');
  if (catalog.status === 'catalog') {
    assert.ok(catalog.metadata.talents.flat().every((t) => t.row !== undefined));
  }
  const prepared = await simulator.prepare(
    mageSnapshot(),
    {
      character: { class: 'MAGE', level: 60, raceToken: 'Gnome' },
      plans: [
        {
          label: 'Level 60',
          talents: [],
          priority: [{ spellId: classMetadata.MAGE.ranks.Frostbolt.at(-1)!.id }],
        },
      ],
    },
    [],
    'empty',
  );
  assert.equal(prepared.character.source, 'hypothetical');
  assert.equal(prepared.character.level, 60);
  assert.equal(prepared.scenario.talentPoints, 0);
});

test(
  'native simulation compares different talent builds without a respec',
  { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
  async () => {
    const snapshot = mageSnapshot();
    snapshot.sections.spells.data.known = [];
    const original = structuredClone(snapshot);
    const result = await simulator.run(snapshot, {
      iterations: 100,
      plans: [
        { label: 'No talents', talents: [], priority: [{ spellId: 205 }] },
        {
          label: 'Improved Frostbolt',
          talents: [{ id: 11070, rank: 2 }],
          priority: [{ spellId: 205 }],
        },
      ],
    });
    assert.equal(result.status, 'available', JSON.stringify(result));
    if (result.status === 'available') {
      assert.equal(result.results.length, 2);
      assert.notEqual(result.results[0].dps.average, result.results[1].dps.average);
      assert.equal(result.results[0].scenario.talentPoints, 0);
      assert.equal(result.results[1].scenario.talentPoints, 2);
    }
    assert.deepEqual(snapshot, original);
  },
);

test('candidate equipment rejects ambiguous slots, unknown IDs and unrepresentable fields', async () => {
  for (const replacements of [
    [{ slot: 11, itemId: 99999999 }],
    [
      { slot: 11, itemId: 1449 },
      { slot: 11, itemId: 1116 },
    ],
  ]) {
    await assert.rejects(simulator.prepare(mageSnapshot(), input, replacements));
  }
  assert.equal(
    simulationInput.safeParse({
      ...input,
      equipmentSets: [
        {
          label: 'Unsafe stats',
          replacements: [{ slot: 11, itemId: 1449, stats: { spellPower: 999 } }],
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    simulationInput.safeParse({
      ...input,
      equipmentSets: [
        { label: 'Enchanted', replacements: [{ slot: 11, itemId: 1449, enchant: 123 }] },
      ],
    }).success,
    false,
  );
});

test('resource conditions and distances pass through with class defaults', async () => {
  const fixture = classFixture('ROGUE', 11);
  const prepared = await simulator.prepare(fixture.snapshot, {
    plans: [
      {
        label: 'Builder/finisher',
        priority: [
          { spellId: 6760, comboPointsAtLeast: 5 },
          { spellId: 1757, energyAbove: 40 },
        ],
      },
    ],
  });
  assert.equal(prepared.scenario.targetDistanceYards, 5);
  await simulator.prepare(fixture.snapshot, { ...fixture.input, targetDistanceYards: 20 });
  await simulator.prepare(fixture.snapshot, {
    plans: [
      {
        label: 'Engine decides resource behavior',
        priority: [{ spellId: 1757, manaBelowPercent: 20 }],
      },
    ],
  });
});

for (const [token, adapter] of Object.entries(adapters)) {
  for (const family of adapter.families) {
    test(
      `native ${token}/${family} executes its declared action`,
      { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
      async () => {
        const fixture = classFixture(token, 60);
        if (family === 'Incinerate') {
          fixture.snapshot.sections.talents.data.selected = classMetadata.WARLOCK.talents[2].map(
            (t) => ({ id: t.id, rank: t.max }),
          );
        }
        const spellId = classMetadata[token].ranks[family].at(-1)!.id;
        const filler = fixture.input.plans[0].priority[0];
        const action = { spellId };
        const utility = ['Bloodrage', 'HuntersMark', 'AspectOfTheHawk', 'RapidFire'].includes(
          family,
        );
        const opener = token === 'PALADIN' ? [{ spellId: 20293 }] : utility ? [action] : [];
        const priority = utility
          ? [filler]
          : family === 'Eviscerate'
            ? [{ spellId, comboPointsAtLeast: 3 }, filler]
            : [action, filler];
        const result = await simulator.run(fixture.snapshot, {
          plans: [{ label: family, opener, priority }],
          targetDistanceYards: token === 'HUNTER' ? 20 : 5,
          iterations: 100,
        });
        assert.equal(result.status, 'available', JSON.stringify(result));
        if (result.status !== 'available') {
          return;
        }
        const report = result.results[0];
        if (utility) {
          assert.ok(
            report.castsBySpell.some((a) => a.spellId === spellId && a.castsPerFight > 0),
            JSON.stringify(report),
          );
        } else {
          assert.ok(
            report.damageBySpell.some((a) => a.spellId === spellId && a.damagePerFight > 0),
            JSON.stringify(report),
          );
        }
      },
    );
  }
}

test(
  'native DoT refresh conditions maintain damage over time while allowing a filler',
  { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
  async () => {
    const fixture = classFixture('WARLOCK', 30);
    const result = await simulator.run(fixture.snapshot, {
      plans: [
        {
          label: 'Maintain Corruption',
          priority: [
            { spellId: 6223, dotRefreshBelowSeconds: 1 },
            fixture.input.plans[0].priority[0],
          ],
        },
      ],
      iterations: 100,
    });
    assert.equal(result.status, 'available', JSON.stringify(result));
    if (result.status === 'available') {
      for (const id of [6223, fixture.input.plans[0].priority[0].spellId]) {
        assert.ok(result.results[0].damageBySpell.some((a) => a.spellId === id));
      }
      const casts = result.results[0].castsBySpell.find((a) => a.spellId === 6223)!.castsPerFight;
      assert.ok(casts >= 1 && casts < 4, 'Corruption is refreshed, not spammed');
    }
  },
);

test(
  'equipment comparisons keep a separate baseline for every rotation',
  { skip: !existsSync('simulator/wowsimcli.exe'), timeout: 60000 },
  async () => {
    const result = await simulator.run(mageSnapshot(), {
      plans: [input.plans[0], { label: 'Fireball', priority: [{ spellId: 143 }] }],
      iterations: 100,
      equipmentSets: [
        { label: 'Ring A', replacements: [{ slot: 11, itemId: 1449 }] },
        { label: 'Ring B', replacements: [{ slot: 11, itemId: 1116 }] },
      ],
    });
    assert.equal(result.status, 'available', JSON.stringify(result));
    if (result.status !== 'available') {
      return;
    }
    assert.equal(result.results.length, 6);
    for (const report of result.results) {
      const baselineDps: number = result.results[report.planIndex].dps.average;
      assert.equal(report.equipmentDeltaDps, report.dps.average - baselineDps);
      assert.equal(report.scenario.iterations, 100);
      assert.equal(report.scenario.targetLevel, 11);
    }
  },
);

test('talent-granted actions and DoT conditions are delegated to the engine', async () => {
  const fixture = classFixture('WARLOCK', 60);
  await simulator.prepare(fixture.snapshot, {
    plans: [{ label: 'Missing talent', priority: [{ spellId: 1293813 }] }],
  });
  await simulator.prepare(mageSnapshot(), {
    plans: [
      {
        label: 'Engine decides dot support',
        priority: [{ spellId: 205, dotRefreshBelowSeconds: 1 }],
      },
    ],
  });
});

import { replaceEquipment, type CatalogItem } from '../src/simulation/equipment.ts';
test('equipment policies are delegated to the engine and replacements do not inherit enchants', () => {
  const catalog = new Map<number, CatalogItem>([
    [1, { id: 1, name: 'Dagger', type: 13, weaponType: 2, handType: 2 }],
    [2, { id: 2, name: 'Staff', type: 13, weaponType: 8, handType: 4 }],
    [3, { id: 3, name: 'Off-hand', type: 13, weaponType: 5, handType: 3 }],
    [4, { id: 4, name: 'High-level ring', type: 11, reqLvl: 60 }],
    [5, { id: 5, name: 'Unique ring', type: 11, unique: true }],
    [6, { id: 6, name: 'Warrior ring', type: 11, classAllowlist: [1] }],
  ]);
  const current = [
    { slot: 16, id: 1, link: 'item:1:123:0:0:0:0:99' },
    { slot: 17, id: 3, link: 'item:3' },
  ];
  const original = structuredClone(current);
  assert.equal(
    replaceEquipment(current, [{ slot: 16, itemId: 2 }], catalog, 'MAGE', 11, 'Human').length,
    2,
  );
  const replaced = replaceEquipment(
    current,
    [
      { slot: 16, itemId: 2 },
      { slot: 17, itemId: 0 },
    ],
    catalog,
    'MAGE',
    11,
    'Human',
  );
  assert.deepEqual(replaced, [{ slot: 16, id: 2, link: 'item:2' }]);
  assert.deepEqual(current, original);
  for (const replacements of [
    [{ slot: 11, itemId: 4 }],
    [
      { slot: 11, itemId: 5 },
      { slot: 12, itemId: 5 },
    ],
    [{ slot: 11, itemId: 6 }],
  ]) {
    replaceEquipment(current, replacements, catalog, 'MAGE', 11, 'Human');
  }
});
