import { useEffect, useState } from 'react';
import { desktop, native } from '../../api';
import { Row } from '../ui/Rows';
import Toggle from '../ui/Toggle';

/** "Start Wisp with Windows": launches Wisp in the tray when the user signs in. */
export default function StartupSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!native) return;
    let active = true;
    void desktop<boolean>('autostart_enabled')
      .then((value) => active && setEnabled(value))
      .catch(() => active && setError('Could not read the startup setting.'));
    return () => {
      active = false;
    };
  }, []);

  async function change(value: boolean) {
    if (enabled === null || pending !== null) return;
    setPending(value);
    setError('');
    try {
      setEnabled(await desktop<boolean>('set_autostart', { enabled: value }));
    } catch {
      setError('Could not change the startup setting. Try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <Row
      title="Start with Windows"
      detail="Open Wisp in the tray when you sign in, so it’s ready before you launch WoW."
      trailing={
        <Toggle
          label="Start Wisp with Windows"
          checked={pending ?? enabled ?? false}
          disabled={enabled === null || pending !== null}
          onChange={change}
        />
      }
    >
      {error && (
        <p role="alert" className="m-0 px-4 pb-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Row>
  );
}
