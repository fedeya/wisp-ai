---
name: effect-ts
description: Use when writing, refactoring, reviewing, or testing Effect v4 code in Wisp, or when setting up Effect. Covers services and layers, typed errors, runtime boundaries, cancellation, and scoped resources.
---

# Effect in Wisp

## Sources of truth

1. Before writing Effect code, read `node_modules/effect/AGENTS.md` completely
   and follow the linked examples relevant to the task. For APIs the guide
   doesn't cover, inspect `node_modules/effect/src` at the installed version.
2. Read the Effect conventions in the root [`AGENTS.md`](../../../AGENTS.md#current-priority-an-effect-native-codebase)
   and the closest implementation in Wisp. Use the installed library for API
   behavior and Wisp's code and guide for local conventions.
3. If dependencies are missing, run `pnpm install --frozen-lockfile`. Wisp
   already pins Effect in the root and in the workspaces that use it. Keep
   those versions aligned, and declare Effect in each workspace that imports it.

## Pick a local example

- **Service and layer:** [`capabilities.ts`](../../../apps/agent/src/host/capabilities.ts)
  exports the `Service` tag and a separate `layerFromFile`. The
  [server runtime](../../../apps/server/src/runtime.ts) selects that implementation
  and supplies `NodeFileSystem.layer`.
- **SDK callback:** the [turn toolbox](../../../apps/agent/src/tools/turn-toolbox.ts)
  captures the Effect context before running MCP operations from Promise-based
  tool callbacks.
- **Resource lifetime:** [`McpConnection.Service.open`](../../../apps/agent/src/integrations/mcp-connection.ts)
  registers the SDK client's release in the caller's scope before connecting,
  and passes the fiber's `AbortSignal` to each SDK call, so interrupting the
  open or a call aborts it and closing the scope closes the client.

## Verify the change

Run typechecks and the relevant tests in the affected workspace. When a test is
needed, exercise the actual operation and substitute external dependencies with
test layers where useful. Use real temporary resources when testing platform
behavior. For resource changes, verify failure and interruption paths as well
as success, including that cleanup finishes before shutdown returns.
