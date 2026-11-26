import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { readContent } from '@wisp/agent/content';
import { Effect } from 'effect';

export function loadAgentContent() {
  return Effect.runPromise(readContent().pipe(Effect.provide(NodeFileSystem.layer)));
}
