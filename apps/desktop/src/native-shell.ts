import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { desktop, native } from './api';
import { desktopPages } from './routes/desktop-routes';

/** Elements where the system context menu (cut, copy, paste) still makes sense. */
const keepsContextMenu = 'input, textarea, [contenteditable="true"], .selectable, .selectable *';

/**
 * Removes the browser behaviour that does not belong in a desktop app. The
 * release build also turns off WebView2's own shortcuts (F5, Ctrl+F, Ctrl+P…)
 * from Rust; this covers what is left: the page context menu and Ctrl+wheel zoom.
 */
export function installNativeShell(): () => void {
  if (!native || import.meta.env.DEV) return () => {};
  const onContextMenu = (event: MouseEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest(keepsContextMenu)) return;
    if (window.getSelection()?.toString()) return;
    event.preventDefault();
  };
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) event.preventDefault();
  };
  document.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    document.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('wheel', onWheel);
  };
}

/** Pages reachable with Ctrl+1…Ctrl+9, in sidebar order. */
export const shortcutPages = desktopPages.slice(0, 9);
const settingsPath = desktopPages.find((page) => page.name === 'Settings')!.path;

export function shortcutFor(path: string): string | undefined {
  if (path === settingsPath) return 'Ctrl+,';
  const index = shortcutPages.findIndex((page) => page.path === path);
  return index === -1 ? undefined : `Ctrl+${index + 1}`;
}

/** The page a key press navigates to, if it is one of the app shortcuts. */
export function shortcutTarget(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'target'>,
): string | undefined {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return undefined;
  // Modal dialogs trap focus, so a key pressed inside one belongs to the dialog.
  if (
    event.target instanceof Element &&
    event.target.closest('[role="dialog"], [role="alertdialog"]')
  ) {
    return undefined;
  }
  if (event.key === ',') return settingsPath;
  return /^[1-9]$/.test(event.key) ? shortcutPages[Number(event.key) - 1]?.path : undefined;
}

/** Ctrl+1…9 jumps between sections, Ctrl+, opens Settings. */
export function useAppShortcuts(enabled: boolean) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const path = shortcutTarget(event);
      if (!path) return;
      event.preventDefault();
      void navigate(path);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, navigate]);
}

/**
 * Mirrors important messages as Windows notifications while Wisp is in the
 * tray or behind another window. Rust skips the notification when the main
 * window is focused, so in-app feedback is never duplicated.
 */
export function useNativeNotifications(feedback: string, failed: boolean, readiness: string) {
  const previousReadiness = useRef(readiness);

  useEffect(() => {
    if (!native || !feedback || document.hasFocus()) return;
    void desktop('notify', {
      title: failed ? 'Wisp needs attention' : 'Wisp AI',
      body: feedback,
    }).catch(() => {});
  }, [failed, feedback]);

  useEffect(() => {
    const previous = previousReadiness.current;
    previousReadiness.current = readiness;
    if (!native || readiness === previous || readiness !== 'update' || document.hasFocus()) return;
    void desktop('notify', {
      title: 'Update your Wisp addon',
      body: 'Open Wisp to update the addon, then type /reload in WoW.',
    }).catch(() => {});
  }, [readiness]);
}
