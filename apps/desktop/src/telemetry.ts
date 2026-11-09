import type { DesktopInfo, Status } from './api';

const storageKey = 'wisp.telemetry.v1';
type Saved = { id: string; since: number; milestones: string[]; activeDay?: string };

/** Explicit events only: never pass status, connection details or chat content to Rybbit. */
export function createTelemetry(storage: Storage, available: boolean) {
  let saved: Saved | undefined;
  const pending = new Set<AbortController>();
  try {
    const value = JSON.parse(storage.getItem(storageKey) || 'null');
    if (
      typeof value?.id === 'string' &&
      typeof value.since === 'number' &&
      Array.isArray(value.milestones)
    ) {
      saved = value;
    }
  } catch {
    /* Unavailable or corrupt storage means disabled. */
  }
  const persist = () => storage.setItem(storageKey, JSON.stringify(saved));
  function send(name: string, info: DesktopInfo) {
    if (!available || !saved) {
      return;
    }
    const controller = new AbortController();
    pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), 3000);
    void fetch('https://rybbit.fedeminaya.com/api/track', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        site_id: '61b021a9d037',
        type: 'custom_event',
        event_name: name,
        hostname: 'wisp.fedeya.sh',
        pathname: '/desktop',
        user_id: saved.id,
        properties: JSON.stringify({
          source: 'desktop',
          version: info.version,
          platform: info.platform,
        }),
      }),
    })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timeout);
        pending.delete(controller);
      });
  }
  function once(name: string, info: DesktopInfo) {
    if (!saved || saved.milestones.includes(name)) {
      return;
    }
    saved.milestones.push(name);
    persist();
    send(name, info);
  }
  let opened = false;
  return {
    get enabled() {
      return available && !!saved;
    },
    setEnabled(enabled: boolean) {
      if (!available) {
        return;
      }
      if (enabled && !saved) {
        saved = { id: crypto.randomUUID(), since: Date.now(), milestones: [] };
        try {
          persist();
        } catch {
          saved = undefined;
          throw Error('Could not save usage preference.');
        }
      } else if (!enabled) {
        saved = undefined;
        opened = false;
        pending.forEach((controller) => controller.abort());
        // Stop immediately even when storage becomes unavailable after opting in.
        storage.removeItem(storageKey);
      }
    },
    observe(info: DesktopInfo | null, status: Status | null) {
      if (!available || !saved || !info) {
        return;
      }
      try {
        once('desktop_first_open', info);
        if (!opened) {
          opened = true;
          send('desktop_opened', info);
        }
        if (info.configured) {
          once('desktop_addon_configured', info);
        }
        if (status?.modelConnected) {
          once('desktop_ai_connected', info);
        }
        const replyAt = status?.lastSuccessfulReplyAt;
        if (replyAt && replyAt >= saved.since) {
          once('desktop_first_response', info);
          const day = new Date(replyAt).toISOString().slice(0, 10);
          if (saved.activeDay !== day) {
            saved.activeDay = day;
            persist();
            send('desktop_active', info);
          }
        }
      } catch {
        /* Telemetry must never interrupt the application. */
      }
    },
    dispose() {
      pending.forEach((controller) => controller.abort());
    },
  };
}
