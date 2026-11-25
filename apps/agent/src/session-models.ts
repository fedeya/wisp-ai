import { createHash } from 'node:crypto';
import type { LanguageModel } from 'ai';
import { Context, Effect, Layer } from 'effect';
import type { z } from 'zod';
import { selectedModel } from '@wisp/protocol/agent-rpc';
import { capabilityEnabled } from './capabilities.ts';
import { connectionModel } from './connection-model.ts';
import { EngineConfig } from './engine-config.ts';
import { hostCall } from './engine-errors.ts';
import type { HostError } from './engine-errors.ts';

/** The model a session runs on, as the bridge's chat settings choose it. */
export type SelectedModel = z.infer<typeof selectedModel>;

/** Which model each session uses, and that model for the AI SDK. */
export class SessionModels extends Context.Service<
  SessionModels,
  {
    readonly selected: (session: string) => Effect.Effect<SelectedModel, HostError>;
    /** `cache` keeps the session's requests on one provider prompt cache. */
    readonly model: (session: string, selected: SelectedModel, cache: boolean) => LanguageModel;
  }
>()('@wisp/agent/SessionModels') {
  static readonly layer = Layer.effect(
    SessionModels,
    Effect.gen(function* () {
      const { origin, token } = yield* EngineConfig;
      return SessionModels.of({
        selected: (session) =>
          hostCall(async (signal) => {
            const response = await fetch(
              origin() + '/session-model?session=' + encodeURIComponent(session),
              {
                headers: { authorization: 'Bearer ' + token },
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
              },
            );
            if (!response.ok) {
              throw Error(
                (await response.text()) || 'Could not load model settings for this conversation.',
              );
            }
            return selectedModel.parse(await response.json());
          }).pipe(Effect.withSpan('SessionModels.selected')),
        model: (session, selected, cache) =>
          connectionModel(
            selected,
            origin(),
            token,
            () => capabilityEnabled('tool:web_search'),
            cache
              ? 'wisp-' + createHash('sha256').update(session).digest('hex').slice(0, 32)
              : undefined,
            session,
          ),
      });
    }),
  );
}
