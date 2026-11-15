import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { desktopStore } from './desktop-controller';

export function useDesktop<T>(select: (state: ReturnType<typeof desktopStore.getState>) => T) {
  return useStore(desktopStore, useShallow(select));
}

export function useDesktopActions() {
  return useDesktop((state) => state.actions);
}
