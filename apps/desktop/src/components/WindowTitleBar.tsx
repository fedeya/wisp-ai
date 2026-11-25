import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState, type ReactNode } from 'react';
import logo from '../../../../assets/wisp.png';
import { native } from '../api';

/** Caption marks drawn as SVG so Linux builds do not depend on Segoe fonts. */
function CaptionIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 10 10"
      width="10"
      height="10"
      aria-hidden="true"
      className="pointer-events-none stroke-current"
      fill="none"
      strokeWidth="1"
    >
      {children}
    </svg>
  );
}

const captionButton =
  'inline-grid h-full w-[46px] place-items-center border-0 bg-transparent p-0 text-muted outline-none focus-visible:bg-hover';

function useMaximized() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const window = currentWindow();
    if (!window) return;
    let active = true;
    const sync = () =>
      void window
        .isMaximized()
        .then((value) => active && setMaximized(value))
        .catch(() => {});
    sync();
    const unlisten = window.onResized(sync);
    return () => {
      active = false;
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);
  return maximized;
}

/** The Tauri window, or undefined in the browser design preview and in tests. */
function currentWindow() {
  if (!native) return undefined;
  try {
    return getCurrentWindow();
  } catch {
    return undefined;
  }
}

function run(action: (window: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
  const window = currentWindow();
  if (window) void action(window).catch(() => {});
}

/** Minimize, maximize/restore and close, drawn like the Windows caption buttons. */
export function WindowControls() {
  const maximized = useMaximized();
  return (
    <div className="flex h-full shrink-0" role="group" aria-label="Window controls">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Minimize"
        className={`${captionButton} hover:bg-hover active:bg-pressed`}
        onClick={() => run((window) => window.minimize())}
      >
        <CaptionIcon>
          <path d="M1 5h8" />
        </CaptionIcon>
      </button>
      {/* On Windows 11, tauri-plugin-snap-layout lays a native hit-test zone over
          this id: hovering opens snap layouts and clicks maximize natively, and
          it adds .is-hovered because CSS :hover no longer reaches the button. */}
      <button
        id="window-maximize"
        type="button"
        tabIndex={-1}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        className={`${captionButton} hover:bg-hover active:bg-pressed [&.is-hovered]:bg-hover`}
        onClick={() => run((window) => window.toggleMaximize())}
      >
        {maximized ? (
          <CaptionIcon>
            <path d="M3 1.5h5.5V7M1.5 3.5h5.5V9H1.5z" />
          </CaptionIcon>
        ) : (
          <CaptionIcon>
            <rect x="1.5" y="1.5" width="7" height="7" />
          </CaptionIcon>
        )}
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close to tray"
        title="Close to tray"
        className={`${captionButton} hover:bg-[#c42b1c] hover:text-white active:bg-[#b22a1b]`}
        onClick={() => run((window) => window.close())}
      >
        <CaptionIcon>
          <path d="M2 2l6 6M8 2L2 8" />
        </CaptionIcon>
      </button>
    </div>
  );
}

/**
 * Draggable strip that replaces the system title bar. Double-click maximizes,
 * as on a native caption. `controls` adds the caption buttons on the right.
 */
export default function WindowTitleBar({
  controls = false,
  className = '',
}: {
  controls?: boolean;
  className?: string;
}) {
  return (
    <div
      data-tauri-drag-region
      className={`flex h-8 shrink-0 items-stretch select-none ${className}`}
    >
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center gap-2 pl-[14px] text-sm text-subtle"
      >
        <img className="pointer-events-none h-4 w-[13px] object-contain" src={logo} alt="" />
        <span data-tauri-drag-region>Wisp AI</span>
      </div>
      {controls && <WindowControls />}
    </div>
  );
}
