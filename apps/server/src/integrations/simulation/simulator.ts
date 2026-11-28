// @effect-migrated allow=jsonParse,typescript/consistent-type-assertions,typescript/no-explicit-any,typescript/no-unsafe-argument,typescript/no-unsafe-assignment,typescript/no-unsafe-call,typescript/no-unsafe-member-access,typescript/no-unsafe-return: the simulator's JSON files are read with JSON.parse until #333 decodes them with Schema
import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from 'effect';
import { Digest } from 'effect/crypto';
import type { PlatformError } from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { simulationInput, simulationNeedsLiveState } from '@wisp/agent/contract/simulation';
import type { RotationAction, SimulationInput } from '@wisp/agent/contract/simulation';
import { AppConfig } from '../../app-config.ts';
import { adapters } from './adapters/index.ts';
import type { ClassMetadata } from './adapters/types.ts';
import { equipmentSlots, replaceEquipment, type CatalogItem } from './equipment.ts';
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const intBetween = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
/** The snapshot sections a simulation needs: a fresh, complete Forever character reading. */
const Reading = Schema.Struct({
  sections: Schema.Struct({
    character: Schema.Struct({
      status: Schema.Literal('available'),
      data: Schema.Struct({
        name: Schema.String,
        realm: Schema.String,
        game: Schema.Literal('WoW Forever'),
        level: intBetween(1, 60),
        class: Schema.String,
        raceToken: Schema.String,
        build: Schema.optional(Schema.String),
      }),
    }),
    spells: Schema.Struct({
      status: Schema.Literal('available'),
      data: Schema.Struct({ known: Schema.Array(Schema.Struct({ id: positiveInt })) }),
    }),
    talents: Schema.Struct({
      status: Schema.Literal('available'),
      data: Schema.Struct({
        selected: Schema.Array(Schema.Struct({ id: positiveInt, rank: intBetween(1, 5) })),
        hasPendingChanges: Schema.optional(Schema.Boolean),
      }),
    }),
    gear: Schema.Struct({
      status: Schema.Literal('available'),
      data: Schema.Struct({
        items: Schema.Array(
          Schema.Struct({ slot: intBetween(1, 19), id: positiveInt, link: Schema.String }),
        ),
      }),
    }),
  }),
});
const decodeReading = Schema.decodeUnknownOption(Reading);
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

type EquipmentBase = 'current' | 'empty';
type Replacement = { slot: number; itemId: number };

/** A simulation step that failed. The agent shows `message` to the model as it is. */
export class SimulationError extends Schema.TaggedError<SimulationError>()('SimulationError', {
  message: Schema.String,
}) {}

const failure = (message: string) => new SimulationError({ message });
/** The message Node gave the failed file or process call, as `fs` and `execFile` reported it. */
const platformFailure = (error: PlatformError) =>
  failure(error.reason.cause instanceof Error ? error.reason.cause.message : error.message);
/** Runs a throwing plain helper (contract parsing, `JSON.parse`, equipment rules). */
const attempt = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) => failure(cause instanceof Error ? cause.message : 'Simulation failed'),
  });

/** The time one CLI run may take, and the budget of a whole structured request. */
const timeLimit = '45 seconds';
/** No new scenario starts after this, so the last one can finish inside the budget. */
const scenarioDeadlineMillis = 40000;
/** The most output one CLI stream may write, as `execFile`'s `maxBuffer` allowed. */
const maxBuffer = 1024 * 1024;

const make = Effect.gen(function* () {
  const { paths } = yield* AppConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const digest = yield* Digest.Digest;
  const directory = path.resolve(paths.root, 'simulator');
  const executable = path.resolve(paths.simulatorExecutable);
  const runtime = path.resolve(paths.runtime);

  const readJson = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.mapError(platformFailure),
      Effect.flatMap((text) => attempt(() => JSON.parse(text))),
    );

  const verifyExecutable = Effect.fnUntraced(function* (manifest: Manifest) {
    const binary = yield* fs.readFile(executable).pipe(Effect.mapError(platformFailure));
    if ((yield* digest.digestHex(Digest.sha256, binary)) !== manifest.sha256) {
      return yield* failure('Simulator binary does not match the pinned manifest.');
    }
  });

  /** Drains one output stream of the CLI, failing like `execFile` once it passes `maxBuffer`. */
  const drain = (
    stream: Stream.Stream<Uint8Array, PlatformError>,
    name: 'stdout' | 'stderr',
    chunks: Uint8Array[],
  ) =>
    stream.pipe(
      Stream.mapError(platformFailure),
      Stream.runForEach((chunk) => {
        chunks.push(chunk);
        return chunks.reduce((size, c) => size + c.length, 0) > maxBuffer
          ? Effect.fail(failure(name + ' maxBuffer length exceeded'))
          : Effect.void;
      }),
    );

  /**
   * Runs the CLI with `args`. A nonzero exit, a signal or the time limit fail
   * with the message `execFile` gave them: the command line and its stderr.
   */
  const execute = (args: string[]) => {
    const stderr: Uint8Array[] = [];
    const commandFailed = () =>
      failure(
        'Command failed: ' +
          [executable, ...args].join(' ') +
          '\n' +
          new TextDecoder().decode(Buffer.concat(stderr)),
      );
    return Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(ChildProcess.make(executable, args, { windowsHide: true }))
        .pipe(Effect.mapError(platformFailure));
      const [exitCode] = yield* Effect.all(
        [
          handle.exitCode.pipe(Effect.mapError(commandFailed)),
          drain(handle.stdout, 'stdout', []),
          drain(handle.stderr, 'stderr', stderr),
        ],
        { concurrency: 'unbounded' },
      );
      if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* commandFailed();
      }
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({ duration: timeLimit, orElse: () => Effect.fail(commandFailed()) }),
    );
  };

  /** Writes `request` to a scoped temporary folder, runs the CLI on it and reads its output. */
  const simulate = Effect.fnUntraced(function* (request: unknown) {
    yield* fs.makeDirectory(runtime, { recursive: true }).pipe(Effect.mapError(platformFailure));
    const temporary = yield* fs
      .makeTempDirectoryScoped({ directory: runtime, prefix: 'simulation-' })
      .pipe(Effect.mapError(platformFailure));
    const infile = path.join(temporary, 'input.json'),
      outfile = path.join(temporary, 'output.json');
    yield* fs
      .writeFileString(infile, JSON.stringify(request))
      .pipe(Effect.mapError(platformFailure));
    yield* execute(['sim', '--infile', infile, '--outfile', outfile]);
    return yield* readJson(outfile);
  }, Effect.scoped);

  const prepare = Effect.fn('Simulator.prepare')(function* (
    snapshot: unknown,
    input: SimulationInput,
    replacements: Replacement[] = [],
    equipmentBase: EquipmentBase = 'current',
  ) {
    const parsedOptions = yield* attempt(() => simulationInput.parse(input));
    if ((snapshot === null || snapshot === undefined) && simulationNeedsLiveState(parsedOptions)) {
      return yield* failure(
        'A fresh snapshot is required for the requested live character or equipment.',
      );
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
    const parsed = decodeReading(snapshot ?? fallback);
    if (Option.isNone(parsed)) {
      return yield* failure(
        'Fresh, complete Forever character, raceToken, talents, spells and gear readings are required. Reload the addon if needed.',
      );
    }
    const s = parsed.value.sections,
      c = { ...s.character.data, ...parsedOptions.character };
    const adapter = adapters[c.class];
    if (!adapter) {
      return yield* failure('No validated damage adapter for class ' + c.class + '.');
    }
    const options = {
      ...parsedOptions,
      targetDistanceYards: parsedOptions.targetDistanceYards ?? (adapter.melee ? 5 : 20),
    };
    const plan = options.plans[0];
    const hypotheticalTalents = plan.talents !== undefined || options.character !== undefined;
    const race = raceMap[c.raceToken];
    if (!race) {
      return yield* failure('The current race has not been validated for this simulator adapter.');
    }
    const manifest: Manifest = yield* readJson(path.join(directory, 'manifest.json'));
    const classes: Record<string, ClassMetadata> = yield* readJson(
      path.join(directory, 'classes.json'),
    );
    const metadata = classes[c.class];
    if (!metadata) {
      return yield* failure('Missing pinned metadata for class ' + c.class + '.');
    }
    const trees = metadata.talents;
    const catalogItems: CatalogItem[] = yield* readJson(path.join(directory, 'items.json'));
    const catalog = new Map(catalogItems.map((i) => [i.id, i]));
    const equipped = yield* attempt(() =>
      replaceEquipment(
        equipmentBase === 'empty' ? [] : s.gear.data.items,
        replacements,
        catalog,
        c.class,
        c.level,
        c.raceToken,
      ),
    );
    const talentSelection = plan.talents ?? (options.character ? [] : s.talents.data.selected);
    const selected = new Map(talentSelection.map((t) => [t.id, t.rank]));
    if (selected.size !== talentSelection.length) {
      return yield* failure('The talent reading contains duplicate talents.');
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
      return yield* failure(
        'Some selected talents are missing from the pinned Forever simulator. No talent was silently omitted.',
      );
    }
    const points = [...selected.values()].reduce((a, b) => a + b, 0);
    const actions = [...plan.opener, ...plan.priority];
    const spellIds = [...new Set(actions.map((a) => a.spellId))];
    const channels = spellIds.filter((id) =>
      (adapter.channels ?? []).some((family) => metadata.ranks[family].some((r) => r.id === id)),
    );
    const compileAction = (a: RotationAction, isPriority = false) => {
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
    const items: ({ id: number; enchant: number; randomSuffix: number } | Record<never, never>)[] =
      [];
    for (const slot of equipmentSlots) {
      const item = gear.get(slot);
      if (!item) {
        items.push({});
        continue;
      }
      if (!catalog.has(item.id)) {
        return yield* failure(
          'Equipped item ' + item.id + ' is absent from the pinned simulator database.',
        );
      }
      const fields = item.link.match(/item:([^|]+)/)?.[1].split(':');
      if (!fields || Number(fields[0]) !== item.id) {
        return yield* failure('Equipped item link does not match its ID.');
      }
      items.push({
        id: item.id,
        enchant: Number(fields[1] || 0),
        randomSuffix: Number(fields[6] || 0),
      });
    }
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
  });

  /** Runs an engine request the agent wrote itself. */
  const executeRequest = Effect.fnUntraced(function* (request: Record<string, unknown>) {
    const manifest: Manifest = yield* readJson(path.join(directory, 'manifest.json'));
    yield* verifyExecutable(manifest);
    const result = yield* simulate(request);
    if (result.error) {
      return yield* failure(result.error.message || 'Simulator rejected the native request.');
    }
    if (!Number.isInteger(result.iterationsDone) || result.iterationsDone <= 0) {
      return yield* failure('Simulator did not complete a valid iteration count.');
    }
    return { result, manifest };
  });

  /** Simulates one plan on one equipment set. */
  const simulateScenario = Effect.fnUntraced(function* (
    snapshot: unknown,
    input: SimulationInput,
    replacements: Replacement[],
    equipmentBase: EquipmentBase,
  ) {
    const prepared = yield* prepare(snapshot, input, replacements, equipmentBase);
    yield* verifyExecutable(prepared.manifest);
    const result = yield* simulate(prepared.request);
    if (result.error) {
      return yield* failure(result.error.message || 'Simulator rejected this character.');
    }
    const player = result.raidMetrics?.parties?.[0]?.players?.[0];
    const dps = { avg: 0, stdev: 0, min: 0, max: 0, ...player?.dps };
    if (
      !player ||
      !Number.isFinite(dps.avg) ||
      dps.avg < 0 ||
      result.iterationsDone !== prepared.scenario.iterations
    ) {
      return yield* failure('Simulator did not finish with a valid nonnegative DPS result.');
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
  });

  /** A scenario's result, or why it produced none. */
  const runSingle = (
    snapshot: unknown,
    input: SimulationInput,
    replacements: Replacement[],
    equipmentBase: EquipmentBase,
  ) =>
    simulateScenario(snapshot, input, replacements, equipmentBase).pipe(
      Effect.catchTag('SimulationError', (error) =>
        Effect.succeed({
          status: 'unavailable' as const,
          version: 'forever',
          error: error.message,
          note: 'No valid DPS result. Do not invent a number or substitute a level-60 preset.',
        }),
      ),
    );
  type ScenarioResult = Extract<
    Effect.Success<ReturnType<typeof runSingle>>,
    { status: 'available' }
  >;

  /**
   * Runs a simulation request: an engine request the agent wrote, the catalog
   * of a class, or every plan on every equipment set within the time budget.
   * Interrupting it stops the CLI and removes its temporary files.
   */
  const run = Effect.fn('Simulator.run')(function* (snapshot: unknown, input: SimulationInput) {
    const options = simulationInput.safeParse(input);
    if (!options.success) {
      return {
        status: 'unavailable' as const,
        version: 'forever',
        error: 'Invalid simulation plans or scenario. No DPS was calculated.',
      };
    }
    const nativeRequest = options.data.nativeRequest;
    if (nativeRequest) {
      return yield* executeRequest(nativeRequest).pipe(
        Effect.map(({ result, manifest }) => ({
          status: 'native' as const,
          engine: manifest,
          request: nativeRequest,
          result,
        })),
        Effect.catchTag('SimulationError', (error) =>
          Effect.succeed({ status: 'unavailable' as const, error: error.message }),
        ),
      );
    }
    if (options.data.catalogOnly) {
      const token =
        options.data.character?.class ??
        Option.getOrUndefined(
          Option.map(decodeReading(snapshot), (r) => r.sections.character.data.class),
        );
      const catalog: Record<string, ClassMetadata> = yield* readJson(
        path.join(directory, 'classes.json'),
      );
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
    const results: ScenarioResult[] = [];
    const deadline = (yield* Clock.currentTimeMillis) + scenarioDeadlineMillis;
    const sets = [
      ...(options.data.includeCurrentEquipment
        ? [
            {
              label: 'Current equipment',
              base: 'current' as const,
              replacements: [] as Replacement[],
            },
          ]
        : []),
      ...options.data.equipmentSets,
    ];
    const totalScenarios = sets.length * options.data.plans.length;
    let next = options.data.startIndex;
    const indices: number[] = [];
    const failures: { index: number; error: string }[] = [];
    // The budget interrupts the scenario in progress; the completed ones are kept.
    yield* Effect.gen(function* () {
      while (next < totalScenarios) {
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          break;
        }
        const set = sets[Math.floor(next / options.data.plans.length)];
        const plan = options.data.plans[next % options.data.plans.length];
        const result = yield* runSingle(
          snapshot,
          { ...options.data, plans: [plan] },
          set.replacements,
          set.base,
        );
        if (result.status === 'available') {
          results.push(result);
          indices.push(next);
        } else {
          failures.push({ index: next, error: result.error });
        }
        next++;
      }
    }).pipe(Effect.timeoutOption(timeLimit));
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
  });

  /** Whether the pinned CLI is installed. */
  const available = fs.exists(executable).pipe(Effect.orElseSucceed(() => false));

  return { prepare, run, available };
});

/** The pinned WoWSims Forever CLI: prepares engine requests and runs them. */
export class Simulator extends Context.Service<Simulator>()('@wisp/server/Simulator', {
  make,
}) {}

/** Requires `AppConfig`, a `ChildProcessSpawner`, `FileSystem`, `Path` and `Digest`. */
export const layer = Layer.effect(Simulator, make);
