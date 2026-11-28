import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Exit, Scope } from 'effect';
import type { TestProject } from 'vitest/node';
import type { AgentHost } from '../../src/host/agent-host.ts';
import { startModelBridge } from './model-bridge.ts';

declare module 'vitest' {
  interface ProvidedContext {
    evalBridge: AgentHost & { model: string };
  }
}

/**
 * Vitest's global setup, an entry point: starts the eval model bridge for the
 * whole run and returns the teardown that stops it.
 */
export default function setup(project: TestProject) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { url, token, model } = yield* startModelBridge.pipe(
        Scope.provide(scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
      project.provide('evalBridge', { origin: url, token, model });
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      return () => runPromise(Scope.close(scope, Exit.void));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
