import { useEffect } from 'react';
import { desktop } from '../api';
import { ActionProgress } from '../components/ui/ActionProgress';
import Icon from '../components/ui/Icon';
import { Button, Card } from '../components/ui/Controls';
import { useDesktop } from '../use-desktop';

export default function Diagnostics() {
  const app = useDesktop((state) => ({
    busyTarget: state.busyTarget,
    busy: state.busy,
    work: state.actions.work,
    connectionError: state.connectionError,
    logs: state.logs,
    info: state.info,
    showLogs: state.actions.showLogs,
  }));
  const { showLogs } = app;
  useEffect(() => {
    void showLogs();
  }, [showLogs]);

  return (
    <Card>
      <div className="section-title gap-[18px] flex items-center justify-between [&_>_svg]:text-muted">
        <div>
          <h2>Local activity</h2>
          <p className="text-muted text-[13px]">
            Logs stay on your computer. Review them before sharing.
          </p>
        </div>
        <div className="actions gap-[10px] mt-0 flex flex-wrap items-center">
          <ActionProgress label={app.busyTarget === '' ? app.busy : ''} />
          <Button onClick={showLogs} disabled={!!app.busy}>
            <Icon name="refresh" size={16} />
            Refresh
          </Button>
          <Button onClick={() => app.work('Opening logs', () => desktop('open_logs'))}>
            Open folder
          </Button>
        </div>
      </div>
      {app.connectionError && (
        <p
          className="banner error gap-[12px] border border-solid border-[#70473f] px-[16px] py-[12px] flex items-center rounded-[9px] [background:#332522] text-[#f0b4aa] mb-[20px] text-[13px] leading-[1.5] [&_.icon-button]:ml-auto"
          role="status"
        >
          Last connection error: {app.connectionError}
        </p>
      )}
      <pre className="logs border border-solid border-[#293a41] p-[18px] [background:#10171b] rounded-[9px] min-h-[320px] max-h-[55vh] overflow-auto text-[11px] [font-family:ui-monospace,_Consolas,_monospace] font-normal not-italic leading-[1.7] text-[#a5b7be] [white-space:pre-wrap] [word-break:break-word] mt-[22px]">
        {app.logs || 'No activity loaded yet. Refresh to read the local bridge logs.'}
      </pre>
      <p className="field-hint text-[11px]! text-muted mt-[12px]">
        Data location: {app.info?.dataDirectory || 'Available in the installed app'}
      </p>
    </Card>
  );
}
