import { useEffect, useState } from 'react';
import { desktop, native } from '../../api';
import Toggle from '../ui/Toggle';
import { Row } from '../ui/Rows';

export default function TelemetrySettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!native) return;
    let active = true;
    void desktop<{ enabled: boolean }>('telemetry_settings')
      .then((settings) => {
        if (!active) return;
        setEnabled(settings.enabled);
      })
      .catch(() => {
        if (active) setError('Could not load usage analytics settings.');
      });
    return () => {
      active = false;
    };
  }, []);

  async function change(value: boolean) {
    if (enabled === null || pending !== null) return;
    setPending(value);
    setError('');
    try {
      const settings = await desktop<{ enabled: boolean }>('telemetry_settings', {
        enabled: value,
      });
      setEnabled(settings.enabled);
    } catch {
      setError('Could not save usage analytics settings. Try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <Row
      title="Usage analytics"
      detail="Help improve Wisp by sharing usage data."
      trailing={
        <Toggle
          label="Share usage analytics"
          checked={pending ?? enabled ?? true}
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
