// @effect-migrated allow=effectRuns: the Updates component's one ManagedRuntime, made when it mounts and disposed when it unmounts
import type { Release, UpdateChannel } from '@wisp/protocol/native-commands';
import {
  Context,
  DateTime,
  Effect,
  FiberHandle,
  FiberSet,
  Layer,
  ManagedRuntime,
  Queue,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import { constVoid } from 'effect/Function';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { failureMessage, hostEvents, nativeCall, rejectionText } from '../../../api/calls';
import { native } from '../../../api/desktop';

/** How long Wisp must stay idle before a downloaded update installs by itself. */
export const AUTO_INSTALL_IDLE_MS = 10 * 60 * 1000;
/** How often a scheduled update checks whether WoW is still running. */
export const GAME_CHECK_MS = 30 * 1000;
/** How often Wisp checks for an update after the check at startup. */
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
/** The native refusal when a reply started just before an automatic install. */
const AUTOMATIC_BUSY = 'Wisp is busy; the update will install later.';

/** The host's `update-progress` payload; `total` is null when the size is unknown. */
const Progress = Schema.Struct({
  phase: Schema.Literals(['downloading', 'waiting', 'installing']),
  downloaded: Schema.optionalKey(Schema.Number),
  total: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type Progress = typeof Progress.Type;

export type UpdateOperation =
  | { kind: 'checking' }
  | { kind: 'changing-channel'; channel: string }
  | { kind: 'installing'; progress: Progress };

export type UpdateState = {
  channel: UpdateChannel | null;
  operation: UpdateOperation | null;
  release: Release | null;
  supported: boolean;
  error: string;
  dismissed: string;
  lastChecked: string;
  /** Install downloaded updates while idle; null until the saved setting loads. */
  autoInstall: boolean | null;
  autoInstallError: string;
  /** The version downloaded in the background and ready to install. */
  prepared: string;
  /** A version whose automatic install failed; it waits for the user. */
  autoFailed: string;
  /** Whether WoW is running; null until checked. Only a closed game counts as idle. */
  gameRunning: boolean | null;
  /**
   * From the component: whether an automatic install would interrupt nothing,
   * because WoW is not connected, no reply is running and no desktop operation is busy.
   */
  idle: boolean;
  /** From the component: whether a desktop operation keeps updates from starting. */
  locked: boolean;
};

const initialState: UpdateState = {
  channel: null,
  operation: null,
  release: null,
  supported: native,
  error: '',
  dismissed: '',
  lastChecked: '',
  autoInstall: null,
  autoInstallError: '',
  prepared: '',
  autoFailed: '',
  gameRunning: null,
  idle: false,
  locked: false,
};

/** The installable update found, or null; the game announces it. */
export const availableVersion = ({ supported, release }: UpdateState) =>
  supported && release ? release.version : null;

/** The version that installs by itself the next time Wisp stays idle. */
export const scheduledVersion = (state: UpdateState) => {
  const available = availableVersion(state);
  // An older version never installs by itself: the user chooses to go back.
  return state.autoInstall &&
    state.release?.downgrade !== true &&
    available &&
    state.prepared === available &&
    state.autoFailed !== available
    ? available
    : null;
};

/** What the update checks ask of the component that shows them. */
export class Host extends Context.Service<
  Host,
  {
    /** Marks desktop operations as busy with `label`, or free with ''. */
    readonly busy: (label: string) => Effect.Effect<void>;
  }
>()('@wisp/desktop/updates/Host') {}

/**
 * The update checks of one mounted Updates component. The startup reads, the
 * progress listener, the six-hour check, the background download, the game
 * check and the idle install run in the scope, so closing it stops them all.
 */
export const makeSession = (store: StoreApi<UpdateState>) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const set = (patch: Partial<UpdateState>) => Effect.sync(() => store.setState(patch));
    /** Actions started by a timer; they outlive the timer that started them. */
    const started = yield* FiberSet.make<void, never>();

    /** Every state of the store, starting with the current one. */
    const states = Stream.callback<UpdateState>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          Queue.offerUnsafe(queue, store.getState());
          return store.subscribe((state) => {
            Queue.offerUnsafe(queue, state);
          });
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    );

    /**
     * Runs `work` for each new value of `key`, interrupting the run for the
     * previous value, the way an effect restarts when its dependencies change.
     */
    const whenChanged = <K>(
      key: (state: UpdateState) => K,
      work: (value: K) => Effect.Effect<void>,
    ) =>
      FiberHandle.make<void, never>().pipe(
        Effect.flatMap((runs) =>
          states.pipe(
            Stream.map(key),
            Stream.changes,
            Stream.runForEach((value) => FiberHandle.run(runs, work(value))),
          ),
        ),
        Effect.scoped,
        Effect.forkScoped,
      );

    const check = Effect.gen(function* () {
      const starts = yield* Effect.sync(() => {
        const { channel, operation } = store.getState();
        if (!native || !channel || operation) return false;
        store.setState({ operation: { kind: 'checking' }, error: '' });
        return true;
      });
      if (!starts) return;
      yield* nativeCall('check_update').pipe(
        Effect.flatMap(({ supported, update }) =>
          Effect.flatMap(DateTime.now, (now) =>
            set({
              supported,
              release: update,
              lastChecked: DateTime.toDateUtc(now).toLocaleString(),
            }),
          ),
        ),
        Effect.catch(() =>
          set({
            error:
              'Could not check for updates. Check your connection and try again. Public releases may not be available yet.',
          }),
        ),
        Effect.ensuring(set({ operation: null })),
      );
    });

    const changeChannel = Effect.fn('Updates.changeChannel')(function* (next: string) {
      const starts = yield* Effect.sync(() => {
        const { channel, operation, locked } = store.getState();
        if (!channel || operation || locked) return false;
        store.setState({
          operation: { kind: 'changing-channel', channel: next },
          release: null,
          prepared: '',
          dismissed: '',
          lastChecked: '',
          error: '',
        });
        return true;
      });
      if (!starts) return;
      yield* nativeCall('update_channel', { channel: next }).pipe(
        Effect.flatMap((channel) => set({ channel, operation: null })),
        Effect.andThen(check),
        Effect.catch((error) =>
          set({
            operation: null,
            error: `Could not change update channel: ${rejectionText(error)}`,
          }),
        ),
      );
    });

    const install = Effect.fn('Updates.install')(function* (heading: HTMLElement | null) {
      const starts = yield* Effect.sync(() => {
        const { release, supported, operation, locked } = store.getState();
        if (!release || !supported || operation || locked) return false;
        heading?.focus();
        store.setState({
          operation: { kind: 'installing', progress: { phase: 'downloading' } },
          error: '',
        });
        return true;
      });
      if (!starts) return;
      yield* host.busy('Updating Wisp');
      yield* nativeCall('install_update').pipe(
        Effect.catch((error) =>
          set({ error: `Update failed: ${failureMessage(error)} You can try again.` }),
        ),
        Effect.ensuring(set({ operation: null }).pipe(Effect.andThen(host.busy('')))),
      );
    });

    const installAutomatically = Effect.gen(function* () {
      const release = yield* Effect.sync(() => {
        const { release, operation } = store.getState();
        if (!release || operation) return null;
        store.setState({
          // The installer is already downloaded and nothing is running, so the next
          // step is the Windows updater: never "waiting for the active reply".
          operation: { kind: 'installing', progress: { phase: 'installing' } },
          error: '',
        });
        return release;
      });
      if (!release) return;
      yield* host.busy('Updating Wisp');
      yield* nativeCall('install_update', { automatic: true }).pipe(
        Effect.catch((error) => {
          const message = failureMessage(error);
          // A reply that started at the last moment only postpones the install.
          return message === AUTOMATIC_BUSY
            ? Effect.void
            : set({
                autoFailed: release.version,
                error: `Automatic update failed: ${message} You can install it yourself.`,
              });
        }),
        Effect.ensuring(set({ operation: null }).pipe(Effect.andThen(host.busy('')))),
      );
    });

    const changeAutoInstall = Effect.fn('Updates.changeAutoInstall')(function* (enabled: boolean) {
      yield* set({ autoInstallError: '' });
      yield* nativeCall('update_auto_install', { enabled }).pipe(
        Effect.flatMap((autoInstall) => set({ autoInstall })),
        Effect.catch(() =>
          set({ autoInstallError: 'Could not change the automatic update setting. Try again.' }),
        ),
      );
    });

    // Download a found update in the background so the idle install is quick.
    // Each successful check (`lastChecked`) retries a download that failed.
    const download = nativeCall('download_update').pipe(
      Effect.flatMap((version) =>
        Effect.sync(() => {
          if (version === store.getState().release?.version) store.setState({ prepared: version });
        }),
      ),
      // Until the next check retries, the manual install still downloads by itself.
      Effect.ignore,
    );
    yield* whenChanged(
      (state) => ({
        autoInstall: state.autoInstall,
        available: availableVersion(state),
        downgrade: state.release?.downgrade === true,
        lastChecked: state.lastChecked,
        prepared: state.prepared,
      }),
      ({ autoInstall, available, downgrade, prepared }) =>
        native && autoInstall && !downgrade && available && prepared !== available
          ? download
          : Effect.void,
    );

    // The bridge keeps reporting the game as connected after WoW exits, so ask
    // Windows for the process while an update waits to install. Each check
    // starts on time and never waits for the one before it.
    const lookForGame = nativeCall('game_running').pipe(
      Effect.flatMap((gameRunning) => set({ gameRunning })),
      Effect.catch(() => set({ gameRunning: null })),
    );
    const watchGame = Effect.gen(function* () {
      const looks = yield* FiberSet.make<void, never>();
      yield* FiberSet.run(looks, lookForGame).pipe(Effect.repeat(Schedule.fixed(GAME_CHECK_MS)));
    }).pipe(Effect.scoped);
    yield* whenChanged(scheduledVersion, (scheduled) =>
      native && scheduled ? watchGame : Effect.void,
    );

    // Install once WoW has stayed closed and Wisp idle for the whole window; any
    // activity or a game launch restarts it.
    yield* whenChanged(
      (state) =>
        state.idle && state.gameRunning === false && !state.locked && !state.operation
          ? scheduledVersion(state)
          : null,
      (scheduled) =>
        scheduled
          ? Effect.sleep(AUTO_INSTALL_IDLE_MS).pipe(
              Effect.andThen(FiberSet.run(started, installAutomatically)),
              Effect.asVoid,
            )
          : Effect.void,
    );

    if (native) {
      const showProgress = (progress: Progress) =>
        Effect.sync(() => {
          if (store.getState().operation?.kind === 'installing') {
            store.setState({ operation: { kind: 'installing', progress } });
          }
        });
      yield* hostEvents('update-progress', Progress).pipe(
        Effect.flatMap(Stream.runForEach(showProgress)),
        Effect.scoped,
        Effect.catch(() =>
          set({ error: 'Update progress is unavailable. Restart Wisp to try again.' }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* nativeCall('update_channel').pipe(
        Effect.flatMap((channel) => set({ channel })),
        Effect.andThen(check),
        Effect.catch(() =>
          set({ error: 'Could not load the update channel. Restart Wisp to try again.' }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* nativeCall('update_auto_install').pipe(
        Effect.flatMap((autoInstall) => set({ autoInstall })),
        Effect.catch(() =>
          set({ autoInstallError: 'Could not read the automatic update setting.' }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      // Every tick starts a check at a fixed cadence and never waits for one in flight.
      yield* FiberSet.run(started, check).pipe(
        Effect.schedule(Schedule.fixed(UPDATE_CHECK_MS)),
        Effect.forkScoped,
      );
    }

    return { check, changeChannel, install, changeAutoInstall };
  });

class Session extends Context.Service<Session, Effect.Success<ReturnType<typeof makeSession>>>()(
  '@wisp/desktop/updates/Session',
) {}

type Operations = Session['Service'];

/** The props the update checks read. */
type Props = Pick<UpdateState, 'idle' | 'locked'> & { onBusy: (label: string) => void };

/**
 * The state and actions of one Updates component. Each mount runs its own
 * session; actions called while it is not mounted do nothing.
 */
export function createUpdates() {
  const store = createStore<UpdateState>(() => initialState);
  let onBusy: (label: string) => void = constVoid;
  const host = Host.of({ busy: (label) => Effect.sync(() => onBusy(label)) });
  let mounted: {
    runtime: ManagedRuntime.ManagedRuntime<Session, never>;
    operations: Operations;
  } | null = null;

  function run(operation: (operations: Operations) => Effect.Effect<void>) {
    if (mounted) mounted.runtime.runFork(operation(mounted.operations));
  }

  return {
    store,
    /** Starts the session; the cleanup it returns disposes it, interrupting its work. */
    mount() {
      // The component's one runtime: every Effect of this session runs here, and
      // disposing it stops the timers and removes the progress listener.
      const runtime = ManagedRuntime.make(
        Layer.effect(Session, makeSession(store)).pipe(Layer.provide(Layer.succeed(Host, host))),
      );
      const session = { runtime, operations: runtime.runSync(Effect.service(Session)) };
      mounted = session;
      return () => {
        if (mounted === session) mounted = null;
        void runtime.dispose();
      };
    },
    /** Keeps the session in step with the component's props. */
    setProps({ idle, locked, onBusy: next }: Props) {
      onBusy = next;
      const state = store.getState();
      if (state.idle !== idle || state.locked !== locked) store.setState({ idle, locked });
    },
    check: () => run((operations) => operations.check),
    changeChannel: (next: string) => run((operations) => operations.changeChannel(next)),
    /** Installs the update found, moving focus to `heading` once it starts. */
    install: (heading: HTMLElement | null) => run((operations) => operations.install(heading)),
    changeAutoInstall: (enabled: boolean) =>
      run((operations) => operations.changeAutoInstall(enabled)),
    dismiss: (version: string) => store.setState({ dismissed: version }),
  };
}
