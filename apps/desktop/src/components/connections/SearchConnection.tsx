import { useForm, useSelector } from '@tanstack/react-form';
import { desktop, request, type Status } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import { Badge, Button, Card, Input, Select } from '../ui/Controls';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';

type SearchProvider = NonNullable<Status['search']>['provider'];
type SearchFields = { provider: SearchProvider | null; apiKey: string };
const defaultValues: SearchFields = { provider: null, apiKey: '' };
const searchProviders: { value: SearchProvider; label: string; description?: string }[] = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'ChatGPT for subscription chats, Exa for API chats',
  },
  { value: 'exa', label: 'Exa for all chats' },
  { value: 'chatgpt', label: 'ChatGPT search only' },
  { value: 'disabled', label: 'Disabled' },
];

function searchInput({ provider, apiKey }: SearchFields, savedProvider: SearchProvider) {
  return { provider: provider ?? savedProvider, apiKey: apiKey.trim() || undefined };
}

export default function SearchConnection() {
  const app = useDesktop((state) => ({
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
    online: !!state.status,
    search: state.status?.search,
  }));
  const { setConfirmation, work } = useDesktopActions();
  const saved = app.search;
  const savedProvider = saved?.provider ?? 'auto';
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value, formApi }) => {
      const saved = await work(
        'Saving search settings',
        () => request('/search/save', searchInput(value, savedProvider)),
        'Search settings saved.',
        'search',
      );
      if (saved) formApi.reset();
    },
  });
  const submitting = useSelector(form.store, (state) => state.isSubmitting);
  const disabled = app.locked || !app.online || submitting;

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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && !form.state.isSubmitting) void form.handleSubmit();
        }}
        className="search-form field-section gap-[12px] border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[26px] pt-[22px] grid"
      >
        <label className="text-[12px] font-medium text-[#bdcccf]" htmlFor="search-provider">
          Search service
        </label>
        <form.Field name="provider">
          {(field) => (
            <Select
              id="search-provider"
              name={field.name}
              value={field.state.value ?? savedProvider}
              onValueChange={field.handleChange}
              options={searchProviders}
              disabled={disabled}
            />
          )}
        </form.Field>
        <label className="text-[12px] font-medium text-[#bdcccf]" htmlFor="exa-key">
          Exa API key (optional){saved?.hasExaKey ? ' (leave blank to keep saved key)' : ''}
        </label>
        <form.Field name="apiKey">
          {(field) => (
            <Input
              id="exa-key"
              name={field.name}
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
              work(
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
              work(
                'Testing Exa',
                () => request('/search/test', searchInput(form.state.values, savedProvider)),
                'Exa accepted the test search. Results depend on source coverage.',
                'search',
              )
            }
          >
            Test Exa
          </Button>
          <Button type="submit" intent="primary" disabled={disabled}>
            Save search settings
          </Button>
          {saved?.hasExaKey && (
            <Button
              intent="quiet"
              destructive
              disabled={app.locked}
              onClick={() =>
                setConfirmation({
                  label:
                    'Remove the saved Exa API key? Searches will use public Exa access and its free rate limits.',
                  run: () =>
                    work(
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
      </form>
    </Card>
  );
}
