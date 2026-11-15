import { useEffect, useState } from 'react';
import { desktop, native } from '../../../api';
import Toggle from '../../ui/Toggle';
import { Card } from '../../ui/Controls';

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
    <Card density="compact">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-[14px] font-semibold">Usage analytics</h2>
          <p className="mb-0 mt-1 text-[13px] text-muted">
            Help improve Wisp by sharing usage data.
          </p>
        </div>
        <Toggle
          label="Share usage analytics"
          checked={pending ?? enabled ?? true}
          disabled={enabled === null || pending !== null}
          onChange={change}
        />
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-[#f0b4aa]">
          {error}
        </p>
      )}
    </Card>
  );
}
