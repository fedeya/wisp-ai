// @effect-migrated
import { Context } from 'effect';
import type { ToolStub } from '../tools/turn-tools.ts';

/** What the engine needs from its host. */
export interface EngineHost {
  /** The bridge's loopback agent endpoint and its token. */
  readonly origin: () => string;
  readonly token: string;
  /** Evals answer tools from fixtures: a stub result replaces the tool's own. */
  readonly stub?: ToolStub;
}

export class EngineConfig extends Context.Service<EngineConfig, EngineHost>()(
  '@wisp/agent/EngineConfig',
) {}
