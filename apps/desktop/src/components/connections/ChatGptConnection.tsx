import { useForm, useSelector } from '@tanstack/react-form';
import { useNavigate } from 'react-router';
import { bridge, call } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import Icon from '../ui/Icon';
import { Badge, Button, Card, Select } from '../ui/Controls';
import { desktopLocked } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';

const defaultValues: { account: string | null } = { account: null };

export default function ChatGptConnection() {
  const app = useDesktop((state) => ({
    status: state.status,
    busy: state.busy,
    busyTarget: state.busyTarget,
    locked: desktopLocked(state),
  }));
  const { signIn, work, setConfirmation } = useDesktopActions();
  const navigate = useNavigate();
  const auth = app.status?.auth;
  const activeAccount = auth?.activeId || '';
  const accountForm = useForm({
    defaultValues,
    onSubmit: async ({ value, formApi }) => {
      const profileId = value.account;
      if (!profileId || !auth?.profiles.some(({ id }) => id === profileId)) return;
      const saved = await work(
        'Switching account',
        () => call(bridge.auth.select.$post({ json: { profileId } })),
        undefined,
        'accounts',
      );
      if (saved) formApi.reset();
    },
  });
  const draft = useSelector(accountForm.store, (state) => state.values.account);
  const submitting = useSelector(accountForm.store, (state) => state.isSubmitting);
  const account = auth?.profiles.some(({ id }) => id === draft) ? draft : activeAccount;
  const locked = app.locked || submitting;
  const canSwitch = !locked && !!account && account !== activeAccount;
  const chatgptConnected = auth?.status === 'connected';
  const authorizationPending = auth?.status === 'authorizing';

  return (
    <Card kind="provider">
      <div className="provider-heading flex items-center gap-[15px] max-xl:flex-wrap">
        <div>
          <h2>ChatGPT subscription</h2>
          <p className="text-muted text-[13px]">
            Connect with your subscription. No API key needed.
          </p>
        </div>
        <Badge positive={chatgptConnected} className="ml-auto">
          {chatgptConnected
            ? 'Connected'
            : authorizationPending
              ? 'Waiting for browser'
              : 'Not connected'}
        </Badge>
      </div>
      {auth?.account && (
        <p className="account-name mt-[24px] text-[14px]! text-[#d1e3dd]!">{auth.account}</p>
      )}
      {auth?.message && <p className="muted text-muted text-[13px]">{auth.message}</p>}
      {!app.status && (
        <div className="empty-inline text-[12px] text-[#c0a77a] mt-[22px]">
          Your account is unavailable while the Wisp service is unreachable.{' '}
          <Button intent="quiet" size="text" onClick={() => void navigate('/')}>
            Go to Overview
          </Button>
        </div>
      )}
      <div className="actions mt-[22px] flex flex-wrap items-center gap-[10px]">
        <ActionProgress label={app.busyTarget === '' ? app.busy : ''} />
        <Button
          intent={chatgptConnected ? 'default' : 'primary'}
          onClick={() => signIn(account ?? undefined)}
          disabled={locked || !app.status}
        >
          {app.busy === 'Opening sign-in'
            ? 'Opening browser…'
            : chatgptConnected
              ? 'Reconnect'
              : 'Continue with ChatGPT'}
          <Icon name="arrow" size={17} />
        </Button>
        {!!auth?.profiles.length && (
          <Button onClick={() => signIn(undefined, true)} disabled={locked || !app.status}>
            Add account
          </Button>
        )}
        {authorizationPending && (
          <Button
            onClick={() => work('Cancelling sign-in', () => call(bridge.auth.cancel.$post()))}
            disabled={!!app.busy}
          >
            Cancel sign-in
          </Button>
        )}
        {chatgptConnected && (
          <Button
            intent="quiet"
            destructive
            disabled={locked}
            onClick={() =>
              setConfirmation({
                label:
                  'Disconnect this AI connection? Your chats and memory will stay on this computer.',
                run: () =>
                  work(
                    'Disconnecting',
                    () => call(bridge.auth.disconnect.$post()),
                    'Connection disconnected.',
                  ),
              })
            }
          >
            Disconnect
          </Button>
        )}
      </div>
      {auth && (auth.profiles.length > 1 || (!activeAccount && auth.profiles.length === 1)) && (
        <div className="field-section border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[26px] pt-[22px]">
          <label className="text-[12px] font-medium text-[#bdcccf]" htmlFor="accounts">
            Saved accounts
          </label>
          <form
            className="inline-field gap-[12px] mt-[10px] flex items-center"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSwitch && !accountForm.state.isSubmitting) void accountForm.handleSubmit();
            }}
          >
            <accountForm.Field name="account">
              {(field) => (
                <Select
                  className="flex-[1]"
                  id="accounts"
                  name={field.name}
                  value={account || null}
                  onValueChange={field.handleChange}
                  options={auth.profiles.map(({ id, label }) => ({ value: id, label }))}
                  placeholder="Choose a saved account"
                  disabled={locked}
                />
              )}
            </accountForm.Field>
            <Button type="submit" disabled={!canSwitch}>
              Use account
            </Button>
          </form>
          <ActionProgress label={app.busyTarget === 'accounts' ? app.busy : ''} />
        </div>
      )}
    </Card>
  );
}
