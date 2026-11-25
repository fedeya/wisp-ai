import { GROK_SUBSCRIPTION_ID, type ProviderId } from '@wisp/protocol/providers';
import { useEffect, useRef, useState } from 'react';
import { bridge, call } from '../../api';
import { desktopLocked, grokSignInUnavailable } from '../../desktop-controller';
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
  const { auth, grok, grokCode, connections, locked, busy, online } = useDesktop((state) => ({
    auth: state.status?.auth,
    grok: state.status?.grok,
    grokCode: state.grokCode,
    connections: state.status?.connections,
    locked: desktopLocked(state),
    busy: state.busy,
    online: !!state.status,
  }));
  const { signIn, signInGrok, work } = useDesktopActions();
  const subscriptionProvider = provider === 'openai' || provider === 'xai';
  const account = provider === 'xai' ? grok : auth;
  const [method, setMethod] = useState<'choose' | 'api' | 'subscription'>(
    subscriptionProvider ? 'choose' : 'api',
  );
  const [connectionId, setConnectionId] = useState<string>();
  const name = providerPresentation(provider).name;
  const connected = account?.status === 'connected';
  const pending = account?.status === 'authorizing';
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
    return (
      <DefaultModelSettings
        onFinish={onFinish}
        review={{
          provider,
          // API-key setup has a saved connection. A Grok account uses the stable
          // subscription id its models are slugged with. ChatGPT models have none.
          connectionId: connectionId ?? (provider === 'xai' ? GROK_SUBSCRIPTION_ID : undefined),
          onBack,
        }}
      />
    );
  }

  const existing = connections?.filter((connection) => connection.provider === provider) ?? [];
  const api = method === 'api';
  const backToMethods = subscriptionProvider && api;
  const grokUnavailable = provider === 'xai' && online && !grok;

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
        {backToMethods ? `Back to ${name}` : 'Back to providers'}
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
            {grokUnavailable ? (
              <p
                className="m-0 border-t [border-top-style:solid] border-t-border pt-4 text-[13px] text-muted"
                role="status"
              >
                {grokSignInUnavailable}
              </p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t [border-top-style:solid] border-t-border pt-4">
                <div>
                  <h3 className="m-0 text-[14px]">Subscription</h3>
                  <p className="m-0 text-[13px] text-muted">
                    {pending
                      ? 'Finish signing in from your browser.'
                      : provider === 'xai'
                        ? 'Sign in with your xAI account.'
                        : 'Sign in with your ChatGPT account.'}
                  </p>
                  {pending && provider === 'xai' && grokCode && (
                    <p className="text-[13px]" role="status">
                      Confirm this code in your browser: <strong>{grokCode}</strong>
                    </p>
                  )}
                  {account?.message && (
                    <p className="text-[13px] text-muted" role="status">
                      {account.message}
                    </p>
                  )}
                </div>
                {pending ? (
                  <Button
                    disabled={!!busy}
                    onClick={() => {
                      signInTracking.cancelling();
                      void work(
                        'Cancelling sign-in',
                        () =>
                          call(
                            provider === 'xai'
                              ? bridge.grok.cancel.$post()
                              : bridge.auth.cancel.$post(),
                          ),
                        null,
                      );
                    }}
                  >
                    Cancel sign-in
                  </Button>
                ) : (
                  <Button
                    intent="primary"
                    disabled={locked || (provider === 'xai' && !grok)}
                    onClick={() => {
                      setMethod('subscription');
                      // An existing session was already reported when its sign-in ended.
                      if (connected) return;
                      signInTracking.started(provider);
                      const opening =
                        provider === 'xai' ? signInGrok() : signIn(auth?.activeId || undefined);
                      void opening.then((opened) => {
                        if (!opened) signInTracking.openFailed(provider);
                      });
                    }}
                  >
                    {busy === 'Opening sign-in'
                      ? 'Opening browser…'
                      : connected
                        ? 'Use subscription'
                        : provider === 'xai'
                          ? 'Continue with Grok'
                          : 'Continue with ChatGPT'}
                    <Icon name="arrow" size={16} />
                  </Button>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t [border-top-style:solid] border-t-border pt-4">
              <div>
                <h3 className="m-0 text-[14px]">API key</h3>
                <p className="m-0 text-[13px] text-muted">
                  {provider === 'xai'
                    ? 'Use your xAI API credits.'
                    : 'Use your OpenAI API credits.'}
                </p>
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
