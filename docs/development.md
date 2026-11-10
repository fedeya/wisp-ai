# Development

[Home](../README.md) · [Usage](usage.md) · [Integrations](reference.md)

## Prerequisites and checks

Use **Node 24.22.1+** and **pnpm 12.18.0**, pinned in [package.json](../package.json). From the repository root:

```sh
pnpm install --frozen-lockfile
luarocks --lua-version=5.1 install busted 2.3.0-1
pnpm build
pnpm check
pnpm test
```

`build` runs workspace builds through Turborepo, including the protocol, agent,
desktop frontend and website. It does not build the native host, simulator or
installer. `check` runs formatting, lint and type checks; `pnpm test` runs all
TypeScript tests with Vitest (apps, packages and integrations) and Lua specs with Busted. Simulator engine tests
require its binary—offline input tests alone do not validate the engine.

Turborepo resolves prerequisites from the declared workspace dependencies and
`turbo.json`. Builds and type checks depend on dependency builds (`^build`), so a
fresh checkout works without manually compiling protocol or agent first. Generated
`dist` and Next outputs are cached; tests, development servers, resource staging
and native packaging are not. Runtime tasks preserve their environment; cached
builds hash the declared build variables. GitHub Actions persists `.turbo` by OS.

The repository uses one pnpm lockfile. Root dependencies are shared development
tools. Core tests, addon tests and build scripts declare their own dependencies in
`tests`, `addon` and `scripts`. Optional native archive codecs from just-bash are
excluded explicitly, following Eve's own optional-engine setup; installs do not
need `--ignore-scripts`. The web deploy uses a filtered install and Turbo build;
`turbo prune @wisp/web` can export an isolated web workspace from the same lockfile.

### Pull request descriptions

Use the [visual-pr contributor skill](../.agents/skills/visual-pr/SKILL.md) when
creating or updating a pull request: explain why, highlight reviewer notes, show
the smallest useful structural outline, and collapse checks and limitations under
Verification. This is a contributor workflow; it does not register an in-game tool.
[OpenCode documents `.agents/skills` project discovery](https://opencode.ai/docs/skills/#discovery);
with other agents, read the skill and its linked references explicitly.

## Tests

Each app or package owns its unit tests and Vitest configuration. The root
`tests/` workspace contains cross-component integrations and repository-wide checks.

| Command                 | Scope                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| `pnpm test`             | All TypeScript tests and Busted Lua specs                                     |
| `pnpm test:core`        | All app/package TypeScript suites and root integrations, excluding desktop UI |
| `pnpm test:integration` | Cross-component tests in `tests/`, including Lua/TS transport                 |
| `pnpm test:addon`       | Busted Lua specs and WoW fixtures in `addon/tests/`                           |
| `pnpm test:ui`          | Svelte components in `apps/desktop/src/` (jsdom + Testing Library)            |
| `pnpm test:watch`       | Watch all projects; Lua source and fixture changes rerun addon tests          |

Use `pnpm test:addon`, `pnpm test:core`, `pnpm test:integration` or `pnpm test:ui`
for a suite. To test one component, run `pnpm exec turbo run test --filter=@wisp/bridge`
(or `@wisp/agent`, `@wisp/protocol`, `@wisp/releases`, `@wisp/scripts`, `@wisp/web`).
For a file, run `pnpm exec turbo run test --filter=@wisp/bridge -- apps/bridge/tests/routines.test.ts`.
`pnpm test:watch` watches the task graph and rebuilds dependencies before rerunning tests.
The root integration task includes addon Lua sources and transport fixtures as
inputs, so addon changes also rerun the cross-language transport tests.
Protocol schema assertions live in `packages/protocol/tests/`; the apps own their
behavior tests in `apps/<app>/tests/` (desktop UI tests remain in `src/`). Release
helpers own their tests in `packages/releases/tests/` and `scripts/tests/`.
Native Rust tests remain on Cargo;
see the CI workflow for their build prerequisites and command. Simulator and native-helper
tests keep their existing skips when the required binaries are absent.

### Lua addon tests

Install Lua 5.1 and LuaRocks using your platform's package manager, then install
[Busted](https://lunarmodules.github.io/busted/) with
`luarocks --lua-version=5.1 install busted 2.3.0-1`. Put that installation's
`lua` and `busted` commands on `PATH`. LuaRocks may require a C compiler and Lua
development headers to build dependencies. CI uses the standard
[Lua](https://github.com/leafo/gh-actions-lua) and
[LuaRocks](https://github.com/leafo/gh-actions-luarocks) actions on Ubuntu.

The addon specs run on Lua 5.1, matching WoW's language APIs; `.busted` rejects
other interpreter versions. This follows the offline test setup used by
[Questie](https://github.com/Questie/Questie/blob/master/.github/workflows/ci.yml)
and [BetterBags](https://github.com/Cidan/BetterBags/blob/main/.github/workflows/test.yml):
Busted installed through LuaRocks, real addon files and explicit WoW mocks.

Write addon-only cases in `addon/tests/*_spec.lua`, using Busted's `it`, assertions
and hooks. `support.lua` creates private WoW globals for each scenario and loads
the real addon files, including the UI dependency order. The existing WoW API
stubs remain fixtures; these specs run outside the game.

```sh
busted
busted addon/tests/settings_spec.lua
busted --filter "settings"
```

Run these commands from the repository root; `.busted` selects `addon/tests/`.
`pnpm test:addon` runs only `busted`; the binary emoji-atlas checks also run in Lua.
`pnpm test:watch` reruns the addon suite when addon files change. Direct Vitest runs
cover TypeScript suites. Tests exchanging frames between Lua and TypeScript live
in `tests/addon/` and still use Fengari.

Root integration tests also launch the real Eve agent against a local model fixture. This checks
agent compilation, dependency resolution, model middleware and streamed replies without
credentials or external inference. Runtime tests exercise startup, shutdown, persistence
and partial-startup cleanup in temporary data directories.

## Build and run on Windows

In addition to the workspace prerequisites, install Rust, Windows C++ build tools, Git, Go and protoc. Build the pinned simulator before starting the native app:

```powershell
powershell -File scripts/build-simulator.ps1
pnpm desktop:dev
```

The simulator script accepts `-GoPath` and `-ProtocPath`. `desktop:dev` stages production resources, including the verified simulator and bundled Node/npm, then starts Tauri. Continue with [addon setup and sign-in](../README.md#get-started-on-windows). `pnpm ui:dev` starts only Vite, without a native bridge.

To build an installer after the simulator is ready:

```sh
pnpm build:desktop
```

`pnpm package:windows` is an alias. Output in `dist/` includes the unsigned per-user installer, SHA-256 checksum and build metrics. Packaged resources include Node/npm, the bridge, agent, protocol, addon and simulator; updates preserve user data. See [packaging code](../scripts/build-desktop.ts), [staging](../scripts/stage-desktop.ts) and the [release workflow](../.github/workflows/release.yml) for resource verification and cache details. Tag builds create draft releases for review before publication.

Windows installers package the bridge, addon installation/migration commands,
Eve's production server and npm into `payload/wisp-engine.exe`. Dependencies are
read from its embedded virtual filesystem; the installer does not extract an
application `node_modules` tree. `payload/runtime/node.exe` remains bundled for
user-configured external MCP programs. Development staging keeps the source-based
layout and Eve development server.

`pnpm package:engine` builds just `dist/wisp-engine.exe` and runs the packaged
integration checks. Those tests relocate the executable to a temporary directory,
remove Node from the child process PATH, complete a streamed model turn and a
real tool call against local fixtures, restart Eve to verify session persistence,
and run a local npm executable offline. They reject loose dependency extraction.
The installer CI additionally checks the native host, installation, upgrades and
preservation of user data.

### Publishing app updates

Installed Windows x64 release builds check `https://github.com/fedeya/wisp-ai/releases/latest/download/latest.json` at startup and every six hours. **Settings > Check for updates** checks manually. Users review release notes and choose **Update and restart**; the app verifies the download before stopping the bridge, waits for active replies and installs through NSIS. Chats, credentials and settings remain in AppData. Development builds and other platforms do not install updates. Overview detects when the bundled addon differs from the installed copy; use **Install / update addon**, then `/reload` in WoW.

The updater public key is checked into `apps/desktop/src-tauri/tauri.conf.json`. Its private key is stored outside the repository at `%USERPROFILE%\.tauri\wisp-ai.key` on the machine where it was generated and in the repository's `TAURI_SIGNING_PRIVATE_KEY` Actions secret. Keep a secure backup: changing the public key breaks updates for existing installations. The generated key has no password; if using a password-protected replacement before the first public release, also configure `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

To prepare a stable release, write user-facing notes in `releases/next.md`, commit your work and run `pnpm release patch` (or `minor` / an explicit version) from clean `main`. release-it synchronizes all workspace, Tauri and Cargo versions and pushes the release commit/tag. Actions builds, signs and verifies the installer, then creates a **draft** with the shared notes and updater manifest. Review and publish it as latest. Every successful build from `main` also publishes a separate Nightly prerelease; users opt into that channel in App updates. Stable never receives nightly builds. See [the release guide](../releases/README.md) for notes, squash merges, channel switching and feeds. The repository and release assets must be public for distributed apps to download them.

Local `pnpm build:desktop` builds remain unsigned unless `TAURI_SIGNING_PRIVATE_KEY` is set to the private key path or contents. Signed builds additionally emit `.sig` and `latest.json`. These updater signatures are independent of Windows Authenticode signing; they do not remove SmartScreen prompts.

## Bridge and addon work

After configuring the native app and signing in, you can run the bridge separately:

```powershell
pnpm install-addon "E:\Blizzard\World of Warcraft\_forever_"
pnpm start
```

Replace the example with the folder containing `Wow.exe`. Installation updates `config.local.json`; fully restart WoW on first install. `start` builds the protocol and launches the bridge, but provides no sign-in UI. It needs Wisp authorization, a configured data root and the native credential helper: set `WISP_DESKTOP_EXE` or use the release executable under `apps/desktop/src-tauri/target/release/`. Stop the desktop bridge first to avoid port/data conflicts. See [data-root configuration](usage.md#local-data-and-deletion).

## Source map

| Area                          | Entry points                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Desktop UI and native host    | [Svelte](../apps/desktop/src), [Tauri, vault and installer](../apps/desktop/src-tauri)         |
| Bridge and agent process      | [main.ts](../apps/bridge/src/main.ts), [agent-process.ts](../apps/bridge/src/agent-process.ts) |
| Agent tools and behavior      | [definitions](../apps/agent/agent), [instructions](../apps/agent/agent/instructions.md)        |
| Shared contracts              | [protocol](../packages/protocol/src)                                                           |
| Game UI, readings and actions | [addon](../addon/WispAI)                                                                       |

The bridge owns accounts, persistence and tool execution. Eve runs on loopback **43186**; the separate RPC/model endpoint on **43187** uses an ephemeral agent token. Credential and data boundaries are documented under [privacy](usage.md#what-leaves-your-computer).

Game transport uses Wisp v2 checked frames in addon enable states in both directions.
Compressed snapshots and patches continue through the reusable lane after the
optional load-on-demand bulk bank is exhausted. The unversioned transport and its
decoder are removed; unsupported game APIs fail clearly rather than selecting
another wire format. See [transport v2](transport-v2.md) and its
[measured comparison](transport-optimization.md), plus [transport.ts](../apps/bridge/src/transport.ts)
and the protocol source for the wire contract.

Interactive packets take priority over unsent background traffic; in-flight frames
are never interleaved. Polls coalesce, and acknowledged retries are removed. The
Sending indicator follows the message's transport acknowledgement while keeping
optimistic history until an authoritative snapshot arrives. Recent user actions
temporarily poll more frequently; idle clients still consume no helper channels.
Interactive acknowledgement reads start only after the message's final frame,
using a short 250 ms polling window. Receipt requests an immediate snapshot publish
instead of waiting for the normal 400 ms UI batch. Character identity travels by
acknowledged revision; changed integration reports still accompany a message, and
heartbeats keep availability fresh. Delivery metrics report compressed bytes,
frame/retry counts, queue time, transmission time and acknowledgement wait.

Manual turns revalidate a bounded quest summary locally. Quest-log events warm a
session/character-scoped bridge cache, and acknowledged, unchanged summaries travel
as revision references. Missing revisions fall back to normal game reads. The
quest data stays out of `game_context`. When requested, `wow__query_character`
serves quests from a private turn-verified reading without a game round trip; mixed
requests fetch only other sections live. Missing/partial readings or `refresh=true`
fall back to the addon. Automatic conversation titles
are assigned from the first message before model preparation, without waiting for a response.
Optional large tool schemas and their instruction modules load through
`wisp__load_tools`, or after related read tools, without changing capability flags.
Compaction keeps the full instruction set. Bridge logs record `Message delivery`
and `Turn timing` entries for receipt, admission and first visible text latency.

Interactive packets take priority over unsent background traffic; in-flight frames
are never interleaved. Polls coalesce, and acknowledged retries are removed. The
Sending indicator follows the message's transport acknowledgement while keeping
optimistic history until an authoritative snapshot arrives. Recent user actions
temporarily poll more frequently; idle clients still consume no helper channels.
Interactive acknowledgement reads start only after the message's final frame,
using a short 250 ms polling window. Receipt requests an immediate snapshot publish
instead of waiting for the normal 400 ms UI batch. Character identity travels by
acknowledged revision; changed integration reports still accompany a message, and
heartbeats keep availability fresh. Delivery metrics report compressed bytes,
frame/retry counts, queue time, transmission time and acknowledgement wait.

Manual turns revalidate a bounded quest summary locally. Quest-log events warm a
session/character-scoped bridge cache, and acknowledged, unchanged summaries travel
as revision references. Missing revisions fall back to normal game reads. The
quest data stays out of `game_context`. When requested, `wow__query_character`
serves quests from a private turn-verified reading without a game round trip; mixed
requests fetch only other sections live. Missing/partial readings or `refresh=true`
fall back to the addon. Automatic conversation titles
are assigned from the first message before model preparation, without waiting for a response.
Optional large tool schemas and their instruction modules load through
`wisp__load_tools`, or after related read tools, without changing capability flags.
Compaction keeps the full instruction set. Bridge logs record `Message delivery`
and `Turn timing` entries for receipt, admission and first visible text latency.

### Runtime boundaries

The bridge entrypoint only starts the runtime and handles process signals.
`runtime.ts` composes services; `packet-receiver.ts` owns game-session coordination,
`turn-runner.ts` executes agent turns, `game-requests.ts` scopes pending game reads,
and the agent and desktop handlers expose their respective HTTP contracts.
Dependencies and ports can be supplied to `startBridge` for isolated integration tests.

- Shared Zod schemas define requests, responses and persisted conversation data.
  Validate external data before using it; derive TypeScript types from schemas.
- A failed load preserves the source file and prevents conversation saves. JSON
  writes use temporary files and atomic replacement. Conversation persistence is
  independent of game snapshots and batches streaming changes with a bounded delay.
- Reloading or changing characters interrupts obsolete turns and rejects pending
  reads. Every request belongs to both a transport session and a conversation.
  Runtime resources unwind on shutdown and failed startup.

Desktop screens live under `apps/desktop/src/pages`; their shared session controller
uses Svelte runes in `desktop-controller.svelte.ts`. Addon widgets, message formatting,
message rows and model controls are separate Lua modules loaded before `UI.lua`.
Agent dependencies link to canonical package paths so isolated pnpm installs remain
resolvable after moving the engine. The bundled just-bash workspace is configured
explicitly with runtime package installation disabled.

## Formatting, CI and diagnostics

Release builds depend on the reusable CI workflow, so formatting, lint, types, all
Vitest projects and native tests must pass before packaging and signing.

`pnpm format:check` checks Oxfmt, StyLua and Svelte/CSS/HTML Prettier output; `pnpm format` writes across the workspace. For Rust, use `cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`. The [CI workflow](../.github/workflows/check.yml) contains native test prerequisites and tests the exact installer artifact after successful release builds; packaging alone is not the full check suite.

[smoke-agent.mjs](../scripts/smoke-agent.mjs) is an **opt-in live diagnostic**, not an offline test: it uses the signed-in subscription and external services, consumes usage, and may put private data in reports outside the repository. It requires Windows configuration and native credentials. Its isolated sessions block game writes but do not validate browser consent; snapshot replay does not replace fresh readings in normal use. Consult the script before running it.

## Adding integrations

To add an integration, declare its capabilities in `packages/protocol/src/capabilities.ts`,
implement its adapter and readiness checks, register live detection in
`addon/WispAI/Integrations.lua` / `apps/bridge/src/integration-state.ts`, and test
missing/incompatible providers and disabled-tool admission. Integrations supply
tools; reply panels and automatic suggestions remain separate features.
