# Using Wisp

[Home](../README.md) · [Development](development.md) · [Integrations](reference.md)

Closing the desktop window keeps Wisp running in the Windows system tray. Left-click its tray icon to reopen it, or right-click for **Open Wisp** and **Exit Wisp**. **Exit Wisp** stops the bridge and closes the app; if a turn is active, wait for it to finish and try again.

On first use, Wisp reads registered installation paths from Battle.net's local `product.db`. Game installations can be on any disk; Wisp does not scan game folders or running processes. Candidates must contain `Wow.exe` and Blizzard metadata identifying the Forever product (`wowf`). Setup shows **Searching for installation…** until the search finishes, with folder selection and installation unavailable during the search. Wisp then shows the detected folder, or a selector if it found multiple installations, and a brief success notification. Click the folder path or **Choose folder** to open the native folder picker, including if automatic detection found nothing or failed. The path is not a text editor. **Search again** runs a fresh search and preserves the selected installation if it is found again. Detection does not save the path or install anything; choose **Install addon** to finish setup. Saved installations skip automatic detection.

## AI connections

**Connections** keeps ChatGPT subscription sign-in and API connections side by side. API connections use native AI SDK adapters for OpenAI, Anthropic (Claude), Google (Gemini), DeepSeek, xAI, Groq, Mistral, Cerebras, Cohere, Together AI, Fireworks, DeepInfra, Alibaba (Qwen), Moonshot (Kimi), MiniMax, Baseten and Z.AI. Vercel AI Gateway and OpenRouter expose multiple vendors through one account. **OpenAI compatible / Local** supports other Chat Completions endpoints, including local servers. Bedrock, Vertex and Azure account/deployment setup are not included. The installed native Hugging Face adapter drops tool results from history, so use its Chat Completions endpoint through **OpenAI compatible / Local** instead.

1. Choose **Add connection**, select a provider and enter its API key. API usage is billed separately by the provider; ChatGPT sign-in remains the subscription option.
2. Choose **Load model list**, or enter an exact model ID. Add the models you want to use. A provider's catalog can include models that do not support tools: choose a language model with tool calling.
3. Set each model's context window in tokens. Discovery fills this when the provider supplies it. For local models, use the server's allocated context, not the model's theoretical maximum. Wisp requires this value to compact long conversations correctly.
4. **Test first model** sends a small, potentially billable tool-calling check without executing any game action. It tests the first listed model only. Save the connection, then choose a **Default model**. Each chat can select another configured model in game.

API keys are stored in the operating system's protected credential store and stay in the bridge; the agent receives only a local transport token. Editing with a blank API key retains the saved key. Custom endpoints require HTTPS, except HTTP on localhost. Only use endpoints you trust with the key and chat context. A local server may omit its key. For OpenAI-compatible endpoints, include their API prefix, typically `/v1`.

Use **Effort** in each in-game chat (including inline questions) to choose reasoning for supported models. **Default** keeps the provider's behavior; available levels depend on the exact model. Toggle-only models show **On/Off** instead of effort levels. Claude and Gemini models that use token budgets receive the native SDK's budget for the chosen level. Higher effort can increase latency and billed tokens. Models with unknown or unsupported controls keep the provider default. Existing API chats remain on their provider default until you choose a level; ChatGPT retains its account-provided controls. Gateway discovery preserves its model-specific reasoning metadata. Refresh the model list to pick up newly supported levels.

Switching an API chat to another model or connection starts fresh provider-native history from the visible transcript, preserving the chat and memory. Removing a connection preserves chats but those chats need another model before continuing. There is no automatic fallback to another provider.

Wowhead search works independently of the model. In **Connections → Web search**, **Auto** keeps ChatGPT search for subscription chats and uses Exa for API chats. Exa works without a key through its public MCP endpoint, with free rate limits. **Exa for all chats**, **ChatGPT search only** and **Disabled** are also available. An optional Exa key uses your account’s REST API credits and billing; it is stored in the operating-system vault. **Test Exa** sends one scoped search using the entered/saved key or public access. Removing the key returns Exa to public access. Requests and source excerpts are restricted to Wowhead Forever; empty results remain unknown. Exa failures are reported without silently switching services. See [Exa’s access limits](https://exa.ai/docs/get-started/exa-mcp). Other enabled game, database and MCP tools remain available with API models. Some providers do not expose model discovery; enter model IDs and context windows manually in that case. Included adapters are covered by local transport tests, not a guarantee that every model or account supports Wisp's tools.

## Conversations and hover questions

After [setup](../README.md#get-started-on-windows), use `/wisp` or `/wispai` to open chat. **+** starts a separate conversation; **−** or Escape minimizes the window. Choose model and effort per chat, or set the default for new chats in the desktop **Connections** page.

Shift-click supported items and spells into the input. Linked references offer native tooltips, map coordinates or macro code; a link identifies something, not whether your character owns or knows it.

Choose **Bind inline chat** in Wisp’s in-game settings, then hover an item, spell, unit or supported link and press the shortcut. `/wisp ask` also uses the current hover. Follow-ups keep that reference; **Expand** moves the query into a full conversation, and Escape dismisses it.

Replies arrive in batches, with tool/progress indicators while Wisp works. The context indicator estimates model context use, not your subscription quota; compaction preserves the visible transcript. Separate Wowhead search calls are excluded from its totals.

## Trackers and routines

Ask Wisp to save a tracker for your character. Panels survive chats and reloads; restore hidden ones with **Show saved panels** in-game or the desktop **Panels** page. Bag counts, money, level and quest completion update locally without model calls. Panel buttons send follow-up questions; ordinary reply cards are temporary unless saved.

Ask Wisp in chat to create a routine, for example “Every two levels, review my spells and rotation.” Open **Routines** in the in-game sidebar to browse routines and their run conversations; the desktop **Routines** page also offers pause, resume, delete and run history. Supported triggers include level, equipment, money, bags, quests, spells, talents and zone changes, plus intervals of at least one minute. Filters use the event’s documented fields. “Every two levels” can use even levels; Wisp should explain the exact saved condition. Routines run only while that character and the desktop app are connected. Combat and active turns delay work; repeated events and missed intervals coalesce. Automatic runs are read-only and can remain silent when there is nothing useful to report. Each useful run has its own conversation, where you can ask follow-up questions. Routine definitions and history are saved locally in routines.json; they are independent of their creation chat. Old Suggestions toggles are replaced by explicit routines; they are not automatically enabled.

## Controls, privacy and limits

In-game **Settings > Integrations** controls optional addons, data sources, MCP connections and individual integration tools. WoW readings, game tools, titles and panels are built into the agent. Memory has separate controls in desktop **Memory** and the in-game **Memory** tab. Changes affect new calls immediately; running calls may finish.

### Actions you control

| Action   | What to expect                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map pins | Requested pins use validated maps/coordinates and verified placement. Undo preserves pins you changed yourself.                                                                   |
| Macros   | New macros only, outside combat. Inspect the code and place it yourself; Wisp cannot overwrite, run or assign it to a bar. Script, console, click and chat commands are excluded. |
| Settings | Supported CVars and registered AceConfig options offer a preview. Use **Apply** or explicitly ask to apply it; **Undo** preserves later player edits.                             |

Settings application checks combat, character identity and stale values, then reads back the result. Failures attempt rollback and report incomplete restoration; the last 30 proposals retain previous values locally. Action bars and keybindings are read-only. Unsupported addon options require an integration, not edits to another addon’s source.

Movement, casting, targeting, training and trading remain with you. Built-in shell/file-editing tools are disabled; generated panels use validated native controls rather than executable code. These controls do not sandbox custom MCP software: stdio servers run local programs, and remote servers receive tool arguments. Choose servers you trust; see [MCP setup](reference.md#custom-mcp-connections).

### What leaves your computer

Each message includes available character name/realm, level, class, race, faction, game version/build and location. Other state—such as bags, quests and equipment—is read on demand. Prompts, tool results, conversation context and recalled memory go to the selected AI connection (and its gateway, if any); enabled external sources receive lookup arguments. Built-in knowledge integrations do not upload whole game saves or memory documents. Custom servers have their own behavior and policies.

The bridge holds the ChatGPT grant and proxies model requests with `store: false`; this does not mean the provider receives no data or retains nothing. Neither the agent nor desktop webview receives the ChatGPT credentials. Windows credentials use DPAPI for the current user, so changing Windows users requires signing in again. See [OpenAI’s sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

### Local data and deletion

Installed Windows data lives in `%APPDATA%/com.wisp.ai`, separate from application resources. Source runs default to the repository root; `WISP_DATA_DIR` overrides it.

| Data                                   | Path relative to the data root                   |
| -------------------------------------- | ------------------------------------------------ |
| Configuration                          | `config.local.json`                              |
| Conversations                          | `runtime/chats.json`                             |
| Routine definitions and run history    | `runtime/routines.json`                          |
| Shared preferences and character plans | `runtime/memory/`                                |
| Tool choices / custom MCP metadata     | `runtime/capabilities.json` / `runtime/mcp.json` |
| Agent log                              | `runtime/eve.log`                                |

WoW stores UI preferences and drafts in the `WispAIDB` SavedVariables. Logs may contain conversations and tool data: redact them before sharing, and never share credential stores, tokens or private configuration.

Use **Settings > Memory** to view, edit or forget notes. Deleting a chat does not delete memory; disabling memory tools preserves notes and the editor. Memory stores preferences/plans, not current character state.

**Connections** supports saved accounts, switching and disconnection. Disconnect attempts to revoke Wisp’s refresh token and clears local credentials, but leaves chats, memory and other applications’ sessions intact.

### Reading the answers

Missing readings and database coverage remain unknown, not zero or proof of absence. External references can be stale or from a different build; market estimates come from uploaded scans, not live listings. Trainer and auction readings need their windows open, and auctions expose only already-loaded partial results. Item comparisons report raw stat differences; [experimental simulations](reference.md#experimental-local-dps-simulations) compare supported class damage scenarios and equipment alternatives, not live combat or an optimal build.

## Troubleshooting

| Symptom                       | Try this                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Addon missing                 | Select the folder containing `Wow.exe`, install/update from **Overview**, fully restart WoW, and enable Wisp AI and its helpers.                                                                                                                          |
| Disconnected or replies stop  | Keep the desktop app running. Check **Diagnostics** and `/wisp diag`; use `/wisp reconnect` for a fresh handshake or `/reload` to renew receive channels. Large payloads take several seconds. Significant game updates may change file-loading behavior. |
| Sign-in or models unavailable | Finish browser authorization in **Connections** and refresh the model list. Expired access, identity-only consent or an ambiguous token refresh may require signing in again.                                                                             |
| Tool unavailable              | Check the game connection, optional integration switches and required windows; missing APIs or source coverage can also prevent a result.                                                                                                                 |
| App remains after closing     | Closing hides it in the tray. **Exit Wisp** stops it. If a turn is active, wait for it to finish and try again.                                                                                                                                           |

For an old portable install, choose **Import your previous installation** on first launch. Existing Wisp saves are preserved; renamed addon folders are backed up under `Interface/WispAI-RenameBackup`. Older Codex-adapter installs need Wisp’s own ChatGPT sign-in. Fully restart WoW after migration.

## Integrations

WoW character readings, inventory, progression, references, settings, maps and macros are core agent capabilities. Titles and persistent panels are also built in. These capabilities have no integration switches; game reads still require a live WoW connection. Older switches for these capabilities no longer apply. Memory remains optional with independent controls.

Desktop **Integrations** and WoW **Settings > Integrations** share the same optional integration controls.
Each integration has a master switch and individual capabilities. Disabling a parent
preserves child preferences. Enabled and available capabilities are projected into
Eve's dynamic definitions; the bridge enforces the same checks on game/RPC calls.

- **Questie:** installed QuestieDB Forever NPC locations, with optional Questie trainer/service indexes. Missing, incompatible and partial providers are distinguished. No addon source is modified.
- **TheWoWDB / Wowhead / Everloot:** primary Forever catalog, scoped fallback search, and complementary MCP observations respectively. Configured network sources are not claimed to be online until a request succeeds.
- **WoWSims Forever:** the bundled experimental class damage and equipment simulator.
- **Custom MCPs:** Add/Edit/Test/Remove plus per-tool switches after discovery.

Local agent tools have public names such as `questie__find_npc_locations` and
`wow__query_character`. Preference IDs remain internal stable keys. Addon reports
piggyback on the existing hello/heartbeat; unchanged reports do not publish new
snapshots. Reports expire after three minutes and reset on reload. Availability is
kept separate from saved choices. A compact `integrations_context` block tells the
agent what is unavailable or disabled for the current turn.

### Reading WoW chat

In the in-game Wisp Settings, open **WoW chat history** to choose channels or clear the buffer. Say, yell, party, raid, instance and guild are enabled initially; whispers (incoming and outgoing), officer and public/custom channels are optional. Public/custom channels have individual checkboxes showing their current number and name (for example /1 General and /3 LookingForGroup). Select only the channels Wisp should capture. Selections follow names when numbers change, and new channels start disabled. The previous all-public-channels switch is replaced by these individual selections; reselect public channels after upgrading. Disabling a channel also removes its buffered messages.

Wisp keeps up to 200 messages for 30 minutes in addon memory, starting at login or reload; the buffer is not saved across sessions. Ask “What did the party leader say?” or “Is anyone looking for a healer?” The agent can consult `wow__read_chat` on demand, filtering by channel type, public channel name, sender, text or recent time. Each read returns up to 50 matches. Messages are shared with the chat’s selected AI provider when consulted, rather than attached to every question. Clearing the buffer does not remove results already returned in a Wisp conversation. The tool can also be disabled under Integrations.
