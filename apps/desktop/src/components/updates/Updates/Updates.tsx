import { listen } from '@tauri-apps/api/event';
import { renderReleaseNotes } from '@wisp/releases';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { desktop, native } from '../../../api';
import { Button, Card, Select } from '../../ui/Controls';

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
  | { kind: 'installing'; progress: string };

type UpdateState = {
  channel: string | null;
  operation: UpdateOperation | null;
  release: Release | null;
  supported: boolean;
  error: string;
  dismissed: string;
  lastChecked: string;
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
  const channelLoaded = savedChannel !== null;
  const message = !lastChecked
    ? ''
    : !supported
      ? 'Updates are available in the installed Windows x64 release.'
      : release
        ? `Version ${release.version} is available.`
        : 'You’re up to date.';

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
    setState({ operation: { kind: 'installing', progress: 'Downloading update…' }, error: '' });
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
        setState({ operation: { kind: 'installing', progress: progressMessage(payload) } });
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

  return (
    <Card>
      <div className="section-title flex items-center justify-between gap-[18px]">
        <div>
          <h2>App updates</h2>
          <p className="text-[13px] text-muted">Installed version: {version}</p>
        </div>
        <Button onClick={check} disabled={!native || !channelLoaded || !!operation || locked}>
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
          value={operation?.kind === 'changing-channel' ? operation.channel : channel}
          onValueChange={(next) => void changeChannel(next)}
          options={updateChannels}
          disabled={!native || !channelLoaded || !!operation || locked}
        />
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
        {installing ? operation.progress : message}
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
              disabled={!supported || !!operation || locked}
            >
              {installing ? 'Updating…' : 'Update and restart'}
            </Button>
          </div>
          <p className="field-hint mt-3 text-[11px]! text-muted">
            Wisp downloads and verifies the update, waits for any active reply, then opens the
            Windows updater. Wisp closes during installation and reopens automatically when it is
            ready. Your chats and settings are kept. Wisp also updates your installed addon when
            needed and reminds you to type /reload if WoW is open.
          </p>
        </>
      )}
    </Card>
  );
}
