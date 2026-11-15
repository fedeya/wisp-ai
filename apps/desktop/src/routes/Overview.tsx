import { desktopConnected, desktopActive, desktopLocked } from '../desktop-controller';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { native } from '../api';
import { ActionProgress, Spinner } from '../components/ui/ActionProgress';
import Icon from '../components/ui/Icon';
import { Badge, Button, Card, Input, Select } from '../components/ui/Controls';
import { useDesktop } from '../use-desktop';

function useOverview() {
  return useDesktop((state) => ({
    loading: state.loading,
    info: state.info,
    detectingGame: state.detectingGame,
    status: state.status,
    starting: state.starting,
    connectionError: state.connectionError,
    connected: desktopConnected(state),
    active: desktopActive(state),
    busy: state.busy,
    locked: desktopLocked(state),
    wow: state.wow,
    install: state.actions.install,
    start: state.actions.start,
    stop: state.actions.stop,
    busyTarget: state.busyTarget,
    searchInstallations: state.actions.searchInstallations,
    detectedFolders: state.detectedFolders,
    selectFolder: state.actions.selectFolder,
    detectionFailed: state.detectionFailed,
    chooseFolder: state.actions.chooseFolder,
    importPrevious: state.actions.importPrevious,
  }));
}

type OverviewState = ReturnType<typeof useOverview>;

const steps = {
  searching: {
    title: 'Finding WoW Forever',
    description: 'Searching for your game installation.',
  },
  loading: {
    title: 'Checking Wisp…',
    description: 'Checking your installation and connections.',
  },
  install: {
    title: 'Welcome to Wisp',
    description: 'Install the addon, connect an AI provider, and meet Wisp in game.',
  },
  update: {
    title: 'Update your Wisp addon',
    description: 'Install the latest addon, then type /reload in WoW to finish updating.',
  },
  starting: {
    title: 'Getting Wisp ready…',
    description: 'Waiting for the local service. Your connections will update automatically.',
  },
  start: {
    title: 'Start Wisp to continue',
    description: 'Your installation is saved. Start the local service to reconnect.',
  },
  account: {
    title: 'Connect your AI account',
    description: 'Connect ChatGPT or an API provider, then choose a default model.',
  },
  game: {
    title: 'Ready when you enter Azeroth',
    description: 'Open WoW with Wisp AI enabled. Already in game? Type /reload.',
  },
  ready: {
    title: 'Everything is ready',
    description: 'Open /wisp in game, or hover an item and use your inline shortcut.',
  },
};

function nextStep(app: OverviewState): keyof typeof steps {
  if (app.loading) return 'loading';
  if (!app.info?.configured) return app.detectingGame ? 'searching' : 'install';
  if (app.info.addonOutdated) return 'update';
  if (!app.status) return app.starting && !app.connectionError ? 'starting' : 'start';
  if (!app.status.ready) return 'starting';
  if (!app.connected) return 'account';
  return app.status.gameConnected ? 'ready' : 'game';
}

function serviceStatus(app: OverviewState) {
  if (app.active) return 'Working…';
  if (app.loading) return 'Checking…';
  if (app.status?.ready) return 'Running';
  if (app.connectionError) return 'Unavailable';
  return app.starting || app.status ? 'Starting…' : 'Stopped';
}

function LiveDot({ online }: { online?: boolean }) {
  return (
    <span
      className={`live-dot w-[6px] h-[6px] rounded-[50%] bg-[#6e7f85] inline-block shrink-0 [&.online]:bg-accent [&.online]:shadow-[0_0_10px_#77dbc633]${online ? ' online' : ''}`}
    />
  );
}

export default function Overview() {
  const app = useOverview();
  const navigate = useNavigate();
  const connect = () => void navigate('/connections');
  const [editingInstallation, setEditingInstallation] = useState(false);
  const choosingFolder = app.busy === 'Choosing folder';
  const configured = app.info?.configured;
  const outdated = app.info?.addonOutdated;
  const installationOpen = !configured || !!outdated || editingInstallation;
  const next = nextStep(app);
  const installationBusy = !!app.busy || !native;
  const installDisabled = app.locked || !app.wow || !native;

  return (
    <>
      <Card
        kind="workspace"
        ready={next === 'ready'}
        className="[background:linear-gradient(120deg,_#1d2c2d,_var(--surface)_80%)] [&_>_.action-progress:not(:empty)]:mt-[12px]"
      >
        <div className="status-heading gap-[18px] flex items-start">
          <div className="status-symbol border border-solid border-[#3c6258] w-[52px] h-[52px] shrink-0 grid [place-items:center] [background:#243e38] rounded-[14px] text-accent">
            <Icon name={next === 'ready' ? 'check' : 'spark'} size={27} />
          </div>
          <div>
            <span className="eyebrow gap-[8px] text-[#8fa5ac] text-[9px] font-semibold tracking-[1.3px] flex items-center">
              YOUR WORKSPACE
            </span>
            <h2 className="text-[25px] mt-[8px] leading-[1.3] tracking-[-0.6px] max-md:text-[23px]">
              {steps[next].title}
            </h2>
            <p className="text-muted text-[14px] max-w-[570px]">{steps[next].description}</p>
          </div>
        </div>
        <div className="actions status-actions gap-[10px] mt-[22px] flex flex-wrap items-center mr-0 mb-[24px] ml-[70px] min-h-[37px]">
          {next === 'update' && (
            <Button intent="primary" disabled={installDisabled} onClick={app.install}>
              {app.busy === 'Installing addon' ? 'Updating addon…' : 'Update addon'}
            </Button>
          )}
          {next === 'start' && (
            <Button intent="primary" disabled={installationBusy} onClick={app.start}>
              Start Wisp
            </Button>
          )}
          {next === 'account' && (
            <Button intent="primary" onClick={connect}>
              Connect AI
              <Icon name="arrow" size={16} />
            </Button>
          )}
          {next === 'game' && (
            <>
              <Badge>Waiting for WoW</Badge>
              <Button intent="quiet" onClick={() => setEditingInstallation(true)}>
                Check installation
              </Button>
            </>
          )}
          {next === 'ready' && (
            <Badge className="good text-accent!">
              <span className="live-dot online w-[6px] h-[6px] rounded-[50%] [background:var(--accent)] inline-block shrink-0 [box-shadow:0_0_10px_#77dbc633]" />
              Ready to help
            </Badge>
          )}
          {(next === 'loading' || next === 'starting') && <Spinner />}
        </div>
        <div className="connection-summary border-t-[1px] [border-top-style:solid] border-t-[var(--border)] pt-[8px] [&_>_div_>_span:nth-child(2)]:w-[150px] [&_>_div_>_span:nth-child(2)]:text-muted">
          <div className="gap-[10px] flex items-center min-h-[46px] text-[13px]">
            <LiveDot online={app.status?.gameConnected} />
            <span>World of Warcraft</span>
            <strong className="font-medium">
              {app.loading
                ? 'Checking…'
                : !app.status
                  ? 'Not checked'
                  : app.status.gameConnected
                    ? 'Connected'
                    : 'Waiting for game'}
            </strong>
          </div>
          <div className="gap-[10px] flex items-center min-h-[46px] text-[13px]">
            <LiveDot online={app.connected} />
            <span>AI provider</span>
            <strong className="font-medium">
              {app.loading
                ? 'Checking…'
                : !app.status
                  ? 'Not checked'
                  : app.connected
                    ? 'Connected'
                    : 'Not connected'}
            </strong>
            {!app.loading && !app.connected && app.status && (
              <Button intent="quiet" size="text" className="ml-auto text-[12px]" onClick={connect}>
                Connect
              </Button>
            )}
          </div>
          <div className="gap-[10px] flex items-center min-h-[46px] text-[13px]">
            <LiveDot online={app.status?.ready} />
            <span>Wisp service</span>
            <strong className="font-medium">{serviceStatus(app)}</strong>
            {app.status && (
              <Button
                intent="quiet"
                size="text"
                className="ml-auto text-[12px]"
                disabled={app.locked}
                onClick={app.stop}
              >
                Stop Wisp
              </Button>
            )}
          </div>
        </div>
        <ActionProgress label={app.busyTarget === '' ? app.busy : ''} />
      </Card>
      {!app.loading && (
        <Card kind="installation">
          <div className="section-title gap-[18px] flex items-center justify-between max-xl:flex-wrap [&_>_svg]:text-muted">
            <div className="installation-heading gap-[14px] flex items-center min-w-[0] [&_>_svg]:text-muted [&_>_svg]:shrink-0">
              <Icon name="folder" size={20} />
              <div className="min-w-[0]">
                <h2>Game installation</h2>
                {configured && (
                  <p className="installation-path [overflow-wrap:anywhere] text-muted text-[13px]">
                    {app.info?.wow || app.wow}
                  </p>
                )}
              </div>
            </div>
            {configured ? (
              <div className="installation-controls gap-[10px] flex items-center shrink-0 flex-wrap">
                <Badge positive={!outdated}>{outdated ? 'Update needed' : 'Addon installed'}</Badge>
                <Button
                  intent="quiet"
                  aria-expanded={installationOpen}
                  onClick={() => setEditingInstallation((editing) => !editing)}
                >
                  {installationOpen && !outdated ? 'Done' : 'Manage installation'}
                </Button>
              </div>
            ) : (
              <Button
                intent="quiet"
                disabled={!native || app.locked || app.detectingGame}
                onClick={app.searchInstallations}
                aria-label="Search again"
                title="Search again"
              >
                <Icon name="refresh" size={17} />
                Search again
              </Button>
            )}
          </div>
          {installationOpen && (
            <>
              {!configured && app.detectingGame ? (
                <p
                  className="field-hint installation-search gap-[10px] flex items-center text-[11px]! text-muted mt-[12px]"
                  role="status"
                >
                  <Spinner />
                  Searching for installation…
                </p>
              ) : (
                <>
                  {!configured && app.detectedFolders.length > 1 && (
                    <>
                      <label
                        className="field-hint text-[11px]! text-muted mt-[12px]"
                        htmlFor="detected-game"
                      >
                        Found multiple Forever installations
                      </label>
                      <Select
                        id="detected-game"
                        aria-label="Detected Forever installations"
                        value={app.wow}
                        onChange={({ currentTarget }) => app.selectFolder(currentTarget.value)}
                        disabled={!!app.busy}
                      >
                        {app.wow && !app.detectedFolders.includes(app.wow) && (
                          <option value={app.wow}>{app.wow}</option>
                        )}
                        {app.detectedFolders.map((folder) => (
                          <option value={folder} key={folder}>
                            {folder}
                          </option>
                        ))}
                      </Select>
                    </>
                  )}
                  {!configured && app.detectedFolders.length === 0 && (
                    <p className="field-hint text-[11px]! text-muted mt-[12px]">
                      {app.detectionFailed
                        ? "Couldn't search automatically. Choose your folder or search again."
                        : 'No WoW Forever installation found. Choose your folder or search again.'}
                    </p>
                  )}
                  <div className="folder-field gap-[12px] mt-[17px] flex items-center">
                    {(configured || app.detectedFolders.length < 2) && (
                      <Input
                        className="folder-picker cursor-pointer flex-[1]"
                        aria-label="WoW client folder"
                        value={app.wow}
                        placeholder="Choose your World of Warcraft folder"
                        disabled={installationBusy}
                        readOnly
                        aria-haspopup="dialog"
                        onClick={app.chooseFolder}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') app.chooseFolder();
                        }}
                      />
                    )}
                    <Button
                      onClick={app.chooseFolder}
                      disabled={installationBusy}
                      aria-busy={choosingFolder}
                    >
                      {choosingFolder ? (
                        <>
                          <Spinner />
                          Choosing…
                        </>
                      ) : (
                        <>
                          <Icon name="folder" size={17} />
                          Choose folder
                        </>
                      )}
                    </Button>
                  </div>
                </>
              )}
              {outdated && (
                <p className="field-hint text-[11px]! text-muted mt-[12px]">
                  Update the addon, then type /reload in WoW.
                </p>
              )}
              <p className="field-hint text-[11px]! text-muted mt-[12px]">
                <strong>Use at your own risk.</strong> We don’t know whether Blizzard permits Wisp
                or whether using it could lead to an account ban.
              </p>
              <div className="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
                {((!configured && !app.detectingGame) || (configured && next !== 'update')) && (
                  <Button intent="primary" onClick={app.install} disabled={installDisabled}>
                    {app.busy === 'Installing addon'
                      ? 'Installing…'
                      : configured
                        ? 'Install / update addon'
                        : 'Install addon'}
                  </Button>
                )}
                <ActionProgress label={app.busyTarget === 'installation' ? app.busy : ''} />
              </div>
              {!configured && !app.detectingGame && (
                <Button
                  intent="quiet"
                  size="text"
                  className="import mx-0 text-[12px] mt-[18px] mb-0"
                  onClick={app.importPrevious}
                  disabled={installationBusy || app.detectingGame}
                >
                  Already using Wisp? Import your previous installation.
                </Button>
              )}
            </>
          )}
        </Card>
      )}
    </>
  );
}
