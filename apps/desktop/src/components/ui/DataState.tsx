import { useNavigate } from 'react-router';
import { useDesktop } from '../../use-desktop';
import { Spinner } from './ActionProgress';
import Icon from './Icon';
import { Button, Card } from './Controls';

export default function DataState() {
  const { loading, starting, connectionError } = useDesktop(
    ({ loading, starting, connectionError }) => ({ loading, starting, connectionError }),
  );
  const navigate = useNavigate();
  return (
    <Card
      kind="empty"
      className="text-center [&_>_svg]:text-[#577e7c] [&_>_svg]:mb-[16px]"
      aria-live="polite"
    >
      {loading ? (
        <>
          <Spinner className="inline-block mb-[16px]" />
          <h2 className="text-[21px]">Loading your workspace…</h2>
          <p className="mx-auto text-muted text-[13px] max-w-[400px] mt-[12px] mb-[23px]">
            Checking Wisp and your saved data.
          </p>
        </>
      ) : (
        <>
          <Icon name="link" size={30} />
          <h2 className="text-[21px]">
            {starting ? 'Wisp is starting' : 'Your workspace is unavailable'}
          </h2>
          <p className="mx-auto text-muted text-[13px] max-w-[400px] mt-[12px] mb-[23px]">
            {starting
              ? 'Your workspace will appear when the service is ready.'
              : 'Wisp could not reach the local service to load your saved data.'}
          </p>
          <Button onClick={() => void navigate('/')}>
            Go to Overview
            <Icon name="arrow" size={16} />
          </Button>
          {connectionError && (
            <Button intent="quiet" onClick={() => void navigate('/settings/diagnostics')}>
              View diagnostics
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
