import { desktopLocked } from '../desktop-controller';
import { ActionProgress } from '../components/ui/ActionProgress';
import DataState from '../components/ui/DataState';
import Toggle from '../components/ui/Toggle';
import { Card } from '../components/ui/Controls';
import { useDesktop } from '../use-desktop';

export default function Memory() {
  const app = useDesktop((state) => ({
    loading: state.loading,
    status: state.status,
    busyTarget: state.busyTarget,
    busy: state.busy,
    locked: desktopLocked(state),
    setIntegration: state.actions.setIntegration,
  }));
  if (app.loading || !app.status) return <DataState />;
  const entries = app.status.integrations.filter((entry) => entry.group === 'memory');

  if (!entries.length) {
    return (
      <Card kind="empty" className="text-center [&_>_svg]:text-[#577e7c] [&_>_svg]:mb-[16px]">
        <h2 className="text-[21px]">No memory controls available</h2>
        <p className="mx-auto text-muted text-[13px] max-w-[400px] mt-[12px] mb-[23px]">
          Memory preferences will appear when Wisp makes them available.
        </p>
      </Card>
    );
  }

  return entries.map((entry) => (
    <Card key={entry.id} kind="toggle" className="gap-[22px] flex items-center justify-between">
      <div className="toggle-description gap-[18px] flex items-center">
        <div>
          <h2 className="text-[15px] max-lg:text-[14px]">{entry.name}</h2>
          <p className="text-muted text-[12px]">{entry.description}</p>
        </div>
      </div>
      <div className="row-controls gap-[14px] flex items-center shrink-0">
        <ActionProgress label={app.busyTarget === entry.id ? app.busy : ''} />
        <Toggle
          label={`Enable ${entry.name}`}
          checked={entry.enabled}
          disabled={app.locked}
          onChange={(checked) => app.setIntegration(entry.id, checked)}
        />
      </div>
    </Card>
  ));
}
