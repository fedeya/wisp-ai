// @effect-migrated allow=effectRuns: the store's one ManagedRuntime, made and disposed with each desktop session
import { Channel } from '@tauri-apps/api/core';
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FiberSet,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Result,
  Semaphore,
} from 'effect';
import { constVoid } from 'effect/Function';
import { createStore } from 'zustand/vanilla';
import { native, type DesktopInfo, type Mcp, type Model, type Panel, type Status } from './api';
import {
  bridgeCall,
  failureMessage,
  nativeCall,
  promised,
  type DesktopCallError,
} from './api/calls';
import * as BridgeLifecycle from './bridge-lifecycle';

type Confirmation = { label: string; run: () => Promise<unknown> };
type DesktopState = {
  status: Status | null;
  info: DesktopInfo | null;
  loading: boolean;
  starting: boolean;
  busy: string;
  busyTarget: string;
  feedback: string;
  failed: boolean;
  wow: string;
  detectedFolders: string[];
  detectingGame: boolean;
  detectionFailed: boolean;
  models: Model[];
  logs: string;
  confirm: Confirmation | null;
  connectionError: string;
  modelsError: string;
  onboarding: boolean;
  /** The automatic addon update after an app update is running. */
  addonUpdating: boolean;
};

const onboardingKey = 'wisp:onboarding:v1';

/** Whether setup still has to finish; webview storage can be unavailable. */
const resumeOnboarding = (configured: boolean) =>
  Effect.try(() => {
    const saved = localStorage.getItem(onboardingKey);
    const pending = saved === 'pending' || (!configured && saved !== 'complete');
    if (pending) localStorage.setItem(onboardingKey, 'pending');
    return pending;
  }).pipe(Effect.orElseSucceed(() => !configured));

/** Remembers setup as done; it can still finish when webview storage is unavailable. */
const completeOnboarding = () => Result.try(() => localStorage.setItem(onboardingKey, 'complete'));

const initialState: DesktopState = {
  status: null,
  info: null,
  loading: true,
  starting: false,
  busy: '',
  busyTarget: '',
  feedback: '',
  failed: false,
  wow: '',
  detectedFolders: [],
  detectingGame: false,
  detectionFailed: false,
  models: [],
  logs: '',
  confirm: null,
  connectionError: '',
  modelsError: '',
  onboarding: false,
  addonUpdating: false,
};

export const desktopConnected = ({ status }: DesktopState) =>
  status?.modelConnected ?? status?.auth.status === 'connected';
export const desktopActive = ({ status }: DesktopState) => (status?.activeTurns ?? 0) > 0;
export const desktopLocked = (state: DesktopState) => !!state.busy || desktopActive(state);

export function desktopReadiness(
  state: DesktopState,
):
  | 'loading'
  | 'updating'
  | 'update'
  | 'starting'
  | 'unavailable'
  | 'setup'
  | 'account'
  | 'agent'
  | 'waiting'
  | 'ready' {
  const { loading, info, status, starting, addonUpdating } = state;
  if (loading) return 'loading';
  if (addonUpdating && info?.addonOutdated) return 'updating';
  if (info?.addonOutdated || info?.addonUpdateNotice === 'failed') return 'update';
  if (!status) return starting ? 'starting' : 'unavailable';
  if (!info?.configured) return 'setup';
  if (!desktopConnected(state)) return 'account';
  if (!status.ready) return 'agent';
  return status.gameConnected ? 'ready' : 'waiting';
}

/** The store's state when a session Effect reads it. */
const current = Effect.sync(() => desktopStore.getState());

/** How long a status read may fail quietly while the bridge starts. */
const startupGraceMillis = 15_000;

/**
 * The desktop session's bridge and native calls. Its fibers live in the layer's
 * scope, so disposing the runtime that built it stops them all.
 */
const makeSession = (update: (patch: Partial<DesktopState>) => void) => {
  const set = (patch: Partial<DesktopState>) => Effect.sync(() => update(patch));
  return Effect.gen(function* () {
    const loadedAccount = yield* Ref.make('');
    const startupDeadline = yield* Ref.make(0);
    const appUpdate = yield* Ref.make<string | null>(null);
    const statusReads = yield* FiberHandle.make<void, never>();
    const statusReadLock = yield* Semaphore.make(1);
    const appUpdateSyncs = yield* FiberHandle.make<void, never>();
    const background = yield* FiberSet.make<void, never>();

    const loadModels = Effect.gen(function* () {
      yield* set({ models: [] });
      const { models } = yield* bridgeCall((client) => client.auth.models.$get());
      yield* set({ models: [...models], modelsError: '' });
    });

    /**
     * Tell the bridge which app update the game should announce. Status reads
     * call this too, so a restarted bridge or a failed send catches up.
     */
    const syncAppUpdate = Effect.fn('DesktopSession.syncAppUpdate')(function* (
      reported: string | null | undefined,
    ) {
      const version = yield* Ref.get(appUpdate);
      if (!native || reported === undefined || reported === version) return;
      yield* FiberHandle.run(
        appUpdateSyncs,
        bridgeCall((client) => client['app-update'].$post({ json: { version } })).pipe(
          Effect.ignore,
        ),
        { onlyIfMissing: true },
      );
    });

    const readStatus = Effect.gen(function* () {
      const status = yield* bridgeCall((client) => client.status.$get());
      yield* set({ status, connectionError: '', starting: false });
      yield* syncAppUpdate(status.appUpdate);
      const catalogRevision = JSON.stringify([
        status.auth.activeId,
        status.auth.status,
        status.auth.revision,
        status.connections,
      ]);
      const locked = desktopLocked(yield* current);
      if (catalogRevision !== (yield* Ref.get(loadedAccount)) && !locked) {
        yield* Ref.set(loadedAccount, catalogRevision);
        yield* loadModels.pipe(
          Effect.catch((error) =>
            Ref.set(loadedAccount, '').pipe(
              Effect.andThen(set({ modelsError: failureMessage(error) })),
            ),
          ),
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Ref.set(loadedAccount, '');
          const now = yield* Clock.currentTimeMillis;
          const starting = (yield* current).starting && now < (yield* Ref.get(startupDeadline));
          yield* set({
            status: null,
            starting,
            connectionError: starting ? '' : failureMessage(error),
          });
        }),
      ),
      Effect.ensuring(set({ loading: false })),
    );

    /** The status read in flight, or a new one; it runs even if the caller stops waiting. */
    const startStatusRead = statusReadLock.withPermit(
      FiberHandle.get(statusReads).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () => FiberHandle.run(statusReads, readStatus),
          }),
        ),
      ),
    );

    const refresh = native ? Effect.flatMap(startStatusRead, Fiber.join) : Effect.void;

    // A read started before the write completed may still contain the old values.
    const refreshAfterWrite = FiberHandle.awaitEmpty(statusReads).pipe(Effect.andThen(refresh));

    const work = Effect.fn('DesktopSession.work')(function* (
      label: string,
      action: Effect.Effect<unknown, DesktopCallError>,
      success?: string | null,
      target?: string,
    ) {
      if ((yield* current).busy) return false;
      yield* set({ busy: label, busyTarget: target ?? '', failed: false, feedback: '' });
      const done = yield* action.pipe(
        Effect.andThen(
          success === null
            ? Effect.void
            : Effect.flatMap(current, ({ feedback }) =>
                set({ feedback: success || feedback || 'Done.' }),
              ),
        ),
        Effect.as(true),
        Effect.catch((error) =>
          set({ failed: true, feedback: failureMessage(error) }).pipe(Effect.as(false)),
        ),
        Effect.ensuring(set({ busy: '', busyTarget: '' })),
      );
      yield* refreshAfterWrite;
      return done;
    });

    const expectService = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.set(startupDeadline, now + startupGraceMillis);
      yield* set({ starting: true, connectionError: '' });
    });

    const launchBridge = expectService.pipe(
      Effect.andThen(nativeCall('start_bridge')),
      Effect.tapError(() => set({ starting: false })),
      Effect.asVoid,
    );

    const pickFolder = Effect.gen(function* () {
      if ((yield* current).detectingGame) return;
      const folder = yield* nativeCall('pick_folder');
      if (folder) yield* set({ wow: folder });
    });

    const searchInstallations = Effect.gen(function* () {
      const state = yield* current;
      const { info, detectingGame, wow: previous } = state;
      if (!native || info?.configured || detectingGame || desktopLocked(state)) return;
      yield* set({ detectingGame: true, detectionFailed: false, feedback: '', failed: false });
      const folders = new Set<string>();
      const addFolder = (folder: string) => {
        if (!desktopStore.getState().info?.configured) folders.add(folder);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const onFound = new Channel<string>();
          onFound.onmessage = addFolder;
          return onFound;
        }),
        // Folders reported after the search ends are not offered.
        (onFound) =>
          Effect.sync(() => {
            onFound.onmessage = constVoid;
          }),
      ).pipe(
        Effect.flatMap((onFound) => nativeCall('detect_game_folders', { onFound })),
        Effect.flatMap((found) => Effect.sync(() => found.forEach(addFolder))),
        Effect.catch(() => set({ detectionFailed: true })),
        Effect.scoped,
        Effect.ensuring(
          Effect.suspend(() => {
            const detectedFolders = [...folders];
            return set({
              detectedFolders,
              wow: folders.has(previous) ? previous : detectedFolders[0] || '',
              detectingGame: false,
            });
          }),
        ),
      );
    });

    const host = BridgeLifecycle.Host.of({
      launchBridge,
      pollStatus: Effect.asVoid(startStatusRead),
      refresh,
      desktopInfo: Effect.fn('DesktopSession.desktopInfo')(function* (info: DesktopInfo) {
        const onboarding = yield* resumeOnboarding(info.configured);
        yield* set({ info, wow: info.wow || '', onboarding });
        if (!info.configured) yield* FiberSet.run(background, searchInstallations);
      }),
      addonUpdate: ({ wow, ...addon }) =>
        Effect.flatMap(current, ({ info }) =>
          info && info.wow === wow ? set({ info: { ...info, ...addon } }) : Effect.void,
        ),
      addonUpdating: (addonUpdating) => set({ addonUpdating }),
      error: (feedback) => set({ failed: true, feedback }),
      initializationError: (feedback) => set({ failed: true, feedback, loading: false }),
    });

    return {
      /** Runs the bridge lifecycle until the session is disposed. */
      mount: native
        ? BridgeLifecycle.run.pipe(Effect.provideService(BridgeLifecycle.Host, host))
        : set({ loading: false }),
      refresh,
      refreshAfterWrite,
      work,
      loadModels,
      /** Succeeds with false when the sign-in page could not be opened. */
      signIn: (profileId?: string, add = false) =>
        work(
          'Opening sign-in',
          bridgeCall((client) =>
            client.auth.start.$post({
              json: { profileId: profileId || undefined, newAccount: add },
            }),
          ).pipe(
            Effect.flatMap(({ authorizationUrl }) =>
              nativeCall('open_sign_in', { url: authorizationUrl }),
            ),
          ),
          'Continue in your browser. Wisp will update when sign-in completes.',
        ),
      searchInstallations,
      install: Effect.gen(function* () {
        if ((yield* current).detectingGame) return;
        yield* work(
          'Installing addon',
          Effect.gen(function* () {
            yield* nativeCall('install_addon', { wow: (yield* current).wow });
            yield* set({ info: yield* nativeCall('desktop_info') });
          }),
          'Addon installed. Restart WoW after the first installation; use /reload for updates.',
          'installation',
        );
      }),
      importPrevious: Effect.gen(function* () {
        const source = yield* nativeCall('pick_folder');
        if (!source) return;
        yield* work(
          'Importing previous installation',
          Effect.gen(function* () {
            yield* nativeCall('import_legacy', { source });
            yield* expectService;
            const info = yield* nativeCall('desktop_info');
            yield* Ref.set(loadedAccount, '');
            yield* set({ info, wow: info.wow || '' });
          }),
          'Imported chats, memory and protected credentials.',
        );
      }),
      showLogs: work(
        'Reading logs',
        nativeCall('read_logs').pipe(Effect.flatMap((logs) => set({ logs }))),
        null,
      ),
      setIntegration: (id: string, enabled: boolean) =>
        work(
          'Updating integration',
          bridgeCall((client) => client.integrations.set.$post({ json: { id, enabled } })),
          'Integration updated.',
          id,
        ),
      setFeature: (id: string, enabled: boolean | null) =>
        work(
          'Updating experimental feature',
          bridgeCall((client) => client.features.set.$post({ json: { id, enabled } })),
          'Experimental feature updated.',
          'feature:' + id,
        ),
      panelAction: (panel: Panel, action: 'show' | 'hide' | 'remove') =>
        work(
          'Updating panel',
          bridgeCall((client) =>
            client.panels.action.$post({
              json: { action, id: panel.id, characterKey: panel.characterKey },
            }),
          ),
          'Panel updated.',
          panel.id,
        ),
      removeMcp: (server: Mcp) =>
        work(
          'Removing connection',
          bridgeCall((client) => client.mcps.remove.$post({ json: { name: server.name } })),
          'Connection removed.',
          'mcp:' + server.name,
        ),
      testMcp: (server: Mcp) =>
        work(
          'Testing ' + server.name,
          bridgeCall((client) => client.mcps.test.$post({ json: { server } })).pipe(
            Effect.flatMap((result) =>
              set({ feedback: `Connected. ${result.count} tools available.` }),
            ),
          ),
          undefined,
          'mcp:' + server.name,
        ),
      chooseFolder: work('Choosing folder', pickFolder, undefined, 'folder-picker'),
      setAppUpdate: Effect.fn('DesktopSession.setAppUpdate')(function* (version: string | null) {
        yield* Ref.set(appUpdate, version);
        yield* syncAppUpdate((yield* current).status?.appUpdate);
      }),
      /** Reports the page on screen; telemetry that fails is not retried. */
      reportScreen: (screen: string) =>
        nativeCall('telemetry_screen', { screen }).pipe(Effect.ignore),
    };
  });
};

class Session extends Context.Service<Session, Effect.Success<ReturnType<typeof makeSession>>>()(
  '@wisp/desktop/DesktopSession',
) {}

function createDesktopSession() {
  let disposed = false;

  function update(patch: Partial<DesktopState>) {
    if (!disposed) desktopStore.setState(patch);
  }

  // The store's one runtime: every Effect of this session runs here, and
  // disposing it interrupts them, which stops the status poll and removes the
  // host listeners.
  const runtime = ManagedRuntime.make(Layer.effect(Session, makeSession(update)));
  const operations = runtime.runSync(Effect.service(Session));

  /**
   * Runs a session operation for a component. It settles as the store's
   * Promise API always has: a failed call rejects with what the call rejected
   * with, and an operation the disposed session stopped settles with `stopped`.
   */
  function run<A>(operation: Effect.Effect<A, DesktopCallError>, stopped: A): Promise<A> {
    if (disposed) return Promise.resolve(stopped);
    return runtime
      .runPromiseExit(Effect.mapError(operation, (error) => error.cause))
      .then((exit) =>
        Exit.isSuccess(exit)
          ? exit.value
          : Cause.hasInterruptsOnly(exit.cause)
            ? stopped
            : Promise.reject(Cause.squash(exit.cause)),
      );
  }

  return {
    dispose() {
      disposed = true;
      void runtime.dispose();
    },
    mount() {
      void run(operations.mount, undefined);
    },
    actions: {
      refresh: () => run(operations.refresh, undefined),
      refreshAfterWrite: () => run(operations.refreshAfterWrite, undefined),
      work: (
        label: string,
        action: () => Promise<unknown>,
        success?: string | null,
        target?: string,
      ) => run(operations.work(label, promised(action), success, target), false),
      loadModels: () => run(operations.loadModels, undefined),
      /** Resolves false when the sign-in page could not be opened. */
      signIn: (profileId?: string, add?: boolean) => run(operations.signIn(profileId, add), false),
      searchInstallations: () => run(operations.searchInstallations, undefined),
      install: () => run(operations.install, undefined),
      importPrevious: () => run(operations.importPrevious, undefined),
      /** Remember setup as done while the wizard still shows its last screen. */
      markOnboardingComplete() {
        completeOnboarding();
      },
      finishOnboarding() {
        completeOnboarding();
        update({ onboarding: false });
      },
      showLogs: () => run(Effect.asVoid(operations.showLogs), undefined),
      setIntegration: (id: string, enabled: boolean) =>
        run(Effect.asVoid(operations.setIntegration(id, enabled)), undefined),
      setFeature: (id: string, enabled: boolean | null) =>
        run(Effect.asVoid(operations.setFeature(id, enabled)), undefined),
      panelAction: (panel: Panel, action: 'show' | 'hide' | 'remove') =>
        run(Effect.asVoid(operations.panelAction(panel, action)), undefined),
      removeMcp(server: Mcp) {
        update({
          confirm: {
            label: `Remove “${server.name}”?`,
            run: () => run(operations.removeMcp(server), false),
          },
        });
      },
      testMcp: (server: Mcp) => run(Effect.asVoid(operations.testMcp(server)), undefined),
      chooseFolder: () => run(operations.chooseFolder, false),
      selectFolder: (wow: string) => update({ wow }),
      dismissAddonReload: () => {
        const { info } = desktopStore.getState();
        if (info?.addonUpdateNotice === 'reload_required') {
          update({ info: { ...info, addonUpdateNotice: null } });
        }
      },
      setConfirmation: (confirm: Confirmation | null) => update({ confirm }),
      setBusy: (busy: string) => update({ busy }),
      /** The app update the updater found (null when none), announced in game. */
      setAppUpdate: (version: string | null) => {
        void run(operations.setAppUpdate(version), undefined);
      },
      /** Reports the page on screen to telemetry. */
      reportScreen: (screen: string) => {
        void run(operations.reportScreen(screen), undefined);
      },
      clearFeedback: () => update({ feedback: '' }),
    },
  };
}

let session = createDesktopSession();
export const desktopStore = createStore(() => ({ ...initialState, actions: session.actions }));

export function mountDesktop() {
  const mounted = session;
  mounted.mount();
  return () => {
    mounted.dispose();
    session = createDesktopSession();
    desktopStore.setState({ ...initialState, actions: session.actions }, true);
  };
}
