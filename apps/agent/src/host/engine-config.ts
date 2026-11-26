import { Context, Layer, Logger, References } from 'effect';
import type { AgentHostCalls } from '../contract/host-calls.ts';
import type { ToolStub } from '../tools/turn-tools.ts';

export interface EngineLogger {
  info: (data: object, message: string) => void;
  warn: (data: object, message: string) => void;
}

/** What the engine needs from its host. */
export interface EngineHost {
  /** What the agent asks of the bridge: plain calls, since it runs in the bridge's process. */
  readonly calls: AgentHostCalls;
  /** The bridge's loopback endpoint for the model proxy and the MCP relay, and its token. */
  readonly origin: () => string;
  readonly token: string;
  /** Player-configured MCP servers (`mcp.json`). */
  readonly mcpConfigFile?: () => string | undefined;
  /** Evals answer tools from fixtures: a stub result replaces the tool's own. */
  readonly stub?: ToolStub;
}

export class EngineConfig extends Context.Service<EngineConfig, EngineHost>()(
  '@wisp/agent/EngineConfig',
) {}

const text = (message: unknown) =>
  Array.isArray(message) ? message.map(String).join(' ') : String(message);

/**
 * Effect's logs, written to the host's logger: the message, with the log
 * annotations (`event`, `error`, ...) as its structured data. Warnings and
 * worse go to `warn`.
 */
export const hostLogger = (logger: EngineLogger) =>
  Logger.layer([
    Logger.make(({ message, logLevel, fiber }) => {
      const data = { ...fiber.getRef(References.CurrentLogAnnotations) };
      if (logLevel === 'Warn' || logLevel === 'Error' || logLevel === 'Fatal') {
        logger.warn(data, text(message));
      } else {
        logger.info(data, text(message));
      }
    }),
  ]);

/** The engine's configuration and logging for a host. */
export const hostLayer = (host: EngineHost & { logger: EngineLogger }) => {
  const { logger, ...config } = host;
  return Layer.merge(Layer.succeed(EngineConfig, EngineConfig.of(config)), hostLogger(logger));
};
