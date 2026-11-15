import { useNavigate } from 'react-router';
import { request } from '../../api';
import ApiConnections from '../../components/connections/ApiConnections';
import SearchConnection from '../../components/connections/SearchConnection';
import type { ConnectionsView } from '../../components/connections/connections-view';
import { ActionProgress } from '../../components/ui/ActionProgress';
import Icon from '../../components/ui/Icon';
import { Badge, Button, Card, Select } from '../../components/ui/controls';
import { useDesktop } from '../../desktop-context';

export default function Connections() {
  const desktop = useDesktop();
  const navigate = useNavigate();
  const app: ConnectionsView = {
    ...desktop,
    showOverview: () => void navigate('/'),
    confirm: desktop.setConfirmation,
  };
  const auth = app.status?.auth;
  const chatgptConnected = auth?.status === 'connected';
  const authorizationPending = auth?.status === 'authorizing';

  return (
    <>
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
            <Button intent="quiet" size="text" onClick={app.showOverview}>
              Go to Overview
            </Button>
          </div>
        )}
        <div className="actions gap-[10px] mt-[22px] flex flex-wrap items-center">
          <ActionProgress label={app.busyTarget === '' ? app.busy : ''} />
          <Button
            intent={chatgptConnected ? 'default' : 'primary'}
            onClick={() => app.signIn()}
            disabled={app.locked || !app.status}
          >
            {app.busy === 'Opening sign-in'
              ? 'Opening browser…'
              : chatgptConnected
                ? 'Reconnect'
                : 'Continue with ChatGPT'}
            <Icon name="arrow" size={17} />
          </Button>
          <Button onClick={() => app.signIn(true)} disabled={app.locked || !app.status}>
            Add account
          </Button>
          {authorizationPending && (
            <Button
              onClick={() => app.work('Cancelling sign-in', () => request('/auth/cancel', {}))}
              disabled={!!app.busy}
            >
              Cancel sign-in
            </Button>
          )}
          {chatgptConnected && (
            <Button
              intent="quiet"
              destructive
              disabled={app.locked}
              onClick={() =>
                app.confirm({
                  label:
                    'Disconnect this AI connection? Your chats and memory will stay on this computer.',
                  run: () =>
                    app.work(
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
            <div className="inline-field gap-[12px] mt-[10px] flex items-center">
              <Select
                className="flex-[1]"
                id="accounts"
                value={app.account}
                onChange={({ currentTarget }) => app.chooseAccount(currentTarget.value)}
                disabled={app.locked}
              >
                {auth.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </Select>
              <Button
                onClick={() =>
                  app.work(
                    'Switching account',
                    () => request('/auth/select', { profileId: app.account }),
                    undefined,
                    'accounts',
                  )
                }
                disabled={app.locked || app.account === auth.activeId}
              >
                Use account
              </Button>
            </div>
            <ActionProgress label={app.busyTarget === 'accounts' ? app.busy : ''} />
          </div>
        )}
      </Card>
      <ApiConnections app={app} />
      <SearchConnection app={app} />
      <Card kind="provider">
        <h2>Default model</h2>
        <div className="field-section border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-[26px] pt-[22px]">
          {app.modelsError && (
            <p
              className="banner error gap-[12px] border border-solid border-[#70473f] px-[16px] py-[12px] flex items-center rounded-[9px] [background:#332522] text-[#f0b4aa] mb-[20px] text-[13px] leading-[1.5] [&_.icon-button]:ml-auto"
              role="status"
            >
              Could not load models: {app.modelsError}
            </p>
          )}
          <div className="label-row flex items-center justify-between">
            <label className="text-[12px] font-medium text-[#bdcccf]" htmlFor="models">
              Default model for new chats
            </label>
            <Button
              intent="quiet"
              size="text"
              onClick={() =>
                app.work('Loading models', app.loadModels, 'Models refreshed.', 'model')
              }
              disabled={app.locked || !app.status}
            >
              <Icon name="refresh" size={14} />
              Refresh
            </Button>
          </div>
          <div className="inline-field gap-[12px] mt-[10px] flex items-center">
            <Select
              className="flex-[1]"
              id="models"
              value={app.model}
              onChange={({ currentTarget }) => app.chooseModel(currentTarget.value)}
              disabled={app.locked || !app.models.length}
            >
              <option value="" disabled>
                {app.models.length ? 'Loading available models…' : 'Connect a provider first'}
              </option>
              {app.models.map((model) => (
                <option key={model.slug} value={model.slug}>
                  {model.displayName}
                </option>
              ))}
            </Select>
            <Button
              onClick={() =>
                app.work(
                  'Updating default model',
                  () => request('/auth/model', { model: app.model }),
                  'Default model updated.',
                  'model',
                )
              }
              disabled={app.locked || !app.models.length || app.model === app.status?.model}
            >
              {app.busy === 'Updating default model' ? 'Saving…' : 'Set default'}
            </Button>
          </div>
          <ActionProgress label={app.busyTarget === 'model' ? app.busy : ''} />
          <p className="field-hint text-[11px]! text-muted mt-[12px]">
            You can choose a different model and effort inside each chat.
          </p>
        </div>
        <p className="privacy-note gap-[7px] text-[11px]! flex items-center mt-[25px] text-[#789c91]!">
          <Icon name="check" size={16} />
          Credentials stay protected by your operating system.
        </p>
      </Card>
    </>
  );
}
