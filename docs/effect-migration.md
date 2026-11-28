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
   it turns a rejection into a defect. A migrated module imports nothing from
   `zod` itself: until [phase 1](#1-schema) converts them, it takes contract
   types and schemas from the contract module (`@wisp/agent/contract/...`,
   `@wisp/protocol/...`). A migrated file starts with `// @effect-migrated`,
   and `tests/effect-migrated.test.ts` fails while it still has a scoreboard
   pattern. A migrated file has no `as` casts (`as const` aside), `any`, non-null
   assertions, `@ts-ignore` comments or `JSON.parse`: fix the type, or decode
   with `Schema` (the same test runs oxlint's type-aware rules on it).
2. **Leaves before the root.** Migrate platform adapters, then domain services,
   then HTTP, then `apps/server/src/runtime.ts`. Until the root is migrated,
   `makeServer` declares the migrated services in its requirements and
   `main.ts` provides them with one layer; no `Layer.build` and `Context.get`
   inside the root. Unmigrated consumers keep their current interface, and
   `runtime.ts` adapts a migrated service for them in one marked block until
   they migrate.
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
   consumers and tests) and deletes the old path, including package exports and
   names nobody imports anymore; no compatibility aliases. The module's own zod
   schemas move to `Schema` in the same PR; only shared contract schemas
   (`@wisp/protocol`, `@wisp/agent/contract`) wait for phase 1. A migration PR
   changes no behavior; a behavior change gets its own PR (see phase 9). Wire
   formats, files on disk and the contracts with the Rust host and the addon stay
   byte-compatible.

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
   `utils/` or `helpers/` folders. A domain is a part of Wisp, not a feature:
   new features land in an existing domain, and a domain that grows gets
   subfolders inside it.
2. **`platform/` for the machine and the network.** Configuration, logging, the
   HTTP client, JSON settings files and the secret vault: adapters every domain
   may use, with no domain logic.
3. **`http/` for servers.** Listeners, security middleware and which API is
   served where. Handlers stay in their domain (`api.ts`) and stay thin.
4. **`index.ts` is a domain's public surface.** Other domains import it as
   `#/<domain>` (`#/routines`, `#/integrations/search`) and platform modules as
   `#/platform/<name>`, through the `imports` field of `apps/server/package.json`:

   ```json
   "imports": { "#/platform/*": "./src/platform/*.ts", "#/*": "./src/*/index.ts" }
   ```

   Node 26, TypeScript, Vitest and esbuild resolve it as is; `#/` is Node's native
   form of the `~/` and `@/` aliases other tools configure in `tsconfig` paths,
   which plain Node would ignore at runtime. `index.ts` exports
   explicitly (the service, its layer, and the schemas, types and errors other
   domains need), never `export *`. Everything else in the folder is private:
   only files inside the domain import it, with relative paths. A small domain
   can be just its `index.ts`. `tests/domain-boundaries.test.ts` enforces this
   in `apps/server/src` for each domain with a door (an `index.ts`, or
   `platform/`): files marked `// @effect-migrated` reach it through `#/`, no
   file outside it imports its private files (`runtime.ts` and `main.ts` aside
   until phase 5), such domains don't import each other in a cycle, and no file
   joins today's `src/` root.

5. **One direction.** `platform/` ← domains ← `http/` ← `server.ts`, and
   folders never import each other in a cycle.
6. **The root holds the entry point and the layer graph only:** `main.ts` and
   `server.ts`. Nothing else is added there.
7. **Contracts stay in packages:** `@wisp/protocol` (Desktop and server,
   including the `HttpApi`), `@wisp/agent/contract` (agent and host),
   `@wisp/wow-bridge` (addon wire format), `@wisp/db` (SQLite schema).
8. **Names.** kebab-case and one main export per file. Inside a domain, name a
   file by its role or concept without repeating the domain (`routines/repo.ts`,
   `routines/scheduler.ts`, not `routines/routine-store.ts`); qualify only when
   two files in one folder share a role (`users-repo.ts`, `accounts-repo.ts`).
9. **Tests mirror the domains** under `apps/server/tests/`
   (`tests/routines/scheduler.test.ts`). A test may import its own domain's
   private files and other domains through `#/<domain>`.

### `apps/server/src`

```text
main.ts           process entry: Layer.launch(ServerLayer) with NodeRuntime.runMain
server.ts         ServerLayer, the layer graph (today's runtime.ts)
platform/         config, http-client, json-file, logger, errors, secret-vault
http/             desktop (Desktop HttpApi server), agent (model proxy, MCP relay)
routines/         index (Routines service), repo, scheduler, gate, api
chat/             index, repo, lifecycle, projection, history, titles, references, replies, api
session/          index: SessionState on SubscriptionRef and its change stream
game/             transport, packet receiver, snapshot publisher, item loading, the agent's Game port
turns/            agent engine wiring, turn runner, turn context, agent history and sessions
auth/             ChatGPT sign-in and its callback page, account operations
models/           connections, catalog, failures, timing, proxy handler, response stream
capabilities/     capability switches and integration availability
integrations/     one domain per external service: everloot/, mcp/, search/, simulation/, thewowdb/
memory/  panels/  features/  telemetry/  settings/  migrations/  evals/
```

| Today                                                                                               | Target                                            |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `runtime.ts`                                                                                        | `server.ts` (phase 5)                             |
| `runtime-resources.ts`, `application-database.ts`, `loopback-server.ts`                             | Deleted by phases 3–5                             |
| `app-config.ts`, `http-client.ts`, `json-file.ts`, `logger.ts`, `errors.ts`, `auth/secret-vault.ts` | `platform/` (`app-config.ts` becomes `config.ts`) |
| `api/desktop-server.ts`; the listener in `agent/agent-server.ts`                                    | `http/`                                           |
| `api/desktop-handler.ts`                                                                            | Each domain's `api.ts` (phase 4)                  |
| `session-state.ts`                                                                                  | `session/`                                        |
| `features.ts`, `telemetry.ts`, `bridge-config.ts`                                                   | `features/`, `telemetry/`, `settings/`            |
| `account-operations.ts`                                                                             | `auth/`                                           |
| `reply/*`                                                                                           | `chat/` (ends the `chat` ↔ `reply` cycle)         |
| `agent/turn-runner.ts`, `agent-history.ts`, `agent-session.ts`, `chat/context.ts`                   | `turns/`                                          |
| `integrations/capabilities.ts`, `integrations/integration-state.ts`                                 | `capabilities/`                                   |
| `integrations/gear-search.ts`, `integrations/item-sources.ts`                                       | `integrations/everloot/`                          |
| `integrations/thewowdb.ts`                                                                          | `integrations/thewowdb/`                          |
| `routines/routine-store.ts`, `chat/chat-record.ts` and other prefixed files                         | Role names in their domain (`repo.ts`, …)         |

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
- A file that moves into its domain drops the domain prefix from its name
  (`routines/routine-record.ts` → `routines/repo.ts`), and its importers from
  other domains switch to `#/<domain>`.

## Phases

Each item is one PR unless it says otherwise. It is ticked after that PR
merges.

### 0. Standard and guardrails

- [x] This plan and the Effect rules in `AGENTS.md` ([#312](https://github.com/fedeya/wisp-ai/pull/312), [#317](https://github.com/fedeya/wisp-ai/pull/317), [#320](https://github.com/fedeya/wisp-ai/pull/320)).
- [x] `@effect/vitest` in the workspaces with Effect tests, with
      `packages/db`'s tests as the example ([#313](https://github.com/fedeya/wisp-ai/pull/313)).
- [x] Ratchets: Effect language service diagnostics as errors where the code is
      already clean, restricted imports for clean folders, and a scoreboard
      test that fails when a count of non-Effect patterns goes up ([#314](https://github.com/fedeya/wisp-ai/pull/314)).
- [x] The `// @effect-migrated` marker: a marked file fails on any scoreboard
      pattern, `JSON.parse`, or a type-aware lint finding for unchecked casts,
      `any`, non-null assertions, `ts-ignore` and plain `as` casts ([#321](https://github.com/fedeya/wisp-ai/pull/321),
      [#330](https://github.com/fedeya/wisp-ai/pull/330), [#331](https://github.com/fedeya/wisp-ai/pull/331)).
- [x] Domain boundaries: the `imports` field in `apps/server/package.json` and a
      test that fails on a relative import that leaves its domain folder, a cycle
      between folders, or a new file at the `src/` root. It covers the migrated
      domains and grows with them ([#325](https://github.com/fedeya/wisp-ai/pull/325)).
- [ ] Stricter compiler, one workspace at a time: `noUncheckedIndexedAccess` is
      on in `protocol`, `db` and `releases` ([#327](https://github.com/fedeya/wisp-ai/pull/327)), `apps/agent` ([#328](https://github.com/fedeya/wisp-ai/pull/328)), `scripts` ([#332](https://github.com/fedeya/wisp-ai/pull/332)),
      `wow-bridge` ([#337](https://github.com/fedeya/wisp-ai/pull/337)), `game-data` ([#338](https://github.com/fedeya/wisp-ai/pull/338)), `tests` ([#342](https://github.com/fedeya/wisp-ai/pull/342)) and `apps/desktop` ([#344](https://github.com/fedeya/wisp-ai/pull/344));
      left is `apps/server` (383 errors, 348 of them in its tests).
- [ ] `noImplicitOverride`, `noImplicitReturns` and `noFallthroughCasesInSwitch`
      are on in every workspace's own tsconfig ([#339](https://github.com/fedeya/wisp-ai/pull/339), [#337](https://github.com/fedeya/wisp-ai/pull/337), [#338](https://github.com/fedeya/wisp-ai/pull/338),
      [#344](https://github.com/fedeya/wisp-ai/pull/344)); left is moving them into `tsconfig.base.json` and dropping the
      copies. `apps/desktop/src/tsconfig.json` does not extend the base, so it
      keeps its own.
- [ ] The type-aware lint rules (`no-unsafe-*`, `no-unsafe-type-assertion`,
      `consistent-type-assertions`, `no-non-null-assertion`, `no-explicit-any`) go
      from `warn` to `error` repo-wide once their counts reach zero.

### 1. Schema

- [x] `@wisp/protocol`, in one PR: every file feeds the Desktop API contract
      through `desktop.ts` and `desktop-routes.ts`. Desktop gains `effect` ([#336](https://github.com/fedeya/wisp-ai/pull/336)).
- [ ] `apps/agent/src/contract`, one PR per tool family (inspection, actions,
      presentation and UI, panels, routines and simulation). The model must see
      the same schemas: `apps/agent/tests/tool-schemas.test.ts` snapshots every
      tool's JSON Schema, and a family's PR leaves that snapshot unchanged.
      Inspection is done ([#346](https://github.com/fedeya/wisp-ai/pull/346)), with the shared building blocks in
      `contract/tool-inputs.ts`; left are actions (with the settings update and
      undo), presentation and UI, panels, and routines and simulation.
- [ ] The remaining `zod` in `apps/server` and `apps/agent`; drop the
      dependency.

### 2. Platform adapters

- [x] App configuration on `Config` (`WISP_*` variables, app paths).
- [x] `json-file.ts` and the bridge config on `FileSystem` and `Schema`, with
      the same file formats: `platform/json-file.ts` and the `Settings` service
      for `config.local.json` ([#341](https://github.com/fedeya/wisp-ai/pull/341)). The root `json-file.ts` stays for the
      consumers that have not migrated (capabilities, model connections, the
      desktop server, `runtime.ts`) and goes with the last of them.
- [x] `SecretVault` on `ChildProcess`, secrets as `Redacted`.
- [x] `Simulator` on `ChildProcess` and `Stream`.
- [ ] One `HttpClient` layer; TheWoWDB, web search (Exa, public, Wowhead) and
      model discovery on it. TheWoWDB is on it ([#316](https://github.com/fedeya/wisp-ai/pull/316)); web search and model
      discovery are left.
- [x] `ChatGPTAuth`: `HttpClient`, `effect/jose`, `Redacted`, refresh on a
      `Schedule`, callback server on `HttpRouter` ([#329](https://github.com/fedeya/wisp-ai/pull/329)).

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
- [x] `@wisp/game-data`: `effect/cli`, `HttpClient` for wago.tools, and its JSON
      inputs decoded with `Schema` ([#326](https://github.com/fedeya/wisp-ai/pull/326)). It keeps its own CSV parser; see
      phase 9.

### 8. Desktop UI (optional)

- [ ] Spike `@effect/atom-react` with `AtomHttpApi` on the Routines page, then
      decide whether it replaces Zustand and the `useEffect` loaders.

### 9. Deferred behavior changes

Changes a migration PR found worth making but left out to stay a pure
migration. Each lands in its own PR after its module is migrated, with a release
note when players can notice it. A migration PR that leaves one out lists it in
its description; it is added here, with a link to that PR, after the PR merges.

- [x] Simulator: decode the pinned data files (`classes.json`, `items.json`,
      `manifest.json`) and the CLI's `output.json` with `Schema` instead of
      `JSON.parse` into loose types, so malformed data fails with a typed error
      instead of reaching the simulation ([#333](https://github.com/fedeya/wisp-ai/pull/333)).
- [ ] Game data: parse wago.tools tables with `effect/encoding`'s `Csv`, which
      strips a BOM, fails on stray quotes and keeps `""`-only lines where the
      current parser does not, and decode table rows with `Schema` instead of the
      `num`/`str` helpers ([#326](https://github.com/fedeya/wisp-ai/pull/326)).
- [ ] TheWoWDB: decode responses into typed schemas instead of checking unknown
      JSON with `Schema.is`; the record the agent receives may then lose the
      source's key order ([#316](https://github.com/fedeya/wisp-ai/pull/316)).
- [ ] ChatGPT sign-in: bound the id token's length before verifying it, as
      `effect/jose` advises, and decode the model catalog strictly instead of
      dropping fields of the wrong type ([#329](https://github.com/fedeya/wisp-ai/pull/329)).
- [ ] Desktop IPC: decode each native command's reply with a schema; `desktop()`
      decodes `desktop_info` only and trusts the caller's type for the rest
      ([#336](https://github.com/fedeya/wisp-ai/pull/336)).
- [ ] MCP manager: decode the saved MCP configuration and its env secret with
      `Schema` instead of `JSON.parse` with casts; a malformed entry may then
      fail where it is accepted today ([#336](https://github.com/fedeya/wisp-ai/pull/336)).
- [ ] Settings: write `config.local.json` encoded with its own schema instead of
      the saved object through `Record(String, Unknown)`; its keys then follow
      the schema's field order instead of the order they were first saved in
      ([#341](https://github.com/fedeya/wisp-ai/pull/341)).
- [ ] JSON settings files: accept a UTF-8 byte order mark. They are read like
      Node's `readFile(file, 'utf8')`, which keeps it, so the file fails to
      parse ([#341](https://github.com/fedeya/wisp-ai/pull/341)).
- [ ] Tool schemas: drop `effectToolInput`'s `layout: 'zod'` once every family
      is on `Schema`, and send the model Effect's own JSON Schema. The shim
      rewrites it as zod wrote it: zod's keyword order, `properties: {}` on every
      object without properties, and no `additionalProperties: true`. One
      deliberate snapshot update, checked against the evals; the zod wording in
      `contract/tool-inputs.ts` goes with it ([#346](https://github.com/fedeya/wisp-ai/pull/346)).
- [ ] Repositories, with phase 3 (proposed in [#307](https://github.com/fedeya/wisp-ai/pull/307)):
  - [ ] Transactions take `BEGIN IMMEDIATE`, including the startup read of
        chats.
  - [ ] Rows are validated against their schemas when read, and a damaged row
        fails with `CorruptRecord`.
  - [ ] The legacy JSON import (`importProductData`) runs once as a startup step
        instead of lazily in every store method.
  - [ ] Panels are read from SQLite on every call instead of an in-memory copy.
  - [ ] The routine scheduler ticks on `Schedule.fixed('3 seconds')`.

## Done

- The scoreboard reads zero for `zod`, Hono, Node I/O imports, timers,
  `process.env` and `new Promise` in every workspace in scope; `Effect.run*`
  remains only in entry points and SDK callbacks, and `Effect.tryPromise` only
  in adapters.
- Every migrated workspace is under the restricted-imports rule.
- Every workspace compiles with `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noImplicitReturns` and `noFallthroughCasesInSwitch`, and the type-aware lint
  rules above are errors repo-wide.

## Working in parallel

Migration PRs run in parallel when they rewrite different files. A few lines of
overlap in `apps/server/src/runtime.ts` (a layer added to `ServerServices`, an
adapter) are fine: the PR that merges second merges `main` and resolves them.
Only rewrites of the composition root itself (phase 5) go one at a time. The
scoreboard test fails only when a count rises above the baseline, so PRs don't
lower the baseline; it is lowered with `pnpm --filter @wisp/tests effect:baseline`
after they merge. A PR that has to raise a count honestly (an adapter's
`Effect.run*`, a new `throw` the code needs) raises it in its own diff and says
why.

## Writing a migration PR

1. Read `node_modules/effect/AGENTS.md` and the matching reference in
   [`.agents/skills/effect/references/`](../.agents/skills/effect/references/).
2. Convert the module (its own zod schemas included) and all its consumers,
   delete the old code path, and put the module in its
   [target folder](#target-structure).
3. Move its tests to `@effect/vitest`, with test layers instead of partial
   dependency objects.
4. Start each of the module's files with `// @effect-migrated`.
   `tests/effect-migrated.test.ts` fails while a marked file has any of the
   scoreboard's patterns; an allowance names the patterns and a reason, such as
   `// @effect-migrated allow=effectPromises: adapter around the MCP SDK`.
   Check files with `pnpm --filter @wisp/tests effect:audit <files...>`, and
   extend the restricted-imports rule to the folder if it is clean now.
5. Leave the checkboxes above alone, and don't lower
   `tests/effect-migration-baseline.json`: both are updated after the PR merges.
6. If you left a behavior change out, list it in the PR description; it is
   added to [phase 9](#9-deferred-behavior-changes) after the PR merges.
