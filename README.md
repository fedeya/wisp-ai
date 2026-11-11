<p align="center">
  <img src="assets/wisp.png" alt="Wisp AI logo" width="120" />
</p>

<h1 align="center">Wisp AI for WoW: Forever</h1>

Ask about your character without leaving the game. Wisp brings your chosen AI provider into World of Warcraft: Forever, with live readings of your quests, talents, spells, equipment and bags.

Open a conversation with `/wisp`, or ask about an item, spell or unit under your cursor. Wisp can compare item stats, find NPC destinations, look up Forever references and keep character-specific progress trackers.

### Questions to try

These are example prompts, not recorded results:

- “How does this ring compare with the one I’m wearing?”
- “Which of my current quests can I finish nearby?”
- “Where is the nearest mage trainer?”
- “Keep a tracker for 20 Linen Cloth and 1 gold.”

## Get started on Windows

Download the [Windows x64 installer](https://github.com/fedeya/wisp-ai/releases/download/v0.0.7/WispAI-0.0.7-windows-x64-setup.exe) from [Releases](https://github.com/fedeya/wisp-ai/releases), or [build from source](docs/development.md#build-and-run-on-windows).

Once the desktop app is running:

1. In **Overview**, select the WoW folder containing `Wow.exe` and install/update the addon.
2. In **Connections**, sign in with **ChatGPT** (no API key needed), or add an **API connection** for Claude, Gemini, DeepSeek, Vercel AI Gateway, OpenRouter or another supported provider. Select a model and click **Set default**. See [AI connections](docs/usage.md#ai-connections) for API setup.
3. Fully exit and restart WoW, then enable **Wisp AI** and its helper addons in the AddOns list.
4. Type `/wisp` and ask a question. Keep the desktop app running; closing its window leaves it in the system tray.

For hover questions, choose **Bind inline chat** in Wisp’s in-game settings and press an unused key combination. Controls are in English; replies follow your language.

## Before you use it

Relevant game readings and conversation context go to the AI connection selected for that chat, including any gateway it uses. You control available tools, memory and connections. Requested settings changes can be previewed before applying them; gameplay stays with you. Read [controls, privacy and limits](docs/usage.md#controls-privacy-and-limits).

Release builds share usage analytics with PostHog by default: versions, activity,
feature use, outcomes and durations with a random installation ID. Analytics events
exclude conversations, character names, tool arguments/results and credentials.
Turn it off in desktop **Settings > Usage analytics**.

Windows is the tested distribution target. Other WoW versions and macOS distribution are not established as supported. Game communication uses addon files; large replies can take several seconds, and `/reload` renews the finite receive channels.

## Explore

- [Usage and troubleshooting](docs/usage.md) — conversations, trackers, actions and local data
- [Development](docs/development.md) — prerequisites, builds and checks
- [Integrations and simulator](docs/reference.md) — knowledge sources, custom MCPs and class damage and equipment comparisons
- [Landing page](apps/web/README.md) — Next.js site for wisp.fedeya.sh, local preview and Vercel deployment

[GPL-3.0-only](LICENSE) · [Attributions](NOTICE) · [WoWSims license](simulator/LICENSE-WoWSims.txt)
