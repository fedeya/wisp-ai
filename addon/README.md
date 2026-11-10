# Lua addon

WoW loads the files listed in `WispAI/WispAI.toc`, in order. It passes the addon
name and one private namespace to each file; there is no Neovim-style `require`
loader in this addon.

```lua
local _, ns = ...

function ns.Chat.Submit()
    -- Chat behavior belongs to this subsystem.
end
```

`Namespace.lua` creates subsystem tables. `Core.lua` owns lifecycle, saved-variable
initialization and shared session state (`ns.db`, `ns.chats`, `ns.active`, transport
revision and connection state). Cross-subsystem calls use an explicit module API.
Helpers and widget state stay local to their owning file.

| Directory                       | Responsibility                                                     |
| ------------------------------- | ------------------------------------------------------------------ |
| `Chat/`                         | Conversation commands and incoming snapshot reconciliation         |
| `Transport/`                    | Wire frames, retries, downlink state and timing                    |
| `Character/`                    | Live collectors, inspections and the training catalog              |
| `Actions/`                      | Validated game mutations, including waypoints and macros           |
| `Integrations/`                 | Optional addon readiness and public API adapters                   |
| `ChatHistory/`                  | Selected WoW chat channels and the bounded message history         |
| `Settings/`                     | Reading and updating game or registered addon settings             |
| `UI/`                           | Window, widgets, rows, model controls, memory and capability views |
| `Inline/`, `Panels/`, `Advice/` | Inline questions, saved panels and suggestions                     |
| `Markdown/`                     | Syntax, parsing, bounded caching and shared text presentation      |

## Conventions and enforcement

- Lua source files and subsystem tables use PascalCase: `Chat/State.lua`, `ns.Chat`.
- Public functions use PascalCase: `ns.Character.Capture`, `ns.Markdown.Parse`.
- Local helper functions use lowerCamelCase. State fields use lowerCamelCase;
  constants use UPPER_SNAKE_CASE. A leading `_` marks internal module helpers.
- Wire payload keys, third-party APIs and imported catalog keys retain their
  external spelling. They are data contracts, not Wisp function names.
- Receive the namespace as `local _, ns = ...` (or `local addonName, ns = ...`
  when the name is needed). Publish functions on a subsystem, not the root table.
- Keep the namespace private. The global `WispAI` exposes only `ActivateInline`
  for bindings; `WispAI_Receive` is the bridge entry point. Saved variables and
  WoW's slash/binding registrations are the other intentional globals.
- Add or move a Lua file in the `.toc` after its dependencies. Tests check that
  every source appears exactly once and load the real manifest in its actual order.

Install [Luacheck](https://github.com/lunarmodules/luacheck) and Busted for Lua 5.1:

```sh
luarocks --lua-version=5.1 install luacheck 1.2.0-1
luarocks --lua-version=5.1 install busted 2.3.0-1
pnpm lint:addon
pnpm format:check
pnpm test:addon
```

StyLua owns indentation, quotes, parentheses and wrapping. Luacheck uses
`.luacheckrc` to catch undefined globals, unused values, shadowing and other Lua
errors against the explicitly listed WoW APIs. The AST checks in
`scripts/conventions.mjs` enforce Lua 5.1 syntax, filenames, the `ns` convention,
subsystem function placement, public function names and local helper names.
They intentionally exclude private helpers and external data keys from public
function naming rules. `pnpm lint` and `pnpm check` include the addon checks; CI
rejects violations.
