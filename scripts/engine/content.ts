// @effect-migrated allow=effectRuns: entry.mjs, plain JavaScript in the packaged engine, awaits it
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { readContent } from '@wisp/agent/content';
import { Effect } from 'effect';

/** The agent's instructions and skills, for the packaged engine's self-test. */
export function loadAgentContent() {
  return Effect.runPromise(readContent().pipe(Effect.provide(NodeFileSystem.layer)));
}
