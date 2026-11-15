import { useForm, useSelector } from '@tanstack/react-form';
import { useEffect } from 'react';
import { desktop, request } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import { Badge, Button, Card, Input, Select } from '../ui/controls';
import type { ConnectionsView } from './connections-view';

type SearchProvider = NonNullable<NonNullable<ConnectionsView['status']>['search']>['provider'];
type SearchFields = { provider: SearchProvider; apiKey: string };
const defaultValues: SearchFields = { provider: 'auto', apiKey: '' };

function searchInput({ provider, apiKey }: SearchFields) {
  return { provider, apiKey: apiKey.trim() || undefined };
}

export default function SearchConnection({ app }: { app: ConnectionsView }) {
  const saved = app.status?.search;
  const savedProvider = saved?.provider;
  const disabled = app.locked || !app.status;
  const form = useForm({
    defaultValues,
    onSubmit: ({ value }) =>
      app.work(
        'Saving search settings',
        async () => {
          await request('/search/save', searchInput(value));
          form.setFieldValue('apiKey', '');
          await app.refresh();
          form.reset({ provider: value.provider, apiKey: '' });
        },
        'Search settings saved.',
        'search',
      ),
  });
  const providerDirty = useSelector(form.store, (state) => !!state.fieldMeta.provider?.isDirty);

  useEffect(() => {
    if (savedProvider && !providerDirty) {
      form.setFieldValue('provider', savedProvider, { dontUpdateMeta: true });
    }
  }, [form, providerDirty, savedProvider]);

  return (
    <Card kind="provider">
      <div className="section-title gap-[18px] flex items-center justify-between [&_>_svg]:text-muted">
        <div>
          <h2>Web search</h2>
          <p className="text-muted text-[13px]">
            Search globally across the public web, independently of your chat model.
          </p>
        </div>
        <Badge positive={saved?.hasExaKey}>
          {saved?.hasExaKey ? 'Exa key saved' : 'Exa public · no key needed'}
        </Badge>
      </div>
      <div className="search-form field-section gap-[12px] border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[26px] pt-[22px] grid">
        <label className="text-[12px] font-medium text-[#bdcccf]" htmlFor="search-provider">
          Search service
        </label>
        <form.Field name="provider">
          {(field) => (
            <Select
              id="search-provider"
              value={field.state.value}
              onChange={({ currentTarget }) =>
                field.handleChange(currentTarget.value as SearchProvider)
              }
              disabled={disabled}
            >
              <option value="auto">Auto — ChatGPT for subscription chats, Exa for API chats</option>
              <option value="exa">Exa for all chats</option>
              <option value="chatgpt">ChatGPT search only</option>
              <option value="disabled">Disabled</option>
            </Select>
          )}
        </form.Field>
        <label className="text-[12px] font-medium text-[#bdcccf]" htmlFor="exa-key">
          Exa API key (optional){saved?.hasExaKey ? ' (leave blank to keep saved key)' : ''}
        </label>
        <form.Field name="apiKey">
          {(field) => (
            <Input
              id="exa-key"
              type="password"
              value={field.state.value}
              onChange={({ currentTarget }) => field.handleChange(currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              disabled={disabled}
            />
          )}
        </form.Field>
        <p className="field-hint text-[11px]! text-muted mt-[12px]">
          Exa works without a key through its public MCP service, with free rate limits. Searches
          cover the public web and return source links and excerpts. An optional key uses your Exa
          account and stays protected by the operating system.
        </p>
        <p className="field-hint text-[11px]! text-muted mt-[12px]">
          A saved key uses your account credits and may incur Exa charges. Testing sends one search
          request using the saved or entered key, or public access.
        </p>
        <div className="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
          <Button
            intent="quiet"
            disabled={!!app.busy}
            onClick={() =>
              app.work(
                'Opening Exa dashboard',
                () => desktop('open_exa_dashboard'),
                'An API key is optional; public search works without one.',
                'search',
              )
            }
          >
            Get Exa key
          </Button>
          <Button
            disabled={disabled}
            onClick={() =>
              app.work(
                'Testing Exa',
                () => request('/search/test', searchInput(form.state.values)),
                'Exa accepted the test search. Results depend on source coverage.',
                'search',
              )
            }
          >
            Test Exa
          </Button>
          <Button intent="primary" disabled={disabled} onClick={() => void form.handleSubmit()}>
            Save search settings
          </Button>
          {saved?.hasExaKey && (
            <Button
              intent="quiet"
              destructive
              disabled={app.locked}
              onClick={() =>
                app.confirm({
                  label:
                    'Remove the saved Exa API key? Searches will use public Exa access and its free rate limits.',
                  run: () =>
                    app.work(
                      'Removing Exa key',
                      () => request('/search/remove-exa', {}),
                      'Exa key removed.',
                      'search',
                    ),
                })
              }
            >
              Remove Exa key
            </Button>
          )}
        </div>
        <ActionProgress label={app.busyTarget === 'search' ? app.busy : ''} />
      </div>
    </Card>
  );
}
