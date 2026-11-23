import { listen } from '@tauri-apps/api/event';
import { renderReleaseNotes } from '@wisp/releases';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { desktop, native } from '../../../api';
import { Spinner } from '../../ui/ActionProgress';
import { Button, Card, Select } from '../../ui/Controls';
import Icon from '../../ui/Icon';
import { groupLabel } from '../../ui/Rows';
import Toggle from '../../ui/Toggle';

/** How long Wisp must stay idle before a downloaded update installs by itself. */
export const AUTO_INSTALL_IDLE_MS = 10 * 60 * 1000;
/** The native refusal when a reply started just before an automatic install. */
const AUTOMATIC_BUSY = 'Wisp is busy; the update will install later.';
/** How often a scheduled update checks whether WoW is still running. */
export const GAME_CHECK_MS = 30 * 1000;

type Release = { version: string; notes: string | null };
const updateChannels = [
  { value: 'stable', label: 'Stable' },
  { value: 'nightly', label: 'Nightly' },
];
type Progress = {
  phase: 'downloading' | 'waiting' | 'installing';
  downloaded?: number;
  total?: number;
};

type UpdatesProps = {
  showSettings: boolean;
  version: string;
  locked: boolean;
  openSettings: () => void;
  onBusy: (label: string) => void;
  /**
   * Whether an automatic install would interrupt nothing: WoW is not connected,
   * no reply is running and no desktop operation is busy.
   */
  idle?: boolean;
  /** The installable update found, or null; the game announces it. */
  onAvailable?: (version: string | null) => void;
};

type UpdateOperation =
  | { kind: 'checking' }
  | { kind: 'changing-channel'; channel: string }
  | { kind: 'installing'; progress: Progress };

type UpdateState = {
  channel: string | null;
  operation: UpdateOperation | null;
  release: Release | null;
  supported: boolean;
  error: string;
  dismissed: string;
  lastChecked: string;
  /** Install downloaded updates while idle; null until the saved setting loads. */
  autoInstall: boolean | null;
  /** The version downloaded in the background and ready to install. */
  prepared: string;
  /** A version whose automatic install failed; it waits for the user. */
  autoFailed: string;
};

function downloadPercent(progress: Progress) {
  if (!progress.total) return undefined;
  return Math.min(100, Math.round(((progress.downloaded ?? 0) / progress.total) * 100));
}

function progressMessage(progress: Progress) {
  if (progress.phase === 'waiting') return 'Waiting for the active reply to finish…';
  if (progress.phase === 'installing') {
    return 'Opening the Windows updater. Wisp will close and reopen automatically…';
  }
  return 'Downloading update';
}

const megabytes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function downloadedSize({ downloaded, total }: Progress) {
  if (downloaded === undefined) return null;
  const transferred = megabytes.format(downloaded / 1_000_000);
  return total
    ? `${transferred} of ${megabytes.format(total / 1_000_000)} MB`
    : `${transferred} MB downloaded`;
}

function updateStatusTitle(
  operation: UpdateOperation | null,
  supported: boolean,
  release: Release | null,
  upToDate: boolean,
) {
  switch (operation?.kind) {
    case 'installing':
      return release ? `Updating to Wisp ${release.version}` : 'Updating Wisp';
    case 'checking':
      return 'Checking for updates…';
    case 'changing-channel':
      return 'Changing update channel…';
  }
  if (!supported) return 'Updates unavailable';
  if (release) return `Wisp ${release.version} is available`;
  return upToDate ? 'You’re up to date.' : 'Software update';
}

export default function Updates({
  showSettings,
  version,
  locked,
  openSettings,
  onBusy,
  idle = false,
  onAvailable,
}: UpdatesProps) {
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const [updates] = useState(() =>
    createStore<UpdateState>(() => ({
      channel: null,
      operation: null,
      release: null,
      supported: native,
      error: '',
      dismissed: '',
      lastChecked: '',
      autoInstall: null,
      prepared: '',
      autoFailed: '',
    })),
  );
  const { getState, setState } = updates;
  const {
    release,
    operation,
    supported,
    error,
    dismissed,
    lastChecked,
    channel: savedChannel,
    autoInstall,
    prepared,
    autoFailed,
  } = useStore(updates);
  const [autoInstallError, setAutoInstallError] = useState('');
  /** Whether WoW is running; null until checked. Only a closed game counts as idle. */
  const [gameRunning, setGameRunning] = useState<boolean | null>(null);
  const channel = savedChannel ?? 'stable';
  const checking = operation?.kind === 'checking';
  const installing = operation?.kind === 'installing';
  const progress = installing ? operation.progress : null;
  const downloading = progress?.phase === 'downloading';
  const percent = downloading ? downloadPercent(progress) : undefined;
  const size = downloading ? downloadedSize(progress) : null;
  const channelLoaded = savedChannel !== null;
  const canInstall = supported && !!release;
  const available = supported && release ? release.version : null;
  /** The version that installs by itself the next time Wisp stays idle. */
  const scheduled =
    autoInstall && available && prepared === available && autoFailed !== available
      ? available
      : null;

  useEffect(() => {
    onAvailable?.(available);
  }, [available, onAvailable]);

  const check = useCallback(async () => {
    const state = getState();
    if (!native || !state.channel || state.operation) return;
    setState({ operation: { kind: 'checking' }, error: '' });
    try {
      const { supported, update } = await desktop<{ supported: boolean; update: Release | null }>(
        'check_update',
      );
      setState({ supported, release: update, lastChecked: new Date().toLocaleString() });
    } catch {
      setState({
        error:
          'Could not check for updates. Check your connection and try again. Public releases may not be available yet.',
      });
    } finally {
      setState({ operation: null });
    }
  }, [getState, setState]);

  async function changeChannel(next: string) {
    const state = getState();
    if (!state.channel || state.operation || locked) return;
    setState({
      operation: { kind: 'changing-channel', channel: next },
      release: null,
      prepared: '',
      dismissed: '',
      lastChecked: '',
      error: '',
    });
    try {
      const channel = await desktop<string>('update_channel', { channel: next });
      setState({ channel, operation: null });
      await check();
    } catch (error) {
      setState({ operation: null, error: `Could not change update channel: ${String(error)}` });
    }
  }

  async function install() {
    const state = getState();
    if (!state.release || !state.supported || state.operation || locked) return;
    statusHeading.current?.focus();
    setState({
      operation: { kind: 'installing', progress: { phase: 'downloading' } },
      error: '',
    });
    onBusy('Updating Wisp');
    try {
      await desktop('install_update');
    } catch (error) {
      setState({
        error: `Update failed: ${String(error).replace(/^Error: /, '')} You can try again.`,
      });
    } finally {
      setState({ operation: null });
      onBusy('');
    }
  }

  const installAutomatically = useCallback(async () => {
    const { release, operation } = getState();
    if (!release || operation) return;
    setState({
      // The installer is already downloaded and nothing is running, so the next
      // step is the Windows updater: never "waiting for the active reply".
      operation: { kind: 'installing', progress: { phase: 'installing' } },
      error: '',
    });
    onBusy('Updating Wisp');
    try {
      await desktop('install_update', { automatic: true });
    } catch (error) {
      const message = String(error).replace(/^Error: /, '');
      // A reply that started at the last moment only postpones the install.
      if (message !== AUTOMATIC_BUSY) {
        setState({
          autoFailed: release.version,
          error: `Automatic update failed: ${message} You can install it yourself.`,
        });
      }
    } finally {
      setState({ operation: null });
      onBusy('');
    }
  }, [getState, onBusy, setState]);

  async function changeAutoInstall(enabled: boolean) {
    setAutoInstallError('');
    try {
      const saved = await desktop<boolean>('update_auto_install', { enabled });
      setState({ autoInstall: saved });
    } catch {
      setAutoInstallError('Could not change the automatic update setting. Try again.');
    }
  }

  // Download a found update in the background so the idle install is quick.
  // Each successful check (`lastChecked`) retries a download that failed.
  useEffect(() => {
    if (!native || !autoInstall || !available || prepared === available) return;
    let current = true;
    void desktop<string>('download_update')
      .then((version) => {
        if (current && version === getState().release?.version) setState({ prepared: version });
      })
      // Until the next check retries, the manual install still downloads by itself.
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [autoInstall, available, getState, lastChecked, prepared, setState]);

  // The bridge keeps reporting the game as connected after WoW exits, so ask
  // Windows for the process while an update waits to install.
  useEffect(() => {
    if (!native || !scheduled) return;
    let current = true;
    const look = () =>
      void desktop<boolean>('game_running')
        .then((running) => {
          if (current) setGameRunning(running);
        })
        .catch(() => {
          if (current) setGameRunning(null);
        });
    look();
    const timer = setInterval(look, GAME_CHECK_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [scheduled]);

  // Install once WoW has stayed closed and Wisp idle for the whole window; any
  // activity or a game launch restarts it.
  useEffect(() => {
    if (!scheduled || !idle || gameRunning !== false || locked || operation) return;
    const timer = setTimeout(() => void installAutomatically(), AUTO_INSTALL_IDLE_MS);
    return () => clearTimeout(timer);
  }, [gameRunning, idle, installAutomatically, locked, operation, scheduled]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void listen<Progress>('update-progress', ({ payload }) => {
      if (!disposed && getState().operation?.kind === 'installing') {
        setState({ operation: { kind: 'installing', progress: payload } });
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
      })
      .catch(() => {
        if (!disposed) {
          setState({ error: 'Update progress is unavailable. Restart Wisp to try again.' });
        }
      });
    void desktop<string>('update_channel')
      .then((channel) => {
        if (disposed) return;
        setState({ channel });
        return check();
      })
      .catch(() => {
        if (!disposed) {
          setState({ error: 'Could not load the update channel. Restart Wisp to try again.' });
        }
      });
    void desktop<boolean>('update_auto_install')
      .then((enabled) => {
        if (!disposed) setState({ autoInstall: enabled });
      })
      .catch(() => {
        if (!disposed) setAutoInstallError('Could not read the automatic update setting.');
      });
    const timer = setInterval(() => void check(), 6 * 60 * 60 * 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [check, getState, setState]);

  if (!showSettings) {
    if (!release || dismissed === release.version) return null;
    return (
      <div className="mb-5 flex w-full shrink-0 flex-wrap items-center justify-between gap-x-5 gap-y-3 rounded-[6px] border border-solid border-accent-line bg-accent-dim px-3.5 py-2.5">
        <div className="flex min-w-0 flex-[1_1_230px] items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#294740] text-accent">
            <Icon name="download" size={18} />
          </span>
          <div className="min-w-0" role="status">
            <p className="m-0 text-sm font-semibold leading-snug [overflow-wrap:anywhere]">
              Wisp {release.version} is available.
            </p>
            <p className="m-0 mt-0.5 text-xs leading-snug text-muted">
              {scheduled
                ? 'It installs by itself once WoW is closed and Wisp is idle.'
                : 'See what’s new before installing.'}
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            intent="quiet"
            className="min-h-8 px-2.5 py-1 text-xs text-muted"
            onClick={() => setState({ dismissed: release.version })}
          >
            Later
          </Button>
          <Button
            className="min-h-8 gap-1.5 border-[#426960] bg-[#243d38] px-2.5 py-1 text-xs font-semibold text-accent"
            onClick={openSettings}
          >
            View update
            <Icon name="chevronRight" size={14} />
          </Button>
        </div>
      </div>
    );
  }

  const busy = !native || !channelLoaded || !!operation || locked;
  const upToDate = supported && !!lastChecked && !release && !error;
  const statusTitle = updateStatusTitle(operation, supported, release, upToDate);
  const changelog = `https://wisp.fedeya.sh/changelog${channel === 'nightly' ? '?channel=nightly' : ''}`;

  return (
    <section aria-labelledby="app-updates-title" className="mb-5">
      <h2 id="app-updates-title" className={groupLabel}>
        App updates
      </h2>
      <Card className="mb-0.5 overflow-hidden rounded-b-none border-0 p-0">
        <div className="p-4 max-sm:p-3">
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={`grid size-10 shrink-0 place-items-center rounded-[9px] ${upToDate || canInstall ? 'bg-[#223a34] text-accent' : 'bg-selected text-muted'}`}
              >
                {checking || (installing && !downloading) ? (
                  <Spinner className="size-[18px]" />
                ) : (
                  <Icon name={upToDate ? 'check' : canInstall ? 'download' : 'refresh'} size={19} />
                )}
              </span>
              <div className="min-w-0">
                <div role="status">
                  <h3
                    ref={statusHeading}
                    tabIndex={-1}
                    className="m-0 text-lg font-semibold outline-none [overflow-wrap:anywhere]"
                  >
                    {statusTitle}
                  </h3>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                  <span>Installed version {version}</span>
                  {lastChecked && !installing && <span>Last checked {lastChecked}</span>}
                </div>
              </div>
            </div>
            {!installing && (
              <div className="flex flex-wrap items-center gap-1.5">
                {canInstall && (
                  <Button intent="primary" onClick={install} disabled={busy}>
                    Update and restart
                  </Button>
                )}
                <Button intent={canInstall ? 'quiet' : 'default'} onClick={check} disabled={busy}>
                  {checking ? 'Checking…' : 'Check for updates'}
                </Button>
              </div>
            )}
          </div>
          {!supported && (
            <p className="mt-2 text-sm text-muted">
              Updates are available in the installed Windows x64 release.
            </p>
          )}
          {progress && (
            <div className="mt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="m-0 text-sm" role="status">
                  {progressMessage(progress)}
                </p>
                {percent !== undefined && (
                  <span
                    aria-hidden="true"
                    className="text-[15px] font-semibold text-accent tabular-nums"
                  >
                    {percent}%
                  </span>
                )}
              </div>
              {downloading && (
                <progress
                  aria-label="Update download"
                  className="mt-2 block h-[6px] w-full overflow-hidden rounded-full accent-accent [&::-webkit-progress-bar]:bg-selected [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-accent"
                  max={100}
                  value={percent}
                />
              )}
              {size && <p className="mb-0 mt-1.5 text-xs text-muted tabular-nums">{size}</p>}
            </div>
          )}
          {error && (
            <p
              className="mb-0 mt-3 rounded-[8px] border border-solid border-[#70473f] bg-[#332522] px-3 py-2 text-sm text-danger"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
        {canInstall && (
          <section
            className="border-t border-border px-4 py-3 [border-top-style:solid] max-sm:px-3"
            aria-labelledby="release-notes-title"
          >
            <h3 id="release-notes-title" className="mb-2 text-sm font-semibold">
              What’s new
            </h3>
            <div
              className="release-notes max-h-[235px] overflow-y-auto text-sm text-muted [overflow-wrap:anywhere] [&_img]:max-w-full [&_img]:rounded-lg [&_h1]:text-[1.35rem] [&_h2]:mt-4 [&_h2]:text-[1.1rem] [&_a]:text-accent [&>:first-child]:mt-0 [&>:last-child]:mb-0"
              dangerouslySetInnerHTML={{
                __html: renderReleaseNotes(release.notes || 'This release has no notes.'),
              }}
            />
            <p className="mb-0 mt-3 text-xs text-muted">
              Wisp restarts after installing and keeps your chats and settings. It updates your
              installed WoW addon when needed and reminds you to type /reload if WoW is open.
              {scheduled &&
                ' Downloaded and ready: it installs by itself after 10 minutes with WoW closed and no reply running.'}
            </p>
          </section>
        )}
      </Card>
      <Card density="compact" className="mb-0 rounded-t-none border-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="m-0 text-base font-semibold">
              <label htmlFor="wisp-update-channel">Update channel</label>
            </h3>
            <p id="wisp-update-channel-description" className="mb-0 mt-1 text-sm text-muted">
              {channel === 'nightly'
                ? 'Experimental builds from main. Features may change or break.'
                : version.includes('-nightly.')
                  ? 'Returning to Stable can install an older version. Your chats and settings are kept.'
                  : 'Stable releases are recommended for most users.'}
            </p>
          </div>
          <Select
            id="wisp-update-channel"
            aria-describedby="wisp-update-channel-description"
            className="w-[128px]"
            value={operation?.kind === 'changing-channel' ? operation.channel : channel}
            onValueChange={(next) => void changeChannel(next)}
            options={updateChannels}
            disabled={busy}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 [border-top-style:solid]">
          <div className="min-w-0">
            <h3 className="m-0 text-base font-semibold">Install updates automatically</h3>
            <p className="mb-0 mt-1 text-sm text-muted">
              Downloads updates in the background and installs them after 10 minutes with WoW closed
              and no reply running.
            </p>
          </div>
          <Toggle
            label="Install updates automatically"
            checked={autoInstall ?? false}
            disabled={!native || autoInstall === null || installing}
            onChange={(enabled) => void changeAutoInstall(enabled)}
          />
        </div>
        {autoInstallError && (
          <p role="alert" className="mb-0 mt-2 text-sm text-danger">
            {autoInstallError}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 [border-top-style:solid]">
          <p className="m-0 text-xs text-muted">Wisp checks at startup and every six hours.</p>
          <a
            href={changelog}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-accent no-underline hover:underline"
          >
            View release history <span aria-hidden="true">↗</span>
          </a>
        </div>
      </Card>
    </section>
  );
}
