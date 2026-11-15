import type { ProviderId } from '@wisp/protocol/providers';
import { useEffect, useRef, useState } from 'react';
import logo from '../../../../../assets/wisp.png';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import DefaultModelSettings from '../connections/DefaultModelSettings';
import ProviderConfiguration from '../connections/ProviderConfiguration';
import ProviderPicker, { BrowseProvidersTrigger } from '../connections/ProviderPicker';
import {
  featuredProviders,
  ProviderLogo,
  providerPresentation,
} from '../connections/provider-directory';
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
  const [provider, setProvider] = useState<ProviderId>();
  const title = useRef<HTMLHeadingElement>(null);
  const name = provider && providerPresentation(provider).name;

  useEffect(() => {
    title.current?.focus();
  }, [app.configured, provider]);

  return (
    <main className="grid min-h-screen items-center px-6 py-8">
      <div className="mx-auto w-full max-w-[720px]">
        <header className="mb-5">
          <img className="mb-3 h-11 w-9 object-contain" src={logo} alt="" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {provider && <ProviderLogo provider={provider} />}
              <h1 ref={title} tabIndex={-1} className="m-0 outline-none">
                {app.configured ? name || 'Connect your AI provider' : 'Set up Wisp'}
              </h1>
            </div>
            {app.configured && (
              <Button intent="quiet" size="text" onClick={finishOnboarding} disabled={!!app.busy}>
                Connect later
              </Button>
            )}
          </div>
          {!provider && (
            <p className="text-muted">
              {app.configured
                ? 'Connect a provider and choose the default model for new chats.'
                : 'Get Wisp ready for your first chat in World of Warcraft.'}
            </p>
          )}
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
        ) : app.ready ? (
          <>
            {provider ? (
              <>
                <Button
                  intent="quiet"
                  size="text"
                  className="mb-3"
                  disabled={!!app.busy}
                  onClick={() => setProvider(undefined)}
                >
                  <Icon name="back" size={16} />
                  Back to providers
                </Button>
                <ProviderConfiguration provider={provider} />
              </>
            ) : (
              <ProviderPicker onSelect={setProvider}>
                <div className="mb-5 grid gap-3">
                  <ul className="m-0 grid list-none grid-cols-3 gap-3 p-0 max-sm:grid-cols-1">
                    {featuredProviders.slice(0, 3).map((id) => {
                      const { name, description } = providerPresentation(id);
                      return (
                        <li key={id}>
                          <Button
                            className="h-full w-full justify-start gap-3 border-border bg-surface p-3 text-left whitespace-normal"
                            aria-label={name}
                            aria-describedby={`setup-provider-${id}`}
                            onClick={() => setProvider(id)}
                            disabled={!!app.busy}
                          >
                            <ProviderLogo provider={id} />
                            <span className="min-w-0">
                              <strong className="block text-[14px]">{name}</strong>
                              <span
                                id={`setup-provider-${id}`}
                                className="block text-[12px] text-muted"
                              >
                                {description}
                              </span>
                            </span>
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                  <BrowseProvidersTrigger />
                </div>
              </ProviderPicker>
            )}
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
