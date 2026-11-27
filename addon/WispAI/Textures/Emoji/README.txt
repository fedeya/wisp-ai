Twemoji 17.0.3
https://github.com/jdecked/twemoji/tree/v17.0.3

Graphics copyright Twitter, Inc. and other contributors.
Licensed under Creative Commons Attribution 4.0 International.
See LICENSE-GRAPHICS.txt in this directory.

Wisp modifications: resized 72px PNG artwork to 30px, with transparent
padding in four 1024px uncompressed BGRA TGA atlases. No Windows emoji
fonts, network requests, or external services are used at runtime.

Rebuild on Windows with PowerShell and System.Drawing:
  Download https://codeload.github.com/jdecked/twemoji/tar.gz/refs/tags/v17.0.3
  Archive SHA256: a0855654b633045ae2337537e77f1bb4361162f7fcd910e613eaab1d6d9c5fca
  Extract and run scripts/textures/emoji.ps1 -Source <extracted directory>

EmojiData.lua maps complete Unicode sequences to atlas slots. Emoji.lua
groups ZWJ sequences, modifiers, keycaps, regional flags, tag flags and
presentation selectors before looking them up. Unsupported future emoji
are displayed as one readable [emoji U+...] fallback. Original stored
messages stay unchanged. Assets ship with the addon and desktop package.
