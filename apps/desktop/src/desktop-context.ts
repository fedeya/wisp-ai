import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { DesktopController } from './desktop-controller';

export const DesktopContext = createContext<DesktopController | null>(null);

export function useDesktop() {
  const controller = useContext(DesktopContext);
  if (!controller) throw Error('Desktop controller is unavailable.');
  const state = useStore(controller.store);
  return { ...state, ...controller.actions };
}
