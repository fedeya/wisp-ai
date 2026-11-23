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

`Locale.lua` loads right after `Namespace.lua`, followed by one file per locale in
`Locales/`: every WoW client language (`enUS`, `deDE`, `esES`, `esMX`, `frFR`,
`itIT`, `koKR`, `ptBR`, `ruRU`, `zhCN`, `zhTW`). UI code reads strings through `ns.L` with
identifier keys grouped by area (`sidebar.newChat`, `routines.newButton`). `enUS` has
every key and is the fallback for a missing translation; a missing key shows the key
itself. The Language setting (`ns.db.language`) picks a locale or follows the game
(`auto`); a change asks to reload the UI. Only addon chrome goes through `ns.L`:
model output, user text and game names stay as they are. Lookups are live, so tables
built at load time hold keys, not text. Strings with several values use `{name}`
placeholders filled by `ns.LocaleText(key, values)`, so a translation can reorder
them. To add a locale, add a file under `Locales/`,
list it in the manifest, `ns.LOCALE_CHOICES` and the test helper's `LOCALES`, and
add its `language.*` name to `enUS`.

Fonts follow the UI language, not only the client's: `ns.UI.BuildUI` calls
`ns.UI.Widgets.ApplyFonts(ns.ActiveLocale())`. Inter covers Latin and Cyrillic;
for Korean or Chinese on a client in another language, text uses the game font
that has the script (`Fonts\2002.TTF`, `Fonts\ARKai_T.ttf`, `Fonts\bLEI00D.ttf`),
and the language list draws each name with a font that covers it. A Korean or
Chinese client keeps the game font for every language, since player and zone
names come in its script.

| Directory                       | Responsibility                                                     |
| ------------------------------- | ------------------------------------------------------------------ |
| `Shared/`                       | Pure cross-subsystem number validation and UTF-8 byte truncation   |
| `Chat/`                         | Conversation commands and incoming snapshot reconciliation         |
| `Transport/`                    | Wire frames, retries, downlink state and timing                    |
| `Character/`                    | Live collectors, inspections and the training catalog              |
| `Actions/`                      | Validated game mutations, including waypoints and macros           |
| `Integrations/`                 | Optional addon readiness and public API adapters                   |
| `ChatHistory/`                  | Selected WoW chat channels and the bounded message history         |
| `Combat/`                       | Death recaps and fight summaries from the game's recap and meter   |
| `Settings/`                     | Reading and updating game or registered addon settings             |
| `UI/`                           | Window, widgets, rows, model controls, memory and capability views |
| `Inline/`, `Panels/`, `Advice/` | Inline questions, saved panels and suggestions                     |
| `Moments/`                      | One-click questions offered at key moments (death, auction, …)     |
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

| Module                      | Responsibility                                                    |
| --------------------------- | ----------------------------------------------------------------- |
| `UI/Widgets.lua`            | Palette, fonts, borders, buttons, toggles, rows and hover washes  |
| `UI/Sidebar.lua`            | Chat/routine navigation, ordering, row reuse and deletion dialog  |
| `UI/Transcript.lua`         | Message rows, per-chat scroll position and new-message navigation |
| `UI/Composer.lua`           | Multiline input, send/stop, and centered or docked placement      |
| `UI/Activity.lua`           | Empty/loading states, progress row and header activity indicators |
| `UI/ConversationStatus.lua` | Conversation title, connection state and context usage            |
| `UI/SettingsPanel.lua`      | Addon preferences and WoW chat-channel settings                   |
| `UI/Routines.lua`           | Routine list, routine pages with their runs, and templates        |

The composer reports its bottom inset to the transcript through a callback wired
by the window. `UI/ModelControls.lua` owns model/effort controls without changing
composer or transcript geometry. Activity ticks update indicators without
rerendering messages. Escape goes through `ns.UI.GoBack`, which closes a
subpage or page before the window minimizes. The manifest loads these
components before the window; the offline UI fixtures follow the same
dependency order.

`Integrations/Integrations.lua` owns provider metadata, readiness aggregation and
protected inspection dispatch. Each provider owns its readiness checks and reads
in one file: `Questie.lua` (quests, chains and NPC/object locations),
`Syndicator.lua` (cached inventory) and `Auctionator.lua` (cached prices).
The manifest loads the coordinator before providers; callers keep using the
`ns.Integrations` API. Provider tests live in their corresponding specs, with
aggregation and dispatch covered by `integrations_spec.lua`.
