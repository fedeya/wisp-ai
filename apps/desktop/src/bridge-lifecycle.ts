import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { desktop, type DesktopInfo } from './api';

type AddonInfo = Pick<
  DesktopInfo,
  'wow' | 'addonOutdated' | 'addonUpdateNotice' | 'addonUpdatePending'
>;

type BridgeLifecycleOptions = {
  onDesktopInfo: (info: DesktopInfo) => void;
  onAddonUpdate: (info: AddonInfo) => void;
  /** Whether the automatic addon update is running. */
  onAddonUpdating: (updating: boolean) => void;
  launchBridge: () => Promise<void>;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  onInitializationError: (message: string) => void;
};

export function startBridgeLifecycle({
  onDesktopInfo,
  onAddonUpdate,
  onAddonUpdating,
  launchBridge,
  refresh,
  onError,
  onInitializationError,
}: BridgeLifecycleOptions) {
  let disposed = false;
  let unsubscribe: UnlistenFn | undefined;

  async function initialize() {
    try {
      await launchBridge();
    } catch (error) {
      onError(String(error));
    }
    if (disposed) return;
    const info = await desktop<DesktopInfo>('desktop_info');
    if (disposed) return;
    onDesktopInfo(info);
    if (info.addonUpdatePending) onAddonUpdating(true);
    void desktop<AddonInfo | null>('auto_update_addon')
      .then((update) => {
        if (!disposed && update) onAddonUpdate(update);
      })
      .catch((error) => {
        if (!disposed) onError(String(error));
      })
      .finally(() => {
        if (!disposed && info.addonUpdatePending) onAddonUpdating(false);
      });
    await refresh();
    if (disposed) {
      return;
    }

    const stop = await listen<string>('desktop-error', ({ payload }) => onError(payload));
    if (disposed) {
      stop();
    } else {
      unsubscribe = stop;
    }
  }

  void initialize().catch((error) => onInitializationError(String(error)));
  const timer = setInterval(() => {
    void refresh();
  }, 3000);

  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    unsubscribe?.();
  };
}
