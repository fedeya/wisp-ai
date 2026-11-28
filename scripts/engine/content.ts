import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as AgentConfig from '@wisp/agent/agent-config';
import { readContent } from '@wisp/agent/content';
import { Effect } from 'effect';

export function loadAgentContent() {
  return Effect.runPromise(
    Effect.flatMap(AgentConfig.AgentConfig, ({ contentRoot }) => readContent(contentRoot)).pipe(
      Effect.provide([NodeFileSystem.layer, AgentConfig.layer]),
    ),
  );
}
