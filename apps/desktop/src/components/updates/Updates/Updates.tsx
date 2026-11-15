import { listen } from '@tauri-apps/api/event';
import { renderReleaseNotes } from '@wisp/releases';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { desktop, native } from '../../../api';
import { Spinner } from '../../ui/ActionProgress';
import { Button, Card, Select } from '../../ui/Controls';
import Icon from '../../ui/Icon';

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
  } = useStore(updates);
  const channel = savedChannel ?? 'stable';
  const checking = operation?.kind === 'checking';
  const installing = operation?.kind === 'installing';
  const progress = installing ? operation.progress : null;
  const downloading = progress?.phase === 'downloading';
  const percent = downloading ? downloadPercent(progress) : undefined;
  const size = downloading ? downloadedSize(progress) : null;
  const channelLoaded = savedChannel !== null;
  const canInstall = supported && !!release;

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
      <div
        className="banner mb-5 flex items-center gap-3 rounded-[9px] border border-solid border-[#355c56] bg-[#1c3330] px-4 py-3 text-xs leading-[1.5] text-[#b7e8db]"
        role="status"
      >
        <span>Wisp {release.version} is available.</span>
        <Button onClick={openSettings}>View update</Button>
        <Button intent="quiet" onClick={() => setState({ dismissed: release.version })}>
          Later
        </Button>
      </div>
    );
  }

  const busy = !native || !channelLoaded || !!operation || locked;
  const upToDate = supported && !!lastChecked && !release && !error;
  const statusTitle = updateStatusTitle(operation, supported, release, upToDate);
  const changelog = `https://wisp.fedeya.sh/changelog${channel === 'nightly' ? '?channel=nightly' : ''}`;

  return (
    <section aria-labelledby="app-updates-title">
      <h2 id="app-updates-title" className="mb-3 ml-px">
        App updates
      </h2>
      <Card className="mb-3 overflow-hidden p-0">
        <div className="p-4 max-sm:p-3">
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={`grid size-10 shrink-0 place-items-center rounded-[9px] ${upToDate || canInstall ? 'bg-[#223a34] text-accent' : 'bg-[#263137] text-muted'}`}
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
                    className="m-0 text-[16px] font-semibold outline-none [overflow-wrap:anywhere]"
                  >
                    {statusTitle}
                  </h3>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-muted">
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
            <p className="mt-2 text-[13px] text-muted">
              Updates are available in the installed Windows x64 release.
            </p>
          )}
          {progress && (
            <div className="mt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="m-0 text-[13px]" role="status">
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
                  className="mt-2 block h-[6px] w-full overflow-hidden rounded-full accent-accent [&::-webkit-progress-bar]:bg-[#34474b] [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-accent"
                  max={100}
                  value={percent}
                />
              )}
              {size && <p className="mb-0 mt-1.5 text-[12px] text-muted tabular-nums">{size}</p>}
            </div>
          )}
          {error && (
            <p
              className="mb-0 mt-3 rounded-[8px] border border-solid border-[#70473f] bg-[#332522] px-3 py-2 text-[13px] text-[#f0b4aa]"
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
            <h3 id="release-notes-title" className="mb-2 text-[13px] font-semibold">
              What’s new
            </h3>
            <div
              className="release-notes max-h-[235px] overflow-y-auto text-[13px] text-muted [overflow-wrap:anywhere] [&_img]:max-w-full [&_img]:rounded-lg [&_h1]:text-[1.35rem] [&_h2]:mt-4 [&_h2]:text-[1.1rem] [&_a]:text-accent [&>:first-child]:mt-0 [&>:last-child]:mb-0"
              dangerouslySetInnerHTML={{
                __html: renderReleaseNotes(release.notes || 'This release has no notes.'),
              }}
            />
            <p className="mb-0 mt-3 text-[12px] text-muted">
              Wisp restarts after installing and keeps your chats and settings. It updates your
              installed WoW addon when needed and reminds you to type /reload if WoW is open.
            </p>
          </section>
        )}
      </Card>
      <Card density="compact">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="m-0 text-[14px] font-semibold">
              <label htmlFor="wisp-update-channel">Update channel</label>
            </h3>
            <p id="wisp-update-channel-description" className="mb-0 mt-1 text-[13px] text-muted">
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
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 [border-top-style:solid]">
          <p className="m-0 text-[12px] text-muted">Wisp checks at startup and every six hours.</p>
          <a
            href={changelog}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] text-accent no-underline hover:underline"
          >
            View release history <span aria-hidden="true">↗</span>
          </a>
        </div>
      </Card>
    </section>
  );
}
