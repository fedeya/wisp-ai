import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { native } from '../api';
import GameInstallation from '../components/settings/GameInstallation';
import { ActionProgress, Spinner } from '../components/ui/ActionProgress';
import { Button } from '../components/ui/Controls';
import Icon from '../components/ui/Icon';
import { Row, RowGroup } from '../components/ui/Rows';
import { desktopConnected, desktopLocked, desktopReadiness } from '../desktop-controller';
import { useDesktop, useDesktopActions } from '../use-desktop';
import {
  overviewChecks,
  overviewHeader,
  type CheckAction,
  type CheckTone,
  type OverviewCheck,
} from './overview-checks';

const toneIcon = {
  ok: <Icon name="circleCheck" size={18} />,
  problem: <Icon name="circleAlert" size={18} />,
  pending: <Spinner />,
  idle: <Icon name="clock" size={18} />,
} satisfies Record<CheckTone, ReactNode>;
const toneColor = {
  ok: 'text-accent',
  problem: 'text-warning',
  pending: 'text-muted',
  idle: 'text-muted',
} satisfies Record<CheckTone, string>;

function useOverview() {
  return useDesktop((state) => ({
    readiness: desktopReadiness(state),
    loading: state.loading,
    starting: state.starting,
    info: state.info,
    status: state.status,
    providerConnected: desktopConnected(state),
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
    canInstall: !!state.wow,
    modelName: state.models.find((model) => model.slug === state.status?.model)?.displayName,
  }));
}

function HeaderIcon({ tone }: { tone: CheckTone }) {
  if (tone === 'ok') {
    return (
      <span className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-accent-dim text-accent">
        <Icon name="circleCheck" size={22} />
      </span>
    );
  }
  if (tone === 'problem') {
    return (
      <span className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-warning-dim text-warning">
        <Icon name="warning" size={20} />
      </span>
    );
  }
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-control text-muted">
      <Spinner />
    </span>
  );
}

export default function Overview() {
  const app = useOverview();
  const { install, dismissAddonReload } = useDesktopActions();
  const navigate = useNavigate();
  const notice = app.info?.addonUpdateNotice;
  const header = overviewHeader(app.readiness, notice);
  const checks = overviewChecks({
    readiness: app.readiness,
    addonUpdateNotice: notice,
    status: app.status,
    starting: app.starting,
    providerConnected: app.providerConnected,
    modelName: app.modelName,
  });
  const working = app.busy || (app.readiness === 'starting' ? 'Starting Wisp' : '');

  function actionButton(action: CheckAction) {
    switch (action) {
      case 'update-addon':
        return (
          <Button
            intent="primary"
            disabled={!native || app.locked || !app.canInstall}
            onClick={install}
          >
            {app.busyTarget === 'installation' ? 'Updating addon…' : 'Update addon'}
          </Button>
        );
      case 'dismiss-reload':
        return (
          <Button intent="quiet" onClick={dismissAddonReload}>
            Dismiss
          </Button>
        );
      case 'view-diagnostics':
        return (
          <Button intent="quiet" onClick={() => void navigate('/settings/diagnostics')}>
            View diagnostics
          </Button>
        );
      case 'change-provider':
        return (
          <Button intent="quiet" onClick={() => void navigate('/connections')}>
            Change
          </Button>
        );
      case 'connect-provider':
        return (
          <Button intent="primary" onClick={() => void navigate('/connections')}>
            Connect AI
          </Button>
        );
    }
  }

  function trailing(check: OverviewCheck) {
    if (check.action) return actionButton(check.action);
    if (check.status) return <span className="text-sm text-muted">{check.status}</span>;
    return undefined;
  }

  return (
    <>
      <header className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3" aria-live="polite">
        <HeaderIcon tone={header.tone} />
        <div className="min-w-0 flex-1">
          <h1 className="mb-0">{header.title}</h1>
          <p className="mt-0.5 text-base text-muted">{header.description}</p>
        </div>
        {header.tone === 'ok' && <CopyCommand />}
      </header>
      <div className="has-[.action-progress:not(:empty)]:-mt-3 has-[.action-progress:not(:empty)]:mb-5">
        <ActionProgress
          label={working || (app.readiness === 'loading' ? 'Checking connections' : '')}
        />
      </div>

      {!app.loading && app.info && !app.info.configured && <GameInstallation firstRun />}

      {!app.loading && app.info?.configured && (
        <RowGroup label="Checks">
          {checks.map((check) => (
            <Row
              key={check.id}
              highlight={check.tone === 'problem'}
              icon={<span className={`flex ${toneColor[check.tone]}`}>{toneIcon[check.tone]}</span>}
              title={check.title}
              detail={check.detail}
              trailing={trailing(check)}
            />
          ))}
        </RowGroup>
      )}
    </>
  );
}

function CopyCommand() {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText('/wisp');
      setMessage('Copied');
    } catch {
      setMessage('Type /wisp in WoW chat');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(''), 2000);
  }

  return (
    <div className="flex items-center gap-2">
      <span role="status" className="text-sm text-muted">
        {message}
      </span>
      <Button onClick={copyCommand} aria-label="Copy /wisp command">
        <code className="font-mono text-accent">/wisp</code>
        <Icon name="copy" size={14} />
      </Button>
    </div>
  );
}
