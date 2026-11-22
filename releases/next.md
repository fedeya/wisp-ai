# What's new in Wisp

<!-- Add user-facing notes for the next stable release here. -->

## Improved

- Upgrade suggestions come from real items for each slot that you can equip at your level, checked against your current gear in one step, instead of guessed item names.
- Quest, dungeon and map questions need fewer steps, so answers arrive sooner.
- When Wisp recommends items, it now tells you where each one comes from (drop, vendor, quest or recipe) and its last auction price, checked for all of them at once.
- If you chat before connecting an AI, Wisp now tells you in your game's language that you need to connect ChatGPT or an API key in the Wisp app, instead of showing a sign-in error.
- Opening your bags or quest log stutters less with Wisp open: the chat now only redraws replies that show an item the game just loaded, at most once per burst of updates, instead of redrawing everything for every update.
- Routines use less of your ChatGPT usage: they pause after you reach your usage limit instead of retrying every few minutes, and skip a check when nothing has changed since the last one had nothing to report.
- Wisp answers dungeon questions from the game's own data, so it knows the dungeons new in Forever, their real level ranges and where each entrance is, and can mark it on your map without searching the web.
