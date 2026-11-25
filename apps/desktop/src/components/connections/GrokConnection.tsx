import { useNavigate } from 'react-router';
import { bridge, call } from '../../api';
import { ActionProgress } from '../ui/ActionProgress';
import Icon from '../ui/Icon';
import { Badge, Button, Card } from '../ui/Controls';
import { desktopLocked, grokSignInUnavailable } from '../../desktop-controller';
import { useDesktop, useDesktopActions } from '../../use-desktop';

export default function GrokConnection() {
  const app = useDesktop((state) => ({
    status: state.status,
    code: state.grokCode,
    busy: state.busy,
    locked: desktopLocked(state),
  }));
  const { signInGrok, work, setConfirmation } = useDesktopActions();
  const navigate = useNavigate();
  const auth = app.status?.grok;
  const unsupported = !!app.status && !auth;
  const connected = auth?.status === 'connected';
  const pending = auth?.status === 'authorizing';
  // Refresh failure and a missing plan keep the saved tokens so they can be revoked.
  const sessionRetained =
    connected || auth?.status === 'reauth_required' || auth?.status === 'plan_permission_required';

  return (
    <Card kind="provider">
      <div className="provider-heading flex items-center gap-[15px] max-xl:flex-wrap">
        <div>
          <h2>Grok account</h2>
          <p className="text-muted text-[13px]">
            {unsupported
              ? grokSignInUnavailable
              : 'Sign in with xAI. No API key needed. A SuperGrok or X Premium+ plan covers use here.'}
          </p>
        </div>
        {!unsupported && (
          <Badge positive={connected} className="ml-auto">
            {connected ? 'Connected' : pending ? 'Waiting for browser' : 'Not connected'}
          </Badge>
        )}
      </div>
      {auth?.account && (
        <p className="account-name mt-[24px] text-[14px]! text-[#d1e3dd]!">{auth.account}</p>
      )}
      {pending && app.code && (
        <p className="mt-[16px] text-[14px]" role="status">
          Confirm this code in your browser:{' '}
          <strong className="tracking-[0.14em]">{app.code}</strong>
        </p>
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
      {!unsupported && (
        <div className="actions mt-[22px] flex flex-wrap items-center gap-[10px]">
          <ActionProgress label={app.busy === 'Opening sign-in' ? app.busy : ''} />
          <Button
            intent={connected ? 'default' : 'primary'}
            onClick={() => void signInGrok()}
            disabled={app.locked || !app.status}
          >
            {app.busy === 'Opening sign-in'
              ? 'Opening browser…'
              : connected
                ? 'Reconnect'
                : 'Continue with Grok'}
            <Icon name="arrow" size={17} />
          </Button>
          {pending && (
            <Button
              onClick={() =>
                work('Cancelling sign-in', () => call(bridge.grok.cancel.$post()), null)
              }
              disabled={!!app.busy}
            >
              Cancel sign-in
            </Button>
          )}
          {sessionRetained && (
            <Button
              intent="quiet"
              destructive
              disabled={app.locked}
              onClick={() =>
                setConfirmation({
                  label:
                    'Disconnect this AI connection? Your chats and memory will stay on this computer.',
                  run: () =>
                    work(
                      'Disconnecting',
                      () => call(bridge.grok.disconnect.$post()),
                      'Connection disconnected.',
                    ),
                })
              }
            >
              Disconnect
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
