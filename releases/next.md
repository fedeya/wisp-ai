# What's new in Wisp

<!-- Add user-facing notes for the next stable release here. -->

## Improved

- Connecting an AI provider with an API key takes one step: paste your key and select **Connect**. Wisp adds every model you can use and fills in each model's context window for you, so you no longer name the connection, pick models one by one or look up token limits. Providers that list many models, like OpenRouter, still let you choose which ones to add. You can rename a connection or adjust its models later from AI Providers.
- Upgrade suggestions come from real items for each slot that you can equip at your level, checked against your current gear in one step, instead of guessed item names.
- Quest, dungeon and map questions need fewer steps, so answers arrive sooner.
- When Wisp recommends items, it now tells you where each one comes from (drop, vendor, quest or recipe) and its last auction price, checked for all of them at once.
- If you chat before connecting an AI, Wisp now tells you in your game's language that you need to connect ChatGPT or an API key in the Wisp app, instead of showing a sign-in error.
- Opening your bags or quest log stutters less with Wisp open: the chat now only redraws replies that show an item the game just loaded, at most once per burst of updates, instead of redrawing everything for every update.
- Long chats open and resize without a hitch: Wisp shows the latest 50 messages and adds earlier ones as you scroll to the top.
- Routines use less of your ChatGPT usage: they pause after you reach your usage limit instead of retrying every few minutes, and skip a check when nothing has changed since the last one had nothing to report.
- Wisp answers dungeon questions from the game's own data, so it knows the dungeons new in Forever, their real level ranges and where each entrance is, and can mark it on your map without searching the web.

## Fixed

- **Discover models** now lists the models you can use for every provider, including OpenAI, Google Gemini, Mistral, Cohere, Fireworks, DeepSeek, xAI, Groq, Cerebras, Together AI, DeepInfra, Qwen, Kimi, MiniMax, Baseten, Z.AI and local OpenAI-compatible servers, instead of saying no supported models were found. Image, speech and embedding models stay hidden because they can't use Wisp's tools.

- With two game windows open, Wisp no longer switches between them every few seconds, interrupting answers and leaving messages stuck on "Waiting for bridge". The window you last typed in keeps Wisp.
- When WoW stops answering Wisp, the answer no longer stalls for minutes trying to read your character again and again: after the first 30-second wait, Wisp answers with what it knows and suggests /reload.
- Messages with an emoji now use the same font as the rest of the chat, instead of switching to the game's font.
- Right after you log in or /reload, Wisp's first answer no longer takes minutes to appear in the game. The addon was busy resending its startup messages and never paused to read the answer; it now leaves room to read between them.
