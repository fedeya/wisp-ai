import { z } from 'zod';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
import {
  simulationInput,
  rotationAction,
  simulationNeedsLiveState,
} from '@wisp/protocol/simulation';
import { adapters } from './adapters/index.ts';
import type { ClassMetadata } from './adapters/types.ts';
import { equipmentSlots, replaceEquipment, type CatalogItem } from './equipment.ts';
const reading = z.object({
  sections: z.object({
    character: z.object({
      status: z.literal('available'),
      data: z.object({
        name: z.string(),
        realm: z.string(),
        game: z.literal('WoW Forever'),
        level: z.number().int().min(1).max(60),
        class: z.string(),
        raceToken: z.string(),
        build: z.string().optional(),
      }),
    }),
    spells: z.object({
      status: z.literal('available'),
      data: z.object({ known: z.array(z.object({ id: z.number().int().positive() })) }),
    }),
    talents: z.object({
      status: z.literal('available'),
      data: z.object({
        selected: z.array(
          z.object({ id: z.number().int().positive(), rank: z.number().int().min(1).max(5) }),
        ),
        hasPendingChanges: z.boolean().optional(),
      }),
    }),
    gear: z.object({
      status: z.literal('available'),
      data: z.object({
        items: z.array(
          z.object({
            slot: z.number().int().min(1).max(19),
            id: z.number().int().positive(),
            link: z.string(),
          }),
        ),
      }),
    }),
  }),
});
interface Manifest {
  wandIds: number[];
  name: string;
  source: string;
  upstream: string;
  commit: string;
  sha256: string;
  patches?: { file: string; sha256: string }[];
}
const raceMap: Record<string, string> = {
  Human: 'RaceHuman',
  Gnome: 'RaceGnome',
  Troll: 'RaceTroll',
  Scourge: 'RaceUndead',
  Undead: 'RaceUndead',
  Dwarf: 'RaceDwarf',
  NightElf: 'RaceNightElf',
  Orc: 'RaceOrc',
  Tauren: 'RaceTauren',
};
export class Simulator {
  readonly root: string;
  readonly runtime: string;
  constructor(root: string, runtime = path.join(root, 'runtime')) {
    this.root = path.resolve(root);
    this.runtime = path.resolve(runtime);
  }
  async prepare(
    snapshot: unknown,
    input: z.input<typeof simulationInput>,
    replacements: { slot: number; itemId: number }[] = [],
    equipmentBase: 'current' | 'empty' = 'current',
  ) {
    const parsedOptions = simulationInput.parse(input);
    if ((snapshot === null || snapshot === undefined) && simulationNeedsLiveState(parsedOptions)) {
      throw Error('A fresh snapshot is required for the requested live character or equipment.');
    }
    const fallback = parsedOptions.character
      ? {
          sections: {
            character: {
              status: 'available',
              data: {
                name: 'Hypothetical',
                realm: '',
                game: 'WoW Forever',
                ...parsedOptions.character,
              },
            },
            spells: { status: 'available', data: { known: [] } },
            talents: { status: 'available', data: { selected: [] } },
            gear: { status: 'available', data: { items: [] } },
          },
        }
      : undefined;
    const parsed = reading.safeParse(snapshot ?? fallback);
    if (!parsed.success) {
      throw Error(
        'Fresh, complete Forever character, raceToken, talents, spells and gear readings are required. Reload the addon if needed.',
      );
    }
    const s = parsed.data.sections,
      c = { ...s.character.data, ...parsedOptions.character };
    const adapter = adapters[c.class];
    if (!adapter) {
      throw Error('No validated damage adapter for class ' + c.class + '.');
    }
    const options = {
      ...parsedOptions,
      targetDistanceYards: parsedOptions.targetDistanceYards ?? (adapter.melee ? 5 : 20),
    };
    const plan = options.plans[0];
    const hypotheticalTalents = plan.talents !== undefined || options.character !== undefined;
    const race = raceMap[c.raceToken];
    if (!race) {
      throw Error('The current race has not been validated for this simulator adapter.');
    }
    const directory = path.join(this.root, 'simulator');
    const manifest = JSON.parse(
      await readFile(path.join(directory, 'manifest.json'), 'utf8'),
    ) as Manifest;
    const metadata = (
      JSON.parse(await readFile(path.join(directory, 'classes.json'), 'utf8')) as Record<
        string,
        ClassMetadata
      >
    )[c.class];
    if (!metadata) {
      throw Error('Missing pinned metadata for class ' + c.class + '.');
    }
    const trees = metadata.talents;
    const catalog = new Map(
      (JSON.parse(await readFile(path.join(directory, 'items.json'), 'utf8')) as CatalogItem[]).map(
        (i) => [i.id, i],
      ),
    );
    const equipped = replaceEquipment(
      equipmentBase === 'empty' ? [] : s.gear.data.items,
      replacements,
      catalog,
      c.class,
      c.level,
      c.raceToken,
    );
    const talentSelection = plan.talents ?? (options.character ? [] : s.talents.data.selected);
    const selected = new Map(talentSelection.map((t) => [t.id, t.rank]));
    if (selected.size !== talentSelection.length) {
      throw Error('The talent reading contains duplicate talents.');
    }
    const mapped = new Set<number>();
    const talentsString = trees
      .map((tree) =>
        tree
          .map((t) => {
            const rank = selected.get(t.id) ?? 0;
            if (rank) {
              mapped.add(t.id);
            }
            return rank;
          })
          .join(''),
      )
      .join('-');
    if (mapped.size !== selected.size) {
      throw Error(
        'Some selected talents are missing from the pinned Forever simulator. No talent was silently omitted.',
      );
    }
    const points = [...selected.values()].reduce((a, b) => a + b, 0);
    const actions = [...plan.opener, ...plan.priority];
    const spellIds = [...new Set(actions.map((a) => a.spellId))];
    const channels = spellIds.filter((id) =>
      (adapter.channels ?? []).some((family) => metadata.ranks[family].some((r) => r.id === id)),
    );
    const compileAction = (a: z.infer<typeof rotationAction>, isPriority = false) => {
      const vals: Record<string, unknown>[] = [];
      for (const id of channels) {
        vals.push({ not: { val: { spellIsChanneling: { spellId: { spellId: id } } } } });
      }
      if (isPriority && plan.opener.length) {
        vals.push({ sequenceIsComplete: { sequenceName: 'opening' } });
      }
      if (a.spellId === 5019) {
        vals.push({ gcdIsReady: {} });
        for (const id of spellIds.filter((id) =>
          Object.values(metadata.ranks)
            .flat()
            .some((r) => r.id === id),
        )) {
          vals.push({ not: { val: { spellIsCasting: { spellId: { spellId: id } } } } });
        }
      }
      if (a.manaBelowPercent !== undefined) {
        vals.push({
          cmp: {
            op: 'OpLe',
            lhs: { currentManaPercent: {} },
            rhs: { const: { val: a.manaBelowPercent + '%' } },
          },
        });
      }
      if (a.manaAbovePercent !== undefined) {
        vals.push({
          cmp: {
            op: 'OpGe',
            lhs: { currentManaPercent: {} },
            rhs: { const: { val: a.manaAbovePercent + '%' } },
          },
        });
      }
      for (const [threshold, resource] of [
        [a.rageAbove, 'currentRage'],
        [a.energyAbove, 'currentEnergy'],
        [a.comboPointsAtLeast, 'currentComboPoints'],
      ] as const) {
        if (threshold === undefined) {
          continue;
        }
        vals.push({
          cmp: { op: 'OpGe', lhs: { [resource]: {} }, rhs: { const: { val: String(threshold) } } },
        });
      }
      if (a.dotRefreshBelowSeconds !== undefined) {
        vals.push({
          cmp: {
            op: 'OpLe',
            lhs: { dotRemainingTime: { spellId: { spellId: a.spellId } } },
            rhs: { const: { val: a.dotRefreshBelowSeconds + 's' } },
          },
        });
      }
      return {
        ...(vals.length ? { condition: vals.length === 1 ? vals[0] : { and: { vals } } } : {}),
        ...(channels.includes(a.spellId)
          ? {
              channelSpell: {
                spellId: { spellId: a.spellId },
                interruptIf: { const: { val: 'false' } },
              },
            }
          : { castSpell: { spellId: { spellId: a.spellId } } }),
      };
    };
    const priorityList: unknown[] = [];
    if (plan.opener.length) {
      priorityList.push({
        action: {
          sequence: { name: 'opening', actions: plan.opener.map((a) => compileAction(a)) },
        },
      });
    }
    priorityList.push(...plan.priority.map((a) => ({ action: compileAction(a, true) })));
    const gear = new Map(equipped.map((i) => [i.slot, i]));
    const items = equipmentSlots.map((slot) => {
      const item = gear.get(slot);
      if (!item) {
        return {};
      }
      if (!catalog.has(item.id)) {
        throw Error('Equipped item ' + item.id + ' is absent from the pinned simulator database.');
      }
      const fields = item.link.match(/item:([^|]+)/)?.[1].split(':');
      if (!fields || Number(fields[0]) !== item.id) {
        throw Error('Equipped item link does not match its ID.');
      }
      return { id: item.id, enchant: Number(fields[1] || 0), randomSuffix: Number(fields[6] || 0) };
    });
    const targetLevel = c.level + options.targetLevelOffset;
    const request = {
      raid: {
        parties: [
          {
            players: [
              {
                name: c.name,
                race,
                class: adapter.engineClass,
                level: c.level,
                equipment: { items },
                talentsString,
                [adapter.spec]: { options: { classOptions: adapter.options ?? {} } },
                distanceFromTarget: options.targetDistanceYards,
                rotation: {
                  type: 'TypeAPL',
                  priorityList,
                },
              },
            ],
          },
        ],
      },
      encounter: {
        duration: options.durationSeconds,
        targets: [{ level: targetLevel, mobType: 'MobTypeHumanoid' }],
      },
      simOptions: { iterations: options.iterations, randomSeed: 12345 },
    };
    return {
      request,
      manifest,
      metadata,
      adapter,
      character: {
        name: c.name,
        realm: c.realm,
        class: c.class,
        level: c.level,
        raceToken: c.raceToken,
        build: c.build,
        source: options.character ? 'hypothetical' : 'live',
      },
      scenario: {
        ...options,
        targetLevel,
        spellIds,
        plan,
        talentPoints: points,
        talentSource: hypotheticalTalents ? 'hypothetical' : 'live',
        talents: talentSelection,
        equippedItems: items.filter((i) => 'id' in i).length,
        equipment: equipped.map((i) => ({ slot: i.slot, id: i.id })),
        replacements,
        equipmentBase,
      },
    };
  }
  async run(snapshot: unknown, input: z.input<typeof simulationInput>, signal?: AbortSignal) {
    const options = simulationInput.safeParse(input);
    if (!options.success) {
      return {
        status: 'unavailable' as const,
        version: 'forever',
        error: 'Invalid simulation plans or scenario. No DPS was calculated.',
      };
    }
    if (options.data.nativeRequest) {
      try {
        const { result, manifest } = await this.executeRequest(options.data.nativeRequest, signal);
        return {
          status: 'native' as const,
          engine: manifest,
          request: options.data.nativeRequest,
          result,
        };
      } catch (error) {
        return {
          status: 'unavailable' as const,
          error: error instanceof Error ? error.message : 'Native simulation failed.',
        };
      }
    }
    if (options.data.catalogOnly) {
      const parsed = reading.safeParse(snapshot);
      const token =
        options.data.character?.class ??
        (parsed.success ? parsed.data.sections.character.data.class : undefined);
      const catalog = JSON.parse(
        await readFile(path.join(this.root, 'simulator', 'classes.json'), 'utf8'),
      ) as Record<string, ClassMetadata>;
      if (!token || !catalog[token]) {
        return {
          status: 'unavailable' as const,
          error: 'Choose a supported class to inspect its simulation catalog.',
        };
      }
      return {
        status: 'catalog' as const,
        class: token,
        metadata: catalog[token],
        supportedFamilies: adapters[token].families,
        requiredTalents: adapters[token].requiredTalents ?? {},
      };
    }
    const results: Extract<Awaited<ReturnType<Simulator['runSingle']>>, { status: 'available' }>[] =
      [];
    const deadline = Date.now() + 40000;
    const budget = AbortSignal.timeout(45000);
    const runSignal = signal ? AbortSignal.any([signal, budget]) : budget;
    const sets = [
      ...(options.data.includeCurrentEquipment
        ? [
            {
              label: 'Current equipment',
              base: 'current' as const,
              replacements: [] as { slot: number; itemId: number }[],
            },
          ]
        : []),
      ...options.data.equipmentSets,
    ];
    const totalScenarios = sets.length * options.data.plans.length;
    let next = options.data.startIndex;
    const indices: number[] = [];
    const failures: { index: number; error: string }[] = [];
    while (next < totalScenarios && !runSignal.aborted) {
      if (Date.now() >= deadline) {
        break;
      }
      const set = sets[Math.floor(next / options.data.plans.length)];
      const plan = options.data.plans[next % options.data.plans.length];
      const result = await this.runSingle(
        snapshot,
        { ...options.data, plans: [plan] },
        runSignal,
        set.replacements,
        set.base,
      );
      if (runSignal.aborted) {
        break;
      }
      if (result.status === 'available') {
        results.push(result);
        indices.push(next);
      } else {
        failures.push({ index: next, error: result.error });
      }
      next++;
    }
    if (!results.length) {
      return {
        status: 'unavailable' as const,
        error: failures[0]?.error ?? 'Simulation time budget reached.',
        failures,
        nextIndex: next < totalScenarios ? next : null,
        totalScenarios,
      };
    }
    return {
      status: 'available' as const,
      version: 'forever',
      character: results[0].character,
      engine: results[0].engine,
      coverage: {
        class: results[0].character.class,
        families: adapters[results[0].character.class].families,
        roles: ['damage'],
        pets: false,
      },
      nextIndex: next < totalScenarios ? next : null,
      totalScenarios,
      failures,
      results: results.map((r, i) => {
        const index = indices[i];
        const planIndex = index % options.data.plans.length;
        const setIndex = Math.floor(index / options.data.plans.length);
        const baseline = results[indices.indexOf(planIndex)];
        const first = results[indices.indexOf(0)];
        return {
          ...r,
          label: options.data.plans[planIndex].label,
          equipmentLabel: sets[setIndex].label,
          planIndex,
          equipmentSetIndex: setIndex,
          relativeToFirstPercent:
            first && first.dps.average > 0 ? (r.dps.average / first.dps.average - 1) * 100 : null,
          equipmentDeltaDps:
            options.data.includeCurrentEquipment && baseline
              ? r.dps.average - baseline.dps.average
              : null,
          equipmentDeltaPercent:
            options.data.includeCurrentEquipment && baseline && baseline.dps.average > 0
              ? (r.dps.average / baseline.dps.average - 1) * 100
              : null,
        };
      }),
      note: 'All results use one character snapshot, duration, target, iterations and seed. nextIndex is the continuation cursor; repeat the identical request with startIndex set to it until null. Failures are reported per scenario without discarding completed results. Percentage deltas are null for zero or absent baselines. Equipment deltas compare the SAME plan against current equipment and are null when current equipment is excluded; relativeToFirstPercent compares to the first result. Sets based on empty inherit no live equipment. Items need not be owned. Small differences require attention to sampling variation. Replacements are unenchanted base catalog items, with no random suffix. These comparisons do not prove a globally optimal rotation or build.',
    };
  }
  private async executeRequest(request: Record<string, unknown>, signal?: AbortSignal) {
    const directory = path.join(this.root, 'simulator');
    const manifest = JSON.parse(
      await readFile(path.join(directory, 'manifest.json'), 'utf8'),
    ) as Manifest;
    const executable = path.join(directory, 'wowsimcli.exe');
    if (
      createHash('sha256')
        .update(await readFile(executable))
        .digest('hex') !== manifest.sha256
    ) {
      throw Error('Simulator binary does not match the pinned manifest.');
    }
    await mkdir(this.runtime, { recursive: true });
    const temporary = await mkdtemp(path.join(this.runtime, 'simulation-'));
    try {
      const infile = path.join(temporary, 'input.json'),
        outfile = path.join(temporary, 'output.json');
      await writeFile(infile, JSON.stringify(request));
      await execute(executable, ['sim', '--infile', infile, '--outfile', outfile], {
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
        signal,
      });
      const result = JSON.parse(await readFile(outfile, 'utf8'));
      if (result.error) {
        throw Error(result.error.message || 'Simulator rejected the native request.');
      }
      if (!Number.isInteger(result.iterationsDone) || result.iterationsDone <= 0) {
        throw Error('Simulator did not complete a valid iteration count.');
      }
      return { result, manifest };
    } finally {
      if (temporary.startsWith(this.runtime + path.sep)) {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
  private async runSingle(
    snapshot: unknown,
    input: z.input<typeof simulationInput>,
    signal?: AbortSignal,
    replacements: { slot: number; itemId: number }[] = [],
    equipmentBase: 'current' | 'empty' = 'current',
  ) {
    let temporary: string | undefined;
    try {
      const prepared = await this.prepare(snapshot, input, replacements, equipmentBase);
      const executable = path.join(this.root, 'simulator', 'wowsimcli.exe');
      const hash = createHash('sha256')
        .update(await readFile(executable))
        .digest('hex');
      if (hash !== prepared.manifest.sha256) {
        throw Error('Simulator binary does not match the pinned manifest.');
      }
      await mkdir(this.runtime, { recursive: true });
      temporary = await mkdtemp(path.join(this.runtime, 'simulation-'));
      const infile = path.join(temporary, 'input.json'),
        outfile = path.join(temporary, 'output.json');
      await writeFile(infile, JSON.stringify(prepared.request));
      await execute(executable, ['sim', '--infile', infile, '--outfile', outfile], {
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
        signal,
      });
      const result = JSON.parse(await readFile(outfile, 'utf8'));
      if (result.error) {
        throw Error(result.error.message || 'Simulator rejected this character.');
      }
      const player = result.raidMetrics?.parties?.[0]?.players?.[0];
      const dps = { avg: 0, stdev: 0, min: 0, max: 0, ...player?.dps };
      if (
        !player ||
        !Number.isFinite(dps.avg) ||
        dps.avg < 0 ||
        result.iterationsDone !== prepared.scenario.iterations
      ) {
        throw Error('Simulator did not finish with a valid nonnegative DPS result.');
      }
      const damage = new Map<
        string,
        { spellId?: number; otherId?: string | number; damagePerFight: number }
      >();
      const casts = new Map<number, number>();
      for (const action of player.actions ?? []) {
        const rawSpellId = action.id?.spellId;
        const spellId = prepared.metadata.triggerParents[rawSpellId] ?? rawSpellId;
        const otherId = action.id?.otherId;
        const key = spellId ? 'spell:' + spellId : 'other:' + otherId;
        const damagePerFight =
          (action.targets ?? []).reduce((sum: number, t: any) => sum + (t.damage ?? 0), 0) /
          result.iterationsDone;
        const castCount =
          (action.targets ?? []).reduce((sum: number, t: any) => sum + (t.casts ?? 0), 0) /
          result.iterationsDone;
        if (rawSpellId && prepared.scenario.spellIds.includes(rawSpellId)) {
          casts.set(rawSpellId, (casts.get(rawSpellId) ?? 0) + castCount);
        }
        if (damagePerFight > 0) {
          damage.set(key, {
            spellId,
            otherId,
            damagePerFight: (damage.get(key)?.damagePerFight ?? 0) + damagePerFight,
          });
        }
      }
      const damageBySpell = [...damage.values()];
      return {
        status: 'available' as const,
        version: 'forever',
        engine: {
          name: prepared.manifest.name,
          source: prepared.manifest.source,
          upstream: prepared.manifest.upstream,
          commit: prepared.manifest.commit,
          patches: prepared.manifest.patches ?? [],
        },
        character: prepared.character,
        scenario: prepared.scenario,
        dps: {
          average: dps.avg,
          standardDeviation: dps.stdev,
          standardError: dps.stdev / Math.sqrt(result.iterationsDone),
          min: dps.min,
          max: dps.max,
        },
        damageBySpell,
        castsBySpell: [...casts].map(([spellId, castsPerFight]) => ({ spellId, castsPerFight })),
        secondsOutOfMana: player.secondsOomAvg,
        unusedSpellIds: prepared.scenario.spellIds.filter(
          (id) => !(casts.get(id) || damageBySpell.some((a) => a.spellId === id)),
        ),
        zeroDamageSpellIds: prepared.scenario.spellIds.filter(
          (id) => !damageBySpell.some((a) => a.spellId === id),
        ),
        assumptions: [
          'Experimental WoWSims Forever levelsim fork; ' +
            prepared.adapter.token +
            ' damage adapter.',
          'Stationary single target, fixed duration and seed. Opening sequence runs once, then actions follow priority, mana conditions, cooldowns and engine cast/channel timing.',
          'Character and talents may be live or hypothetical, as reported by character.source and talentSource. Equipment starts from the live snapshot or empty, as reported by equipmentBase, then applies explicit catalog replacements without ownership requirements. No external buffs, consumables or temporary enchants. Orc Blood Fury requires an explicit action.',
          'The engine assumes trained weapon types and level-appropriate weapon skills; current weapon training/skill is not read. Zero-damage actions may be utility cooldowns or may never be reached under the selected priorities.',
          'No incoming attacks, movement, kiting or player latency. This is a scenario estimate, not measured combat DPS.',
          ...prepared.adapter.assumptions,
        ],
      };
    } catch (error) {
      return {
        status: 'unavailable' as const,
        version: 'forever',
        error: error instanceof Error ? error.message : 'Simulation failed',
        note: 'No valid DPS result. Do not invent a number or substitute a level-60 preset.',
      };
    } finally {
      if (temporary && temporary.startsWith(this.runtime + path.sep)) {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
}
