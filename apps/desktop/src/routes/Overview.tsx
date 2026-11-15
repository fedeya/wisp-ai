import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { native } from '../api';
import GameInstallation from '../components/settings/GameInstallation';
import { ActionProgress } from '../components/ui/ActionProgress';
import { Button, Card, Input } from '../components/ui/Controls';
import Icon from '../components/ui/Icon';
import { desktopActive, desktopConnected, desktopLocked } from '../desktop-controller';
import { useDesktop, useDesktopActions } from '../use-desktop';

const states = {
  loading: {
    title: 'Checking Wisp…',
    description: 'Checking your installation and connections.',
  },
  update: {
    title: 'Update your Wisp addon',
    description: 'Update the addon, then type /reload in WoW.',
  },
  starting: {
    title: 'Wisp is starting',
    description: 'Your connections will update when the local service is ready.',
  },
  stopped: {
    title: 'Start Wisp to continue',
    description: 'Start the local service to reconnect to WoW and your AI provider.',
  },
  account: {
    title: 'Connect your AI account',
    description: 'Connect ChatGPT or an API provider and choose a default model.',
  },
  waiting: {
    title: 'Waiting for WoW',
    description: 'Open WoW with the Wisp addon enabled. Once in game, enter this command in chat.',
  },
  ready: {
    title: 'Wisp is ready',
    description: 'Enter this command in WoW chat to open your companion.',
  },
};

function useOverview() {
  return useDesktop((state) => ({
    loading: state.loading,
    info: state.info,
    status: state.status,
    starting: state.starting && !state.connectionError,
    connectionError: state.connectionError,
    connected: desktopConnected(state),
    active: desktopActive(state),
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
    canInstall: !!state.wow,
    modelName: state.models.find((model) => model.slug === state.status?.model)?.displayName,
  }));
}

function overviewState(app: ReturnType<typeof useOverview>): keyof typeof states {
  if (app.loading) return 'loading';
  if (app.info?.addonOutdated) return 'update';
  if (!app.status?.ready) return app.starting || app.status ? 'starting' : 'stopped';
  if (!app.connected) return 'account';
  return app.status.gameConnected ? 'ready' : 'waiting';
}

export default function Overview() {
  const app = useOverview();
  const { install, start, stop } = useDesktopActions();
  const navigate = useNavigate();
  const [editingInstallation, setEditingInstallation] = useState(false);
  const state = overviewState(app);
  const { title, description } = states[state];
  const showCommand = state === 'ready' || state === 'waiting';
  const working = app.busy || (state === 'starting' ? 'Starting Wisp' : '');
  const service = app.active
    ? 'Working…'
    : app.status?.ready
      ? 'Running'
      : app.starting || app.status
        ? 'Starting…'
        : 'Stopped';

  return (
    <>
      <Card
        ready={showCommand}
        className={`p-[26px] md:p-[32px] ${showCommand ? 'bg-[radial-gradient(ellipse_at_top_right,#244740,transparent_74%)]' : ''}`}
        aria-labelledby="overview-title"
      >
        <div className="mb-4 grid h-10 w-10 place-items-center rounded-[10px] border border-solid border-[#41675e] bg-[#243e38] text-accent">
          <Icon
            name={state === 'ready' ? 'check' : state === 'update' ? 'folder' : 'spark'}
            size={22}
          />
        </div>
        <div aria-live="polite">
          <h1 id="overview-title" className="text-[32px]">
            {title}
          </h1>
          <p className="max-w-[65ch] text-muted">{description}</p>
        </div>
        {showCommand && <GameCommand />}
        {state === 'account' && (
          <Button className="mt-4" intent="primary" onClick={() => void navigate('/connections')}>
            Connect AI
            <Icon name="arrow" size={16} />
          </Button>
        )}
        {state === 'update' && (
          <Button
            className="mt-4"
            intent="primary"
            disabled={!native || app.locked || !app.canInstall}
            onClick={install}
          >
            {app.busyTarget === 'installation' ? 'Updating addon…' : 'Update addon'}
          </Button>
        )}
        {state === 'stopped' && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              intent="primary"
              disabled={!native || app.locked || !app.info?.configured}
              onClick={start}
            >
              Start Wisp
            </Button>
            {app.connectionError && (
              <Button intent="quiet" onClick={() => void navigate('/diagnostics')}>
                View diagnostics
              </Button>
            )}
          </div>
        )}
        <div className="has-[.action-progress:not(:empty)]:mt-3">
          <ActionProgress label={working || (state === 'loading' ? 'Checking connections' : '')} />
        </div>
      </Card>

      {!app.loading && app.info?.configured && (
        <>
          <Card
            aria-label="Connection status"
            className="grid grid-cols-3 gap-y-3 divide-x divide-border p-4"
          >
            <ConnectionStatus label="Addon" online={!app.info.addonOutdated}>
              {app.info.addonOutdated ? 'Update needed' : 'Installed'}
            </ConnectionStatus>
            <ConnectionStatus label="World of Warcraft" online={!!app.status?.gameConnected}>
              {app.status?.gameConnected
                ? 'Connected'
                : app.status?.ready
                  ? 'Waiting for game'
                  : 'Not checked'}
            </ConnectionStatus>
            <ConnectionStatus label="Default model" online={app.connected}>
              {app.connected
                ? app.modelName || app.status?.model || 'Connected'
                : app.status?.ready
                  ? 'Not connected'
                  : 'Not checked'}
            </ConnectionStatus>
          </Card>
          <Card kind="installation" className={editingInstallation ? 'mb-3' : ''}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="text-muted">
                  <Icon name="folder" />
                </span>
                <div>
                  <h2>Installation details</h2>
                  <p className="text-[13px] text-muted">
                    Wisp service <span aria-hidden="true">·</span> <span>{service}</span>
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  intent="quiet"
                  aria-expanded={editingInstallation}
                  aria-controls="overview-installation"
                  onClick={() => setEditingInstallation((editing) => !editing)}
                >
                  {editingInstallation ? 'Done' : 'Manage installation'}
                </Button>
                {app.status && (
                  <Button intent="quiet" disabled={app.locked} onClick={stop}>
                    Stop Wisp
                  </Button>
                )}
              </div>
            </div>
          </Card>
          <div id="overview-installation" hidden={!editingInstallation}>
            {editingInstallation && <GameInstallation />}
          </div>
        </>
      )}
    </>
  );
}

function ConnectionStatus({
  label,
  online,
  children,
}: {
  label: string;
  online: boolean;
  children: string;
}) {
  return (
    <div className="min-w-0 px-3 first:pl-0">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="mt-1 flex items-start gap-1.5 font-medium [overflow-wrap:anywhere]">
        {online && (
          <span className="mt-1 shrink-0 text-accent">
            <Icon name="check" size={14} />
          </span>
        )}
        <span>{children}</span>
      </div>
    </div>
  );
}

function GameCommand() {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText('/wisp');
      setMessage('Copied.');
    } catch {
      input.current?.focus();
      input.current?.select();
      setMessage('Press Ctrl+C to copy.');
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2.5">
      <Input
        ref={input}
        className="w-[86px] text-center font-mono text-[16px] font-semibold text-accent"
        aria-label="WoW chat command"
        value="/wisp"
        readOnly
      />
      <Button onClick={copyCommand}>
        <Icon name="copy" size={16} />
        Copy command
      </Button>
      <span role="status" className="text-[13px] text-muted">
        {message}
      </span>
    </div>
  );
}
