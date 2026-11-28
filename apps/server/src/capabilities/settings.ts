// @effect-migrated
import { Context, Effect, Predicate, Ref, Schema, Semaphore } from 'effect';
import type { FileSystem, Path } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import type { SecureRandom } from 'effect/crypto';
import type { Capability, CapabilityView } from '@wisp/protocol/capabilities';
import { Features } from '#/features';
import type { FeatureValues } from '#/features';
import * as JsonFile from '#/platform/json-file';

/** Whether a capability can be used right now, and why not. It is never saved. */
export type Availability = Pick<CapabilityView, 'available' | 'status' | 'reason' | 'version'>;

/** `capabilities.json`: the player's switches, by capability id. */
const SavedSwitches = Schema.Struct({ enabled: Schema.Record(Schema.String, Schema.Boolean) });

/** The file the agent reads: each capability's effective state and the resolved feature flags. */
const AgentCapabilities = Schema.Struct({
  enabled: Schema.Record(Schema.String, Schema.Boolean),
  features: Schema.Record(Schema.String, Schema.Boolean),
});

/** The player tried to switch a capability that is not in the catalog, is core or is hidden. */
export class UnknownCapability extends Schema.TaggedError<UnknownCapability>()(
  'UnknownCapability',
  { id: Schema.String, message: Schema.String },
) {}

/**
 * A capability file could not be read, decoded or written; a file that does
 * not decode is left as it was. The message is the one the file system gave.
 */
export class CapabilityFileError extends Schema.TaggedError<CapabilityFileError>()(
  'CapabilityFileError',
  { file: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

/** Like Node's own message for the failed call, which is what the player saw before. */
const failureMessage = (error: PlatformError | Schema.SchemaError) =>
  error._tag === 'PlatformError' && Predicate.isError(error.cause)
    ? error.cause.message
    : error.message;

const fileError = (file: string) => (error: PlatformError | Schema.SchemaError) =>
  new CapabilityFileError({ file, message: failureMessage(error), cause: error });

/**
 * The capability catalog with the player's switches, what can be used right
 * now and the feature flags that hide flagged tools.
 */
export class CapabilitySettings extends Context.Service<
  CapabilitySettings,
  {
    /** The file `publish` writes for the agent. */
    readonly agentFile: string;
    /** Whether the player's switch is on: always for core capabilities, else the saved choice or the default. */
    readonly configured: (id: string) => Effect.Effect<boolean>;
    /**
     * Whether a capability can be used: it is in the catalog, no feature flag
     * hides it, its switch is on, it is available and so is its parent.
     */
    readonly enabled: (id: string) => Effect.Effect<boolean>;
    /** Every capability no feature flag hides, with its switch, availability and effective state. */
    readonly snapshot: Effect.Effect<CapabilityView[]>;
    /** Replaces the catalog, as when the MCP servers change. */
    readonly setCatalog: (catalog: readonly Capability[]) => Effect.Effect<void>;
    /** Records what can be used right now, by id; capabilities not named keep theirs. */
    readonly setAvailability: (
      entries: Readonly<Record<string, Availability>>,
    ) => Effect.Effect<void>;
    /**
     * Saves the player's switch and then publishes. Writes of either file run
     * one at a time, and a switch changes only once it is saved.
     */
    readonly set: (
      id: string,
      enabled: boolean,
    ) => Effect.Effect<void, UnknownCapability | CapabilityFileError>;
    /** Writes the agent's file, unless it would hold what the last write wrote. */
    readonly publish: Effect.Effect<void, CapabilityFileError>;
  }
>()('@wisp/server/capabilities/CapabilitySettings') {}

export interface CapabilitySettingsOptions {
  /** Where the player's switches are saved. */
  readonly file: string;
  /** Where the agent reads the effective switches and the feature flags. */
  readonly agentFile: string;
  readonly catalog: readonly Capability[];
  /** The feature flag of each flagged tool, by `toolDescriptions` name. */
  readonly toolFlags: Readonly<Record<string, string>>;
}

/** What writing a capability file needs. */
type FileServices = FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom;

interface State {
  readonly catalog: readonly Capability[];
  /** The player's saved switches. */
  readonly switches: Readonly<Record<string, boolean>>;
  readonly availability: ReadonlyMap<string, Availability>;
}

/** The capabilities as `state` and the feature flag `values` describe them. */
const view = (
  { catalog, switches, availability }: State,
  toolFlags: Readonly<Record<string, string>>,
  values: FeatureValues,
) => {
  const find = (id: string) => catalog.find((entry) => entry.id === id);
  // A feature flag that is off removes the tool everywhere.
  const hidden = (id: string) => {
    const tool = id.startsWith('tool:') ? id.slice(5) : '';
    const flag = Object.hasOwn(toolFlags, tool) ? toolFlags[tool] : undefined;
    return flag !== undefined && values[flag] !== true;
  };
  const configured = (id: string) => {
    const entry = find(id);
    const saved = Object.hasOwn(switches, id) ? switches[id] : undefined;
    return entry?.group === 'core' || (saved ?? entry?.defaultEnabled ?? true);
  };
  const availabilityOf = (id: string): Availability => {
    const entry = find(id);
    return (
      availability.get(id) ??
      (entry?.parent
        ? availabilityOf(entry.parent)
        : {
            available: true,
            status: entry?.kind === 'source' || entry?.kind === 'mcp' ? 'configured' : 'ready',
          })
    );
  };
  const enabled = (id: string): boolean => {
    const entry = find(id);
    return (
      entry !== undefined &&
      !hidden(id) &&
      configured(id) &&
      availabilityOf(id).available &&
      (!entry.parent || enabled(entry.parent))
    );
  };
  const snapshot = (): CapabilityView[] =>
    catalog
      .filter((entry) => !hidden(entry.id))
      .map((entry) => ({
        ...entry,
        ...availabilityOf(entry.id),
        enabled: configured(entry.id),
        effective: enabled(entry.id),
      }));
  // What the agent reads: the effective state of every capability, and the flags.
  const agentCapabilities = () => ({
    enabled: Object.fromEntries(catalog.map((entry) => [entry.id, enabled(entry.id)])),
    features: values,
  });
  return { find, hidden, configured, enabled, snapshot, agentCapabilities };
};

/**
 * Capability settings from `options.file`, read once here. A missing file
 * reads as no switches; one that does not decode fails the layer.
 */
export const make = Effect.fn('CapabilitySettings.make')(function* (
  options: CapabilitySettingsOptions,
) {
  const { file, agentFile, toolFlags } = options;
  const features = yield* Features;
  const services = yield* Effect.context<FileServices>();
  const saved = yield* JsonFile.read(file, SavedSwitches, () => ({ enabled: {} })).pipe(
    Effect.catchTags({
      JsonFileError: (cause) =>
        Effect.fail(
          new CapabilityFileError({
            file,
            message: 'Invalid capability settings; the file was preserved',
            cause,
          }),
        ),
      PlatformError: (error) => Effect.fail(fileError(file)(error)),
    }),
  );
  const state = yield* Ref.make<State>({
    catalog: options.catalog,
    switches: saved.enabled,
    availability: new Map(),
  });
  // What the agent's file holds, as JSON, after this instance last wrote it.
  const published = yield* Ref.make('');
  const writes = yield* Semaphore.make(1);

  const current = Effect.gen(function* () {
    return view(yield* Ref.get(state), toolFlags, yield* features.values);
  });

  // Once a write starts, the file and what this instance remembers of it change together.
  const write = <E>(effect: Effect.Effect<void, E, FileServices>) =>
    writes.withPermit(Effect.uninterruptible(effect)).pipe(Effect.provideContext(services));

  const publish = Effect.gen(function* () {
    // Taken when publish is called, as later changes publish again.
    const content = (yield* current).agentCapabilities();
    const text = JSON.stringify(content);
    yield* write(
      Effect.gen(function* () {
        if ((yield* Ref.get(published)) === text) {
          return;
        }
        yield* JsonFile.write(agentFile, AgentCapabilities, content).pipe(
          Effect.mapError(fileError(agentFile)),
        );
        yield* Ref.set(published, text);
      }),
    );
  }).pipe(Effect.withSpan('CapabilitySettings.publish'));

  const set = Effect.fn('CapabilitySettings.set')(function* (id: string, enabled: boolean) {
    const capabilities = yield* current;
    const entry = capabilities.find(id);
    if (!entry || entry.group === 'core' || capabilities.hidden(id)) {
      return yield* new UnknownCapability({ id, message: 'Unknown capability or invalid setting' });
    }
    yield* write(
      Effect.gen(function* () {
        const next = { ...(yield* Ref.get(state)).switches, [id]: enabled };
        yield* JsonFile.write(file, SavedSwitches, { enabled: next }).pipe(
          Effect.mapError(fileError(file)),
        );
        yield* Ref.update(state, (previous) => ({ ...previous, switches: next }));
      }),
    );
    yield* publish;
  });

  return CapabilitySettings.of({
    agentFile,
    configured: Effect.fn('CapabilitySettings.configured')(function* (id: string) {
      return (yield* current).configured(id);
    }),
    enabled: Effect.fn('CapabilitySettings.enabled')(function* (id: string) {
      return (yield* current).enabled(id);
    }),
    snapshot: Effect.map(current, (capabilities) => capabilities.snapshot()),
    setCatalog: Effect.fn('CapabilitySettings.setCatalog')(function* (
      catalog: readonly Capability[],
    ) {
      yield* Ref.update(state, (previous) => ({ ...previous, catalog }));
    }),
    setAvailability: Effect.fn('CapabilitySettings.setAvailability')(function* (
      entries: Readonly<Record<string, Availability>>,
    ) {
      yield* Ref.update(state, (previous) => ({
        ...previous,
        availability: new Map([...previous.availability, ...Object.entries(entries)]),
      }));
    }),
    set,
    publish,
  });
});
