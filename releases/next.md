# What's new in Wisp

<!-- Add user-facing notes for the next stable release here. -->

## Improved

- Wisp can now create macros with any command, including `/run`, `/click`, `/console`, chat commands and short aliases like `/tar`. Wisp explains what script, click and chat lines do, so review the code before you put the macro on a bar.
- After an app update, Overview shows that Wisp is updating your addon instead of asking you to update it.

## Fixed

- The Wisp window and persistent panels no longer cover the world map. They
  now stack with your bags and character window, and the one you click last
  comes to the front.
- Map pins, persistent panels and routines work again since the November 20
  WoW Forever hotfix, which stopped the game from reporting a realm name.
- Routines, panels, character memory and chats you saved before the November 20
  hotfix come back the next time you log in to that character. Wisp now
  recognizes each character by its in-game ID, so saved data follows it even if
  its realm or name changes. If you had characters with the same name on more
  than one server, their older data stays hidden, because the game no longer
  says which server each one was on.
