# A redesigned Wisp

<!-- Add user-facing notes for the next stable release here. -->

## New

- The WoW chat has a new look: a cleaner layout, new type and a palette shared
  with Wisp Desktop. Recent chats are grouped by day.
- Wisp's interface in WoW is now in Spanish when your game client is in Spanish.
- Copy any finished reply: hover it and select **Copy**.
- Wisp Desktop looks and behaves like a native Windows app, with its own title
  bar, and it remembers its window size and position.
- First-time setup is now a step-by-step wizard: install the addon, connect your
  AI, and you're ready.

## Improved

- Suggestions in a new chat now match what you're doing: your level, dungeon,
  group, or whether you just died or are resting.
- Wisp can now create macros with any command, including `/run`, `/click`,
  `/console`, chat commands and short aliases like `/tar`. Wisp explains what
  script, click and chat lines do, so review the code before you put the macro
  on a bar.
- After an app update, Overview shows that Wisp is updating your addon instead
  of asking you to update it, and WoW tells you to `/reload` once the new addon
  is ready.
- Routine notifications and the minimized chat bar have a new look.
- New chats get their title sooner.

## Fixed

- The Wisp window and persistent panels no longer cover the world map. They now
  stack with your bags and character window, and the one you click last comes
  to the front.
- Map pins, persistent panels and routines work again since the November 20
  WoW Forever hotfix, which stopped the game from reporting a realm name.
- Routines, panels, character memory and chats you saved before the November 20
  hotfix come back the next time you log in to that character. Wisp now
  recognizes each character by its in-game ID, so saved data follows it even if
  its realm or name changes. If you had characters with the same name on more
  than one server, their older data stays hidden, because the game no longer
  says which server each one was on.
- Wisp Desktop starts correctly even when another copy of Wisp is already using
  its agent port.
