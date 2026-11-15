import { native } from '../../api';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import { ActionProgress } from '../ui/ActionProgress';
import { Button, Card, Input, Select } from '../ui/Controls';
import Icon from '../ui/Icon';

export default function GameInstallation({ firstRun = false }: { firstRun?: boolean }) {
  const app = useDesktop((state) => ({
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
    outdated: state.info?.addonOutdated,
    wow: state.wow,
    detecting: state.detectingGame,
    detectionFailed: state.detectionFailed,
    detectedFolders: state.detectedFolders,
  }));
  const { searchInstallations, selectFolder, chooseFolder, install, importPrevious } =
    useDesktopActions();
  const choosing = app.busy === 'Choosing folder';
  const installing = app.busy === 'Installing addon';
  const multipleFolders = firstRun && app.detectedFolders.length > 1;
  const detected = firstRun && app.detectedFolders.includes(app.wow);
  const folderDisabled = !native || !!app.busy;

  return (
    <Card className="mb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2>{firstRun ? 'Install the Wisp addon' : 'Game installation'}</h2>
          {app.outdated && (
            <p className="text-muted">Update the addon, then type /reload in WoW.</p>
          )}
        </div>
        {firstRun && (
          <Button
            intent="quiet"
            onClick={searchInstallations}
            disabled={app.locked || app.detecting}
          >
            <Icon name="refresh" size={16} />
            Search again
          </Button>
        )}
      </div>
      {app.detecting ? (
        <div className="mt-3">
          <ActionProgress label="Finding WoW Forever" />
        </div>
      ) : (
        <>
          {firstRun && (
            <p className={`mt-3 text-[13px] ${detected ? 'text-accent' : 'text-muted'}`}>
              {multipleFolders
                ? `Found ${app.detectedFolders.length} WoW Forever installations.`
                : detected
                  ? 'WoW Forever found.'
                  : app.detectionFailed
                    ? 'Could not search automatically. Choose your WoW Forever folder.'
                    : app.wow
                      ? 'Using your selected folder.'
                      : 'No WoW Forever installation found. Choose your folder to continue.'}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {multipleFolders ? (
              <Select
                className="min-w-[220px] flex-1"
                id="detected-game"
                aria-label="Detected Forever installations"
                value={app.wow || null}
                onValueChange={selectFolder}
                options={[...(app.wow && !detected ? [app.wow] : []), ...app.detectedFolders].map(
                  (folder) => ({ value: folder, label: folder }),
                )}
                placeholder="Choose a Forever installation"
                disabled={folderDisabled}
              />
            ) : (
              <Input
                className="min-w-[220px] flex-1 cursor-pointer"
                aria-label="WoW client folder"
                value={app.wow}
                placeholder="World of Warcraft folder"
                disabled={folderDisabled}
                readOnly
                aria-haspopup="dialog"
                onClick={chooseFolder}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void chooseFolder();
                }}
              />
            )}
            <Button onClick={chooseFolder} disabled={folderDisabled} aria-busy={choosing}>
              <Icon name="folder" size={17} />
              {choosing ? 'Choosing…' : 'Choose folder'}
            </Button>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              intent="primary"
              onClick={install}
              disabled={!native || app.locked || !app.wow}
              aria-busy={installing}
            >
              {installing
                ? 'Installing…'
                : firstRun
                  ? 'Install addon'
                  : app.outdated
                    ? 'Update addon'
                    : 'Install / update addon'}
              {firstRun && <Icon name="arrow" size={16} />}
            </Button>
          </div>
        </>
      )}
      {firstRun && !app.detecting && (
        <Button
          intent="quiet"
          size="text"
          className="mt-3"
          onClick={importPrevious}
          disabled={folderDisabled}
        >
          Already using Wisp? Import your previous installation.
        </Button>
      )}
    </Card>
  );
}
