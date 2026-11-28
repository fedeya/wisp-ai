// @effect-migrated
import * as NodePath from '@effect/platform-node/NodePath';
import { Context, Effect, Layer, Option, Path } from 'effect';
import { sourceContentRoot } from '../wisp/content.ts';
import * as Environment from './environment.ts';

/**
 * The agent's settings from the environment its process starts with, read
 * once. What the host registers with `setAgentHost` takes precedence where both
 * name the same thing.
 */
export class AgentConfig extends Context.Service<
  AgentConfig,
  {
    /**
     * The authored instructions and skills: `WISP_AGENT_CONTENT`, which the
     * packaged engine sets to the assets next to its entry point, or else the
     * source tree's folder.
     */
    readonly contentRoot: string;
    /** `WOW_CAPABILITIES_FILE`: the capability settings when the host names no file. */
    readonly capabilitiesFile: string | undefined;
    /**
     * `WISP_ENGINE_EXECUTABLE` is set: the agent runs in the packaged engine,
     * which ships its own Node runtime and npm for MCP servers.
     */
    readonly packagedEngine: boolean;
  }
>()('@wisp/agent/AgentConfig') {}

/** Reads the settings from the current `ConfigProvider` (the environment by default). */
export const layer = Layer.effect(
  AgentConfig,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const contentRoot = yield* Environment.variable('WISP_AGENT_CONTENT').pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () => path.fromFileUrl(sourceContentRoot).pipe(Effect.orDie),
        }),
      ),
    );
    const capabilitiesFile = yield* Environment.variable('WOW_CAPABILITIES_FILE');
    const engineExecutable = yield* Environment.variable('WISP_ENGINE_EXECUTABLE');
    return AgentConfig.of({
      contentRoot,
      capabilitiesFile: Option.getOrUndefined(capabilitiesFile),
      packagedEngine: Option.isSome(engineExecutable),
    });
  }),
).pipe(Layer.provide(NodePath.layer));
