import type { ProviderId } from '@wisp/protocol/providers';
import { desktop } from '../../api';

export type OnboardingStep = 'addon' | 'ai_provider';
export type ProviderConnectMethod = 'subscription' | 'api_key';
export type ProviderConnectError =
  | 'sign_in_open_failed'
  | 'sign_in_failed'
  | 'plan_permission_required'
  | 'model_discovery_failed'
  | 'model_test_failed'
  | 'connection_save_failed';

export type OnboardingEvent =
  | { kind: 'opened' | 'step_viewed' | 'skipped'; step: OnboardingStep }
  | { kind: 'completed' }
  | { kind: 'provider_selected'; provider: ProviderId }
  | {
      kind: 'provider_connect_finished';
      provider: ProviderId;
      method: ProviderConnectMethod;
      outcome: 'completed' | 'cancelled';
    }
  | {
      kind: 'provider_connect_finished';
      provider: ProviderId;
      method: ProviderConnectMethod;
      outcome: 'failed';
      error_code: ProviderConnectError;
    };

/** Only fixed ids and enums: never keys, endpoints, accounts or provider messages. */
export function trackOnboarding(event: OnboardingEvent) {
  void desktop('telemetry_onboarding', { event }).catch(() => {});
}
