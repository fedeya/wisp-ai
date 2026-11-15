import { useEffect, useRef } from 'react';
import logo from '../../../../../assets/wisp.png';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import ApiConnections from '../connections/ApiConnections';
import ChatGptConnection from '../connections/ChatGptConnection';
import DefaultModelSettings from '../connections/DefaultModelSettings';
import GameInstallation from '../settings/GameInstallation';
import { ActionProgress } from '../ui/ActionProgress';
import { Button, Card } from '../ui/Controls';
import Icon from '../ui/Icon';

export default function Onboarding() {
  const app = useDesktop((state) => ({
    configured: !!state.info?.configured,
    ready: !!state.status?.ready,
    starting: state.starting && !state.connectionError,
    loading: state.loading,
    busy: state.busy,
  }));
  const { finishOnboarding, start } = useDesktopActions();
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    title.current?.focus();
  }, [app.configured]);

  return (
    <main className="grid min-h-screen items-center px-6 py-8">
      <div className="mx-auto w-full max-w-[720px]">
        <header className="mb-5">
          <img className="mb-3 h-11 w-9 object-contain" src={logo} alt="" />
          <h1 ref={title} tabIndex={-1} className="outline-none">
            {app.configured ? 'Connect your AI provider' : 'Set up Wisp'}
          </h1>
          <p className="text-muted">
            {app.configured
              ? 'Connect a provider and choose the default model for new chats.'
              : 'Get Wisp ready for your first chat in World of Warcraft.'}
          </p>
        </header>
        <ol className="mb-5 grid list-none grid-cols-2 gap-3 p-0" aria-label="Setup progress">
          <SetupStep number={1} current={!app.configured} done={app.configured}>
            {app.configured ? 'Addon installed' : 'Install addon'}
          </SetupStep>
          <SetupStep number={2} current={app.configured}>
            Connect AI
          </SetupStep>
        </ol>
        {!app.configured ? (
          <GameInstallation firstRun />
        ) : (
          <>
            {app.ready ? (
              <>
                <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1 [&>section]:mb-3">
                  <ChatGptConnection firstRun />
                  <ApiConnections firstRun />
                </div>
                <DefaultModelSettings onFinish={finishOnboarding} />
              </>
            ) : (
              <Card>
                {app.loading || app.starting || app.busy ? (
                  <ActionProgress label={app.busy || 'Starting Wisp'} />
                ) : (
                  <>
                    <h2>The Wisp service is unavailable</h2>
                    <p className="mb-3 text-muted">Start Wisp to connect a provider.</p>
                    <Button intent="primary" onClick={start}>
                      Start Wisp
                    </Button>
                  </>
                )}
              </Card>
            )}
            <Button intent="quiet" size="text" onClick={finishOnboarding} disabled={!!app.busy}>
              Connect later
            </Button>
          </>
        )}
      </div>
    </main>
  );
}

function SetupStep({
  number,
  current,
  done = false,
  children,
}: {
  number: number;
  current: boolean;
  done?: boolean;
  children: string;
}) {
  return (
    <li
      aria-current={current ? 'step' : undefined}
      className={`flex items-center gap-2 border-b-2 pb-3 text-[13px] ${current ? 'border-accent' : 'border-border text-muted'}`}
    >
      <span
        aria-hidden="true"
        className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${current ? 'bg-accent font-semibold text-[#102322]' : 'bg-surface text-accent'}`}
      >
        {done ? <Icon name="check" size={15} /> : number}
      </span>
      {children}
    </li>
  );
}
