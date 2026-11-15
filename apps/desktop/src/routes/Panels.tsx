import { desktopLocked } from '../desktop-controller';
import { ActionProgress } from '../components/ui/ActionProgress';
import DataState from '../components/ui/DataState';
import Icon from '../components/ui/Icon';
import { Badge, Button, Card } from '../components/ui/Controls';
import { useDesktop } from '../use-desktop';

export default function Panels() {
  const app = useDesktop((state) => ({
    loading: state.loading,
    status: state.status,
    busyTarget: state.busyTarget,
    busy: state.busy,
    panelAction: state.actions.panelAction,
    locked: desktopLocked(state),
    setConfirmation: state.actions.setConfirmation,
  }));
  if (app.loading || !app.status) return <DataState />;
  const { gameConnected, panels } = app.status;
  if (!panels.length) {
    return (
      <Card kind="empty" density="compact" className="[&_>_svg]:mb-2 [&_>_svg]:text-[#577e7c]">
        <Icon name="panel" size={34} />
        <h2 className="text-[21px]">No panels yet.</h2>
        <p className="mx-auto mt-1 mb-0 max-w-[400px] text-[13px] text-muted">
          Ask Wisp in game to create a tracker or panel. Your saved panels will appear here.
        </p>
      </Card>
    );
  }

  return (
    <>
      {!gameConnected && (
        <p className="field-hint offline-hint text-[11px]! text-muted mt-[12px]">
          Connect WoW to show or hide panels. Your saved panels remain available here.
        </p>
      )}
      {panels.map((panel) => (
        <Card
          key={panel.id}
          kind="panel"
          density="compact"
          className="gap-[20px] flex justify-between items-center max-xl:gap-[12px] max-xl:items-stretch max-xl:flex-col"
        >
          <div className="integration-top gap-[18px] flex items-center justify-between flex-[1]">
            <div>
              <h2>{panel.title}</h2>
              <p className="mt-1 text-[13px] text-muted">{panel.character}</p>
            </div>
            <Badge>{panel.bindings?.length || 0} tracked values</Badge>
          </div>
          <div className="actions gap-[10px] mt-0 flex flex-wrap items-center">
            <ActionProgress label={app.busyTarget === panel.id ? app.busy : ''} />
            <Button
              onClick={() => app.panelAction(panel, 'show')}
              disabled={app.locked || !gameConnected}
            >
              Show in WoW
            </Button>
            <Button
              onClick={() => app.panelAction(panel, 'hide')}
              disabled={app.locked || !gameConnected}
            >
              Hide
            </Button>
            <Button
              intent="quiet"
              destructive
              disabled={app.locked}
              onClick={() =>
                app.setConfirmation({
                  label: `Delete “${panel.title}”?`,
                  run: () => app.panelAction(panel, 'remove'),
                })
              }
            >
              Delete
            </Button>
          </div>
        </Card>
      ))}
    </>
  );
}
