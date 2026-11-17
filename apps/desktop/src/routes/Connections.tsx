import {
  providerDefinitions,
  type ConnectionView,
  type ProviderId,
} from '@wisp/protocol/providers';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import type { Status } from '../api';
import DefaultModelSettings from '../components/connections/DefaultModelSettings';
import ProviderPicker, { AddProviderTrigger } from '../components/connections/ProviderPicker';
import {
  featuredProviders,
  ProviderLogo,
  providerPresentation,
} from '../components/connections/provider-directory';
import { Card } from '../components/ui/Controls';
import { button } from '../components/ui/Controls/styles';
import DataState from '../components/ui/DataState';
import Icon from '../components/ui/Icon';
import { useDesktop } from '../use-desktop';

const statusColors = {
  connected: 'bg-[#223a34] text-accent',
  attention: 'bg-[#423529] text-[#efc59c]',
  neutral: 'bg-selected text-[#b1c0c5]',
} as const;

function connectionStatus(
  provider: ProviderId,
  connections: ConnectionView[],
  subscription?: Status['auth'],
): { label: string; tone: keyof typeof statusColors; action?: string } {
  if (subscription?.status === 'connected') return { label: 'Connected', tone: 'connected' };
  if (subscription?.status === 'authorizing') {
    return { label: 'Waiting for browser', tone: 'attention' };
  }
  if (subscription?.status === 'disconnecting') return { label: 'Disconnecting', tone: 'neutral' };
  if (provider === 'compatible') return { label: 'Endpoint saved', tone: 'neutral' };
  if (connections.some(({ hasKey }) => hasKey)) return { label: 'Key saved', tone: 'neutral' };
  if (subscription?.status === 'plan_permission_required') {
    return { label: 'Plan access needed', tone: 'attention' };
  }
  if (subscription) return { label: 'Reconnect needed', tone: 'attention', action: 'Reconnect' };
  return { label: 'API key missing', tone: 'attention' };
}

export default function Connections() {
  const { status, showModelSettings } = useDesktop((state) => ({
    status: state.status,
    showModelSettings:
      state.models.length > 0 || !!state.modelsError || state.busyTarget === 'model',
  }));
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);

  const auth = status?.auth;
  const hasSubscription = auth && (auth.profiles.length > 0 || auth.status !== 'signed_out');
  const configured = new Map<ProviderId, ConnectionView[]>();
  if (hasSubscription) configured.set('openai', []);
  for (const connection of status?.connections ?? []) {
    const group = configured.get(connection.provider);
    if (group) group.push(connection);
    else configured.set(connection.provider, [connection]);
  }

  const online = !!status;
  const canAddProvider = online && configured.size < providerDefinitions.length;

  return (
    <ProviderPicker configured={new Set(configured.keys())}>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 ref={title} tabIndex={-1} className="m-0 outline-none">
          AI Providers
        </h1>
        {canAddProvider && configured.size > 0 && <AddProviderTrigger />}
      </header>
      {!online ? (
        <DataState />
      ) : configured.size === 0 ? (
        <Card
          aria-labelledby="connections-empty-title"
          className="grid justify-items-center gap-3 bg-[radial-gradient(ellipse_at_top,#223632,transparent_77%)] px-5 py-10 text-center"
        >
          <span className="grid size-11 place-items-center rounded-[10px] border border-solid border-[#406459] bg-[#29463e] text-accent">
            <Icon name="link" size={24} />
          </span>
          <div>
            <h2 id="connections-empty-title" className="text-[21px]">
              Connect your first provider
            </h2>
            <p className="mx-auto max-w-[44ch] text-[13px] text-muted">
              Use a ChatGPT subscription or add an API key to make models available in Wisp.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3 text-[13px]">
            {featuredProviders.slice(0, 3).map((provider) => (
              <span
                key={provider}
                className="flex items-center gap-1.5 [&>span]:size-7 [&_img]:size-4"
              >
                <ProviderLogo provider={provider} />
                {providerPresentation(provider).name}
              </span>
            ))}
          </div>
          <AddProviderTrigger />
        </Card>
      ) : (
        <>
          <section className="mb-4 grid gap-5" aria-labelledby="configured-providers-title">
            <h2 id="configured-providers-title">Configured providers</h2>
            <Card className="mb-0 p-0">
              <ul className="m-0 list-none divide-y [--tw-divide-style:solid] divide-border p-0">
                {[...configured].map(([provider, connections]) => {
                  const { name } = providerPresentation(provider);
                  const subscription = provider === 'openai' && hasSubscription ? auth : undefined;
                  const {
                    label,
                    tone,
                    action = 'Manage',
                  } = connectionStatus(provider, connections, subscription);
                  const method =
                    subscription && connections.length
                      ? 'Subscription · API key'
                      : subscription
                        ? 'Subscription'
                        : provider === 'compatible'
                          ? 'Custom endpoint'
                          : 'API key';
                  const titleId = `provider-${provider}-title`;

                  return (
                    <li
                      key={provider}
                      aria-labelledby={titleId}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(105px,145px)_auto] items-center gap-3 px-4 py-3 max-sm:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <div className="flex min-w-0 items-center gap-3 max-sm:row-span-2">
                        <ProviderLogo provider={provider} />
                        <div className="min-w-0">
                          <h3 id={titleId} className="m-0 break-words text-[14px] font-semibold">
                            {name}
                          </h3>
                          <p className="m-0 text-[13px] text-muted">{method}</p>
                        </div>
                      </div>
                      <span
                        className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-1 text-[12px] leading-4 ${statusColors[tone]}`}
                      >
                        <span
                          className="size-[6px] shrink-0 rounded-full bg-current"
                          aria-hidden="true"
                        />
                        {label}
                      </span>
                      <Link
                        to={`/connections/${provider}`}
                        aria-label={`${action} ${name}`}
                        className={button({
                          class: 'justify-self-end no-underline max-sm:col-start-2',
                        })}
                      >
                        {action}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </section>
          {showModelSettings && <DefaultModelSettings />}
          <Link to="/integrations/web-search" className="text-[13px] text-accent">
            Configure web search in Integrations
          </Link>
        </>
      )}
    </ProviderPicker>
  );
}
