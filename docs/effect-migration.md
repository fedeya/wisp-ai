# Effect migration

[Development](development.md) · [Package boundaries](package-boundaries.md) · [Transport](transport.md)

Wisp's TypeScript workspaces are moving to idiomatic Effect v4 (`effect` 4.1.3).
The goal is a codebase where every side effect, dependency, failure, resource
and piece of background work goes through Effect, and data is modeled with
`Schema`. Wrapping existing Promise and class code in Effect is not the goal:
it keeps both styles and the problems of each.

Pure logic stays plain TypeScript (`reasoning.ts`, `context-windows.ts`, the
simulation adapters). Effect code calls it directly.

## Rules

1. **Replace, don't wrap.** A migrated module has no `async`, `new Promise`,
   `try`/`catch`, thrown expected failures or `Effect.run*` inside it.
   `Effect.tryPromise` appears only in adapters around third-party Promise APIs
   (AI SDK, MCP SDK, PostHog, impit) and maps the failure to a
   `Schema.TaggedError`. `Effect.promise` is never used for work that can fail:
   it turns a rejection into a defect.
2. **Leaves before the root.** Migrate platform adapters, then domain services,
   then HTTP, then `apps/server/src/runtime.ts`. Until the root is migrated,
   `makeServer` declares the migrated services in its requirements and
   `main.ts` provides them with one layer; no `Layer.build` and `Context.get`
   inside the root.
3. **Services by default.** Anything with dependencies, state or a lifecycle is
   a `Context.Service` with a layer (`Layer.effect` returning `Service.of(...)`)
   and `Effect.fn('Service.operation')` methods. Factories that take a bag of
   callbacks (`createX({ changed, saveChats, ... })`) are not used.
4. **Observable state, not callbacks.** Shared state lives in a service backed
   by `SubscriptionRef`. Whatever reacts to it (the addon snapshot publisher,
   chat persistence) subscribes to its changes; nothing calls `changed()`.
5. **Typed failures.** Expected failures are `Schema.TaggedError`s in the error
   channel. `Error` and `unknown` error types appear only at a boundary that
   maps them right away.
6. **Closed layers.** Consumers depend on the domain service, not on the
   infrastructure under it: don't `Layer.provideMerge` `SqlDatabase` out to
   them, and don't use `Layer.mergeAll` or `provideMerge` just to make types
   check.
7. **Tests through Effect.** `it.effect` and `layer(...)` from `@effect/vitest`,
   test layers instead of partial objects cast with `as unknown as`, and
   `TestClock` instead of real sleeps or fake timers.
8. **One module per PR.** A PR converts one module end to end (implementation,
   consumers and tests) and deletes the old path. It changes no behavior; a
   behavior change gets its own PR. Wire formats, files on disk and the
   contracts with the Rust host and the addon stay byte-compatible.

## From → to

| Today                                    | Effect                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `zod`                                    | `Schema`, `Schema.TaggedError`, brands; `effect/StandardSchema` where the AI SDK takes a schema          |
| Hono, `@hono/node-server`, `hono/client` | `HttpApi` (contract in `@wisp/protocol`), `HttpApiBuilder`, `NodeHttpServer`; `HttpApiClient` in Desktop |
| `fetch`                                  | `HttpClient` with `retryTransient` and Schema-decoded bodies                                             |
| `node:fs`, `json-file.ts`                | `FileSystem`, `Path`, `Schema.fromJsonString`                                                            |
| `node:child_process`                     | `ChildProcess` (`effect/process`)                                                                        |
| `process.env`                            | `Config`; tests use `ConfigProvider`                                                                     |
| `setTimeout`, `setInterval`              | `Schedule`, `Effect.sleep`, `Effect.timeout`, fibers forked in the owning layer's scope                  |
| Mutable `state` and `changed()`          | `SubscriptionRef`, `PubSub`, `Stream`                                                                    |
| `shutdownRequested`, `engineReady`       | The scope's finalizers, `Latch`                                                                          |
| Hand-rolled fibers, locks and caches     | `FiberHandle`, `FiberMap`, `Semaphore`, `Cache`, `Effect.cachedWithTTL`                                  |
| `jose`, `randomBytes`                    | `effect/jose`, `effect/crypto`                                                                           |
| API keys and tokens as `string`          | `Redacted`                                                                                               |
| `Date.now()`                             | `Clock`, `DateTime`                                                                                      |
| `process.argv` in scripts                | `effect/cli`                                                                                             |
| Plain Vitest                             | `@effect/vitest`, `TestClock`                                                                            |

## Kept as they are

- **AI SDK** (`ai` and its providers), behind Effect services. Effect AI v4
  ships providers for OpenAI, Anthropic, OpenRouter, Amazon Bedrock and
  OpenAI-compatible APIs; Wisp uses 19 AI SDK provider packages plus
  OpenRouter, and Google has no v4 package.
- **`@modelcontextprotocol/sdk`**, unless the spike in phase 6 shows that
  `effect/ai`'s `McpClient` covers stdio, streamable HTTP and the auth flows
  Wisp uses.
- **Drizzle** as the query builder on `@effect/sql-sqlite-node`
  (`drizzle-orm/effect-sqlite-node`), with drizzle-kit migrations.
- **Libraries without an Effect equivalent** (PostHog, OpenFeature, impit,
  linkedom, turndown, marked, fengari), behind services.
- **Out of scope:** `apps/web` (Next.js), the Rust host and the Lua addon. The
  Desktop React UI is an optional last phase.

## Target structure

The migration also fixes where code lives, so the rewritten modules land in a
layout worth keeping. Today `apps/server/src/` mixes the entry point, platform
helpers, domain services and code on its way out at its root; `chat/` and
`reply/` import each other; HTTP servers sit in `api/`, `agent/`, `models/`
and `auth/`; and `integrations/` holds settings that every domain reads.

### Principles

1. **Folders by domain, not by kind.** A folder is about one part of Wisp (chats,
   routines, the game connection) and owns its services, repository, schemas,
   desktop API handlers and the agent host port it implements. No `services/`,
   `utils/` or `helpers/` folders.
2. **`platform/` for the machine and the network.** Configuration, logging, the
   HTTP client, JSON settings files and the secret vault: adapters every domain
   may use, with no domain logic.
3. **`http/` for servers.** Listeners, security middleware and which API is
   served where. Handlers stay in their domain (`<domain>-api.ts`) and stay
   thin.
4. **One direction.** `platform/` ← domains ← `http/` ← `server.ts`. A domain
   uses another domain through its service, never its records, repository or
   private helpers, and folders never import each other in a cycle.
5. **The root holds the entry point and the layer graph only:** `main.ts` and
   `server.ts`. Nothing else is added there.
6. **Contracts stay in packages:** `@wisp/protocol` (Desktop and server,
   including the `HttpApi`), `@wisp/agent/contract` (agent and host),
   `@wisp/wow-bridge` (addon wire format), `@wisp/db` (SQLite schema).
7. **Names.** kebab-case, one main export per file, prefixed with the domain
   when the bare name would be ambiguous in a search (`routine-store.ts`, not
   `store.ts`). A domain with a single file can stay a file
   (`integrations/thewowdb.ts`).

### `apps/server/src`

```text
main.ts           process entry: Layer.launch(ServerLayer) with NodeRuntime.runMain
server.ts         ServerLayer, the layer graph (today's runtime.ts)
platform/         app-config, http-client, json-file, logger, errors, secret-vault
http/             desktop-server (Desktop HttpApi), agent-server (model proxy, MCP relay)
session/          SessionState on SubscriptionRef and its change stream
game/             WoW transport, packet receiver, snapshot publisher, item loading, the agent's Game port
chat/             Chat schema, repository, lifecycle, projection, history, titles, references, replies
turns/            agent engine wiring, turn runner, turn context, agent history and sessions
auth/             ChatGPT sign-in and its callback page, account operations
models/           model connections, catalog, failures, timing, proxy handler, response stream
capabilities/     capability switches and integration availability
integrations/     one folder (or file) per external service: everloot/, mcp/, search/, simulation/, thewowdb.ts
memory/  panels/  routines/  features/  telemetry/  settings/  migrations/  evals/
```

| Today                                                                                               | Target                                    |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `runtime.ts`                                                                                        | `server.ts` (phase 5)                     |
| `runtime-resources.ts`, `application-database.ts`, `loopback-server.ts`                             | Deleted by phases 3–5                     |
| `app-config.ts`, `http-client.ts`, `json-file.ts`, `logger.ts`, `errors.ts`, `auth/secret-vault.ts` | `platform/`                               |
| `api/desktop-server.ts`; the listener in `agent/agent-server.ts`                                    | `http/`                                   |
| `api/desktop-handler.ts`                                                                            | Each domain's `<domain>-api.ts` (phase 4) |
| `session-state.ts`                                                                                  | `session/`                                |
| `features.ts`, `telemetry.ts`, `bridge-config.ts`                                                   | `features/`, `telemetry/`, `settings/`    |
| `account-operations.ts`                                                                             | `auth/`                                   |
| `reply/*`                                                                                           | `chat/` (ends the `chat` ↔ `reply` cycle) |
| `agent/turn-runner.ts`, `agent-history.ts`, `agent-session.ts`, `chat/context.ts`                   | `turns/`                                  |
| `integrations/capabilities.ts`, `integrations/integration-state.ts`                                 | `capabilities/`                           |
| `integrations/gear-search.ts`, `integrations/item-sources.ts`                                       | `integrations/everloot/`                  |

`apps/agent/src` keeps its layout (`contract/`, `execution/`, `host/` ports,
`integrations/`, `models/`, `session/`, `tools/` and the `wisp/` tool catalog);
`host/agent-rpc.ts` and `host/agent-host.ts` go away with the last RPC routes in
phase 4.

### Moving files

- A migration PR moves the module it rewrites to its target folder, with its
  tests, and updates every import. New modules go straight to their target.
- A module that only needs to move gets a move-only PR, so Git shows renames
  and nothing else; it is never mixed with a rewrite of another module.
- Moving keeps a file's package export name; replacing a module's API renames
  or removes the export (rule 8).

## Phases

Each item is one PR unless it says otherwise. Tick it in the PR that lands it.

### 0. Standard and guardrails

- [ ] This plan and the Effect rules in `AGENTS.md`.
- [ ] `@effect/vitest` in the workspaces with Effect tests, with
      `packages/db`'s tests as the example.
- [ ] Ratchets: Effect language service diagnostics as errors where the code is
      already clean, restricted imports for clean folders, and a scoreboard
      test that fails when a count of non-Effect patterns goes up.

### 1. Schema

- [ ] `@wisp/protocol`, in one PR: every file feeds the Desktop API contract
      through `desktop.ts` and `desktop-routes.ts`. Desktop gains `effect`.
- [ ] `apps/agent/src/contract`, one PR per tool family (inspection, actions,
      presentation and UI, panels, routines and simulation). Snapshot each
      tool's JSON Schema before and after: the model must see the same schemas.
- [ ] The remaining `zod` in `apps/server` and `apps/agent`; drop the
      dependency.

### 2. Platform adapters

- [ ] App configuration on `Config` (`WISP_*` variables, app paths).
- [ ] `json-file.ts` and the bridge config on `FileSystem` and `Schema`, with
      the same file formats.
- [ ] `SecretVault` on `ChildProcess`, secrets as `Redacted`.
- [ ] `Simulator` on `ChildProcess` and `Stream`.
- [ ] One `HttpClient` layer; TheWoWDB, web search (Exa, public, Wowhead) and
      model discovery on it.
- [ ] `ChatGPTAuth`: `HttpClient`, `effect/jose`, `Redacted`, refresh on a
      `Schedule`, callback server on `HttpRouter`.

### 3. Domain services and state

- [ ] SQL repositories (routines, panels, memory, chats, agent history) on
      `SqlDatabase`. They move together: a synchronous connection and an Effect
      connection to the same file in one process can lock each other. One
      commit per store, and no behavior changes (`BEGIN IMMEDIATE`, row
      validation) in this PR.
- [ ] `ModelConnections` and the model catalog refresh.
- [ ] `WebSearch` settings.
- [ ] `CapabilitySettings` and `IntegrationState`, with the health check on a
      `Schedule`.
- [ ] `Features`: OpenFeature behind a service, flag values in a
      `SubscriptionRef`.
- [ ] `UsageTelemetry`: PostHog behind a service, flushed in a finalizer.
- [ ] `SessionState` on `SubscriptionRef`; the snapshot publisher and chat
      persistence subscribe to it, and `changed()` goes away.
- [ ] Turn runner and routine scheduler: fibers in `FiberMap` and
      `FiberHandle`, ticks on `Schedule`; `shutdownRequested` and
      `engineReady` become the scope and a `Latch`.

### 4. HTTP

- [ ] Desktop API as an `HttpApi` in `@wisp/protocol`, replacing
      `desktop-routes.ts`: `HttpApiBuilder` handlers, bearer and no-`Origin`
      middleware, body limit, `NodeHttpServer`. Compatible with what the Rust
      host uses (`desktop.json`, the bearer token, `/addon/transport`).
- [ ] Desktop client: `HttpApiClient` over an `HttpClient` that sends requests
      through Tauri's `bridge_request`; removes `hono` from Desktop.
- [ ] Agent server: the remaining RPC routes become direct calls to host
      services; the model proxy and MCP relay move to `HttpRouter` with
      streamed responses.

### 5. Composition root

- [ ] `runtime.ts` becomes one `AppLayer`, and `main.ts` runs
      `Layer.launch(AppLayer)` with `NodeRuntime.runMain`. Shutdown order
      follows the layer graph. `startup()`, `RuntimeResources`,
      `releaseRuntimeResource`, `Effect.uninterruptible` and `runPromiseWith`
      are deleted.

### 6. Agent

- [ ] `process.env` on `Config` (`WISP_AGENT_CONTENT`, `WOW_CAPABILITIES_FILE`,
      `WISP_ENGINE_EXECUTABLE`).
- [ ] Web fetch (impit, linkedom, turndown) and the public web tunnel as scoped
      services.
- [ ] Spike: `effect/ai`'s `McpClient` against `@modelcontextprotocol/sdk`;
      record the decision here.

### 7. Scripts and game data

Independent of the other phases; these PRs can run in parallel.

- [ ] Release scripts on `effect/cli`, `ChildProcess`, `FileSystem`, `Config`
      and `HttpClient`.
- [ ] Build and staging scripts.
- [ ] Verify and smoke scripts.
- [ ] `@wisp/game-data`: `effect/cli`, `HttpClient` for wago.tools and the
      `Csv` module from `effect/encoding`.

### 8. Desktop UI (optional)

- [ ] Spike `@effect/atom-react` with `AtomHttpApi` on the Routines page, then
      decide whether it replaces Zustand and the `useEffect` loaders.

## Done

- The scoreboard reads zero for `zod`, Hono, Node I/O imports, timers,
  `process.env` and `new Promise` in every workspace in scope; `Effect.run*`
  remains only in entry points and SDK callbacks, and `Effect.tryPromise` only
  in adapters.
- Every migrated workspace is under the restricted-imports rule.

## Writing a migration PR

1. Read `node_modules/effect/AGENTS.md` and the matching reference in
   [`.agents/skills/effect/references/`](../.agents/skills/effect/references/).
2. Convert the module and all its consumers, delete the old code path, and put
   the module in its [target folder](#target-structure).
3. Move its tests to `@effect/vitest`, with test layers instead of partial
   dependency objects.
4. Record the scoreboard drop, and extend the restricted-imports rule to the
   folder if it is clean now.
5. Tick the item above.
