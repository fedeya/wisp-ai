import { useEffect, useRef, useState } from 'react';
import { desktop } from '../api';
import { ActionProgress } from '../components/ui/ActionProgress';
import Icon from '../components/ui/Icon';
import { Button, Card } from '../components/ui/Controls';
import { desktopReadiness } from '../desktop-controller';
import { useDesktop } from '../use-desktop';
import { diagnosticsReport } from './diagnostics-report';

export default function Diagnostics() {
  const app = useDesktop((state) => ({
    busyTarget: state.busyTarget,
    busy: state.busy,
    work: state.actions.work,
    connectionError: state.connectionError,
    logs: state.logs,
    info: state.info,
    status: state.status,
    readiness: desktopReadiness(state),
    showLogs: state.actions.showLogs,
  }));
  const { showLogs } = app;
  const [copied, setCopied] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    void showLogs();
  }, [showLogs]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copyReport() {
    const report = diagnosticsReport({
      version: app.info?.version,
      platform: app.info?.platform,
      readiness: app.readiness,
      serviceReady: app.status?.ready,
      gameConnected: app.status?.gameConnected,
      addonOutdated: app.info?.addonOutdated,
      connectionError: app.connectionError,
      logs: app.logs,
    });
    try {
      await navigator.clipboard.writeText(report);
      setCopied('Copied. Review it before sharing.');
    } catch {
      setCopied('Couldn’t copy. Use Open folder instead.');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(''), 4000);
  }

  return (
    <Card density="compact">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-base font-semibold">Local activity</h2>
          <p className="mb-0 mt-1 text-sm text-muted">
            Logs stay on your computer. Review them before sharing.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionProgress label={app.busyTarget === '' ? app.busy : ''} />
          <span role="status" className="text-sm text-muted">
            {copied}
          </span>
          <Button intent="primary" onClick={copyReport}>
            <Icon name="copy" size={16} />
            Copy diagnostics
          </Button>
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
          className="mt-3 mb-0 rounded-[8px] border border-solid border-[#70473f] bg-[#332522] px-3 py-2 text-sm text-danger [overflow-wrap:anywhere]"
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
      <p className="selectable mt-2 mb-0 text-xs text-muted [overflow-wrap:anywhere]">
        Data location: {app.info?.dataDirectory || 'Available in the installed app'}
      </p>
    </Card>
  );
}
