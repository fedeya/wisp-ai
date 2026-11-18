import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { native } from '../api';
import GameInstallation from '../components/settings/GameInstallation';
import { ActionProgress, Spinner } from '../components/ui/ActionProgress';
import { Button } from '../components/ui/Controls';
import Icon from '../components/ui/Icon';
import { Row, RowGroup } from '../components/ui/Rows';
import { desktopConnected, desktopLocked, desktopReadiness } from '../desktop-controller';
import { useDesktop, useDesktopActions } from '../use-desktop';

type Readiness = ReturnType<typeof desktopReadiness>;
type Tone = 'ok' | 'problem' | 'pending' | 'idle';

const states: Record<Readiness, { title: string; description: string; tone: Tone }> = {
  loading: {
    title: 'Checking Wisp…',
    description: 'Checking your installation and connections.',
    tone: 'pending',
  },
  update: {
    title: 'Update your Wisp addon',
    description: 'The addon in your WoW folder is older than this app.',
    tone: 'problem',
  },
  starting: {
    title: 'Wisp is starting',
    description: 'The checks update when the local service is ready.',
    tone: 'pending',
  },
  unavailable: {
    title: 'Wisp is unavailable',
    description: 'The local service isn’t running. Diagnostics shows why.',
    tone: 'problem',
  },
  setup: {
    title: 'Set up World of Warcraft',
    description: 'Install the Wisp addon to use your companion in game.',
    tone: 'problem',
  },
  agent: {
    title: 'Waiting for the agent',
    description: 'You can manage AI providers and saved data while you wait.',
    tone: 'pending',
  },
  account: {
    title: 'Connect your AI account',
    description: 'Wisp needs a model to answer in game.',
    tone: 'problem',
  },
  waiting: {
    title: 'Wisp is ready',
    description: 'Open WoW and type /wisp in chat.',
    tone: 'ok',
  },
  ready: {
    title: 'Wisp is ready',
    description: 'Type /wisp in WoW chat to open your companion.',
    tone: 'ok',
  },
};

const toneIcon = {
  ok: <Icon name="circleCheck" size={18} />,
  problem: <Icon name="circleAlert" size={18} />,
  pending: <Spinner />,
  idle: <Icon name="clock" size={18} />,
};
const toneColor = {
  ok: 'text-accent',
  problem: 'text-[#e8ba78]',
  pending: 'text-muted',
  idle: 'text-muted',
};

function useOverview() {
  return useDesktop((state) => ({
    readiness: desktopReadiness(state),
    loading: state.loading,
    starting: state.starting,
    info: state.info,
    status: state.status,
    connected: desktopConnected(state),
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
    canInstall: !!state.wow,
    modelName: state.models.find((model) => model.slug === state.status?.model)?.displayName,
  }));
}

function Check({
  tone,
  title,
  detail,
  trailing,
}: {
  tone: Tone;
  title: string;
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <Row
      highlight={tone === 'problem'}
      icon={<span className={`flex ${toneColor[tone]}`}>{toneIcon[tone]}</span>}
      title={title}
      detail={detail}
      trailing={trailing}
    />
  );
}

export default function Overview() {
  const app = useOverview();
  const { install, dismissAddonReload } = useDesktopActions();
  const navigate = useNavigate();
  const state = app.readiness;
  const { title, description, tone } = states[state];
  const updateFailed = app.info?.addonUpdateNotice === 'failed';
  const working = app.busy || (state === 'starting' ? 'Starting Wisp' : '');
  const diagnostics = (
    <Button intent="quiet" onClick={() => void navigate('/diagnostics')}>
      View diagnostics
    </Button>
  );

  return (
    <>
      <header className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3" aria-live="polite">
        <span
          className={`grid size-10 shrink-0 place-items-center rounded-[8px] ${
            tone === 'ok'
              ? 'bg-accent-dim text-accent'
              : tone === 'problem'
                ? 'bg-[#3a2f1e] text-[#e8ba78]'
                : 'bg-white/[0.06] text-muted'
          }`}
        >
          {tone === 'ok' ? (
            <Icon name="circleCheck" size={22} />
          ) : tone === 'problem' ? (
            <Icon name="warning" size={20} />
          ) : (
            <Spinner />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="mb-0">{title}</h1>
          <p className="mt-0.5 text-[14px] text-muted">
            {state === 'update' && updateFailed
              ? 'Wisp couldn’t update the addon automatically. Try updating it again below.'
              : description}
          </p>
        </div>
        {tone === 'ok' && <CopyCommand />}
      </header>
      <div className="has-[.action-progress:not(:empty)]:-mt-3 has-[.action-progress:not(:empty)]:mb-5">
        <ActionProgress label={working || (state === 'loading' ? 'Checking connections' : '')} />
      </div>

      {!app.loading && app.info && !app.info.configured && <GameInstallation firstRun />}

      {!app.loading && app.info?.configured && (
        <RowGroup label="Checks">
          {state === 'update' ? (
            <Check
              tone="problem"
              title={updateFailed ? 'Addon update failed' : 'Addon out of date'}
              detail="Update the addon, then type /reload in WoW."
              trailing={
                <Button
                  intent="primary"
                  disabled={!native || app.locked || !app.canInstall}
                  onClick={install}
                >
                  {app.busyTarget === 'installation' ? 'Updating addon…' : 'Update addon'}
                </Button>
              }
            />
          ) : app.info.addonUpdateNotice === 'reload_required' ? (
            <Check
              tone="ok"
              title="Addon updated"
              detail="Wisp updated the addon. Type /reload in WoW to finish updating."
              trailing={
                <Button intent="quiet" onClick={dismissAddonReload}>
                  Dismiss
                </Button>
              }
            />
          ) : (
            <Check tone="ok" title="Addon installed" detail="Up to date" />
          )}

          {app.status?.ready ? (
            <Check tone="ok" title="Wisp service running" />
          ) : app.status ? (
            <Check
              tone="pending"
              title="Starting the agent"
              detail="This usually takes a few seconds."
              trailing={diagnostics}
            />
          ) : app.starting || state === 'starting' ? (
            <Check tone="pending" title="Starting the Wisp service" />
          ) : (
            <Check
              tone="problem"
              title="Wisp service isn’t running"
              detail="Wisp runs a local service while it’s in the tray."
              trailing={diagnostics}
            />
          )}

          {!app.status ? (
            <Check tone="idle" title="AI provider" detail="Checked when the Wisp service starts." />
          ) : app.connected ? (
            <Check
              tone="ok"
              title="AI provider connected"
              detail={app.modelName || app.status.model}
              trailing={
                <Button intent="quiet" onClick={() => void navigate('/connections')}>
                  Change
                </Button>
              }
            />
          ) : (
            <Check
              tone="problem"
              title="No AI provider connected"
              detail="Use your ChatGPT plan or an API key."
              trailing={
                <Button intent="primary" onClick={() => void navigate('/connections')}>
                  Connect AI
                </Button>
              }
            />
          )}

          {app.status?.gameConnected ? (
            <Check tone="ok" title="World of Warcraft" detail="Connected" />
          ) : (
            <Check
              tone="idle"
              title="World of Warcraft"
              detail="Connects automatically when you log in with the addon enabled."
              trailing={<span className="text-[13px] text-muted">Not connected</span>}
            />
          )}
        </RowGroup>
      )}
    </>
  );
}

function CopyCommand() {
  const [message, setMessage] = useState('');

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText('/wisp');
      setMessage('Copied');
    } catch {
      setMessage('Type /wisp in WoW chat');
    }
    setTimeout(() => setMessage(''), 2000);
  }

  return (
    <div className="flex items-center gap-2">
      <span role="status" className="text-[13px] text-muted">
        {message}
      </span>
      <Button onClick={copyCommand} aria-label="Copy /wisp command">
        <code className="font-mono text-accent">/wisp</code>
        <Icon name="copy" size={14} />
      </Button>
    </div>
  );
}
