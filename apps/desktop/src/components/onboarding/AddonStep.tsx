import { native } from '../../api';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import { ActionProgress } from '../ui/ActionProgress';
import { Button, Input, Select } from '../ui/Controls';
import Icon from '../ui/Icon';
import { Row } from '../ui/Rows';

/**
 * First-run addon step: shows the WoW Forever folder Wisp found, so installing
 * is one click (the wizard footer holds Install addon). Choosing another
 * folder or searching again stays available but secondary.
 */
export default function AddonStep() {
  const app = useDesktop((state) => ({
    busy: state.busy,
    locked: desktopLocked(state),
    wow: state.wow,
    detecting: state.detectingGame,
    detectionFailed: state.detectionFailed,
    detectedFolders: state.detectedFolders,
  }));
  const { searchInstallations, selectFolder, chooseFolder, importPrevious } = useDesktopActions();
  const folderDisabled = !native || !!app.busy;
  const multiple = app.detectedFolders.length > 1;
  const detected = app.detectedFolders.includes(app.wow);
  const choosing = app.busy === 'Choosing folder';
  const found = !app.detecting && !!app.wow;

  const status = multiple
    ? `Found ${app.detectedFolders.length} WoW Forever installations.`
    : detected
      ? 'WoW Forever found.'
      : app.detectionFailed
        ? 'Could not search automatically. Choose your WoW Forever folder.'
        : app.wow
          ? 'Using your selected folder.'
          : 'No WoW Forever installation found. Choose your folder to continue.';

  return (
    <>
      <div className="flex flex-col gap-0.5 overflow-hidden rounded-[6px]">
        <Row
          icon={
            <span className={`flex ${found ? 'text-accent' : 'text-muted'}`}>
              <Icon name={found ? 'circleCheck' : 'folder'} size={18} />
            </span>
          }
          title={app.detecting ? 'Looking for WoW Forever' : status}
          trailing={
            <Button
              intent="quiet"
              onClick={searchInstallations}
              disabled={app.locked || app.detecting}
            >
              <Icon name="refresh" size={14} />
              Search again
            </Button>
          }
        >
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
            {app.detecting ? (
              <ActionProgress label="Finding WoW Forever" />
            ) : (
              <>
                {multiple ? (
                  <Select
                    className="min-w-[220px] flex-1"
                    aria-label="Detected Forever installations"
                    value={app.wow || null}
                    onValueChange={selectFolder}
                    options={[
                      ...(app.wow && !detected ? [app.wow] : []),
                      ...app.detectedFolders,
                    ].map((folder) => ({ value: folder, label: folder }))}
                    placeholder="Choose a Forever installation"
                    disabled={folderDisabled}
                  />
                ) : (
                  <Input
                    className="min-w-[220px] flex-1"
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
                  <Icon name="folder" size={16} />
                  {choosing ? 'Choosing…' : 'Choose folder'}
                </Button>
              </>
            )}
          </div>
        </Row>
      </div>
      {!app.detecting && (
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
    </>
  );
}
