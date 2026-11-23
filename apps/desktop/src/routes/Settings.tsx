import { useState } from 'react';
import { Link } from 'react-router';
import ExperimentalSettings from '../components/settings/ExperimentalSettings';
import GameInstallation from '../components/settings/GameInstallation';
import StartupSettings from '../components/settings/StartupSettings';
import TelemetrySettings from '../components/settings/TelemetrySettings';
import { Button } from '../components/ui/Controls';
import Icon from '../components/ui/Icon';
import { Row, RowGroup } from '../components/ui/Rows';
import { desktopActive } from '../desktop-controller';
import { useDesktop } from '../use-desktop';
import { diagnosticsPage } from './desktop-routes';

function GameFolder() {
  const app = useDesktop((state) => ({ info: state.info, active: desktopActive(state) }));
  const [editing, setEditing] = useState(false);
  if (!app.info?.configured) return null;

  return (
    <RowGroup label="World of Warcraft">
      <Row
        icon={<Icon name="folder" size={18} />}
        title="Game folder"
        detail={app.active ? 'Working…' : app.info.wow}
        trailing={
          <Button
            aria-expanded={editing}
            aria-controls="settings-installation"
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? 'Done' : 'Manage installation'}
          </Button>
        }
      >
        <div id="settings-installation" hidden={!editing} className="px-4 pb-4">
          {editing && <GameInstallation />}
        </div>
      </Row>
    </RowGroup>
  );
}

export default function Settings() {
  return (
    <>
      <GameFolder />
      <RowGroup label="App">
        <StartupSettings />
        <TelemetrySettings />
      </RowGroup>
      <ExperimentalSettings />
      <RowGroup label="Troubleshooting">
        <Link
          to={diagnosticsPage.path}
          aria-label="Open diagnostics"
          className="block text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent hover:[&>div]:bg-raised"
        >
          <Row
            icon={<Icon name={diagnosticsPage.icon} size={18} />}
            title={diagnosticsPage.title}
            detail="Logs and connection details to check or share when something isn’t working."
            trailing={<Icon name="chevronRight" size={16} />}
          />
        </Link>
      </RowGroup>
    </>
  );
}
