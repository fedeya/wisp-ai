import { useEffect, useState } from 'react';
import { desktop, native } from '../../api';
import Toggle from '../ui/Toggle';
import { Card } from '../ui/controls';

export default function TelemetrySettings() {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!native) return;
    let active = true;
    void desktop<{ enabled: boolean }>('telemetry_settings')
      .then((settings) => {
        if (!active) return;
        setEnabled(settings.enabled);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setError('Could not load usage analytics settings.');
      });
    return () => {
      active = false;
    };
  }, []);

  async function change(value: boolean) {
    const previous = enabled;
    setEnabled(value);
    setSaving(true);
    setError('');
    try {
      const settings = await desktop<{ enabled: boolean }>('telemetry_settings', {
        enabled: value,
      });
      setEnabled(settings.enabled);
    } catch {
      setEnabled(previous);
      setError('Could not save usage analytics settings. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-6">
        <div>
          <h2>Usage analytics</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Help improve Wisp by sharing usage data.
          </p>
        </div>
        <Toggle
          label="Share usage analytics"
          checked={enabled}
          disabled={!loaded || saving}
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
