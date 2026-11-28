// @effect-migrated
import { Clock, Context, Effect, Option, Ref, Schedule, Schema, Semaphore, Stream } from 'effect';
import { errorMessage } from '../errors.ts';
import { CapabilitySettings } from './settings.ts';
import type { Availability } from './settings.ts';

/** How long a report counts after it arrived. */
const REPORT_TTL_MS = 180_000;
/** How often the health check looks for a report that stopped counting. */
const HEALTH_CHECK_INTERVAL = '30 seconds';

const shortText = Schema.String.check(Schema.isMaxLength(80));
const missingIsFalse = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)));

const AddonStatus = Schema.Literals(['ready', 'partial', 'waiting', 'missing', 'incompatible']);
type AddonStatus = typeof AddonStatus.Type;

const AddonReport = Schema.Struct({ status: AddonStatus, version: Schema.optional(shortText) });

/** What the addon reports about the game and the addons Wisp reads. */
const IntegrationReport = Schema.Struct({
  syndicator: Schema.optional(AddonReport),
  auctionator: Schema.optional(AddonReport),
  polestar: Schema.optional(Schema.Struct({ ...AddonReport.fields, guides: missingIsFalse })),
  version: shortText,
  questie: Schema.Struct({
    status: Schema.Literals(['ready', 'partial', 'missing', 'incompatible']),
    version: Schema.optional(shortText),
    npcs: missingIsFalse,
    quests: missingIsFalse,
    objects: missingIsFalse,
    trainers: Schema.Boolean,
    services: Schema.Boolean,
  }),
});
export type IntegrationReport = typeof IntegrationReport.Type;

const decodeReport = Schema.decodeUnknownOption(IntegrationReport);

// Why an addon that reported this status cannot be used.
const addonStatusReasons: Partial<Record<AddonStatus, string>> = {
  missing: 'The addon is not loaded.',
  incompatible: 'This addon version is not supported.',
  waiting: 'The addon has not finished initializing.',
};
// What to keep in mind about each usable addon's data.
const availableReasons: Record<
  'syndicator' | 'auctionator' | 'polestar',
  Partial<Record<AddonStatus, string>>
> = {
  syndicator: {
    ready: 'Saved inventory may be out of date.',
    partial: 'Saved inventory may be out of date.',
  },
  auctionator: {
    ready: 'Prices reflect the last scan. Their age is shown when available.',
    partial: 'Prices reflect the last scan. Their age is shown when available.',
  },
  polestar: {
    partial: 'Only the guide and step number are available in this Polestar version.',
  },
};

function guideToolReason(status: AddonStatus | undefined) {
  if (!status) {
    return 'Waiting for WoW.';
  }
  return status === 'missing'
    ? 'Install or enable Polestar.'
    : 'Your installed Polestar does not offer its guide API.';
}

const usable = (status: AddonStatus) => status === 'ready' || status === 'partial';

/** What the game and its addons make available, from a report that still counts. */
function integrationAvailability(
  live: Option.Option<IntegrationReport>,
): Record<string, Availability> {
  const report = Option.getOrUndefined(live);
  const entries: Record<string, Availability> = {
    'core:wow': {
      available: report !== undefined,
      status: report ? 'ready' : 'waiting',
      version: report?.version,
      reason: report ? 'Connected to the game.' : 'Open WoW and load Wisp to connect.',
    },
  };
  const q = report?.questie;
  entries['integration:questie'] = {
    available: !!q && usable(q.status),
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
  };
  for (const [id, feature] of [
    ['find_npc_locations', 'npcs'],
    ['get_quest', 'quests'],
    ['get_quest_chain', 'quests'],
    ['find_object_locations', 'objects'],
  ] as const) {
    const available = !!q && usable(q.status) && q[feature];
    entries['tool:' + id] = {
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
    };
  }
  for (const id of ['syndicator', 'auctionator', 'polestar'] as const) {
    const addon = report?.[id];
    entries['integration:' + id] = {
      available: !!addon && usable(addon.status),
      status: addon?.status || 'waiting',
      version: addon?.version,
      reason: !addon
        ? 'Open WoW and reload Wisp to check this addon.'
        : (addonStatusReasons[addon.status] ?? availableReasons[id][addon.status]),
    };
  }
  const polestar = report?.polestar;
  const guides = !!polestar && usable(polestar.status) && polestar.guides;
  entries['tool:create_guide'] = {
    available: guides,
    status: !polestar ? 'waiting' : guides ? 'ready' : 'unavailable',
    reason: guides ? undefined : guideToolReason(polestar?.status),
  };
  return entries;
}

/**
 * The game's integrations as the addon last reported them, kept in
 * `CapabilitySettings` as what can be used right now.
 */
export class IntegrationState extends Context.Service<
  IntegrationState,
  {
    /** The addon's last report since the game last disconnected, even one that stopped counting. */
    readonly report: Effect.Effect<Option.Option<IntegrationReport>>;
    /** Records a report from the addon; one that does not decode is ignored and returns false. */
    readonly receive: (report: unknown) => Effect.Effect<boolean>;
    /** Forgets the report, as when the game disconnects. */
    readonly reset: Effect.Effect<void>;
    /** Updates what can be used; a report counts for three minutes after it arrived. */
    readonly refresh: Effect.Effect<void>;
    /**
     * The health check: every 30 seconds from when the stream starts, a
     * refresh, and when that changed the capabilities (a report stopped
     * counting) a publish, after which it emits. A failed publish is logged.
     * Each run of the stream checks on its own, so the bridge runs it once.
     */
    readonly healthChecks: Stream.Stream<void>;
  }
>()('@wisp/server/capabilities/IntegrationState') {}

interface Received {
  readonly report: Option.Option<IntegrationReport>;
  /** When the report arrived, in milliseconds. */
  readonly at: number;
}

/** The integration state of the capabilities in `CapabilitySettings`, refreshed once here. */
export const make = Effect.fn('IntegrationState.make')(function* () {
  const capabilities = yield* CapabilitySettings;
  const received = yield* Ref.make<Received>({ report: Option.none(), at: 0 });
  // Reading the report and recording what it makes available happen together.
  const lock = yield* Semaphore.make(1);

  const update = Effect.gen(function* () {
    const { report, at } = yield* Ref.get(received);
    const now = yield* Clock.currentTimeMillis;
    const live = Option.filter(report, () => now - at < REPORT_TTL_MS);
    yield* capabilities.setAvailability(integrationAvailability(live));
  });

  const refresh = lock.withPermit(update).pipe(Effect.withSpan('IntegrationState.refresh'));

  const receive = Effect.fn('IntegrationState.receive')(function* (value: unknown) {
    const report = decodeReport(value);
    if (Option.isNone(report)) {
      return false;
    }
    const at = yield* Clock.currentTimeMillis;
    yield* lock.withPermit(Effect.andThen(Ref.set(received, { report, at }), update));
    return true;
  });

  const reset = lock
    .withPermit(Effect.andThen(Ref.set(received, { report: Option.none(), at: 0 }), update))
    .pipe(Effect.withSpan('IntegrationState.reset'));

  // Whether refreshing changed what the capabilities look like.
  const check = lock.withPermit(
    Effect.gen(function* () {
      const before = JSON.stringify(yield* capabilities.snapshot);
      yield* update;
      return JSON.stringify(yield* capabilities.snapshot) !== before;
    }),
  );

  yield* update;

  return IntegrationState.of({
    report: Effect.map(Ref.get(received), ({ report }) => report),
    receive,
    reset,
    refresh,
    healthChecks: Stream.fromSchedule(Schedule.fixed(HEALTH_CHECK_INTERVAL)).pipe(
      Stream.mapEffect(() => check),
      Stream.filter(Boolean),
      Stream.mapEffect(() =>
        capabilities.publish.pipe(
          Effect.catch((error) =>
            Effect.logWarning('Integration update failed').pipe(
              Effect.annotateLogs({
                event: 'integration.update_failed',
                error: errorMessage(error),
              }),
            ),
          ),
        ),
      ),
    ),
  });
});
