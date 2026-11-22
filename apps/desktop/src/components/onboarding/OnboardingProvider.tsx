import type { ProviderId } from '@wisp/protocol/providers';
import { useEffect, useRef, useState } from 'react';
import { bridge, call } from '../../api';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';
import ConnectionEditor from '../connections/ConnectionEditor';
import DefaultModelSettings from '../connections/DefaultModelSettings';
import { ProviderLogo, providerPresentation } from '../connections/provider-directory';
import { Button, Card } from '../ui/Controls';
import Icon from '../ui/Icon';
import {
  trackOnboarding,
  type ProviderConnectError,
  type ProviderConnectMethod,
} from './onboarding-telemetry';
import type { SignInTracking } from './use-sign-in-tracking';

export default function OnboardingProvider({
  provider,
  onBack,
  onFinish,
  signInTracking,
}: {
  provider: ProviderId;
  onBack: () => void;
  onFinish: () => void;
  signInTracking: SignInTracking;
}) {
  const { auth, connections, locked, busy } = useDesktop((state) => ({
    auth: state.status?.auth,
    connections: state.status?.connections,
    locked: desktopLocked(state),
    busy: state.busy,
  }));
  const { signIn, work } = useDesktopActions();
  const [method, setMethod] = useState<'choose' | 'api' | 'subscription'>(
    provider === 'openai' ? 'choose' : 'api',
  );
  const [connectionId, setConnectionId] = useState<string>();
  const name = providerPresentation(provider).name;
  const connected = auth?.status === 'connected';
  const pending = auth?.status === 'authorizing';
  const reviewing = !!connectionId || (method === 'subscription' && connected);
  const panel = useRef<HTMLHeadingElement>(null);

  function connectFinished(
    connectMethod: ProviderConnectMethod,
    outcome: 'completed' | ProviderConnectError,
  ) {
    trackOnboarding(
      outcome === 'completed'
        ? { kind: 'provider_connect_finished', provider, method: connectMethod, outcome }
        : {
            kind: 'provider_connect_finished',
            provider,
            method: connectMethod,
            outcome: 'failed',
            error_code: outcome,
          },
    );
  }

  useEffect(() => {
    panel.current?.focus();
  }, [method]);

  if (reviewing) {
    return <DefaultModelSettings onFinish={onFinish} review={{ provider, connectionId, onBack }} />;
  }

  const existing = connections?.filter((connection) => connection.provider === provider) ?? [];
  const api = method === 'api';
  const backToMethods = provider === 'openai' && api;

  return (
    <>
      <Button
        intent="quiet"
        size="text"
        className="mb-3"
        disabled={!!busy}
        onClick={backToMethods ? () => setMethod('choose') : onBack}
      >
        <Icon name="back" size={16} />
        {backToMethods ? 'Back to ChatGPT' : 'Back to providers'}
      </Button>
      <Card kind="provider" className="grid gap-4 p-5">
        <div className="flex items-center gap-3">
          <ProviderLogo provider={provider} />
          <div>
            <h2 ref={panel} tabIndex={-1} className="text-[19px] outline-none">
              {name}
            </h2>
            {api && (
              <p className="m-0 text-[13px] text-muted">
                {provider === 'compatible'
                  ? 'Connect to a local or custom endpoint.'
                  : 'Connect with your API key. Usage is billed by the provider.'}
              </p>
            )}
          </div>
        </div>
        {api ? (
          <ConnectionEditor
            provider={provider}
            connection={existing.length === 1 ? existing[0] : undefined}
            close={onBack}
            onConnected={(id) => {
              connectFinished('api_key', 'completed');
              setConnectionId(id);
            }}
            onSetupFailed={(code) => connectFinished('api_key', code)}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t [border-top-style:solid] border-t-border pt-4">
              <div>
                <h3 className="m-0 text-[14px]">Subscription</h3>
                <p className="m-0 text-[13px] text-muted">
                  {pending
                    ? 'Finish signing in from your browser.'
                    : 'Sign in with your ChatGPT account.'}
                </p>
                {auth?.message && (
                  <p className="text-[13px] text-muted" role="status">
                    {auth.message}
                  </p>
                )}
              </div>
              {pending ? (
                <Button
                  disabled={!!busy}
                  onClick={() => {
                    signInTracking.cancelling();
                    void work('Cancelling sign-in', () => call(bridge.auth.cancel.$post()), null);
                  }}
                >
                  Cancel sign-in
                </Button>
              ) : (
                <Button
                  intent="primary"
                  disabled={locked}
                  onClick={() => {
                    setMethod('subscription');
                    // An existing session was already reported when its sign-in ended.
                    if (connected) return;
                    signInTracking.started(provider);
                    void signIn(auth?.activeId || undefined).then((opened) => {
                      if (!opened) signInTracking.openFailed(provider);
                    });
                  }}
                >
                  {busy === 'Opening sign-in'
                    ? 'Opening browser…'
                    : connected
                      ? 'Use subscription'
                      : 'Continue with ChatGPT'}
                  <Icon name="arrow" size={16} />
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t [border-top-style:solid] border-t-border pt-4">
              <div>
                <h3 className="m-0 text-[14px]">API key</h3>
                <p className="m-0 text-[13px] text-muted">Use your OpenAI API credits.</p>
              </div>
              <Button disabled={locked} onClick={() => setMethod('api')}>
                Use API key
              </Button>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
