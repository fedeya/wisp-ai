import { createHash } from 'node:crypto';
import type { LanguageModel } from 'ai';
import { Context, Effect, Layer, Schema } from 'effect';
import { selectedModel, type SelectedModel } from '../contract/agent-rpc.ts';
import * as Capabilities from '../host/capabilities.ts';
import { connectionModel } from './connection-model.ts';
import { EngineConfig } from '../host/engine-config.ts';
import { HostError, hostCall } from '../execution/engine-errors.ts';

/** The model a session runs on, as the bridge's chat settings choose it. */
export type { SelectedModel };
const decodeSelectedModel = Schema.decodeUnknownEffect(selectedModel);

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
      const settings = yield* Capabilities.Service;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const webSearchEnabled = settings.read.pipe(
        Effect.map((capabilities) => capabilities.enabled('tool:web_search')),
        Effect.mapError((error) => error.cause),
      );
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
            const body: unknown = await response.json();
            return body;
          }).pipe(
            Effect.flatMap((body) =>
              decodeSelectedModel(body).pipe(Effect.mapError((cause) => new HostError({ cause }))),
            ),
            Effect.withSpan('SessionModels.selected'),
          ),
        model: (session, selected, cache) =>
          connectionModel(
            selected,
            origin(),
            token,
            (signal) => runPromise(webSearchEnabled, { signal }),
            cache
              ? 'wisp-' + createHash('sha256').update(session).digest('hex').slice(0, 32)
              : undefined,
            session,
          ),
      });
    }),
  );
}
