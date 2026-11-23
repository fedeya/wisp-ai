import { useEffect, type ReactNode } from 'react';
import {
  OpenFeature,
  OpenFeatureProvider,
  TypedInMemoryProvider,
  useBooleanFlagValue,
} from '@openfeature/react-sdk';
import type { FeatureFlag, FeaturesState } from '@wisp/protocol/features';
import { desktopStore } from './desktop-controller';

const domain = 'wisp-desktop';
// The bridge evaluates every flag; the webview only mirrors its answers, so
// the desktop, the addon and the agent never disagree.
const provider = new TypedInMemoryProvider();
OpenFeature.setProvider(domain, provider);
let mirrored = '';

/** Mirror the bridge's resolved flags into the webview's OpenFeature provider. */
export function mirrorFeatures(state: FeaturesState | undefined) {
  const configuration = Object.fromEntries(
    (state?.flags ?? []).map((flag) => [
      flag.id,
      {
        variants: { on: true, off: false },
        defaultVariant: flag.enabled ? ('on' as const) : ('off' as const),
        disabled: false,
      },
    ]),
  );
  const key = JSON.stringify(configuration);
  if (key === mirrored) return;
  mirrored = key;
  void provider.putConfiguration(configuration);
}

/** Scope for `useFeature`, kept in step with the bridge's status. */
export function FeatureFlags({ children }: { children: ReactNode }) {
  useEffect(() => {
    mirrorFeatures(desktopStore.getState().status?.features);
    return desktopStore.subscribe((state) => mirrorFeatures(state.status?.features));
  }, []);
  return <OpenFeatureProvider domain={domain}>{children}</OpenFeatureProvider>;
}

/** Whether a feature flag is on; re-renders when it changes. Off before the bridge answers. */
export function useFeature(id: FeatureFlag): boolean {
  return useBooleanFlagValue(id, false);
}
