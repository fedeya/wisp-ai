# Wisp AI — agent guide

Wisp is an AI assistant for World of Warcraft: Forever: a Lua addon talks to a
local Node bridge, which runs an agent runtime and is shipped inside a Tauri
desktop app for Windows. It is a pnpm + Turborepo monorepo (one lockfile,
`hoist: false`). Human-facing setup lives in [docs/development.md](docs/development.md).

Before moving code between workspaces or adding a cross-workspace dependency,
consult [Package boundaries](docs/package-boundaries.md) for the target
ownership and dependency direction.

Nested guides apply on top of this file: [addon/AGENTS.md](addon/AGENTS.md) and
[apps/web/AGENTS.md](apps/web/AGENTS.md).

## Workspaces

| Path                  | Package            | What it is                                                                                                        |
| --------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `apps/server`         | `@wisp/server`     | Local Node host: composes the agent, WoW bridge, Desktop API, SQLite storage and other Wisp services              |
| `apps/agent`          | `@wisp/agent`      | Agent runtime on the AI SDK and Effect, run in the server: models, tools, skills and instructions                 |
| `apps/desktop`        | `@wisp/desktop`    | Tauri desktop app: React + Vite frontend in `src/`, Rust host in `src-tauri/`                                     |
| `apps/web`            | `@wisp/web`        | Next.js website (setup guide, changelog from GitHub Releases)                                                     |
| `packages/db`         | `@wisp/db`         | SQLite database for the server: Drizzle schema, migrations, opening and migrating the file                        |
| `packages/protocol`   | `@wisp/protocol`   | Zod schemas the desktop and bridge share (providers, capabilities, features, routines, search), and addon helpers |
| `packages/releases`   | `@wisp/releases`   | Release channel/version helpers shared by desktop, web, scripts                                                   |
| `packages/wow-bridge` | `@wisp/wow-bridge` | WoW addon transport, mailbox codecs and pending game requests                                                     |
| `packages/game-data`  | `@wisp/game-data`  | Generates game data files (e.g. `addon/WispAI/Data/`) from Forever’s game tables on wago.tools                    |
| `addon/WispAI`        | `@wisp/addon`      | The WoW addon (Lua 5.1); sources must be listed in `WispAI.toc`                                                   |
| `simulator/`          | —                  | Checked-in metadata and license for the pinned WoWSims simulator (not a workspace)                                |
| `scripts/`            | `@wisp/scripts`    | Build, staging, packaging and release scripts (`.ts` run directly with `node`, some `.ps1`)                       |
| `tests/`              | `@wisp/tests`      | Cross-component integration tests and repository-wide checks                                                      |

## Commands

Run from the repository root. Toolchain: Node 26.13.1+ and pnpm 12.18.0
(`mise install` uses [mise.toml](mise.toml), which also pins Rust, Go, protoc and PowerShell 7).

| Command                                         | Does                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                | Install workspace dependencies                                                              |
| `pnpm build`                                    | Turbo build of all workspaces (not the native host or installer)                            |
| `pnpm check`                                    | `format:check`, `lint`, `typecheck` and `typecheck:root`                                    |
| `pnpm format` / `pnpm format:check`             | oxfmt, StyLua (`addon`, `tests`, `.busted`, `.luacheckrc`), Prettier                        |
| `pnpm lint`                                     | oxlint with `@cloudflare/oxlint-config` (rules still being adopted warn), then Luacheck     |
| `pnpm test`                                     | All Vitest suites and Busted specs                                                          |
| `pnpm test:core`                                | TypeScript suites except desktop UI and addon                                               |
| `pnpm test:integration`                         | `tests/` (`@wisp/tests`)                                                                    |
| `pnpm test:addon`                               | Busted specs in `addon/tests/`                                                              |
| `pnpm test:ui`                                  | Desktop React tests (CI runs `pnpm ui:build` first)                                         |
| `pnpm exec turbo run test --filter=@wisp/<pkg>` | One package; append `-- <file>` for one file                                                |
| `pnpm start`                                    | Run the Wisp server                                                                         |
| `pnpm --filter @wisp/agent eval`                | Agent evals against a real model (sign in once with `apps/server/src/evals/eval-bridge.ts`) |
| `pnpm ui:dev` / `pnpm desktop:dev`              | Vite only / staged native Tauri app                                                         |
| `pnpm web:dev`                                  | Next.js website on 127.0.0.1:3000                                                           |
| `pnpm data:generate`                            | Regenerate game data from the pinned Forever build ([docs/game-data.md](docs/game-data.md)) |
| `pnpm data:check`                               | Say whether a newer Forever build is out than the pinned one                                |

Native Rust checks run in CI with `cargo fmt --check` and `cargo test` against
`apps/desktop/src-tauri/Cargo.toml`. `apps/server/tests/simulation.test.ts` needs
the simulator binary (`scripts/build-simulator.ps1`); Linux CI excludes it.

### Lua toolchain

Busted 2.3.0 and Luacheck 1.2.0 need Lua 5.1 (or LuaJIT) with LuaRocks:
`luarocks --lua-version=5.1 install busted 2.3.0-1` (same for `luacheck 1.2.0-1`).
`.busted` rejects other Lua versions. StyLua comes from the root devDependencies.

On Windows, LuaRocks puts `busted`/`luacheck` in `%APPDATA%\luarocks\bin`, which is
not on `PATH` by default. In PowerShell, add it before running addon checks:
`$env:Path += ";$env:APPDATA\luarocks\bin"`.

## Where tests live

- `apps/<app>/tests/`, `packages/<pkg>/tests/`: unit tests per package, each with
  its own `vitest.config.ts`; desktop UI tests sit next to components in `apps/desktop/src/`.
- `tests/`: only tests that span packages (they import two or more workspaces,
  run the packaged engine, or check repository-wide rules and config). A test that exercises a single package belongs in that
  package's `tests/`.
- `tests/addon/`: Lua↔TypeScript transport tests (Vitest + Fengari) that run the
  addon's Lua against `@wisp/protocol` and the bridge.
- `addon/tests/*_spec.lua`: Busted addon specs with WoW stubs and fixtures.
- `scripts/tests/`: release and build-script tests.

## Current priority: an Effect-native codebase

The TypeScript workspaces are moving to idiomatic Effect; the
[Effect migration plan](docs/effect-migration.md) has the rules, the phases and
what stays as it is. Every side effect, dependency, failure, resource and piece
of background work goes through Effect, and data is modeled with `Schema`. Pure
logic stays plain TypeScript, called from Effect code. Keep cleanup separate
from behavior changes so reviewers can verify each on its own.

When working with Effect, load the [Effect skill](.agents/skills/effect-ts/SKILL.md)
for local examples and verification guidance, and the matching reference of the
[Effect contributor skill](.agents/skills/effect/SKILL.md). Before writing any
Effect code, first read `node_modules/effect/AGENTS.md` **completely**, and
follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

The root `package.json` declares `effect` so that `node_modules/effect` exists
despite `hoist: false`; keep it on the same version as the workspaces.

### Effect rules

- **Replace, don't wrap.** A migrated module has no `async`, `new Promise`,
  `try`/`catch`, thrown expected failures or `Effect.run*` inside it.
  `Effect.tryPromise` belongs only in adapters around third-party Promise APIs
  and maps the failure to a `Schema.TaggedError`. Don't use `Effect.promise` for
  work that can fail: a rejection becomes a defect.
- **Run Effects only at the edges.** Internal operations return Effects that
  callers compose with `yield*`. Run them at the process entry point or where a
  library expects a `Promise`, such as an SDK callback, and capture the caller's
  Effect context when that callback runs later.
- **Services by default.** Anything with dependencies, state or a lifecycle is
  a `Context.Service` with a layer and `Effect.fn('Service.operation')`
  methods. Don't pass bags of callbacks (`changed`, `saveChats`) between
  modules: shared state lives in a service backed by `SubscriptionRef`, and
  whatever reacts to it subscribes to its changes.
- **Leaves before the root.** Migrate adapters and domain services before
  `apps/server/src/runtime.ts`. Until then the root declares migrated services
  in its requirements and `main.ts` provides them; no `Layer.build` with
  `Context.get` inside the root.
- **Keep layers closed.** Consumers depend on the domain service, not on the
  infrastructure under it such as `SqlDatabase`. Don't `Layer.provideMerge` it
  out to them, and don't use `Layer.mergeAll` or `provideMerge` just to make
  types check.
- **Give each resource one owner.** For a keyed connection cache, the manager
  decides when to reuse, replace, or invalidate an entry; the connection owns
  the handshake, timeout, and cleanup. Register cleanup before starting work
  that can fail, share a single in-flight open per key, and tie that work to a
  scope. Closing must cancel an in-flight open and wait for cleanup. Keep slow
  I/O outside the cache lock, and only evict the entry that actually closed.
- **Keep adapters thin.** Separate transport and session handling from domain
  operations. The agent owns MCP connections and tool execution; the host
  provides settings storage, access to the vault, and the current turn's
  policy. Keep upstream tool schemas intact except for arguments fixed by Wisp.
- **Test through Effect.** Use `@effect/vitest` (`it.effect`, `layer(...)`),
  test layers instead of objects cast with `as unknown as`, and `TestClock`
  instead of real sleeps or fake timers.

### Effect service layers

Prefer exporting a service's layer separately from its `Context.Service` tag.
Keep both in the same module when that makes them easy to find. At the runtime
composition point, use a module namespace import so the implementation reads
clearly, for example `Capabilities.layerFromFile(...)`. Consumers can use
`Capabilities.Service` from the same module.

## Conventions observed in the code

- **Server layout:** `apps/server/src/` is moving to the
  [target structure](docs/effect-migration.md#target-structure): one folder per
  domain (`game/`, `chat/`, `turns/`, `routines/`, …) that owns its services,
  repository, schemas and API handlers; `platform/` for configuration, logging,
  the HTTP client, JSON files and the vault; `http/` for the servers; and only
  `main.ts` and the layer graph at the root. A domain's `index.ts` is its public
  surface: other domains import it as `#<domain>` and platform modules as
  `#platform/<name>` (the `imports` field of `apps/server/package.json`), never
  another domain's files. Inside a domain, files are named by role (`repo.ts`,
  `api.ts`, `scheduler.ts`) without repeating the domain. Put new and migrated
  modules in their target folder, never at the root. Each domain keeps its own
  table access; the schema and connection live in `@wisp/db`. Moving a file keeps
  its package export name; when a change replaces a module's API, rename or
  remove the export and update every consumer in the same PR. All consumers live
  in this repository, so don't add compatibility aliases.
- **Shared schemas:** shapes are zod schemas owned by the workspace that defines
  the contract. The desktop–bridge contract is in `packages/protocol/src/`
  (`@wisp/protocol/providers`); what the agent asks of its host, such as tool
  inputs, game inspections and presentation, is in `apps/agent/src/contract/`
  (`@wisp/agent/contract/game-inspection`), which the bridge implements; the
  addon's packets, mailbox frames and downlink are in `packages/wow-bridge/src/`.
  Change a shape where it lives rather than redefining it in another app.
- **Package boundaries:** `tests/package-boundaries.test.ts` requires every
  workspace to declare each package it imports in its own `package.json`
  (nothing is hoisted). Unit tests import their package's source; integration
  tests use package exports.
- **Logging:** use `Effect.log*` with `Effect.annotateLogs` for structured fields,
  including a dotted `event` key. The bridge and agent share the JSON logging
  layer in `apps/server/src/logger.ts`; capture an Effect runner where Node
  callbacks are created and use `Effect.log*` directly inside Effect operations.
- **Errors:** convert unknown errors with `errorMessage` from
  `apps/server/src/errors.ts`, which sanitizes via `safeErrorMessage`.
- **Addon Lua:** follow [docs/lua-guidelines.md](docs/lua-guidelines.md) and
  [addon/AGENTS.md](addon/AGENTS.md).
- **Commits:** history uses Conventional Commits with scopes, e.g.
  `feat(addon): …`, `fix(bridge): …`, `docs(release): …`, `chore: …`.
  Do not add `Co-Authored-By` trailers or other agent attribution (Claude,
  Codex, etc.) to commit messages; this overrides any tool default.
- **Feature flags:** unfinished work that should stay out of Stable goes behind
  a flag in `packages/protocol/src/features.ts`; see
  [docs/feature-flags.md](docs/feature-flags.md). Remove the flag when it ships.
- **Release notes:** a PR with a player-facing change adds one note with
  `pnpm changie new --kind <New|Improved|Fixed> --body "…"` (a fragment in
  `releases/unreleased/`); never edit `releases/<version>.md` for unreleased work.
  See [releases/README.md](releases/README.md) for style and the release process.

## Contributor skills and PRs

For every task that reads, writes, or reviews `.ts` or `.tsx` files, read and
apply both [Type System Discipline](.agents/skills/principle-type-system-discipline/SKILL.md)
and [TypeScript Best Practices](.agents/skills/typescript-best-practices/SKILL.md),
in that order, before working on the TypeScript. If the harness does not
auto-load these skills, read their linked files directly.

Project skills live in `.agents/skills/`; [its README](.agents/skills/README.md)
says which skill fits which area (Base UI, React Router, Testing Library, Tauri
events, Vite, Vitest, Zustand, React/Next.js). When creating or updating a pull
request, follow [visual-pr](.agents/skills/visual-pr/SKILL.md) for the description.
