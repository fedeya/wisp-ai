# Lua guidelines

[Development](development.md) · [Addon modules](../addon/README.md) · [Transport](transport.md) · [Markdown contract](markdown.md)

These are Wisp's conventions for `addon/WispAI`. Keep the addon idiomatic for
WoW, with explicit subsystem APIs and small local implementations.

## Runtime and loading

Production code targets Lua 5.1 and the supported WoW client APIs. Do not use
newer Lua syntax or assume a desktop standard library, filesystem, package
manager, or Neovim-style module loader inside the game.

WoW loads `WispAI.toc` in order and passes the addon name and a private table:

```lua
local _, ns = ...

local function normalizeText(value)
    return tostring(value or ""):match("^%s*(.-)%s*$")
end

function ns.Chat.Submit()
    local text = normalizeText(ns.draft:GetText())
    -- Validate and submit the conversation's input.
end
```

Use `local addonName, ns = ...` when the name is needed. `Namespace.lua` creates
subsystem tables before their implementation files. Add or move a source in the
`.toc` after its dependencies; keep declarations safe to load before login.
Saved variables initialize on `ADDON_LOADED`; game UI initialization belongs to
the login lifecycle.

## Ownership and APIs

- Give each behavior one owner: conversation commands in `Chat/`, reads in
  `Character/`, mutations in `Actions/`, transport in `Transport/`, and widget
  presentation in `UI/`. The [module map](../addon/README.md) covers the other areas.
- Keep helpers and owned widget/cache state local. Export only what another
  module needs. Cross-subsystem calls use `ns.Chat.Submit`, `ns.Transport.Send`,
  and similarly explicit APIs; avoid flat root functions or compatibility aliases.
- `Core.lua` owns lifecycle and shared session state, including `ns.db`,
  `ns.chats`, `ns.active` and connection/revision state. Prefer an explicit module
  dependency over adding more shared fields. Do not duplicate ownership.
- Use plain function tables for modules. Use a metatable or instance only when
  independent mutable state calls for one; follow the existing module pattern.
- Keep `ns` private. `WispAI.ActivateInline` is the public binding entry point and
  `WispAI_Receive` receives bridge payloads. Saved variables, slash commands and
  binding labels are intentional WoW registrations, not a general export surface.

## Names and formatting

| Element                           | Convention       | Example                                     |
| --------------------------------- | ---------------- | ------------------------------------------- |
| Source files and subsystem tables | PascalCase       | `Chat/State.lua`, `ns.Character`            |
| Exported functions                | PascalCase       | `ns.Character.Capture`, `ns.Markdown.Parse` |
| Local helpers and state fields    | lowerCamelCase   | `normalizeText`, `lastActivityAt`           |
| Constants                         | UPPER_SNAKE_CASE | `MAX_PENDING`, `FRAME_BUDGET`               |
| Unused positional values          | `_`              | `local name, _, quality = GetItemInfo(id)`  |
| Internal cross-file helpers       | Leading `_`      | `ns.Character._ReadWaypoint`                |

Keep wire payload keys, third-party APIs and imported catalog keys in their
external spelling. A protocol key such as `compare_items` is not a Wisp function
name. Private parser helpers also retain their internal conventions.

Use StyLua rather than hand-formatting around it: four spaces, an approximate
100-column width, preferred double quotes, and parentheses for calls. Do not
mix formatters or disable checks to preserve a personal layout.

For nontrivial public APIs, document input/output shapes and important invariants
beside the code; use LuaCATS annotations where they clarify the contract.
Annotations do not replace validation of incoming data.

## Host APIs, errors and actions

Check optional API/provider availability at the boundary and return a meaningful
unavailable/error result. Catch errors with `pcall` when a host or integration
failure is expected; do not hide programming errors behind success-shaped defaults.
Preserve the distinction between false, zero, empty data and unavailable data.

Keep character reads free of game mutations. Validate arguments and game state
before executing an action, preserve existing capability and combat/protected-API
checks, and expose only supported actions. Use public integration APIs without
modifying another addon's code or private data. Keep external text and wire data
out of dynamically compiled Lua.

## Work on the UI thread

Bound scans, queues, text sizes, nesting and retained history. Avoid repeated
collection, parsing and allocation inside `OnUpdate`; defer or budget expensive
work and stop timers/updates when idle. Reuse existing widgets and caches.

The Markdown parser owns syntax; renderers consume its tree. A resize, item-data
event or reference update invalidates presentation without reparsing unchanged
source. Keep canonical transport state separate from mutable UI state. See the
[Markdown contract](markdown.md) and [transport contract](transport.md) for limits
and invalidation rules.

## Checks and tests

Install the pinned Lua tools and keep their commands on `PATH`:

```sh
luarocks --lua-version=5.1 install luacheck 1.2.0-1
luarocks --lua-version=5.1 install busted 2.3.0-1
pnpm lint:addon
pnpm format:check
pnpm test:addon
```

StyLua owns formatting. Luacheck uses `.luacheckrc` for Lua 5.1 globals, unused
values, shadowing and other errors. `pnpm check` and CI include both tools.
Naming and module ownership are reviewed against this guide; there is no custom
naming linter or static type checker.

Exercise changed behavior with real addon modules and explicit WoW mocks. Use
`addon/tests/support.lua` to isolate scenario globals and initialize namespaces;
do not build a second implementation of the behavior in a fixture. The source
spec verifies manifest coverage, compilation and real load order.

Keep addon-only regressions in Busted. Cross-language framing and host/addon
interactions belong in `tests/addon/`; those offline fixtures may use Fengari's
newer syntax for native bit-operation mocks, while production remains Lua 5.1.
Use reproducible synthetic inputs and temporary files for regression checks.
Session-specific experiments and historical snapshots do not belong in the
maintained script or documentation surface. Offline mocks cannot establish
in-game appearance, native cost or measured end-to-end latency.
