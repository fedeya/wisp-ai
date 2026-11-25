import type { ProviderId } from '@wisp/protocol/providers';
import { useEffect, useRef } from 'react';
import { useDesktop } from '../../use-desktop';
import { trackOnboarding } from './onboarding-telemetry';

export type SignInTracking = {
  started: (provider: ProviderId) => void;
  openFailed: (provider: ProviderId) => void;
  cancelling: () => void;
};

/**
 * Reports how a browser sign-in ends. Owned by the wizard, not the provider panel,
 * because the bridge keeps authorizing after the user navigates back to the list.
 */
export function useSignInTracking(): SignInTracking {
  const chatgpt = useDesktop((state) => state.status?.auth?.status);
  const grok = useDesktop((state) => state.status?.grok?.status);
  const attempt = useRef<{ provider: ProviderId; cancelling: boolean }>(undefined);
  const lastStatus = useRef(chatgpt);

  // A browser sign-in ends when the bridge leaves `authorizing`.
  useEffect(() => {
    const status = attempt.current?.provider === 'xai' ? grok : chatgpt;
    const previous = lastStatus.current;
    lastStatus.current = status;
    const current = attempt.current;
    if (!current || !status || status === previous || status === 'authorizing') return;
    if (previous !== 'authorizing' && status !== 'connected') return;
    attempt.current = undefined;
    const base = {
      kind: 'provider_connect_finished',
      provider: current.provider,
      method: 'subscription',
    } as const;
    if (status === 'connected') {
      trackOnboarding({ ...base, outcome: 'completed' });
      return;
    }
    if (current.cancelling) {
      trackOnboarding({ ...base, outcome: 'cancelled' });
      return;
    }
    trackOnboarding({
      ...base,
      outcome: 'failed',
      error_code:
        status === 'plan_permission_required' ? 'plan_permission_required' : 'sign_in_failed',
    });
  }, [chatgpt, grok]);

  return {
    started: (provider) => {
      attempt.current = { provider, cancelling: false };
    },
    openFailed: (provider) => {
      attempt.current = undefined;
      trackOnboarding({
        kind: 'provider_connect_finished',
        provider,
        method: 'subscription',
        outcome: 'failed',
        error_code: 'sign_in_open_failed',
      });
    },
    cancelling: () => {
      if (attempt.current) attempt.current.cancelling = true;
    },
  };
}
