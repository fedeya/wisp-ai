# Package boundaries

[Development](development.md) · [Game transport](transport.md)

**A change should stay with the part of Wisp it belongs to.** Changing a SQLite
table shouldn't affect a client. Changing the addon mailbox shouldn't affect
agent tools. Testing a tool shouldn't require a running host.

This guide describes the target architecture. [Where to start](#where-to-start)
calls out where the code still differs from it.

## The local runtime

```text
Desktop ───► Desktop API contract ◄─── Server
                                         ├──► Agent
                                         ├──► WoW bridge
                                         └──► SQLite storage
```

Arrows show source dependencies. The addon exchanges messages with the WoW bridge;
it doesn't import the bridge's TypeScript. Packaging the server with desktop is
a build dependency, separate from what the desktop UI imports.

| Workspace             | Responsibility                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`         | Runs the local host. Owns application workflows and permissions, and wires the agent, game transport, and storage together.                                                 |
| `apps/agent`          | Runs model turns, defines tools, assembles context, and declares the host capabilities it needs. The host or an eval supplies those capabilities.                           |
| `apps/desktop`        | Owns the desktop UI and supervises the local process. The UI uses the Desktop API to reach the host.                                                                        |
| `addon/WispAI`        | Owns the in-game UI, WoW API calls, and the Lua side of the game transport.                                                                                                 |
| `packages/wow-bridge` | Owns the TypeScript side of the game transport: mailbox framing, delivery, and matching responses to requests. The server decides what an event means for the application.  |
| `packages/db`         | Owns the SQLite file format, schema migrations, and connection lifecycle. Tables and transaction types stay out of client and agent APIs.                                   |
| `packages/protocol`   | Holds the Desktop API contract and product values shared across components. Agent-only requests, mailbox framing, and persisted rows belong to their respective boundaries. |

## Build, release, and test

| Workspace            | Responsibility                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/web`           | Presents setup and release information. Builds independently of the local runtime.                                      |
| `packages/releases`  | Provides shared version and channel rules to desktop, web, and release tooling.                                         |
| `packages/game-data` | Generates versioned game data. Runtime code consumes the generated data.                                                |
| `scripts`            | Builds, stages, and publishes artifacts. Can compose workspaces without making production code depend on build scripts. |
| `tests`              | Checks behavior across workspaces through their exports. Production code has no dependency on the test harness.         |

## Where to start

### Separate contracts by who uses them

[`desktop-routes.ts`](../packages/protocol/src/desktop-routes.ts) already lets
desktop and server share a contract without importing each other. Keep that
separation when reorganizing `@wisp/protocol`. A routine definition can be a
shared product value; a mailbox slot count belongs to the game wire format.
Move wire constants and encoders with the bridge, and expose packaging helpers
through an entry point for their actual consumers.

### Let the agent ask for capabilities

[`GameAccess`](../apps/agent/src/host/game-access.ts) already lets the server or
an eval supply game capabilities. Other calls through
[`agent-rpc.ts`](../apps/agent/src/host/agent-rpc.ts) still discover a loopback
host through global or environment configuration. Use supplied capabilities
for in-process calls and keep RPC where a separate process needs it.

### Give each application operation one owner

The [agent handler](../apps/server/src/agent/agent-server.ts) and
[addon handler](../apps/server/src/game/packet-receiver.ts) can resolve identity
and permissions differently. Both should delegate memory edits to the same
host operation. That operation owns whose memory changes, the quota, and the
resulting order. SQLite is how it persists the result.

## When to draw another package boundary

Start with a module and a clear API. Split a workspace when consumers need
different dependency surfaces, or when a component needs to build or run on
its own. A second client could justify a shared client SDK; a second host
could justify extracting application workflows. Memory, chat, and routines
can share workflows inside the current host.

## What CI can check

The [current package-boundary test](../tests/package-boundaries.test.ts)
checks whether the imports it scans are declared. To enforce the target,
check source imports separately from the build graph:

- Desktop frontend code can import the Desktop API contract; it can't import
  the server implementation.
- The agent can import shared product values; it can't import the host,
  SQLite storage, or the game transport.
- Contract packages can't import the components that implement them.
