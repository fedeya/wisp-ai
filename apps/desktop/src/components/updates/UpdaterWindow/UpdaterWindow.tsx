import { Button } from '@base-ui/react/button';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import logo from '../../../../src-tauri/icons/128x128@2x.png';

type UpdateState = {
  phase: 'preparing' | 'installing' | 'reopening' | 'failed';
  percent: number | null;
  log: string[];
  error: string | null;
};

const statuses = {
  preparing: 'Preparing the update',
  installing: 'Installing the update',
  reopening: 'Reopening Wisp',
  failed: 'The installation stopped. Try updating Wisp again.',
};

export default function UpdaterWindow() {
  const [update, setUpdate] = useState<UpdateState>({
    phase: 'preparing',
    percent: null,
    log: [],
    error: null,
  });
  const logPanel = useRef<HTMLPreElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const failed = update.phase === 'failed';
  const status = statuses[update.phase];

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      if (!active) return;
      try {
        const next = await invoke<UpdateState>('updater_status');
        if (!active) return;
        setUpdate(next);
        if (next.phase === 'failed') return;
      } catch {
        // The installer can close while the last status request is in flight.
      }
      if (active) timer = setTimeout(refresh, 120);
    }
    void invoke('updater_ready')
      .then(refresh)
      .catch(() => {});
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  useLayoutEffect(() => {
    if (!failed) return;
    if (logPanel.current) logPanel.current.scrollTop = logPanel.current.scrollHeight;
    closeButton.current?.focus();
  }, [failed]);

  return (
    <main className="min-h-dvh border border-solid border-border bg-canvas px-[25px] pt-[15px] pb-[24px] [background-image:radial-gradient(ellipse_at_15%_0%,#243a38_0%,transparent_58%)]">
      <header
        className="h-[30px] text-[12px] font-semibold text-muted select-none"
        data-tauri-drag-region=""
      >
        Wisp AI
      </header>
      <section
        className={`mt-[10px] flex min-h-[92px] items-center gap-[17px] ${failed ? 'mb-[15px]' : 'mb-[25px]'}`}
        aria-live="polite"
      >
        <div className="grid size-[68px] flex-none place-items-center rounded-[18px] border border-solid border-[#45625c] bg-[#1b2c2a]">
          <img className="size-[57px] object-contain" src={logo} alt="" />
        </div>
        <div>
          <h1 className="m-0 text-[25px] tracking-[-0.7px]">
            {failed ? "Couldn't update Wisp" : 'Updating Wisp'}
          </h1>
          <p
            className={`mt-[5px] text-[13px] [overflow-wrap:anywhere] ${failed ? 'text-[#e8aca5]' : 'text-muted'}`}
          >
            {failed ? (update.error ?? status) : 'Wisp will reopen automatically.'}
          </p>
        </div>
      </section>
      {failed ? (
        <>
          <section className="overflow-hidden rounded-[12px] border border-solid border-border bg-sidebar">
            <h2 className="border-0 border-b border-solid border-border px-[12px] py-[10px] text-[12px] text-[#c5d3d1]">
              Installation log
            </h2>
            <pre
              className="m-0 max-h-[113px] min-h-[72px] overflow-auto px-[12px] py-[10px] whitespace-pre-wrap text-[#adbcbf] [font:11px/1.6_Consolas,monospace] [overflow-wrap:anywhere]"
              ref={logPanel}
              tabIndex={0}
              aria-label="Installation log"
            >
              {update.log.join('\n')}
            </pre>
          </section>
          <footer className="mt-[17px] flex justify-end">
            <Button
              className="min-w-[92px] cursor-pointer rounded-[8px] border border-solid border-[#518178] bg-[#29443f] px-[17px] py-[8px] font-semibold text-[#dcf3ed] hover:bg-[#355951] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-accent"
              ref={closeButton}
              onClick={() => void invoke('updater_close')}
            >
              Close
            </Button>
          </footer>
        </>
      ) : (
        <section className="rounded-[12px] border border-solid border-border bg-surface px-[16px] py-[15px]">
          <div className="mb-[10px] flex justify-between gap-[12px] text-[13px] text-[#c5d3d1]">
            <span>{status}</span>
            {update.percent !== null && (
              <strong className="text-accent tabular-nums">{update.percent}%</strong>
            )}
          </div>
          <progress
            className="block h-[6px] w-full appearance-none rounded-[10px] accent-accent [&::-webkit-progress-bar]:rounded-[10px] [&::-webkit-progress-bar]:bg-selected [&::-webkit-progress-value]:rounded-[10px] [&::-webkit-progress-value]:bg-accent"
            max={100}
            value={update.percent ?? undefined}
            aria-label={status}
          />
        </section>
      )}
    </main>
  );
}
