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
    <Card density="compact">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-[14px] font-semibold">Local activity</h2>
          <p className="mb-0 mt-1 text-[13px] text-muted">
            Logs stay on your computer. Review them before sharing.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          className="mt-3 mb-0 rounded-[8px] border border-solid border-[#70473f] bg-[#332522] px-3 py-2 text-[13px] text-[#f0b4aa] [overflow-wrap:anywhere]"
          role="status"
        >
          Last connection error: {app.connectionError}
        </p>
      )}
      <pre
        role="region"
        aria-label="Local logs"
        tabIndex={0}
        className="logs catalog-scroll mt-3 mb-0 min-h-[min(240px,40vh)] max-h-[55vh] overflow-auto rounded-[8px] border border-solid border-border bg-sidebar p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[#a5b7be] [overflow-wrap:anywhere]"
      >
        {app.logs || 'No activity loaded yet. Refresh to read the local bridge logs.'}
      </pre>
      <p className="mt-2 mb-0 text-[12px] text-muted [overflow-wrap:anywhere]">
        Data location: {app.info?.dataDirectory || 'Available in the installed app'}
      </p>
    </Card>
  );
}
