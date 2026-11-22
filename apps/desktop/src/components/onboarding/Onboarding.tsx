import type { ProviderId } from '@wisp/protocol/providers';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import logo from '../../../../../assets/wisp.png';
import { native } from '../../api';
import { desktopConnected, desktopLocked, desktopReadiness } from '../../desktop-controller';
import { overviewChecks } from '../../routes/overview-checks';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import DefaultModelSettings from '../connections/DefaultModelSettings';
import ProviderPicker, { BrowseProvidersTrigger } from '../connections/ProviderPicker';
import {
  featuredProviders,
  ProviderLogo,
  providerPresentation,
} from '../connections/provider-directory';
import { ActionProgress, Spinner } from '../ui/ActionProgress';
import { Button } from '../ui/Controls';
import Icon from '../ui/Icon';
import { groupLabel, Row } from '../ui/Rows';
import AddonStep from './AddonStep';
import OnboardingProvider from './OnboardingProvider';
import {
  firstScreen,
  railSteps,
  stepLabel,
  type RailStepState,
  type WizardScreen,
} from './setup-steps';
import { trackOnboarding, type OnboardingStep } from './onboarding-telemetry';
import { useSignInTracking } from './use-sign-in-tracking';

/** Welcome and ready are not tracked: telemetry only knows the two setup steps. */
const trackedStep: Partial<Record<WizardScreen, OnboardingStep>> = {
  addon: 'addon',
  provider: 'ai_provider',
};

type HeadingRef = RefObject<HTMLHeadingElement | null>;

export default function Onboarding() {
  const app = useDesktop((state) => ({
    configured: !!state.info?.configured,
    online: !!state.status,
    starting: state.starting && !state.connectionError,
    loading: state.loading,
    busy: state.busy,
    locked: desktopLocked(state),
    wow: state.wow,
    detecting: state.detectingGame,
  }));
  const { finishOnboarding, markOnboardingComplete, install } = useDesktopActions();
  const [screen, setScreen] = useState<WizardScreen>(() => firstScreen(app.configured));
  const [provider, setProvider] = useState<ProviderId>();
  const signInTracking = useSignInTracking();
  const title = useRef<HTMLHeadingElement>(null);
  const viewedSteps = useRef(new Set<OnboardingStep>());
  const step = trackedStep[screen];

  // Installing the addon moves the wizard on to the AI step.
  useEffect(() => {
    if (app.configured && screen === 'addon') setScreen('provider');
  }, [app.configured, screen]);

  useEffect(() => {
    if (!step || viewedSteps.current.has(step)) return;
    if (viewedSteps.current.size === 0) trackOnboarding({ kind: 'opened', step });
    viewedSteps.current.add(step);
    trackOnboarding({ kind: 'step_viewed', step });
  }, [step]);

  useEffect(() => {
    title.current?.focus();
  }, [screen, provider]);

  function complete() {
    trackOnboarding({ kind: 'completed' });
    markOnboardingComplete();
    setScreen('ready');
  }

  function skip() {
    if (step) trackOnboarding({ kind: 'skipped', step });
    finishOnboarding();
  }

  function selectProvider(id: ProviderId) {
    trackOnboarding({ kind: 'provider_selected', provider: id });
    setProvider(id);
  }

  const installing = app.busy === 'Installing addon';
  const label = stepLabel(screen);

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Setup steps" className="w-[200px] shrink-0 px-2 pt-3 max-md:w-[180px]">
        <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
          {railSteps(screen).map((item) => (
            <RailItem key={item.screen} state={item.state} complete={item.complete}>
              {item.title}
            </RailItem>
          ))}
        </ol>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col rounded-tl-[8px] border-0 border-t border-l border-solid border-divider bg-canvas">
        <main className="app-scroll min-h-0 flex-1 overflow-y-auto px-8 pt-8 pb-6">
          <div
            className={
              screen === 'welcome'
                ? 'flex h-full flex-col items-center justify-center pb-10 text-center'
                : 'max-w-[560px]'
            }
          >
            {screen === 'welcome' && (
              <>
                <span className="mb-5 grid size-16 place-items-center rounded-[14px] bg-accent-dim">
                  <img className="h-10 w-8 object-contain" src={logo} alt="" />
                </span>
                <Heading title={title}>Welcome to Wisp</Heading>
                <p className="max-w-[480px] text-base text-muted">
                  Your AI companion inside World of Warcraft. Setup takes about two minutes.
                </p>
                <p className="mt-4 max-w-[420px] text-sm text-subtle">
                  You’ll need WoW Forever installed, and a ChatGPT plan or an API key from an AI
                  provider.
                </p>
              </>
            )}

            {screen === 'addon' && (
              <>
                <Heading title={title}>Install the addon</Heading>
                <p className="mb-5 text-base text-muted">
                  Wisp adds its addon to your WoW Forever folder. Nothing else in your game changes.
                </p>
                <AddonStep />
              </>
            )}

            {screen === 'provider' && (
              <>
                <Heading title={title}>Connect AI</Heading>
                <p className="mb-5 text-base text-muted">Choose the AI that answers you in game.</p>
                {app.online ? (
                  provider ? (
                    <OnboardingProvider
                      key={provider}
                      provider={provider}
                      onBack={() => setProvider(undefined)}
                      onFinish={complete}
                      signInTracking={signInTracking}
                    />
                  ) : (
                    <ProviderPicker onSelect={selectProvider}>
                      <section aria-labelledby="choose-provider" className="mb-5">
                        <h2 id="choose-provider" className={groupLabel}>
                          Choose your provider
                        </h2>
                        <ul className="m-0 flex list-none flex-col gap-0.5 overflow-hidden rounded-[6px] p-0">
                          {featuredProviders.slice(0, 3).map((id) => (
                            <ProviderChoice
                              key={id}
                              id={id}
                              disabled={!!app.busy}
                              onSelect={selectProvider}
                            />
                          ))}
                        </ul>
                        <div className="mt-2">
                          <BrowseProvidersTrigger />
                        </div>
                      </section>
                      <DefaultModelSettings onFinish={complete} />
                    </ProviderPicker>
                  )
                ) : app.loading || app.starting || app.busy ? (
                  <ActionProgress label={app.busy || 'Preparing AI providers'} />
                ) : (
                  <Row
                    icon={
                      <span className="flex text-warning">
                        <Icon name="circleAlert" size={18} />
                      </span>
                    }
                    title="The Wisp service is unavailable"
                    detail="Choose Connect later to continue. Settings → Troubleshooting shows what went wrong."
                  />
                )}
              </>
            )}

            {screen === 'ready' && <ReadyScreen title={title} />}
          </div>
        </main>

        <footer className="flex min-h-[56px] shrink-0 items-center gap-2 border-0 border-t border-solid border-divider px-4">
          {screen === 'addon' && (
            <Button intent="quiet" onClick={() => setScreen('welcome')} disabled={!!app.busy}>
              <Icon name="back" size={16} />
              Back
            </Button>
          )}
          {label && <span className="px-2 text-sm text-subtle">{label}</span>}
          <span className="flex-1" />
          {screen === 'welcome' && (
            <Button intent="primary" onClick={() => setScreen('addon')}>
              Get started
              <Icon name="arrow" size={16} />
            </Button>
          )}
          {screen === 'addon' && (
            <>
              <Button intent="quiet" onClick={skip} disabled={!!app.busy}>
                Set up WoW later
              </Button>
              {!app.detecting && (
                <Button
                  intent="primary"
                  onClick={install}
                  disabled={!native || app.locked || !app.wow}
                  aria-busy={installing}
                >
                  {installing ? 'Installing…' : 'Install addon'}
                </Button>
              )}
            </>
          )}
          {screen === 'provider' && (
            <Button intent="quiet" onClick={skip} disabled={!!app.busy}>
              Connect later
            </Button>
          )}
          {screen === 'ready' && (
            <Button intent="primary" onClick={finishOnboarding}>
              Open Wisp
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Heading({ title, children }: { title: HeadingRef; children: string }) {
  return (
    <h1 ref={title} tabIndex={-1} className="mb-1 outline-none">
      {children}
    </h1>
  );
}

function ProviderChoice({
  id,
  disabled,
  onSelect,
}: {
  id: ProviderId;
  disabled: boolean;
  onSelect: (id: ProviderId) => void;
}) {
  const { name, description } = providerPresentation(id);
  return (
    <li>
      <button
        type="button"
        className="flex min-h-[56px] w-full items-center gap-3 border-0 bg-surface px-4 py-2.5 text-left text-inherit transition-colors duration-75 hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
        aria-label={name}
        aria-describedby={`setup-provider-${id}`}
        onClick={() => onSelect(id)}
        disabled={disabled}
      >
        <ProviderLogo provider={id} />
        <span className="min-w-0 flex-1">
          <span className="block text-base">{name}</span>
          <span id={`setup-provider-${id}`} className="block text-sm text-subtle">
            {description}
          </span>
        </span>
        <span className="text-subtle">
          <Icon name="chevronRight" size={16} />
        </span>
      </button>
    </li>
  );
}

const railIcon: Record<RailStepState, ReactNode> = {
  done: <Icon name="circleCheck" size={16} />,
  current: <Icon name="circleDashed" size={16} />,
  upcoming: <Icon name="circleDashed" size={16} />,
};

function RailItem({
  state,
  complete,
  children,
}: {
  state: RailStepState;
  complete: boolean;
  children: string;
}) {
  return (
    <li
      aria-current={state === 'current' ? 'step' : undefined}
      className={`flex min-h-[34px] items-center gap-[10px] rounded-[4px] px-[10px] text-base ${
        state === 'current'
          ? 'bg-active text-foreground'
          : state === 'done'
            ? 'text-muted'
            : 'text-subtle'
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex ${state === 'upcoming' ? 'text-subtle' : 'text-accent'}`}
      >
        {complete ? railIcon.done : railIcon[state]}
      </span>
      {children}
      {state === 'done' && <span className="sr-only">(done)</span>}
    </li>
  );
}

/** Last screen: the command to try and the same checks Overview shows. */
function ReadyScreen({ title }: { title: HeadingRef }) {
  const state = useDesktop((store) => ({
    readiness: desktopReadiness(store),
    notice: store.info?.addonUpdateNotice,
    status: store.status,
    starting: store.starting,
    providerConnected: desktopConnected(store),
    modelName: store.models.find((model) => model.slug === store.status?.model)?.displayName,
  }));
  const [copied, setCopied] = useState('');
  const checks = overviewChecks({
    readiness: state.readiness,
    addonUpdateNotice: state.notice,
    status: state.status,
    starting: state.starting,
    providerConnected: state.providerConnected,
    modelName: state.modelName,
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText('/wisp');
      setCopied('Copied');
    } catch {
      setCopied('Type /wisp in WoW chat');
    }
  }

  return (
    <>
      <Heading title={title}>You’re ready</Heading>
      <p className="mb-4 text-base text-muted">
        Open World of Warcraft and type this in chat to open your companion.
      </p>
      <div className="mb-6 flex items-center gap-2">
        <code className="selectable rounded-[4px] border border-solid border-border bg-sidebar px-3.5 py-1.5 font-mono text-lg text-accent">
          /wisp
        </code>
        <Button onClick={copy} aria-label="Copy /wisp command">
          <Icon name="copy" size={14} />
          Copy
        </Button>
        <span role="status" className="text-sm text-muted">
          {copied}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 overflow-hidden rounded-[6px]">
        {checks.map((check) => (
          <Row
            key={check.id}
            icon={
              <span className={`flex ${check.tone === 'ok' ? 'text-accent' : 'text-muted'}`}>
                {check.tone === 'ok' ? (
                  <Icon name="circleCheck" size={18} />
                ) : check.tone === 'pending' ? (
                  <Spinner />
                ) : (
                  <Icon name={check.tone === 'problem' ? 'circleAlert' : 'clock'} size={18} />
                )}
              </span>
            }
            title={check.title}
            detail={check.detail}
          />
        ))}
      </div>
    </>
  );
}
