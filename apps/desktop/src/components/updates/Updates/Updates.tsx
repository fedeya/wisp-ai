// @effect-migrated
import type { Release } from '@wisp/protocol/native-commands';
import { renderReleaseNotes } from '@wisp/releases';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { native } from '../../../api/desktop';
import { Spinner } from '../../ui/ActionProgress';
import { Button, Card, Select } from '../../ui/Controls';
import Icon from '../../ui/Icon';
import { groupLabel } from '../../ui/Rows';
import Toggle from '../../ui/Toggle';
import { availableVersion, createUpdates, scheduledVersion } from './updates-store';
import type { Progress, UpdateOperation } from './updates-store';

const updateChannels = [
  { value: 'stable', label: 'Stable' },
  { value: 'nightly', label: 'Nightly' },
];

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
  const [updates] = useState(createUpdates);
  const state = useStore(updates.store);
  const {
    release,
    operation,
    supported,
    error,
    dismissed,
    lastChecked,
    channel: savedChannel,
    autoInstall,
    autoInstallError,
  } = state;
  const channel = savedChannel ?? 'stable';
  const checking = operation?.kind === 'checking';
  const installing = operation?.kind === 'installing';
  const progress = installing ? operation.progress : null;
  const downloading = progress?.phase === 'downloading';
  const percent = downloading ? downloadPercent(progress) : undefined;
  const size = downloading ? downloadedSize(progress) : null;
  const channelLoaded = savedChannel !== null;
  const canInstall = supported && !!release;
  const available = availableVersion(state);
  /** An older version never installs by itself: the user chooses to go back. */
  const downgrade = release?.downgrade === true;
  /** The version that installs by itself the next time Wisp stays idle. */
  const scheduled = scheduledVersion(state);

  useEffect(() => {
    onAvailable?.(available);
  }, [available, onAvailable]);

  // Runs before the session mounts, so the session starts with the current props.
  useEffect(() => {
    updates.setProps({ idle, locked, onBusy });
  }, [updates, idle, locked, onBusy]);

  useEffect(() => updates.mount(), [updates]);

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
                : downgrade
                  ? 'It’s older than your version, so it only installs when you choose.'
                  : 'See what’s new before installing.'}
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            intent="quiet"
            className="min-h-8 px-2.5 py-1 text-xs text-muted"
            onClick={() => updates.dismiss(release.version)}
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
                  <Button
                    intent="primary"
                    onClick={() => updates.install(statusHeading.current)}
                    disabled={busy}
                  >
                    Update and restart
                  </Button>
                )}
                <Button
                  intent={canInstall ? 'quiet' : 'default'}
                  onClick={updates.check}
                  disabled={busy}
                >
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
              {downgrade &&
                ' This version is older than the one installed, so it never installs by itself.'}
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
            onValueChange={updates.changeChannel}
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
            onChange={updates.changeAutoInstall}
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
