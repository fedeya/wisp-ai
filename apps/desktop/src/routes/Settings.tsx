import { useState } from 'react';
import GameInstallation from '../components/settings/GameInstallation';
import StartupSettings from '../components/settings/StartupSettings';
import TelemetrySettings from '../components/settings/TelemetrySettings';
import { Button } from '../components/ui/Controls';
import Icon from '../components/ui/Icon';
import { Row, RowGroup } from '../components/ui/Rows';
import { desktopActive } from '../desktop-controller';
import { useDesktop } from '../use-desktop';

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
    </>
  );
}
