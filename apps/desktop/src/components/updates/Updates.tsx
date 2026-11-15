import { listen } from '@tauri-apps/api/event';
import { renderReleaseNotes } from '@wisp/releases';
import { useCallback, useEffect, useRef, useState } from 'react';
import { desktop, native } from '../../api';
import { Button, Card, Select } from '../ui/controls';

type Release = { version: string; notes: string | null };
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

function progressMessage(progress: Progress) {
  if (progress.phase === 'waiting') return 'Waiting for the active reply to finish…';
  if (progress.phase === 'installing') {
    return 'Opening the Windows updater. Wisp will close and reopen automatically…';
  }
  return progress.total
    ? `Downloading update… ${Math.min(100, Math.round(((progress.downloaded || 0) / progress.total) * 100))}%`
    : 'Downloading update…';
}

export default function Updates({
  showSettings,
  version,
  locked,
  openSettings,
  onBusy,
}: UpdatesProps) {
  const [release, setRelease] = useState<Release | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [supported, setSupported] = useState(native);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState('');
  const [lastChecked, setLastChecked] = useState('');
  const [progress, setProgress] = useState('Preparing update…');
  const [channel, setChannel] = useState('stable');
  const [channelLoaded, setChannelLoaded] = useState(!native);
  const [requestedChannel, setRequestedChannel] = useState('');
  const operations = useRef({
    checking: false,
    installing: false,
    channelLoaded: !native,
    changingChannel: false,
  });

  const check = useCallback(async () => {
    const status = operations.current;
    if (
      !native ||
      !status.channelLoaded ||
      status.checking ||
      status.installing ||
      status.changingChannel
    ) {
      return;
    }
    status.checking = true;
    setChecking(true);
    setError('');
    try {
      const result = await desktop<{ supported: boolean; update: Release | null }>('check_update');
      setSupported(result.supported);
      setRelease(result.update);
      setLastChecked(new Date().toLocaleString());
      setMessage(
        !result.supported
          ? 'Updates are available in the installed Windows x64 release.'
          : result.update
            ? `Version ${result.update.version} is available.`
            : 'You’re up to date.',
      );
    } catch {
      setError(
        'Could not check for updates. Check your connection and try again. Public releases may not be available yet.',
      );
    } finally {
      status.checking = false;
      setChecking(false);
    }
  }, []);

  async function changeChannel(next: string) {
    const status = operations.current;
    if (status.changingChannel) return;
    status.changingChannel = true;
    setRequestedChannel(next);
    setRelease(null);
    setDismissed('');
    try {
      setChannel(await desktop<string>('update_channel', { channel: next }));
      status.changingChannel = false;
      await check();
    } catch (error) {
      setError(`Could not change update channel: ${String(error)}`);
    } finally {
      status.changingChannel = false;
      setRequestedChannel('');
    }
  }

  async function install() {
    const status = operations.current;
    if (!release || status.installing || locked) return;
    status.installing = true;
    setInstalling(true);
    setError('');
    setProgress('Downloading update…');
    onBusy('Updating Wisp');
    try {
      await desktop('install_update');
    } catch (error) {
      setError(`Update failed: ${String(error).replace(/^Error: /, '')} You can try again.`);
    } finally {
      status.installing = false;
      setInstalling(false);
      onBusy('');
    }
  }

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void listen<Progress>('update-progress', ({ payload }) => {
      if (!disposed && operations.current.installing) setProgress(progressMessage(payload));
    })
      .then((stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
      })
      .catch(() => {
        if (!disposed) setError('Update progress is unavailable. Restart Wisp to try again.');
      });
    void desktop<string>('update_channel')
      .then((saved) => {
        if (disposed) return;
        setChannel(saved);
        operations.current.channelLoaded = true;
        setChannelLoaded(true);
        return check();
      })
      .catch(() => {
        if (!disposed) setError('Could not load the update channel. Restart Wisp to try again.');
      });
    const timer = setInterval(() => void check(), 6 * 60 * 60 * 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [check]);

  if (!showSettings) {
    if (!release || dismissed === release.version) return null;
    return (
      <div
        className="banner mb-5 flex items-center gap-3 rounded-[9px] border border-solid border-[#355c56] bg-[#1c3330] px-4 py-3 text-xs leading-[1.5] text-[#b7e8db]"
        role="status"
      >
        <span>Wisp {release.version} is available.</span>
        <Button onClick={openSettings}>View update</Button>
        <Button intent="quiet" onClick={() => setDismissed(release.version)}>
          Later
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <div className="section-title flex items-center justify-between gap-[18px]">
        <div>
          <h2>App updates</h2>
          <p className="text-[13px] text-muted">Installed version: {version}</p>
        </div>
        <Button
          onClick={check}
          disabled={!native || !channelLoaded || checking || installing || locked}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>
      <p className="field-hint mt-3 text-[11px]! text-muted">
        Wisp checks automatically at startup and every six hours. You choose when to install.
      </p>
      <label className="mt-3 flex items-center text-[13px] text-muted">
        Update channel
        <Select
          className="ml-3 w-auto"
          value={requestedChannel || channel}
          onChange={({ currentTarget }) => void changeChannel(currentTarget.value)}
          disabled={
            !native || !channelLoaded || checking || installing || !!requestedChannel || locked
          }
        >
          <option value="stable">Stable</option>
          <option value="nightly">Nightly</option>
        </Select>
      </label>
      {channel === 'nightly' ? (
        <p className="field-hint mt-3 text-[11px]! text-muted">
          Experimental builds from main. Features may change or break.
        </p>
      ) : (
        version.includes('-nightly.') && (
          <p className="field-hint mt-3 text-[11px]! text-muted">
            Returning to Stable can install an older version. Your chats and settings are kept.
          </p>
        )
      )}
      <p className="mt-3 text-[13px] text-accent">
        <a
          href={`https://wisp.fedeya.sh/changelog${channel === 'nightly' ? '?channel=nightly' : ''}`}
          target="_blank"
          rel="noreferrer"
        >
          View all updates ↗
        </a>
      </p>
      {lastChecked && (
        <p className="field-hint mt-3 text-[11px]! text-muted">Last checked: {lastChecked}</p>
      )}
      <p className="text-[13px] text-muted" role="status">
        {installing ? progress : message}
      </p>
      {error && (
        <p
          className="banner error mb-5 flex items-center gap-3 rounded-[9px] border border-solid border-[#70473f] bg-[#332522] px-4 py-3 text-[13px] leading-[1.5] text-[#f0b4aa]"
          role="alert"
        >
          {error}
        </p>
      )}
      {release && (
        <>
          <h3>Wisp {release.version}</h3>
          <div
            className="release-notes max-h-[280px] overflow-y-auto text-muted [overflow-wrap:anywhere] [&_img]:max-w-full [&_img]:rounded-lg [&_h1]:text-[1.35rem] [&_h2]:mt-5 [&_h2]:text-[1.1rem] [&_a]:text-accent"
            dangerouslySetInnerHTML={{
              __html: renderReleaseNotes(release.notes || 'This release has no notes.'),
            }}
          />
          <div className="actions mt-[22px] flex flex-wrap items-center gap-[10px]">
            <Button
              intent="primary"
              onClick={install}
              disabled={!supported || installing || checking || locked}
            >
              {installing ? 'Updating…' : 'Update and restart'}
            </Button>
          </div>
          <p className="field-hint mt-3 text-[11px]! text-muted">
            Wisp downloads and verifies the update, waits for any active reply, then opens the
            Windows updater. Wisp closes during installation and reopens automatically when it is
            ready. Your chats and settings are kept. Use Install / update addon in Overview after
            updating, then /reload in WoW.
          </p>
        </>
      )}
    </Card>
  );
}
