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
| `Shared/`                       | Pure cross-subsystem number validation and UTF-8 byte truncation   |
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

`Shared/Numbers.lua` owns finite-number and non-negative-integer checks. Consumers
keep their own range constraints, including the transport's JSON-safe integer
limit. `Shared/Text.lua` truncates strings by bytes without splitting UTF-8
characters and reports truncation; it does not validate UTF-8. These modules load
immediately after `Namespace.lua`. UI text caching belongs to `UI/Widgets.lua`;
RichUI and Inline reuse `ns.UI.Widgets.SetText`.

`UI/Window.lua` composes the main chat window and owns its position, minimize/resize
behavior and refresh entry point. Its components keep widget and cache state local:

| Module                      | Responsibility                                                     |
| --------------------------- | ------------------------------------------------------------------ |
| `UI/Sidebar.lua`            | Chat/routine navigation, ordering, row reuse and deletion dialog   |
| `UI/Transcript.lua`         | Message rows, per-chat scroll position and new-message navigation  |
| `UI/Composer.lua`           | Multiline input, cursor scrolling, send/stop and responsive layout |
| `UI/RecentErrors.lua`       | Local notice selection and a separate memory-only review editor    |
| `UI/Activity.lua`           | Empty/loading states, progress row and header activity indicators  |
| `UI/ConversationStatus.lua` | Conversation title, connection state and context usage             |
| `UI/SettingsPanel.lua`      | Addon preferences and WoW chat-channel settings                    |

The composer reports its bottom inset to the transcript through a callback wired
by the window. `UI/ModelControls.lua` owns model/effort controls without changing
composer or transcript geometry. Activity ticks update indicators without
rerendering messages. The manifest loads these components before the window;
the offline UI fixtures follow the same dependency order.

The header's **Notices** button opens a separate, screen-clamped 420×310 review
window without shrinking the minimum chat viewport. Capture is off after every
reload, logout or character change. `Character/RecentErrors.lua` owns the local
opt-in `UI_ERROR_MESSAGE` subscription, 30-record / rolling-120-second buffer and
secret checks before reading either event field. Equal complete type/text may
coalesce; counts describe deliveries, not attempts. Text is UTF-8-boundary clipped
to 512 bytes; clipped prefixes are never coalesced. Coverage reports omitted
secret/malformed deliveries, clipping, expiry and eviction. There is no blacklist
or `GetGameMessageInfo` enrichment, nor a claim that an event was displayed.

Scroll the list, select a notice and choose **Explain → edit unsent question**.
The separate editor never enters the ordinary composer or SavedVariables-backed
drafts. Enter edits; only **Send to Wisp** submits. Disable, expiry, selection loss,
conversation change and closing discard unsent review text. Ordinary drafts keep
their existing persistence. Capture/browse/edit do not call transport, models,
diagnostics or gameplay actions. Explicit Send and requested tool reads use normal
conversation persistence/model access; submitted chat is not disk-free.
`tests/addon/recent-errors.test.ts` exercises production modules with Fengari and
source-derived synthetic event tuples, not an observed native payload. Physical
Forever readability, rendering, focus and cost remain native acceptance gates.

`Integrations/Integrations.lua` owns provider metadata, readiness aggregation and
protected inspection dispatch. Each provider owns its readiness checks and reads
in one file: `Questie.lua` (quests, chains and NPC/object locations),
`Syndicator.lua` (cached inventory) and `Auctionator.lua` (cached prices).
The manifest loads the coordinator before providers; callers keep using the
`ns.Integrations` API. Provider tests live in their corresponding specs, with
aggregation and dispatch covered by `integrations_spec.lua`.
