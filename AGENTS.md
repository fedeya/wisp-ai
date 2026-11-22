# Wisp AI — agent guide

Wisp is an AI assistant for World of Warcraft: Forever: a Lua addon talks to a
local Node bridge, which runs an agent runtime and is shipped inside a Tauri
desktop app for Windows. It is a pnpm + Turborepo monorepo (one lockfile,
`hoist: false`). Human-facing setup lives in [docs/development.md](docs/development.md).

Nested guides apply on top of this file: [addon/AGENTS.md](addon/AGENTS.md) and
[apps/web/AGENTS.md](apps/web/AGENTS.md).

## Workspaces

| Path                 | Package           | What it is                                                                                        |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `apps/bridge`        | `@wisp/bridge`    | Local Node host: addon transport, chat sessions, SQLite (Drizzle) storage, MCP, routines, logging |
| `apps/agent`         | `@wisp/agent`     | Eve agent runtime: model connections, tools, skills and instructions in `agent/`                  |
| `apps/desktop`       | `@wisp/desktop`   | Tauri desktop app: React + Vite frontend in `src/`, Rust host in `src-tauri/`                     |
| `apps/web`           | `@wisp/web`       | Next.js website (setup guide, changelog from GitHub Releases)                                     |
| `packages/protocol`  | `@wisp/protocol`  | Shared zod schemas and types for the wire protocol, desktop, settings and addon helpers           |
| `packages/releases`  | `@wisp/releases`  | Release channel/version helpers shared by desktop, web, scripts                                   |
| `packages/game-data` | `@wisp/game-data` | Generates game data files (e.g. `addon/WispAI/Data/`) from Forever’s game tables on wago.tools    |
| `addon/WispAI`       | `@wisp/addon`     | The WoW addon (Lua 5.1); sources must be listed in `WispAI.toc`                                   |
| `simulator/`         | —                 | Checked-in metadata and license for the pinned WoWSims simulator (not a workspace)                |
| `scripts/`           | `@wisp/scripts`   | Build, staging, packaging and release scripts (`.ts` run directly with `node`, some `.ps1`)       |
| `tests/`             | `@wisp/tests`     | Cross-component integration tests and repository-wide checks                                      |

## Commands

Run from the repository root. Toolchain: Node 24.22.1+ and pnpm 12.18.0
(`mise install` uses [mise.toml](mise.toml), which also pins Rust, Go, protoc and PowerShell 7).

| Command                                         | Does                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                | Install workspace dependencies                                                              |
| `pnpm build`                                    | Turbo build of all workspaces (not the native host or installer)                            |
| `pnpm check`                                    | `format:check`, `lint`, `typecheck` and `typecheck:root`                                    |
| `pnpm format` / `pnpm format:check`             | oxfmt, StyLua (`addon`, `tests`, `.busted`, `.luacheckrc`), Prettier                        |
| `pnpm lint`                                     | oxlint `--deny-warnings`, then `pnpm lint:addon` (Luacheck)                                 |
| `pnpm test`                                     | All Vitest suites and Busted specs                                                          |
| `pnpm test:core`                                | TypeScript suites except desktop UI and addon                                               |
| `pnpm test:integration`                         | `tests/` (`@wisp/tests`)                                                                    |
| `pnpm test:addon`                               | Busted specs in `addon/tests/`                                                              |
| `pnpm test:ui`                                  | Desktop React tests (CI runs `pnpm ui:build` first)                                         |
| `pnpm exec turbo run test --filter=@wisp/<pkg>` | One package; append `-- <file>` for one file                                                |
| `pnpm start`                                    | Run the bridge                                                                              |
| `pnpm agent`                                    | Agent dev server (`eve dev`)                                                                |
| `pnpm ui:dev` / `pnpm desktop:dev`              | Vite only / staged native Tauri app                                                         |
| `pnpm web:dev`                                  | Next.js website on 127.0.0.1:3000                                                           |
| `pnpm data:generate`                            | Regenerate game data from the pinned Forever build ([docs/game-data.md](docs/game-data.md)) |
| `pnpm data:check`                               | Say whether a newer Forever build is out than the pinned one                                |

Native Rust checks run in CI with `cargo fmt --check` and `cargo test` against
`apps/desktop/src-tauri/Cargo.toml`. `apps/bridge/tests/simulation.test.ts` needs
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
  run the packaged engine, or check repository-wide rules and config such as
  release-it). A test that exercises a single package belongs in that
  package's `tests/`.
- `tests/addon/`: Lua↔TypeScript transport tests (Vitest + Fengari) that run the
  addon's Lua against `@wisp/protocol` and the bridge.
- `addon/tests/*_spec.lua`: Busted addon specs with WoW stubs and fixtures.
- `scripts/tests/`: release and build-script tests.

## Conventions observed in the code

- **Bridge layout:** `apps/bridge/src` groups modules by domain: `addon/`
  (transport, snapshots, panels), `agent/` (Eve process, agent server, turns),
  `auth/`, `chat/`, `reply/`, `models/`, `integrations/` (search, MCP,
  simulation, TheWoWDB), `desktop/`, `routines/`, `db/` and `migrations/`.
  Composition and process-wide helpers (`runtime.ts`, `main.ts`, `errors.ts`,
  `logger.ts`, `app-paths.ts`) stay at the root. Package export names do not
  follow file moves.
- **Shared schemas:** wire, desktop and settings shapes are zod schemas in
  `packages/protocol/src/`, imported via subpaths like `@wisp/protocol/model-errors`.
  Add or change a shape there rather than redefining it in an app.
- **Package boundaries:** `tests/package-boundaries.test.ts` requires every
  workspace to declare each package it imports in its own `package.json`
  (nothing is hoisted). Unit tests import their package's source; integration
  tests use package exports.
- **Logging:** the bridge logs with pino (`apps/bridge/src/logger.ts`) using
  structured objects with a dotted `event` key, e.g.
  `{ event: 'bridge.startup_failed', error: errorMessage(error) }`.
- **Errors:** convert unknown errors with `errorMessage` from
  `apps/bridge/src/errors.ts`, which sanitizes via `safeErrorMessage`.
- **Addon Lua:** follow [docs/lua-guidelines.md](docs/lua-guidelines.md) and
  [addon/AGENTS.md](addon/AGENTS.md).
- **Commits:** history uses Conventional Commits with scopes, e.g.
  `feat(addon): …`, `fix(bridge): …`, `docs(release): …`, `chore: …`.
  Do not add `Co-Authored-By` trailers or other agent attribution (Claude,
  Codex, etc.) to commit messages; this overrides any tool default.
- **Release notes:** user-facing notes for the next stable release go in
  `releases/next.md`; see [releases/README.md](releases/README.md) for format
  and process.

## Contributor skills and PRs

Project skills live in `.agents/skills/`; [its README](.agents/skills/README.md)
says which skill fits which area (Base UI, React Router, Testing Library, Tauri
events, Vite, Vitest, Zustand, React/Next.js). When creating or updating a pull
request, follow [visual-pr](.agents/skills/visual-pr/SKILL.md) for the description.
