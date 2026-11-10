# Markdown

`Syntax.lua`, `Block.lua` and `Parser.lua` produce Wisp's text tree without UI
dependencies. `Cache.lua` schedules and caches parsing, `InlineRenderer.lua`
formats text, and `ReplyView.lua` owns reply presentation and its state.

The parser API is `C.Markdown.parse` and `C.Markdown.parseInline`; its tree uses
`children` arrays. The other modules live under the same `C.Markdown` namespace.
`MessageRows` and `RichUI` own the native widgets.

See [the contract](../../../docs/markdown.md) for syntax, API, limits and checks.
