import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { desktop, type DesktopInfo } from './api';

type BridgeLifecycleOptions = {
  onDesktopInfo: (info: DesktopInfo) => void;
  launchBridge: () => Promise<void>;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  onInitializationError: (message: string) => void;
};

export function startBridgeLifecycle({
  onDesktopInfo,
  launchBridge,
  refresh,
  onError,
  onInitializationError,
}: BridgeLifecycleOptions) {
  let disposed = false;
  let unsubscribe: UnlistenFn | undefined;

  async function initialize() {
    const info = await desktop<DesktopInfo>('desktop_info');
    if (disposed) {
      return;
    }
    onDesktopInfo(info);
    if (info.configured) {
      try {
        await launchBridge();
      } catch (error) {
        onError(String(error));
      }
    }
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
