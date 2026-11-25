import { Effect, Exit, Scope } from 'effect';
import { makeAgentApp, type AgentDependencies } from '../src/agent/agent-server.ts';
import { serveOnLoopback } from '../src/loopback-server.ts';

/**
 * Serves the agent app on a free loopback port. Tests pass only the
 * dependencies the routes under test use.
 */
export async function serveAgent(deps: Partial<AgentDependencies>) {
  const scope = Scope.makeUnsafe();
  const port = await Effect.runPromise(
    makeAgentApp(deps as AgentDependencies).pipe(
      Effect.flatMap((app) => serveOnLoopback(app, 0)),
      Scope.provide(scope),
    ),
  );
  return {
    origin: 'http://127.0.0.1:' + port,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}
