import type { ProviderId } from '@wisp/protocol/providers';
import { useEffect, useRef, useState } from 'react';
import logo from '../../../../../assets/wisp.png';
import { desktop } from '../../api';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import DefaultModelSettings from '../connections/DefaultModelSettings';
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
import OnboardingProvider from './OnboardingProvider';

type OnboardingStep = 'addon' | 'ai_provider';
type OnboardingEvent =
  | { kind: 'opened' | 'step_viewed' | 'skipped'; step: OnboardingStep }
  | { kind: 'completed' };

function trackOnboarding(event: OnboardingEvent) {
  void desktop('telemetry_onboarding', { event }).catch(() => {});
}

export default function Onboarding() {
  const app = useDesktop((state) => ({
    configured: !!state.info?.configured,
    online: !!state.status,
    starting: state.starting && !state.connectionError,
    loading: state.loading,
    busy: state.busy,
  }));
  const { finishOnboarding } = useDesktopActions();
  const [provider, setProvider] = useState<ProviderId>();
  const title = useRef<HTMLHeadingElement>(null);
  const viewedSteps = useRef(new Set<OnboardingStep>());
  const step = app.configured ? 'ai_provider' : 'addon';

  useEffect(() => {
    if (viewedSteps.current.has(step)) return;
    if (viewedSteps.current.size === 0) trackOnboarding({ kind: 'opened', step });
    viewedSteps.current.add(step);
    trackOnboarding({ kind: 'step_viewed', step });
  }, [step]);

  useEffect(() => {
    title.current?.focus();
  }, [app.configured, provider]);

  function complete() {
    trackOnboarding({ kind: 'completed' });
    finishOnboarding();
  }

  function skip() {
    trackOnboarding({ kind: 'skipped', step });
    finishOnboarding();
  }

  return (
    <main
      className={`grid min-h-screen bg-[radial-gradient(ellipse_at_50%_16%,#22332f_0%,transparent_55%)] px-6 pb-8 ${app.configured ? 'items-start pt-[clamp(2rem,12vh,7rem)]' : 'items-center pt-8'}`}
    >
      <div className="mx-auto w-full max-w-[720px]">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <img className="h-10 w-8 object-contain" src={logo} alt="" />
            <strong className="text-[18px]">Wisp</strong>
          </div>
          <Button intent="quiet" size="text" onClick={skip} disabled={!!app.busy}>
            {app.configured ? 'Connect later' : 'Set up WoW later'}
          </Button>
        </header>
        <ol className="mb-5 grid list-none grid-cols-2 gap-3 p-0" aria-label="Setup progress">
          <SetupStep number={1} current={!app.configured} done={app.configured}>
            {app.configured ? 'Addon installed' : 'Install addon'}
          </SetupStep>
          <SetupStep number={2} current={app.configured}>
            AI provider
          </SetupStep>
        </ol>
        <div className="mb-4">
          <h1 ref={title} tabIndex={-1} className="m-0 outline-none">
            {app.configured ? 'Connect AI' : 'Set up Wisp'}
          </h1>
          {!app.configured && (
            <p className="text-muted">Get Wisp ready for your first chat in World of Warcraft.</p>
          )}
        </div>
        {!app.configured ? (
          <GameInstallation firstRun />
        ) : app.online ? (
          <>
            {provider ? (
              <OnboardingProvider
                key={provider}
                provider={provider}
                onBack={() => setProvider(undefined)}
                onFinish={complete}
              />
            ) : (
              <ProviderPicker onSelect={setProvider}>
                <div className="mb-5 grid gap-3">
                  <h2>Choose your provider</h2>
                  <ul className="m-0 grid list-none grid-cols-3 gap-3 p-0 max-sm:grid-cols-1">
                    {featuredProviders.slice(0, 3).map((id) => {
                      const { name, description } = providerPresentation(id);
                      return (
                        <li key={id}>
                          <Button
                            className="grid h-full w-full grid-cols-[1fr_auto] justify-items-start gap-2 border-border bg-surface p-3 text-left whitespace-normal enabled:hover:border-accent"
                            aria-label={name}
                            aria-describedby={`setup-provider-${id}`}
                            onClick={() => setProvider(id)}
                            disabled={!!app.busy}
                          >
                            <ProviderLogo provider={id} />
                            <span className="self-start text-accent">
                              <Icon name="chevronRight" size={16} />
                            </span>
                            <span className="col-span-2 min-w-0">
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
                <DefaultModelSettings onFinish={complete} />
              </ProviderPicker>
            )}
          </>
        ) : (
          <Card>
            {app.loading || app.starting || app.busy ? (
              <ActionProgress label={app.busy || 'Preparing AI providers'} />
            ) : (
              <>
                <h2>The Wisp service is unavailable</h2>
                <p className="text-muted">Open Diagnostics after setup to check the service.</p>
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
