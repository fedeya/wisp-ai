import { useForm, useSelector } from '@tanstack/react-form';
import { useNavigate } from 'react-router';
import { request } from '../../api';
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
      if (!value.account || !auth?.profiles.some(({ id }) => id === value.account)) return;
      const saved = await work(
        'Switching account',
        () => request('/auth/select', { profileId: value.account }),
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
      <div className="provider-heading gap-[15px] flex items-center max-xl:flex-wrap">
        <div className="provider-symbol border border-solid border-[#36534d] [background:#243e3a] text-accent rounded-[11px] w-[47px] h-[47px] flex items-center justify-center shrink-0">
          <Icon name="spark" size={25} />
        </div>
        <div>
          <h2>ChatGPT</h2>
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
        <p className="account-name text-[14px]! text-[#d1e3dd]! mt-[24px]">{auth.account}</p>
      )}
      {auth?.message && <p className="muted text-muted text-[13px]">{auth.message}</p>}
      {!app.status && (
        <div className="empty-inline text-[12px] text-[#c0a77a] mt-[22px]">
          Start Wisp to manage your account.{' '}
          <Button intent="quiet" size="text" onClick={() => void navigate('/')}>
            Go to Overview
          </Button>
        </div>
      )}
      <div className="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
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
        <Button onClick={() => signIn(undefined, true)} disabled={locked || !app.status}>
          Add account
        </Button>
        {authorizationPending && (
          <Button
            onClick={() => work('Cancelling sign-in', () => request('/auth/cancel', {}))}
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
                    () => request('/auth/disconnect', {}),
                    'Connection disconnected.',
                  ),
              })
            }
          >
            Disconnect
          </Button>
        )}
      </div>
      {auth && auth.profiles.length > 0 && (
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
