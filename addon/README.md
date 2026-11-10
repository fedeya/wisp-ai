# Lua addon

[Lua guidelines](../docs/lua-guidelines.md) · [Transport](../docs/transport.md)

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

See [the Lua guidelines](../docs/lua-guidelines.md) for naming, API boundaries,
formatting, validation, performance practices and the required local checks.
