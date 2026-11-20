# Fonts

Inter 4.1 Medium sets Wisp's running text: conversation replies, rows and
controls. Inter SemiBold sets titles, headings, section labels and emphasis.
Regular strokes read thin on the near-black ground in the game's renderer, so
Medium is the lightest weight in use. This follows the Polestar addon
(fitzforge/polestar), which draws the same client's UI the same way. Text carries
a soft one-pixel shadow in the palette's shade. JetBrains Mono Regular 2.305
provides inline and fenced code text.

Inter covers Latin, Greek and Cyrillic, plus General Punctuation (quotes,
ellipsis, dashes, middle dot) used in tool labels. Clients localized to Simplified or
Traditional Chinese or Korean keep the game fonts, and text containing other
scripts, as well as a failed font load, falls back to the localized game font.
Code conservatively uses JetBrains Mono under the same script rule.

The unchanged static TrueType fonts come from the
[Inter 4.1 release](https://github.com/rsms/inter/releases/tag/v4.1)
(`extras/ttf/Inter-Medium.ttf` and `extras/ttf/Inter-SemiBold.ttf`) and the
[JetBrains Mono project](https://github.com/JetBrains/JetBrainsMono/blob/master/fonts/ttf/JetBrainsMono-Regular.ttf).
Their SIL Open Font License 1.1 texts are included in `OFL-Inter.txt` and
`OFL-JetBrainsMono.txt`.
